'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { relocateRelativeImages, copyImage } = require('./relative-assets.cjs');
const { copyImageToDocument } = require('./image-store.cjs');
const { decodeText, encodeText, normalizeEncoding, labelFor, bomInfo, ENCODINGS } = require('./text-codec.cjs');

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_ENCODING_MEMORY_ENTRIES = 256;
const MAX_ENCODING_MEMORY_BYTES = 64 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);

function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeMarkdown(bytes, options = {}) {
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('文件超过 32 MB，请拆分后编辑。');
  const decoded = decodeText(bytes, options), text = decoded.text;
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.match(/(?<!\r)\n/g) || []).length;
  const crCount = (text.match(/\r(?!\n)/g) || []).length;
  const eol = crlfCount > 0 && crlfCount >= lfCount && crlfCount >= crCount ? '\r\n' : crCount > lfCount ? '\r' : '\n';
  const { text: _text, ...metadata } = decoded;
  return { content: normalizeLineEndings(text), ...metadata, eol };
}

function encodeMarkdown(content, { bom = false, eol = '\n', encoding = 'utf-8' } = {}) {
  if (typeof content !== 'string') throw new TypeError('文档内容必须是文本。');
  const text = normalizeLineEndings(content).replace(/\n/g, eol);
  const data = encodeText(text, { bom, encoding });
  if (data.length > MAX_DOCUMENT_BYTES) throw new Error('文档超过 32 MB，无法保存。');
  return data;
}

