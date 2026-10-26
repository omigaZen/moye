'use strict';

// A deliberately small source-preserving image-reference scanner. Only spans
// containing destinations are rewritten; unrecognized Markdown stays intact.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function maskCode(source) {
  const chars = source.split('');
  const erase = (start, end) => { for (let i = start; i < end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' '; };
  let fence = null, offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line);
    if (fence) {
      erase(offset, offset + line.length);
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = null;
    } else if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
      fence = { char: match[1][0], length: match[1].length };
      erase(offset, offset + line.length);
    }
    offset += line.length;
  }
  let masked = chars.join('');
  for (const match of masked.matchAll(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) erase(match.index, match.index + match[0].length);
  masked = chars.join('');
  for (let i = 0; i < masked.length;) {
    if (masked[i] !== '`' || escaped(masked, i)) { i++; continue; }
    let end = i; while (masked[end] === '`') end++;
    const ticks = masked.slice(i, end);
    let close = masked.indexOf(ticks, end);
    while (close >= 0 && (masked[close - 1] === '`' || masked[close + ticks.length] === '`')) close = masked.indexOf(ticks, close + ticks.length);
    if (close >= 0) { erase(i, close + ticks.length); i = close + ticks.length; }
    else i = end;
  }
  return chars.join('');
}

function escaped(source, offset) {
  let slash = 0; while (offset > 0 && source[--offset] === '\\') slash++;
  return Boolean(slash % 2);
}

function destinationAt(source, start, { readable = false, definition = false } = {}) {
  while (source[start] === ' ' || source[start] === '\t') start++;
  if (source[start] === '<') {
    let end = start + 1;
    while (end < source.length && source[end] !== '\n' && !(source[end] === '>' && !escaped(source, end))) end++;
    return source[end] === '>' ? { start: start + 1, end, raw: source.slice(start + 1, end), angle: true } : null;
  }
  let end = start, depth = 0;
  while (end < source.length) {
    const char = source[end];
    if (!escaped(source, end)) {
      if (/\s/.test(char)) break;
      if (char === '(') depth++;
      if (char === ')') { if (!depth) break; depth--; }
    }
    end++;
  }
  const ordinary = end > start ? { start, end, raw: source.slice(start, end), angle: false } : null;
  if (!readable) return ordinary;
  // The editor supports readable image paths containing spaces and serializes
  // angle destinations without their brackets. Recognize those paths during
  // Save As as well, while leaving an optional Markdown title outside the span.
  let finish = start, nested = 0;
  for (; finish < source.length && !/[\r\n]/.test(source[finish]); finish++) {
    if (escaped(source, finish)) continue;
    if (source[finish] === '(') nested++;
    if (source[finish] === ')') {
      if (!nested && !definition) break;
      if (nested) nested--;
    }
  }
  let raw = source.slice(start, finish).trimEnd();
  const title = /[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/.exec(raw);
  if (title) raw = raw.slice(0, title.index).trimEnd();
  let decoded;
  try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]); } catch { return ordinary; }
  return /[ \t]/.test(raw) && IMAGE_EXTENSIONS.has(path.extname(decoded).toLowerCase())
    ? { start, end: start + raw.length, raw, angle: false } : ordinary;
}

function normalizeLabel(label) { return label.replace(/\\([\\\[\]])/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase(); }

function imageReferences(source) {
  const masked = maskCode(source), references = [], labels = new Set();
  const image = /!\[((?:\\.|[^\]\\])*)\]/g;
  for (const match of masked.matchAll(image)) {
    if (escaped(masked, match.index)) continue;
    let at = match.index + match[0].length;
    while (masked[at] === ' ' || masked[at] === '\t') at++;
    if (masked[at] === '(') {
      const destination = destinationAt(masked, at + 1, { readable: true });
      if (destination) references.push({ ...destination, kind: 'markdown' });
    } else if (masked[at] === '[') {
      const end = masked.indexOf(']', at + 1);
      if (end >= 0) labels.add(normalizeLabel(masked.slice(at + 1, end) || match[1]));
    } else labels.add(normalizeLabel(match[1]));
  }
  for (const match of masked.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*/gm)) {
    if (!labels.has(normalizeLabel(match[1]))) continue;
    const destination = destinationAt(masked, match.index + match[0].length, { readable: true, definition: true });
    if (destination) references.push({ ...destination, kind: 'markdown' });
  }
  for (const match of masked.matchAll(/<img\b[^>]*>/gi)) {
    const attribute = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
    if (!attribute) continue;
    const raw = attribute[1] ?? attribute[2] ?? attribute[3];
    const within = attribute.index + attribute[0].indexOf('=') + 1;
    let start = within; while (/\s/.test(match[0][start] || '')) start++;
    if (match[0][start] === '"' || match[0][start] === "'") start++;
    start += match.index;
    references.push({ start, end: start + raw.length, raw, kind: 'html' });
  }
  return references.sort((a, b) => a.start - b.start).filter((reference, index, list) => !index || reference.start !== list[index - 1].start);
}

