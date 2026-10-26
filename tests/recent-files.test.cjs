'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RecentFilesStore, MAX_STATE_BYTES } = require('../electron/recent-files.cjs');
const { MAX_DOCUMENT_BYTES } = require('../electron/file-store.cjs');
async function fixture(t, maxEntries = 40) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-recent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'state', 'recent.json'), store = new RecentFilesStore({ filePath, maxEntries });
  async function document(name, content = name) { const filename = path.join(root, name); await fs.writeFile(filename, content); return filename; }
  return { root, filePath, store, document };
}
test('recent documents deduplicate canonical aliases, retain opaque IDs and reorder true opens', async t => {
  const { root, store, document } = await fixture(t), first = await document('中文.md'), second = await document('2.md');
  const one = await store.remember(first); await store.remember(second);
  const alias = path.join(root, 'alias.md'); await fs.symlink(first, alias);
  const again = await store.remember(alias), snapshot = await store.list();
  assert.equal(again.id, one.id); assert.deepEqual(snapshot.entries.map(e => e.path), [first, second]);
  assert.ok(snapshot.entries[0].lastOpened > snapshot.entries[1].lastOpened);
  assert.notEqual(one.id, first); assert.equal(await store.resolve(one.id), first);
});
test('preview documents never create or reorder recent-file records', async t => {
  const { store, filePath, document } = await fixture(t), a = await document('a.md'), b = await document('b.txt');
  assert.deepEqual(await store.remember(a, { preview: true }), { recorded: false, reason: 'preview' });
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' });
  await store.remember(a); await store.remember(b); const before = await fs.readFile(filePath, 'utf8');
  await store.remember(a, { preview: true }); assert.equal(await fs.readFile(filePath, 'utf8'), before);
  assert.deepEqual((await store.list()).entries.map(e => e.path), [b, a]);
});
test('bounded recent files survive a new store and eviction invalidates old capabilities', async t => {
  const { store, filePath, document } = await fixture(t, 3); let first;
  for (let index = 1; index <= 5; index++) { const result = await store.remember(await document(`${index}.md`)); if (index === 1) first = result.id; }
  const reopened = new RecentFilesStore({ filePath, maxEntries: 3 });
  const initial = await store.list(), after = await reopened.list();
  assert.deepEqual(after.entries, initial.entries); assert.deepEqual(after.entries.map(e => e.name), ['5.md', '4.md', '3.md']);
  await assert.rejects(store.resolve(first), /失效/); await assert.rejects(reopened.resolve(first), /失效/);
});
test('missing records remain visible, and removing a record never deletes another document', async t => {
  const { store, document } = await fixture(t), gone = await document('gone.md'), kept = await document('kept.md', 'keep exact bytes\r\n');
  const a = await store.remember(gone); await store.remember(kept); await fs.unlink(gone);
  const missing = (await store.list()).entries.find(e => e.id === a.id);
  assert.equal(missing.available, false); assert.equal(missing.reason, 'missing');
  await assert.rejects(store.resolve(a.id), error => error.code === 'RECENT_FILE_UNAVAILABLE' && error.reason === 'missing');
  await store.remove(a.id); assert.equal(await fs.readFile(kept, 'utf8'), 'keep exact bytes\r\n');
  assert.equal((await store.list()).entries.length, 1);
});
test('a replaced file or directory cannot redirect a retained recent capability through a symlink', async t => {
  const { root, store, document } = await fixture(t), selected = await document('selected.md'), other = await document('other.md', 'unselected target');
  const recent = await store.remember(selected); await fs.unlink(selected); await fs.symlink(other, selected);
  assert.equal((await store.list()).entries[0].reason, 'changed-target');
  await assert.rejects(store.resolve(recent.id), error => error.reason === 'changed-target');
  await store.remove(recent.id); assert.equal(await fs.readFile(other, 'utf8'), 'unselected target'); assert.ok((await fs.lstat(path.join(root, 'selected.md'))).isSymbolicLink());
});
test('non-files and oversized documents are diagnosed without opening them', async t => {
  const { store, document } = await fixture(t), directory = await document('directory.md'), large = await document('large.md');
  const dirId = (await store.remember(directory)).id; await fs.unlink(directory); await fs.mkdir(directory);
  const handle = await fs.open(large, 'w'); try { await handle.truncate(MAX_DOCUMENT_BYTES + 1); } finally { await handle.close(); }
  const largeId = (await store.remember(large)).id, entries = (await store.list()).entries;
  assert.equal(entries.find(e => e.id === dirId).reason, 'not-file'); assert.equal(entries.find(e => e.id === largeId).reason, 'too-large');
  await assert.rejects(store.resolve(dirId), /普通文件/); await assert.rejects(store.resolve(largeId), /32 MB/);
});
test('renderer-style malformed IDs never become paths or change persistent records', async t => {
  const { store, filePath, document } = await fixture(t), selected = await document('safe.md');
  await store.remember(selected); const bytes = await fs.readFile(filePath);
  for (const id of [selected, '../secret', null, {}, ['fake'], crypto.randomUUID()]) { await assert.rejects(store.resolve(id), /失效/); await assert.rejects(store.remove(id), /失效/); }
  assert.deepEqual(await fs.readFile(filePath), bytes); assert.equal(await fs.readFile(selected, 'utf8'), 'safe.md');
});
test('clearing history persists an empty list without deleting original files', async t => {
  const { store, filePath, document } = await fixture(t), a = await document('a.md', '# unchanged\n');
  const oldId = (await store.remember(a)).id; const empty = await store.clear();
  assert.equal(empty.entries.length, 0); assert.equal((await new RecentFilesStore({ filePath }).list()).entries.length, 0);
  await assert.rejects(store.resolve(oldId), /失效/); assert.equal(await fs.readFile(a, 'utf8'), '# unchanged\n');
});
test('corrupt, oversized, or symlinked history files recover without following or rewriting their target', async t => {
  const { root, filePath, document } = await fixture(t); await fs.mkdir(path.dirname(filePath));
  for (const bytes of ['{bad', ' '.repeat(MAX_STATE_BYTES + 1), JSON.stringify({ version: 2, entries: [] })]) {
    await fs.writeFile(filePath, bytes); const store = new RecentFilesStore({ filePath }); const snapshot = await store.list();
    assert.equal(snapshot.entries.length, 0); assert.ok(snapshot.warnings.length); assert.equal(await fs.readFile(filePath, 'utf8'), bytes);
  }
  await fs.unlink(filePath); const target = await document('not-history.json', 'do not follow this'); await fs.symlink(target, filePath);
  const store = new RecentFilesStore({ filePath }); assert.ok((await store.list()).warnings.length);
  await store.remember(await document('repair.md')); assert.equal(await fs.readFile(target, 'utf8'), 'do not follow this'); assert.equal((await fs.lstat(filePath)).isSymbolicLink(), false);
  assert.ok((await fs.stat(path.join(root, 'repair.md'))).isFile());
});
test('loaded history validates ID types, deduplicates paths and ignores malformed entries', async t => {
  const { filePath, document } = await fixture(t), a = await document('a.md'), b = await document('b.md'); await fs.mkdir(path.dirname(filePath));
  const id = crypto.randomUUID(); await fs.writeFile(filePath, JSON.stringify({ version: 1, entries: [
    { id, path: a, lastOpened: 30 }, { id: crypto.randomUUID(), path: a, lastOpened: 20 },
    { id: [crypto.randomUUID()], path: b, lastOpened: 40 }, { id: crypto.randomUUID(), path: 'relative.md', lastOpened: 10 },
    { id: crypto.randomUUID(), path: b, lastOpened: -2 },
  ] }));
  const snapshot = await new RecentFilesStore({ filePath }).list(); assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.entries[0].id, id); assert.ok(snapshot.warnings.length);
});
test('failed persistence does not change capabilities or poison later queued operations', async t => {
  const { store, filePath, document } = await fixture(t), a = await document('a.md'), b = await document('b.md');
  const first = await store.remember(a); await fs.unlink(filePath); await fs.mkdir(filePath);
  await assert.rejects(store.remember(b)); assert.equal((await store.list()).entries.length, 1); assert.equal(await store.resolve(first.id), a);
  await fs.rmdir(filePath); await store.remember(b); assert.deepEqual((await store.list()).entries.map(e => e.name), ['b.md', 'a.md']);
});
test('concurrent history mutations remain ordered and cannot revive cleared entries', async t => {
  const { store, filePath, document } = await fixture(t), a = await document('a.md'), b = await document('b.md'), c = await document('c.md');
  const first = await store.remember(a);
  await Promise.all([store.remember(b), store.remove(first.id), store.clear(), store.remember(c)]);
  assert.deepEqual((await store.list()).entries.map(e => e.name), ['c.md']);
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8')); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].path, c);
});
