'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./file-store.cjs');
const schema = require('../src/settings-schema.js');

const MAX_SETTINGS_BYTES = 64 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseSettings(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('设置文件超过 64 KB 或内容无效。');
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('设置文件不是有效 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设置文件格式无效。');
  if (parsed.schemaVersion !== schema.schemaVersion) throw new Error('不支持此设置文件版本。');
  if (parsed.revision !== undefined && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) throw new Error('设置版本号无效。');
  const permitted = new Set(['schemaVersion', 'revision', 'values']);
  if (Object.keys(parsed).some(key => !permitted.has(key))) throw new Error('设置文件包含未知字段。');
  return { schemaVersion: schema.schemaVersion, revision: parsed.revision || 0, values: schema.normalize(parsed.values) };
}

class SettingsConflictError extends Error {
  constructor() { super('设置已被更新，请刷新后重试。'); this.name = 'SettingsConflictError'; this.code = 'SETTINGS_CONFLICT'; }
}
class SettingsExternalEditError extends Error {
  constructor(message) { super(message); this.name = 'SettingsExternalEditError'; this.code = 'SETTINGS_EXTERNAL_INVALID'; }
}

class SettingsStore {
  constructor(directory, { write = atomicWrite } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('需要绝对设置目录。');
    this.directory = directory;
    this.filePath = path.join(directory, 'settings.json');
    this.write = write;
    this.values = { ...schema.defaults };
    this.revision = 0;
    this.warnings = [];
    this.queue = Promise.resolve();
    this.initializing = null;
    this.diskHash = null;
    this.externalError = null;
    this.listeners = new Set(); this.watcher = null; this.watchTimer = null; this.disposed = false;
  }

  initialize() {
    if (this.disposed) return Promise.reject(new Error('设置目录已关闭。'));
    if (!this.initializing) this.initializing = this.load();
    return this.initializing;
  }