function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    if (entity[1] === '#') {
      const code = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' }[entity.toLowerCase()] || entity;
  });
}

function relativeImage(reference) {
  let value = reference.kind === 'html' ? decodeHtml(reference.raw) : reference.raw.replace(/\\([\\`*{}\[\]()#+\-.!_<> ])/g, '$1');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|[\\/]|#)/i.test(value)) return null;
  const separator = value.search(/[?#]/);
  const suffix = separator >= 0 ? value.slice(separator) : '';
  value = separator >= 0 ? value.slice(0, separator) : value;
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!value || value.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(value)) return null;
  if (!IMAGE_EXTENSIONS.has(path.extname(value).toLowerCase())) return null;
  return { value: value.replace(/[\\/]/g, path.sep), suffix };
}

function isWithin(root, location) {
  const relative = path.relative(root, location);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathWithoutSymlink(root, relative, { create = false, directory = false } = {}) {
  const parts = relative.split(path.sep).filter(part => part && part !== '.');
  let location = root;
  for (let i = 0; i < parts.length; i++) {
    location = path.join(location, parts[i]);
    let info;
    try { info = await fs.lstat(location); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return { missing: true, location };
      if (i < parts.length - 1 || directory) { await fs.mkdir(location); continue; }
      return { missing: true, location };
    }
    if (info.isSymbolicLink()) return { symlink: true, location };
    if ((i < parts.length - 1 || directory) && !info.isDirectory()) throw new Error(`图片资源目录不可用：${location}`);
    if (i === parts.length - 1) return { info, location };
  }
  return { info: await fs.stat(root), location: root };
}

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function copyImage(source, destination) {
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return false;
    bytes = await handle.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) return false;
  } finally { await handle.close(); }
  const temporary = path.join(path.dirname(destination), `.moye-image-${crypto.randomBytes(12).toString('hex')}.tmp`);
  let output;
  try {
    output = await fs.open(temporary, 'wx', 0o600);
    await output.writeFile(bytes); await output.sync(); await output.close(); output = null;
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await fs.lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_IMAGE_BYTES) {
        throw new Error(`新位置中已存在内容不同的图片：${path.basename(destination)}。请另选目录，以免覆盖图片。`);
      }
      const existing = await fs.open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        if (digest(await existing.readFile()) !== digest(bytes)) throw new Error(`新位置中已存在内容不同的图片：${path.basename(destination)}。请另选目录，以免覆盖图片。`);
      } finally { await existing.close(); }
    }
  } finally {
    if (output) await output.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
  return true;
}

async function relocateRelativeImages(content, sourcePath, targetPath) {
  if (!sourcePath || path.dirname(sourcePath) === path.dirname(targetPath)) return content;
  const sourceDirectory = path.dirname(sourcePath), targetDirectory = path.dirname(targetPath);
  const replacements = [], copied = new Set();
  for (const reference of imageReferences(content)) {
    const image = relativeImage(reference);
    if (!image) continue;
    const source = path.resolve(sourceDirectory, image.value);
    const rebase = () => {
      let replacement = (pathToFileURL(source).href + image.suffix).replace(/[!'()*<>"\s]/g, char => encodeURIComponent(char).replace(/[!'()*]/g, unsafe => `%${unsafe.charCodeAt(0).toString(16).toUpperCase()}`));
      if (reference.kind === 'html') replacement = replacement.replace(/&/g, '&amp;');
      replacements.push({ ...reference, replacement });
    };
    if (!isWithin(sourceDirectory, source) || !isWithin(targetDirectory, path.resolve(targetDirectory, image.value))) { rebase(); continue; }
    const relative = path.relative(sourceDirectory, source);
    const sourceInfo = await pathWithoutSymlink(sourceDirectory, relative);
    // A symlink is preserved as a reference, never followed or copied. Missing
    // files were already broken in the original document and remain unchanged.
    if (sourceInfo.symlink) { rebase(); continue; }
    if (sourceInfo.missing || !sourceInfo.info.isFile()) continue;
    if (sourceInfo.info.size > MAX_IMAGE_BYTES) { rebase(); continue; }
    if (copied.has(relative)) continue;
    const destination = path.resolve(targetDirectory, relative);
    if (!isWithin(targetDirectory, destination)) throw new Error('图片资源路径超出保存目录。');
    const destinationDirectory = path.dirname(relative);
    const parent = await pathWithoutSymlink(targetDirectory, destinationDirectory, { create: true, directory: true });
    if (parent.symlink) throw new Error(`图片资源目录不能是符号链接：${parent.location}`);
    const target = await pathWithoutSymlink(targetDirectory, relative, { create: true });
    if (target.symlink) throw new Error(`图片资源不能是符号链接：${target.location}`);
    if (!await copyImage(source, destination)) rebase();
    else copied.add(relative);
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) content = content.slice(0, replacement.start) + replacement.replacement + content.slice(replacement.end);
  return content;
}

module.exports = { imageReferences, maskCode, relocateRelativeImages, copyImage };
