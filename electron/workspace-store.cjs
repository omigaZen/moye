'use strict';
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const MAX_ENTRIES = 2000, MAX_CAPABILITIES = 20000, MAX_BYTES = 32 * 1024 * 1024;
function isInside(root, target) { const relative = path.relative(root, target); return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
function fileKind(filename) { return path.extname(filename).toLowerCase() === '.txt' ? 'text' : 'markdown'; }
class WorkspaceStore {
  constructor() { this.close(); }
  close() { this.stopWatch?.(); this.stopWatch = null; this.rootPath = null; this.rootId = null; this.entries = new Map(); this.ids = new Map(); this.revision = 0; }
  capability(relativePath, kind, realPath) {
    const existing = this.ids.get(relativePath);
    if (existing) { const item = this.entries.get(existing); if (item?.kind === kind) { item.realPath = realPath; return item; } }
    if (this.entries.size >= MAX_CAPABILITIES) throw new Error('工作区文件过多，请选择更小的目录。');
    const item = { id: crypto.randomUUID(), name: relativePath ? path.basename(relativePath) : path.basename(this.rootPath), relativePath, kind, realPath };
    this.entries.set(item.id, item); this.ids.set(relativePath, item.id); return item;
  }
  publicEntry(item) { return { id: item.id, name: item.name, relativePath: item.relativePath, kind: item.kind, fileKind: item.kind === 'file' ? fileKind(item.name) : undefined }; }
  async chooseRoot(absolutePath) {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) throw new TypeError('需要绝对工作区目录。');
    const real = await fs.realpath(absolutePath); const info = await fs.stat(real);
    if (!info.isDirectory()) throw new Error('请选择工作区文件夹。');
    this.close(); this.rootPath = real; const root = this.capability('', 'directory', real); this.rootId = root.id;
    return this.list(root.id);
  }
  async checked(id, kind) {
    if (!this.rootPath || typeof id !== 'string' || !this.entries.has(id)) throw new Error('工作区条目已失效，请重新打开文件夹。');
    const item = this.entries.get(id), rootPath = this.rootPath, rootId = this.rootId;
    if (kind && item.kind !== kind) throw new Error('工作区条目类型不匹配。');
    const lexical = path.resolve(rootPath, item.relativePath);
    if (!isInside(rootPath, lexical)) throw new Error('工作区路径越界。');
    const real = await fs.realpath(lexical);
    if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
    if (!isInside(rootPath, real)) throw new Error('链接指向工作区外部，请通过打开文件选择器明确选择。');
    const info = await fs.stat(real);
    if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
    if (item.kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error('工作区条目已改变类型。');
    item.realPath = real; return { item, real, info };
  }
  async list(directoryId = this.rootId) {
    const { item, real } = await this.checked(directoryId, 'directory');
    const rootPath = this.rootPath, rootId = this.rootId;
    const raw = await fs.readdir(real, { withFileTypes: true });
    const visible = [], skipped = []; let truncated = false;
    for (const entry of raw.sort((a, b) => collator.compare(a.name, b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (visible.length >= MAX_ENTRIES) { truncated = true; break; }
      const relative = path.join(item.relativePath, entry.name);
      const lexical = path.join(rootPath, relative);
      try {
        const target = await fs.realpath(lexical);
        if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
        if (!isInside(rootPath, target)) { skipped.push({ name: entry.name, reason: 'outside-workspace' }); continue; }
        const info = await fs.stat(target);
        const kind = info.isDirectory() ? 'directory' : info.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ? 'file' : null;
        if (!kind) continue;
        if (kind === 'directory' && (target === real || isInside(target, real))) { skipped.push({ name: entry.name, reason: 'directory-cycle' }); continue; }
        if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
        visible.push(this.publicEntry(this.capability(relative, kind, target)));
      } catch (error) { skipped.push({ name: entry.name, reason: error.code || 'unavailable' }); }
    }
    if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
    visible.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || collator.compare(a.name, b.name));
    return { rootId: this.rootId, id: item.id, name: item.name, relativePath: item.relativePath, entries: visible, skipped, truncated, revision: this.revision };
  }
  async search(query) {
    if (typeof query !== 'string' || query.length > 200) throw new TypeError('工作区搜索文字无效。');
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.list();
    const root = await this.checked(this.rootId, 'directory');
    const rootPath = this.rootPath, rootId = this.rootId;
    const queue = [{ relative: '', real: root.real }], visited = new Set(), entries = [], skipped = [];
    let truncated = false;
    while (queue.length) {
      if (visited.size >= 3000 || entries.length >= 500) { truncated = true; break; }
      const current = queue.shift();
      if (visited.has(current.real)) continue;
      visited.add(current.real);
      let raw; try { raw = await fs.readdir(current.real, { withFileTypes: true }); } catch (error) { skipped.push({ name: current.relative, reason: error.code || 'unavailable' }); continue; }
      for (const item of raw) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const relative = path.join(current.relative, item.name);
        try {
          const real = await fs.realpath(path.join(rootPath, relative));
          if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
          if (!isInside(rootPath, real)) continue;
          const info = await fs.stat(real);
          if (info.isDirectory()) { if (!visited.has(real)) queue.push({ relative, real }); }
          else if (info.isFile() && DOCUMENT_EXTENSIONS.has(path.extname(item.name).toLowerCase()) && terms.every(term => relative.toLocaleLowerCase().includes(term.replace(/^\./, '')))) {
            if (entries.length >= 500) { truncated = true; break; }
            if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
            entries.push(this.publicEntry(this.capability(relative, 'file', real)));
          }
        } catch (error) { skipped.push({ name: relative, reason: error.code || 'unavailable' }); }
      }
    }
    if (rootId !== this.rootId) throw new Error('工作区已切换，请重新操作。');
    entries.sort((a,b) => collator.compare(a.relativePath,b.relativePath));
    return { rootId: this.rootId, id: this.rootId, name: root.item.name, relativePath: '', entries, skipped, truncated, revision: this.revision, search: query };
  }
  async resolveFile(id) {
    const { item, real, info } = await this.checked(id, 'file');
    if (!DOCUMENT_EXTENSIONS.has(path.extname(item.name).toLowerCase())) throw new Error('不支持的文档格式。');
    if (info.size > MAX_BYTES) throw new Error('文件超过 32 MB，请拆分后编辑。');
    return real;
  }
  async entryForPath(absolutePath) {
    if (!this.rootPath || typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) return null;
    const rootPath = this.rootPath, rootId = this.rootId;
    let real; try { real = await fs.realpath(absolutePath); } catch { return null; }
    if (rootId !== this.rootId || !isInside(rootPath, real) || !DOCUMENT_EXTENSIONS.has(path.extname(real).toLowerCase())) return null;
    if (!(await fs.stat(real)).isFile()) return null;
    if (rootId !== this.rootId) return null;
    return this.publicEntry(this.capability(path.relative(rootPath, real), 'file', real));
  }
  async neighbor(id, direction) {
    if (direction !== -1 && direction !== 1) throw new TypeError('文档方向必须是 -1 或 1。');
    const { item, real } = await this.checked(id, 'file');
    const parentRelative = path.dirname(item.relativePath) === '.' ? '' : path.dirname(item.relativePath);
    const parent = this.capability(parentRelative, 'directory', path.dirname(real));
    const files = (await this.list(parent.id)).entries.filter(entry => entry.kind === 'file' && entry.fileKind === fileKind(item.name));
    const index = files.findIndex(entry => entry.id === id || entry.relativePath === item.relativePath);
    return index < 0 ? null : files[index + direction] || null;
  }
  watch(callback) {
    if (typeof callback !== 'function' || !this.rootPath) throw new TypeError('需要已打开的工作区和回调。');
    this.stopWatch?.(); const rootId = this.rootId; let timer, watcher, closed = false;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => { if (!closed && rootId === this.rootId) callback({ rootId, revision: ++this.revision }); }, 180); timer.unref?.(); };
    try { watcher = nativeFs.watch(this.rootPath, { recursive: true, persistent: false }, changed); }
    catch { watcher = nativeFs.watch(this.rootPath, { persistent: false }, changed); }
    watcher.on('error', changed);
    const stop = () => { closed = true; clearTimeout(timer); watcher.close(); if (this.stopWatch === stop) this.stopWatch = null; };
    this.stopWatch = stop; return stop;
  }
}
module.exports = { WorkspaceStore, DOCUMENT_EXTENSIONS, isInside, fileKind, MAX_ENTRIES, MAX_CAPABILITIES };