async function atomicWrite(filePath, bytes) {
  const directory = path.dirname(filePath);
  let originalMode;
  try { originalMode = (await fs.stat(filePath)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.moye-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', originalMode ?? 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    // Directory fsync is not available on every Windows filesystem.
    try {
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {}
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function baseUrlFor(filePath) {
  return filePath ? pathToFileURL(path.dirname(filePath) + path.sep).href : null;
}

async function relocateManagedAssets(content, sourcePath, targetPath) {
  if (!sourcePath || path.dirname(sourcePath) === path.dirname(targetPath)) return;
  const names = new Set([`${path.basename(sourcePath, path.extname(sourcePath))}.assets`]);
  // Only adjacent *.assets directories are managed by the editor. Never follow
  // arbitrary ../ references or symlinks supplied by Markdown content.
  for (const match of content.matchAll(/(?:\.\/)?([^\s<>"'()[\]\\/]+\.assets)\//g)) {
    let name;
    try { name = decodeURIComponent(match[1]); } catch { continue; }
    if (name && name !== '.' && name !== '..' && !/[\\/]/.test(name)) names.add(name);
  }
  for (const name of names) {
    const source = path.join(path.dirname(sourcePath), name);
    let info;
    try { info = await fs.lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const entries = await fs.readdir(source, { withFileTypes: true });
    const destination = path.join(path.dirname(targetPath), name);
    try {
      const destinationInfo = await fs.lstat(destination);
      if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error(`图片资源目录不可用：${name}。请另选保存位置。`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const sourceFile = path.join(source, entry.name);
      await fs.mkdir(destination, { recursive: true });
      const destinationFile = path.join(destination, entry.name);
      await copyImage(sourceFile, destinationFile);
    }
  }
}

class ExternalChangeError extends Error {
  constructor(filePath) {
    super('文件已被其他程序修改。');
    this.name = 'ExternalChangeError';
    this.code = 'EXTERNAL_CHANGE';
    this.filePath = filePath;
  }
}

class DocumentStore {
  constructor({ encodingMemoryPath = null } = {}) {
    if (encodingMemoryPath !== null && (typeof encodingMemoryPath !== 'string' || !path.isAbsolute(encodingMemoryPath))) throw new TypeError('编码记忆文件路径无效。');
    this.encodingMemoryPath = encodingMemoryPath;
    this.encodingMemoryEntries = new Map();
    this.encodingMemoryLoaded = false;
    this.encodingMemoryQueue = Promise.resolve();
    this.encodingMemoryWarning = '';
    this.reset();
  }

  async loadEncodingMemory() {
    if (this.encodingMemoryLoaded || !this.encodingMemoryPath) return;
    this.encodingMemoryLoaded = true;
    try {
      const stat = await fs.stat(this.encodingMemoryPath);
      if (!stat.isFile() || stat.size > MAX_ENCODING_MEMORY_BYTES) throw new Error('编码记忆文件无效或过大。');
      const stored = JSON.parse(await fs.readFile(this.encodingMemoryPath, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.entries) || stored.entries.length > MAX_ENCODING_MEMORY_ENTRIES) throw new Error('编码记忆格式无效。');
      const entries = [];
      for (const entry of stored.entries) {
        if (!entry || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key) || !Number.isSafeInteger(entry.usedAt) || entry.usedAt < 0) throw new Error('编码记忆条目无效。');
        entries.push([entry.key, { encoding: normalizeEncoding(entry.encoding), usedAt: entry.usedAt }]);
      }
      this.encodingMemoryEntries = new Map(entries.sort((a, b) => a[1].usedAt - b[1].usedAt));
    } catch (error) {
      if (error.code !== 'ENOENT') this.encodingMemoryWarning = '编码记忆无法读取，已使用自动检测；可重新选择并确认编码。';
    }
  }

  async encodingMemoryKey(filePath) {
    const canonical = await fs.realpath(filePath);
    return digest(process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical);
  }

  rememberEncoding(filePath, encoding) {
    if (!this.encodingMemoryPath || !filePath) return Promise.resolve();
    const selected = normalizeEncoding(encoding);
    const write = this.encodingMemoryQueue.then(async () => {
      await this.loadEncodingMemory();
      const key = await this.encodingMemoryKey(filePath);
      this.encodingMemoryEntries.delete(key);
      this.encodingMemoryEntries.set(key, { encoding: selected, usedAt: Date.now() });
      while (this.encodingMemoryEntries.size > MAX_ENCODING_MEMORY_ENTRIES) this.encodingMemoryEntries.delete(this.encodingMemoryEntries.keys().next().value);
      const entries = [...this.encodingMemoryEntries].map(([entryKey, entry]) => ({ key: entryKey, ...entry }));
      await fs.mkdir(path.dirname(this.encodingMemoryPath), { recursive: true });
      await atomicWrite(this.encodingMemoryPath, Buffer.from(JSON.stringify({ version: 1, entries }) + '\n'));
      this.encodingMemoryWarning = '';
    });
    this.encodingMemoryQueue = write.catch(() => { this.encodingMemoryWarning = '编码选择已用于当前文档，但无法写入编码记忆；下次打开时请重新确认。'; });
    return this.encodingMemoryQueue;
  }

  async flushEncodingMemory() { await this.encodingMemoryQueue; }

  reset() {
    this.documentId = crypto.randomUUID();
    this.filePath = null;
    this.assetSourcePath = null;
    this.originalBytes = Buffer.alloc(0);
    this.originalContent = '';
    this.bom = false;
    this.encoding = 'utf-8'; this.originalEncoding = 'utf-8'; this.originalBom = false; this.encodingGuessed = false; this.originalEncodingGuessed = false; this.encodingWarning = ''; this.encodingConfirmed = false; this.encodingRemembered = false;
    this.eol = '\n';
    return this.payload('');
  }

  payload(content) {
    return {
      path: this.filePath,
      documentId: this.documentId,
      name: this.filePath ? path.basename(this.filePath) : '未命名.md',
      content,
      baseUrl: baseUrlFor(this.filePath || this.assetSourcePath),
      encoding: labelFor(this.encoding, this.bom),
      encodingId: this.encoding, encodingGuessed: this.encodingGuessed, encodingWarning: this.encodingWarning || this.encodingMemoryWarning, encodingRemembered: this.encodingRemembered, availableEncodings: ENCODINGS,
      eol: this.eol === '\r\n' ? 'CRLF' : this.eol === '\r' ? 'CR' : 'LF',
    };
  }

  async open(filePath, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('需要绝对文件路径。');
    const info = await fs.stat(filePath);
    if (!info.isFile()) throw new Error('请选择普通 Markdown 文档文件。');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error('文件超过 32 MB，请拆分后编辑。');
    const bytes = await fs.readFile(filePath);
    await this.encodingMemoryQueue;
    await this.loadEncodingMemory();
    const selected = normalizeEncoding(options.encoding ?? 'auto', true);
    const remembered = selected === 'auto' && !bomInfo(bytes) && this.encodingMemoryPath ? this.encodingMemoryEntries.get(await this.encodingMemoryKey(filePath))?.encoding : null;
    const decoded = decodeMarkdown(bytes, { ...options, encoding: remembered || selected });
    this.documentId = crypto.randomUUID();
    this.filePath = filePath;
    this.assetSourcePath = null;
    this.originalBytes = bytes;
    this.originalContent = decoded.content;
    this.bom = decoded.bom; this.originalBom = decoded.bom;
    this.encoding = decoded.encoding; this.originalEncoding = decoded.encoding; this.encodingGuessed = decoded.encodingGuessed; this.originalEncodingGuessed = decoded.encodingGuessed; this.encodingWarning = decoded.warning;
    this.encodingRemembered = !!remembered;
    this.encodingConfirmed = selected !== 'auto' && options.rememberEncoding !== false || !!remembered;
    this.eol = decoded.eol;
    if (this.encodingConfirmed) await this.rememberEncoding(filePath, this.encoding);
    return this.payload(decoded.content);
  }

  recover(content, originalPath = null) {
    this.reset();
    if (originalPath && (typeof originalPath !== 'string' || !path.isAbsolute(originalPath))) throw new Error('原始文档路径无效。');
    this.assetSourcePath = originalPath;
    const normalized = normalizeLineEndings(content);
    encodeMarkdown(normalized); // Validate size before returning recovery data.
    return { ...this.payload(normalized), originalPath, name: originalPath ? `${path.basename(originalPath)}（恢复副本）` : '恢复的草稿.md' };
  }

  async hasExternalChange() {
    if (!this.filePath) return false;
    try { return digest(await fs.readFile(this.filePath)) !== digest(this.originalBytes); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }

  async save(content, targetPath = this.filePath, { overwriteConflict = false } = {}) {
    await this.encodingMemoryQueue;
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) throw new TypeError('需要绝对保存路径。');
    const samePath = this.filePath === targetPath;
    if (samePath && !overwriteConflict && await this.hasExternalChange()) throw new ExternalChangeError(targetPath);
    // A no-op save must preserve all original bytes, including mixed line endings.
    let normalized = normalizeLineEndings(content);
    normalized = await relocateRelativeImages(normalized, this.filePath || this.assetSourcePath, targetPath);
    if (this.encodingGuessed && normalized !== this.originalContent) {
      const error = new Error('文件编码为推测结果，请先确认或选择编码，再保存修改。'); error.code = 'ENCODING_CONFIRMATION'; throw error;
    }
    const bytes = samePath && normalized === this.originalContent && this.encoding === this.originalEncoding && this.bom === this.originalBom
      ? this.originalBytes
      : encodeMarkdown(normalized, this);
    await relocateManagedAssets(normalized, this.filePath || this.assetSourcePath, targetPath);
    await atomicWrite(targetPath, bytes);
    this.filePath = targetPath;
    this.assetSourcePath = null;
    this.originalBytes = bytes;
    this.originalContent = normalized;
    this.originalEncoding = this.encoding; this.originalBom = this.bom; this.originalEncodingGuessed = this.encodingGuessed;
    if (this.encodingConfirmed) await this.rememberEncoding(targetPath, this.encoding);
    return { ...this.payload(normalized), saved: true };
  }

  setEncoding(encoding, options = {}) {
    this.encoding = normalizeEncoding(encoding);
    const bom = options.bom ?? this.encoding.startsWith('utf-16');
    this.bom = this.encoding.startsWith('utf-') && bom === true;
    this.encodingGuessed = false; this.encodingWarning = ''; this.encodingConfirmed = true; this.encodingRemembered = false;
    return this.payload(this.originalContent);
  }

  async confirmEncoding() {
    this.encodingGuessed = false; this.encodingWarning = ''; this.encodingConfirmed = true;
    if (this.encoding === this.originalEncoding) this.originalEncodingGuessed = false;
    await this.rememberEncoding(this.filePath, this.encoding);
    return this.payload(this.originalContent);
  }

  async addImage(image, policy = {}) { return copyImageToDocument(image, this.filePath, policy); }
}

module.exports = {
  DocumentStore, ExternalChangeError, MAX_DOCUMENT_BYTES, MAX_ENCODING_MEMORY_ENTRIES, IMAGE_EXTENSIONS,
  atomicWrite, baseUrlFor, decodeMarkdown, encodeMarkdown, normalizeLineEndings,
  relocateManagedAssets,
};
