'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite, MAX_DOCUMENT_BYTES } = require('./file-store.cjs');

function validSnapshot(value) {
  return value && value.version === 1 && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= MAX_DOCUMENT_BYTES;
}

// Current-session autosaves and unresolved previous-session recoveries have
// separate identities. Editing a new document never overwrites a recovery the
// user has not yet chosen to restore or discard.
class RecoveryStore {
  constructor(directory) {
    this.directory = directory;
    this.currentPath = path.join(directory, 'recovery-draft.json');
    this.pendingDirectory = path.join(directory, 'pending-recoveries');
    this.queue = Promise.resolve();
    this.initialization = null;
    this.selectedId = null;
  }

  initialize() {
    if (!this.initialization) this.initialization = (async () => {
      await fs.mkdir(this.pendingDirectory, { recursive: true, mode: 0o700 });
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.json`;
      try { await fs.rename(this.currentPath, path.join(this.pendingDirectory, filename)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    })();
    return this.initialization;
  }

  serialize(operation) {
    const next = this.queue.then(async () => { await this.initialize(); return operation(); });
    this.queue = next.catch(() => {});
    return next;
  }

  async readPending(id) {
    if (typeof id !== 'string' || !/^\d+-[a-f0-9]{16}\.json$/.test(id)) return null;
    try {
      const filename = path.join(this.pendingDirectory, id);
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DOCUMENT_BYTES * 7) return null;
      const snapshot = JSON.parse(await fs.readFile(filename, 'utf8'));
      return validSnapshot(snapshot) ? { ...snapshot, recoveryId: id } : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  getPending() {
    return this.serialize(async () => {
      if (this.selectedId) {
        const selected = await this.readPending(this.selectedId);
        if (selected) return selected;
      }
      const names = (await fs.readdir(this.pendingDirectory)).filter(name => /^\d+-[a-f0-9]{16}\.json$/.test(name)).sort().reverse();
      for (const name of names) {
        const snapshot = await this.readPending(name);
        if (snapshot) { this.selectedId = name; return snapshot; }
      }
      this.selectedId = null;
      return null;
    });
  }

  stash(snapshot, isCurrent = () => true) {
    if (!validSnapshot(snapshot)) return Promise.reject(new Error('草稿内容无效。'));
    const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
    return this.serialize(async () => {
      if (!isCurrent()) return { stashed: false, reason: 'stale-document' };
      await atomicWrite(this.currentPath, bytes);
      return { stashed: true };
    });
  }

  clearCurrent() {
    return this.serialize(() => fs.unlink(this.currentPath).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  }

  consumePending(id, restoredSnapshot) {
    if (!validSnapshot(restoredSnapshot)) return Promise.reject(new Error('恢复内容无效。'));
    return this.serialize(async () => {
      if (!await this.readPending(id)) throw new Error('恢复草稿已不存在，请重新启动编辑器检查。');
      // The recovery remains durable until its current-session replacement has
      // been atomically written. A crash between the two leaves two safe copies.
      await atomicWrite(this.currentPath, Buffer.from(JSON.stringify(restoredSnapshot), 'utf8'));
      await fs.unlink(path.join(this.pendingDirectory, id));
      if (this.selectedId === id) this.selectedId = null;
      return { restored: true };
    });
  }

  discardPending() {
    return this.getPending().then(snapshot => {
      if (!snapshot) return { discarded: false };
      return this.serialize(async () => {
        await fs.unlink(path.join(this.pendingDirectory, snapshot.recoveryId)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (this.selectedId === snapshot.recoveryId) this.selectedId = null;
        return { discarded: true };
      });
    });
  }
}

module.exports = { RecoveryStore };
