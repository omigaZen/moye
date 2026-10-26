'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');

const DEFAULT_MAX_ENTRIES = 40, MAX_ENTRIES = 100, MAX_STATE_BYTES = 256 * 1024;
const ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const canonicalKey = filename => process.platform === 'win32' ? filename.toLocaleLowerCase('en-US') : filename;
const validPath = filename => typeof filename === 'string' && filename.length > 0 && filename.length <= 32768 && !filename.includes('\0') && path.isAbsolute(filename);

// Only main-process code may remember a path, after a successful user-authorized
// open/save. Renderer operations consume this store's opaque IDs, never paths.
class RecentFilesStore {
  constructor({ filePath, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    if (!validPath(filePath)) throw new TypeError('最近文件存储需要绝对路径。');
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) throw new TypeError('最近文件数量必须在 1—100 之间。');
    this.filePath = filePath; this.maxEntries = maxEntries; this.entries = [];
    this.revision = 0; this.warnings = []; this.initialization = null; this.queue = Promise.resolve();
  }

  initialize() {
    if (!this.initialization) this.initialization = (async () => {
      try {
        const info = await fs.lstat(this.filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('Invalid recent-files store');
        const saved = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (!saved || saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES) throw new Error('Invalid recent-files schema');
        const paths = new Set(), ids = new Set();
        const sorted = saved.entries.filter(entry => entry && Object.getPrototypeOf(entry) === Object.prototype
          && typeof entry.id === 'string' && ID.test(entry.id) && validPath(entry.path) && Number.isSafeInteger(entry.lastOpened) && entry.lastOpened >= 0 && entry.lastOpened <= 8640000000000000)
          .sort((a, b) => b.lastOpened - a.lastOpened);
        for (const entry of sorted) {
          const key = canonicalKey(entry.path);
          if (paths.has(key) || ids.has(entry.id)) continue;
          paths.add(key); ids.add(entry.id);
          this.entries.push({ id: entry.id, path: entry.path, lastOpened: entry.lastOpened });
          if (this.entries.length >= this.maxEntries) break;
        }
        if (sorted.length !== saved.entries.length) this.warnings = ['部分最近文件记录无效，已忽略；文档文件未改动。'];
      } catch (error) {
        if (error.code !== 'ENOENT') this.warnings = ['最近文件记录无法读取，已使用空列表；文档文件未改动。'];
      }
    })();
    return this.initialization;
  }

  init() { return this.initialize(); }
  serialize(operation) {
    const next = this.queue.then(async () => { await this.initialize(); return operation(); });
    this.queue = next.catch(() => {}); return next;
  }

  async inspect(entry) {
    try {
      const real = await fs.realpath(entry.path);
      // A retained name must not become a new filesystem capability when a
      // directory or file is replaced with a symlink to another target.
      if (canonicalKey(real) !== canonicalKey(entry.path)) return { available: false, reason: 'changed-target' };
      const info = await fs.stat(real);
      if (!info.isFile()) return { available: false, reason: 'not-file' };
      if (info.size > MAX_DOCUMENT_BYTES) return { available: false, reason: 'too-large' };
      await fs.access(real, fs.constants.R_OK);
      return { available: true, reason: null, real };
    } catch (error) {
      return { available: false, reason: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : ['EACCES', 'EPERM'].includes(error.code) ? 'permission' : 'unavailable' };
    }
  }

  async snapshot() {
    const entries = await Promise.all(this.entries.map(async entry => {
      const { available, reason } = await this.inspect(entry);
      return { id: entry.id, name: path.basename(entry.path), path: entry.path, lastOpened: entry.lastOpened, available, reason };
    }));
    return { entries, revision: this.revision, maxEntries: this.maxEntries, warnings: [...this.warnings] };
  }

  list() { return this.serialize(() => this.snapshot()); }

  async commit(entries) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, entries }) + '\n');
    if (bytes.length > MAX_STATE_BYTES) throw new Error('最近文件记录过大，请先移除部分记录。');
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await atomicWrite(this.filePath, bytes);
    // A failed write leaves the in-memory capabilities and ordering untouched.
    this.entries = entries; this.revision++; this.warnings = [];
  }

  remember(filename, { preview = false } = {}) {
    if (typeof preview !== 'boolean') return Promise.reject(new TypeError('最近文件预览参数无效。'));
    if (!validPath(filename)) return Promise.reject(new TypeError('最近文件需要已授权的绝对路径。'));
    return this.serialize(async () => {
      if (preview) return { recorded: false, reason: 'preview' };
      const real = await fs.realpath(filename), info = await fs.stat(real);
      if (!info.isFile()) throw new Error('最近文件必须是普通文件。');
      const key = canonicalKey(real), previous = this.entries.find(entry => canonicalKey(entry.path) === key);
      const timestamp = Math.max(Date.now(), (this.entries[0]?.lastOpened || 0) + 1);
      const entry = { id: previous?.id || crypto.randomUUID(), path: real, lastOpened: timestamp };
      const retained = this.entries.filter(item => canonicalKey(item.path) !== key);
      await this.commit([entry, ...retained].slice(0, this.maxEntries));
      return { recorded: true, id: entry.id, revision: this.revision };
    });
  }

  checked(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('最近文件记录已失效，请重新打开最近文件列表。');
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error('最近文件记录已失效，请重新打开最近文件列表。');
    return entry;
  }

  resolve(id) {
    return this.serialize(async () => {
      const entry = this.checked(id), result = await this.inspect(entry);
      if (!result.available) {
        const messages = { missing: '文件已被移动或删除，可移除此记录。', 'changed-target': '文件链接目标已改变，请通过打开文件重新选择。', 'too-large': '文件超过 32 MB，请拆分后编辑。', 'not-file': '原文档已不再是普通文件，可移除此记录。', permission: '没有读取此文件的权限，请通过打开文件重新选择。' };
        const error = new Error(messages[result.reason] || '文件暂时不可用，请通过打开文件重新选择。');
        error.code = 'RECENT_FILE_UNAVAILABLE'; error.reason = result.reason; throw error;
      }
      return result.real;
    });
  }

  remove(id) {
    return this.serialize(async () => {
      this.checked(id); await this.commit(this.entries.filter(entry => entry.id !== id));
      return this.snapshot();
    });
  }

  clear() { return this.serialize(async () => { await this.commit([]); return this.snapshot(); }); }
}

module.exports = { RecentFilesStore, DEFAULT_MAX_ENTRIES, MAX_ENTRIES, MAX_STATE_BYTES };
