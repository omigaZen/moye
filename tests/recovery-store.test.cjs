'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RecoveryStore } = require('../electron/recovery-store.cjs');

const snapshot = (content, filePath = null) => ({ version: 1, content, path: filePath, updatedAt: new Date().toISOString() });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('new session preserves unresolved old recovery while autosaving a new document', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'recovery-draft.json'), JSON.stringify(snapshot('old unsaved content')));
  const store = new RecoveryStore(directory);
  await store.initialize();
  const pending = await store.getPending();
  assert.equal(pending.content, 'old unsaved content');
  await store.stash(snapshot('new welcome edits'));
  assert.equal((await store.getPending()).content, 'old unsaved content');
  assert.equal(JSON.parse(await fs.readFile(store.currentPath, 'utf8')).content, 'new welcome edits');
});

test('saving or discarding the current document cannot remove an unopened recovery', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'recovery-draft.json'), JSON.stringify(snapshot('old')));
  const store = new RecoveryStore(directory);
  await store.initialize();
  await store.stash(snapshot('current'));
  await store.clearCurrent();
  assert.equal((await store.getPending()).content, 'old');
  await assert.rejects(fs.access(store.currentPath), { code: 'ENOENT' });
});

test('restoring a pending recovery atomically creates a durable current replacement', async t => {
  const directory = await fixture(t);
  const originalPath = path.join(directory, 'original.md');
  await fs.writeFile(path.join(directory, 'recovery-draft.json'), JSON.stringify(snapshot('recovered text', originalPath)));
  const store = new RecoveryStore(directory);
  const pending = await store.getPending();
  await store.consumePending(pending.recoveryId, snapshot(pending.content, pending.path));
  assert.equal(await store.getPending(), null);
  const current = JSON.parse(await fs.readFile(store.currentPath, 'utf8'));
  assert.equal(current.content, 'recovered text');
  assert.equal(current.path, originalPath);
  const nextSession = new RecoveryStore(directory);
  assert.equal((await nextSession.getPending()).content, 'recovered text');
});

test('dismissing the pending recovery preserves the active current-session draft', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'recovery-draft.json'), JSON.stringify(snapshot('old')));
  const store = new RecoveryStore(directory);
  await store.getPending();
  await store.stash(snapshot('current'));
  assert.deepEqual(await store.discardPending(), { discarded: true });
  assert.equal(await store.getPending(), null);
  assert.equal(JSON.parse(await fs.readFile(store.currentPath, 'utf8')).content, 'current');
});

test('several interrupted sessions retain all unresolved recoveries', async t => {
  const directory = await fixture(t);
  const first = new RecoveryStore(directory);
  await first.stash(snapshot('first session'));
  const second = new RecoveryStore(directory);
  await second.initialize();
  await second.stash(snapshot('second session'));
  const third = new RecoveryStore(directory);
  const newest = await third.getPending();
  const remaining = new Set();
  remaining.add(newest.content);
  await third.discardPending();
  remaining.add((await third.getPending()).content);
  assert.deepEqual(remaining, new Set(['first session', 'second session']));
});

test('stale draft guard is checked when the queued write actually runs', async t => {
  const directory = await fixture(t);
  const store = new RecoveryStore(directory);
  await store.initialize();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const blocker = store.serialize(() => barrier);
  let currentId = 'old';
  const queuedWrite = store.stash(snapshot('stale'), () => currentId === 'old');
  currentId = 'new';
  release();
  await blocker;
  assert.deepEqual(await queuedWrite, { stashed: false, reason: 'stale-document' });
  await assert.rejects(fs.access(store.currentPath), { code: 'ENOENT' });
});

test('initialization is idempotent and does not archive this session’s current draft', async t => {
  const directory = await fixture(t);
  const store = new RecoveryStore(directory);
  await store.initialize();
  await store.stash(snapshot('current'));
  await Promise.all([store.initialize(), store.initialize(), store.getPending()]);
  assert.equal(await store.getPending(), null);
  assert.equal(JSON.parse(await fs.readFile(store.currentPath, 'utf8')).content, 'current');
});

test('invalid pending data is retained without becoming editable recovery content', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'recovery-draft.json'), '{broken-json');
  const store = new RecoveryStore(directory);
  assert.equal(await store.getPending(), null);
  assert.equal((await fs.readdir(store.pendingDirectory)).length, 1);
  assert.equal(await store.readPending('../../outside.json'), null);
});
