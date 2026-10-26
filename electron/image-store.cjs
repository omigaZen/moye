'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { validateFolder, normalizePolicy, shouldCopyImage } = require('../src/image-policy.js');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
const windowsAbsolute = value => /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value);
const pathApi = value => windowsAbsolute(value) ? path.win32 : path;
const encodeSegment = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function cleanStem(value) {
  const characters = Array.from(value.replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '')).slice(0, 100);
  while (Buffer.byteLength(characters.join(''), 'utf8') > 180) characters.pop();
  return characters.join('') || 'image';
}

function assetFolderFor(documentPath, values = {}) {
  if (typeof documentPath !== 'string' || !path.isAbsolute(documentPath)) throw new Error('请先保存 Markdown 文档，图片将保存在文档旁的资源文件夹中。');
  const policy = normalizePolicy(values);
  let filename = cleanStem(path.basename(documentPath, path.extname(documentPath)));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = `_${filename}`;
  const relative = policy.assetFolder.replace(/\$\{filename\}/g, filename).replace(/[\\/]/g, path.sep);
  // Revalidate after expanding the filename, including names consisting of dots.
  if (!validateFolder(relative)) throw new Error('图片资源文件夹无效，请使用文档内的相对目录。');
  const root = path.dirname(documentPath), directory = path.resolve(root, relative);
  const within = path.relative(root, directory);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('图片资源文件夹超出文档目录。');
  return { root, relative: within, directory };
}

function absoluteUrl(filename) {
  return pathToFileURL(filename, { windows: windowsAbsolute(filename) }).href.replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function readablePath(value) {
  // These are URL delimiters rather than optional readability escaping. Leaving
  // them raw would point at another file (or turn a filename into a fragment).
  const stack = [], unmatched = new Set();
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') stack.push(i);
    if (value[i] === ')') { if (stack.length) stack.pop(); else unmatched.add(i); }
  }
  for (const offset of stack) unmatched.add(offset);
  // IR serialization removes angle brackets. Unmatched parentheses and code
  // delimiters must remain escaped for the next parse and asset scan.
  return value.replace(/[%#?<>"\\`\x00-\x1f()]/g, (char, offset) => /[()]/.test(char) && !unmatched.has(offset) ? char : encodeSegment(char));
}

function imageReference(imagePath, documentPath, values = {}, { copied = false } = {}) {
  const policy = normalizePolicy(values), api = pathApi(imagePath);
  if (typeof imagePath !== 'string' || !api.isAbsolute(imagePath)) throw new TypeError('需要绝对图片路径。');
  let destination, relative;
  if ((policy.pathStyle === 'relative' || policy.pathStyle === 'auto' && copied) && documentPath && pathApi(documentPath) === api) {
    relative = api.relative(api.dirname(documentPath), imagePath);
    // path.win32.relative returns an absolute path for another drive/share.
    if (api.isAbsolute(relative)) relative = undefined;
  }
  if (relative !== undefined) {
    relative = relative.split(api.sep).join('/');
    if (policy.relativePrefix && !relative.startsWith('../') && !relative.startsWith('./')) relative = `./${relative}`;
    destination = policy.escapePath ? relative.split('/').map(encodeSegment).join('/') : readablePath(relative);
  } else {
    destination = absoluteUrl(imagePath);
    if (!policy.escapePath) destination = destination.split('/').map(segment => readablePath(decodeURIComponent(segment))).join('/');
  }
  if (!policy.escapePath && /[\s()]/.test(destination)) destination = `<${destination}>`;
  const stem = api.basename(imagePath, api.extname(imagePath));
  const alt = stem.replace(/([\\\[\]`])/g, '\\$1');
  return { path: imagePath, markdown: `![${alt}](${destination})` };
}

async function ensureAssetDirectory({ root, relative }) {
  let directory = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('图片资源文件夹不能是符号链接或普通文件，请检查资源文件夹。');
  }
}

function imageData({ name, bytes }) {
  if (typeof name !== 'string' || name.length > 240 || !name) throw new Error('图片文件名无效。');
  const extension = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('不支持的图片格式。');
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能为空，且不能超过 25 MB。');
  let stem = cleanStem(path.basename(name, path.extname(name)));
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return { bytes, extension, stem };
}

async function copyImageToDocument(image, documentPath, values = {}) {
  const folder = assetFolderFor(documentPath, values);
  const { bytes, extension, stem } = imageData(image);
  await ensureAssetDirectory(folder);
  const temporary = path.join(folder.directory, `.moye-image-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    // Publish the complete file atomically without replacing an existing name.
    // A failed read/write never leaves a partially imported image behind.
    for (let attempt = 0; attempt < 10000; attempt++) {
      const filename = `${stem}${attempt ? `-${attempt + 1}` : ''}${extension}`;
      const destination = path.join(folder.directory, filename);
      try {
        await fs.link(temporary, destination);
        return imageReference(destination, documentPath, values, { copied: true });
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    throw new Error('同名图片过多，请重命名图片后重试。');
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function readLocalImage(imagePath) {
  if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath) || !IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) throw new Error('请选择有效的本地图片。');
  if ((await fs.lstat(imagePath)).isSymbolicLink()) throw new Error('请选择原始图片文件，不要使用符号链接。');
  const handle = await fs.open(imagePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES) throw new Error('图片不能为空，且不能超过 25 MB。');
    const bytes = await handle.readFile();
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能为空，且不能超过 25 MB。');
    return { name: path.basename(imagePath), bytes };
  } finally { await handle.close(); }
}

module.exports = { validateFolder, normalizePolicy, shouldCopyImage, assetFolderFor, imageReference, copyImageToDocument, readLocalImage, MAX_IMAGE_BYTES };
