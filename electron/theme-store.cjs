'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../src/color-theme-config.js');

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function payload(raw, allowContent) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('主题操作需要键值对象。');
  const allowed = allowContent ? ['fileName', 'content', 'expectedHash'] : ['fileName', 'expectedHash'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new TypeError('主题操作包含未知选项。');
  config.fileName(raw.fileName);
  if (allowContent && typeof raw.content !== 'string') throw new TypeError('主题内容需要文本。');
  if (raw.expectedHash !== undefined && raw.expectedHash !== null && !/^[a-f0-9]{64}$/.test(raw.expectedHash)) throw new TypeError('主题版本标识无效。');
  return raw;
}
class ThemeStore {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('ThemeStore requires an absolute application themes directory.');
    this.directory = path.resolve(directory);
    this.queue = Promise.resolve(); this.listeners = new Set(); this.watcher = null; this.timer = null; this.disposed = false;
  }
  serial(action) {
    const next = this.queue.then(() => { if (this.disposed) throw new Error('主题目录已关闭。'); return action(); });
    this.queue = next.catch(() => {}); return next;
  }
  async ensureDirectory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('主题目录必须是应用目录内的真实文件夹。');
  }
  async readFile(filename) {
    const target = path.join(this.directory, config.fileName(filename));
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('主题必须为普通文件，不支持符号链接或硬链接。');
    if (stat.size > config.maximumBytes) throw new Error('主题文件超过 64 KiB。');
    const handle = await fs.open(target, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > config.maximumBytes || opened.nlink > 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('主题文件在读取时变化，请重试。');
      const buffer = Buffer.alloc(config.maximumBytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > config.maximumBytes) throw new Error('主题文件超过 64 KiB。');
      const bytes = buffer.subarray(0, length);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { content, hash: digest(content) };
    } finally { await handle.close(); }
  }
  async snapshot() {
    await this.ensureDirectory();
    const entries = (await fs.readdir(this.directory, { withFileTypes: true })).filter(entry => /^[^.].*\.toml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    const themes = [], errors = [];
    if (entries.length > 128) errors.push({ fileName: '', message: '主题文件超过 128 个，仅读取前 128 个。' });
    for (const entry of entries.slice(0, 128)) {
      let loaded = null;
      try {
        config.fileName(entry.name);
        loaded = await this.readFile(entry.name);
        themes.push({ ...config.parse(loaded.content, entry.name), hash: loaded.hash });
      } catch (error) { errors.push({ fileName: entry.name, message: error.message, ...(loaded ? loaded : {}) }); }
    }
    return { directory: this.directory, themes, errors, updatedAt: new Date().toISOString() };
  }
  get() { return this.serial(() => this.snapshot()); }
  notify(snapshot) {
    for (const listener of this.listeners) { try { const pending = listener(snapshot); pending?.catch?.(() => {}); } catch (_) { /* A renderer observer cannot stop theme delivery. */ } }
  }
  async checkVersion(filename, expectedHash, requireAbsent = false) {
    let existing;
    try { existing = await this.readFile(filename); }
    catch (error) { if (error.code === 'ENOENT') { if (expectedHash) throw new Error('主题文件已被删除，请重新载入。'); return; } throw error; }
    if (requireAbsent || expectedHash === null) throw new Error('同名主题文件已存在，请选择该文件编辑或换一个文件名。');
    if (!expectedHash || existing.hash !== expectedHash) throw new Error('主题文件已在外部修改，请重新载入后再保存。');
  }
  save(raw) {
    const options = payload(raw, true);
    config.parse(options.content, options.fileName);
    return this.serial(async () => {
      await this.ensureDirectory();
      await this.checkVersion(options.fileName, options.expectedHash, options.expectedHash === undefined);
      const temporary = path.join(this.directory, `.${options.fileName}.${crypto.randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(options.content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temporary, path.join(this.directory, options.fileName));
      } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      const snapshot = await this.snapshot(); this.notify(snapshot); return snapshot;
    });
  }
  remove(raw) {
    const options = payload(raw, false);
    return this.serial(async () => {
      await this.ensureDirectory();
      await this.checkVersion(options.fileName, options.expectedHash);
      await fs.unlink(path.join(this.directory, options.fileName));
      const snapshot = await this.snapshot(); this.notify(snapshot); return snapshot;
    });
  }
  watch(listener) {
    if (typeof listener !== 'function') throw new TypeError('主题监听器需要函数。');
    this.listeners.add(listener);
    this.ensureDirectory().then(() => {
      if (this.disposed || this.watcher) return;
      this.watcher = nativeFs.watch(this.directory, { persistent: false }, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.get().then(snapshot => this.notify(snapshot), error => this.notify({ directory: this.directory, themes: [], errors: [{ fileName: '', message: error.message }], updatedAt: new Date().toISOString() }));
        }, 100);
        this.timer.unref?.();
      });
      this.watcher.on('error', error => this.notify({ directory: this.directory, themes: [], errors: [{ fileName: '', message: error.message }], updatedAt: new Date().toISOString() }));
    }).catch(error => this.notify({ directory: this.directory, themes: [], errors: [{ fileName: '', message: error.message }], updatedAt: new Date().toISOString() }));
    return () => this.listeners.delete(listener);
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); this.timer = null;
    this.watcher?.close(); this.watcher = null; this.listeners.clear();
  }
}
module.exports = { ThemeStore };