  async readDisk() {
    let info;
    try { info = await fs.lstat(this.filePath); } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
    const invalid = message => { const error = new Error(message); error.code = 'SETTINGS_FILE_INVALID'; return error; };
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MAX_SETTINGS_BYTES) throw invalid('设置文件类型或大小无效。');
    const file = await fs.open(this.filePath, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.size > MAX_SETTINGS_BYTES || opened.ino !== info.ino || opened.dev !== info.dev) throw invalid('设置文件在读取时变化，请重试。');
      // Keep the actual read bounded even if an external writer grows the file
      // between stat and read. The extra byte detects the size limit.
      const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_SETTINGS_BYTES) throw invalid('设置文件超过 64 KB。');
      const bytes = buffer.subarray(0, length);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (_) { throw invalid('设置文件需要有效 UTF-8 文本。'); }
      return { exists: true, text, hash: hash(bytes) };
    } finally { await file.close(); }
  }

  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const disk = await this.readDisk();
      if (!disk.exists) return this.snapshot();
      const parsed = parseSettings(disk.text);
      this.values = parsed.values; this.revision = parsed.revision; this.diskHash = disk.hash;
    } catch (error) {
      // Quarantine is limited to initial startup, before any live session has
      // adopted settings. Runtime reload never renames a work-in-progress file.
      if (error.code && error.code !== 'SETTINGS_FILE_INVALID') throw error;
      const quarantine = path.join(this.directory, `settings.invalid-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
      await fs.rename(this.filePath, quarantine);
      this.warnings.push(`设置文件无效，已保留为 ${path.basename(quarantine)}，本次使用应用默认值。${error.message}`);
    }
    return this.snapshot();
  }

  snapshot() { return { schemaVersion: schema.schemaVersion, revision: this.revision, values: { ...this.values }, warnings: [...this.warnings], ...(this.externalError ? { externalError: this.externalError } : {}) }; }

  serialize(operation) {
    const run = () => { if (this.disposed) throw new Error('设置目录已关闭。'); return operation(); };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  checkRevision(expectedRevision) {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('设置版本号无效。');
    if (expectedRevision !== this.revision) throw new SettingsConflictError();
  }
  advanceRevision() {
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('设置版本号已超出范围。');
    this.revision++;
  }
  notify() {
    for (const listener of this.listeners) { try { const pending = listener(this.snapshot()); pending?.catch?.(() => {}); } catch (_) { /* One observer cannot stop delivery. */ } }
  }
  queueExternalError(error) { this.serialize(() => this.reportExternalError(error)).catch(() => {}); }
  reportExternalError(error) {
    const message = `外部设置文件暂未载入，继续使用上次有效设置。${error.message}`;
    if (this.externalError !== message) {
      this.advanceRevision(); this.externalError = message; this.warnings = [message]; this.notify();
    }
  }
  async refreshDisk() {
    try {
      const disk = await this.readDisk();
      if (!disk.exists) {
        if (this.diskHash !== null) throw new Error('设置文件暂时不存在，请等待外部编辑器保存或重新打开配置文件。');
        return this.snapshot();
      }
      if (disk.hash === this.diskHash && !this.externalError) return this.snapshot();
      const parsed = parseSettings(disk.text);
      const changed = Object.keys(parsed.values).some(key => !Object.is(parsed.values[key], this.values[key]));
      const diagnosticsChanged = Boolean(this.externalError) || this.warnings.length > 0;
      if (changed || diagnosticsChanged) this.advanceRevision();
      this.values = parsed.values; this.diskHash = disk.hash; this.externalError = null; this.warnings = [];
      if (changed || diagnosticsChanged) this.notify();
    } catch (error) { this.reportExternalError(error); }
    return this.snapshot();
  }
  async preflight() {
    await this.refreshDisk();
    if (this.externalError) throw new SettingsExternalEditError(this.externalError);
  }

  async get() { await this.initialize(); return this.snapshot(); }

  reload({ throwOnInvalid = false } = {}) {
    return this.serialize(async () => {
      await this.initialize();
      const snapshot = await this.refreshDisk();
      if (throwOnInvalid && this.externalError) throw new SettingsExternalEditError(this.externalError);
      return snapshot;
    });
  }

  ensureFile() {
    return this.serialize(async () => {
      await this.initialize();
      let info;
      try { info = await fs.lstat(this.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info) {
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('配置文件必须为普通文件。');
        // Existing invalid JSON must remain openable so the user can fix it.
        return this.snapshot();
      }
      const clearDiagnostics = Boolean(this.externalError) || this.warnings.length > 0;
      const revision = this.revision + (clearDiagnostics ? 1 : 0);
      if (!Number.isSafeInteger(revision)) throw new Error('设置版本号已超出范围。');
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: schema.schemaVersion, revision, values: this.values }, null, 2) + '\n');
      if (bytes.length > MAX_SETTINGS_BYTES) throw new Error('设置文件超过 64 KB。');
      await this.write(this.filePath, bytes);
      this.diskHash = hash(bytes); this.revision = revision; this.externalError = null; this.warnings = [];
      if (clearDiagnostics) this.notify();
      return this.snapshot();
    });
  }

  update(patch, { expectedRevision } = {}) {
    // Validate and clone before queuing. Caller changes or getters cannot alter
    // a later write, and invalid multi-key updates have no partial effect.
    const validated = schema.validatePatch(patch);
    return this.serialize(async () => {
      await this.initialize(); await this.preflight();
      this.checkRevision(expectedRevision);
      const next = { ...this.values, ...validated };
      if (Object.keys(next).every(key => Object.is(next[key], this.values[key]))) return this.snapshot();
      return this.commit(next);
    });
  }

  reset({ expectedRevision } = {}) {
    return this.serialize(async () => {
      await this.initialize(); await this.preflight();
      this.checkRevision(expectedRevision);
      return this.commit({ ...schema.defaults });
    });
  }

  import(text, { expectedRevision } = {}) {
    const parsed = parseSettings(text);
    return this.serialize(async () => {
      await this.initialize(); await this.preflight();
      this.checkRevision(expectedRevision);
      return this.commit(parsed.values);
    });
  }

  async export() {
    await this.initialize();
    return JSON.stringify({ schemaVersion: schema.schemaVersion, revision: this.revision, values: this.values }, null, 2) + '\n';
  }

  async commit(values) {
    if (this.revision >= Number.MAX_SAFE_INTEGER) throw new Error('设置版本号已超出范围。');
    const revision = this.revision + 1;
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: schema.schemaVersion, revision, values }, null, 2) + '\n');
    if (bytes.length > MAX_SETTINGS_BYTES) throw new Error('设置文件超过 64 KB。');
    await this.write(this.filePath, bytes);
    // Publication follows the durable write; an I/O failure leaves all current
    // values and revision unchanged.
    this.values = { ...values }; this.revision = revision; this.diskHash = hash(bytes);
    this.warnings = []; this.externalError = null;
    return this.snapshot();
  }

  watch(listener) {
    if (typeof listener !== 'function') throw new TypeError('设置监听器需要函数。');
    this.listeners.add(listener);
    this.initialize().then(() => {
      if (this.disposed || this.watcher || !this.listeners.size) return;
      this.watcher = nativeFs.watch(this.directory, { persistent: false }, (_event, filename) => {
        if (filename && filename.toString() !== 'settings.json') return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => { this.watchTimer = null; this.reload().catch(error => { if (!this.disposed) this.queueExternalError(error); }); }, 120);
        this.watchTimer.unref?.();
      });
      this.watcher.on('error', error => { if (!this.disposed) this.queueExternalError(error); });
    }).catch(error => { if (!this.disposed) this.queueExternalError(error); });
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { clearTimeout(this.watchTimer); this.watchTimer = null; this.watcher?.close(); this.watcher = null; }
    };
  }
  dispose() {
    this.disposed = true; clearTimeout(this.watchTimer); this.watchTimer = null;
    this.watcher?.close(); this.watcher = null; this.listeners.clear();
  }
}

module.exports = { SettingsStore, SettingsConflictError, SettingsExternalEditError, parseSettings, MAX_SETTINGS_BYTES };
