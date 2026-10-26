'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SettingsStore, MAX_SETTINGS_BYTES } = require('../electron/settings-store.cjs');
const json = (values, revision = 0) => JSON.stringify({ schemaVersion: 1, revision, values });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-settings-live-'));
  const store = new SettingsStore(directory);
  t.after(async () => { store.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}
async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('external valid settings reload live with a fresh monotonic local revision', async t => {
  const { store } = await fixture(t);
  const first = await store.update({ 'appearance.fontSize': 20, 'appearance.theme': 'dark' });
  const changed = json({ ...first.values, 'appearance.fontSize': 24 }, 9000);
  await fs.writeFile(store.filePath, changed);
  const next = await store.reload();
  assert.equal(next.values['appearance.fontSize'], 24); assert.equal(next.values['appearance.theme'], 'dark');
  assert.equal(next.revision, first.revision + 1); assert.notEqual(next.revision, 9000);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), changed);
});
test('format-only external edits do not rewrite the file or advance settings revision', async t => {
  const { store } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 20 });
  const pretty = JSON.stringify({ schemaVersion: 1, revision: 22, values: first.values }, null, 4) + '\n';
  await fs.writeFile(store.filePath, pretty); const next = await store.reload();
  assert.equal(next.revision, first.revision); assert.deepEqual(next.values, first.values);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), pretty);
});
test('runtime incomplete JSON preserves last-known settings and is never quarantined or overwritten', async t => {
  const { store, directory } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 25, 'appearance.theme': 'dark' });
  const incomplete = '{"schemaVersion":1,"values":'; await fs.writeFile(store.filePath, incomplete);
  const failed = await store.reload();
  assert.deepEqual(failed.values, first.values); assert.equal(failed.revision, first.revision + 1); assert.ok(failed.externalError); assert.equal(failed.warnings.length, 1);
  assert.equal((await store.reload()).revision, failed.revision, 'same invalid edit must not repeatedly advance revision');
  await assert.rejects(store.reload({ throwOnInvalid: true }), error => error.code === 'SETTINGS_EXTERNAL_INVALID');
  await assert.rejects(store.update({ 'appearance.fontSize': 18 }, { expectedRevision: failed.revision }), error => error.code === 'SETTINGS_EXTERNAL_INVALID');
  assert.equal(await fs.readFile(store.filePath, 'utf8'), incomplete);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('settings.invalid-')), []);
});
test('fixing an external file clears diagnostics and old UI revisions cannot overwrite the accepted edit', async t => {
  const { store } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 25 });
  await fs.writeFile(store.filePath, '{broken'); const failed = await store.reload();
  const repaired = json({ ...first.values, 'appearance.fontSize': 22 }); await fs.writeFile(store.filePath, repaired);
  const next = await store.reload(); assert.equal(next.externalError, undefined); assert.deepEqual(next.warnings, []); assert.equal(next.revision, failed.revision + 1);
  await assert.rejects(store.update({ 'appearance.theme': 'dark' }, { expectedRevision: first.revision }), error => error.code === 'SETTINGS_CONFLICT');
  assert.equal(await fs.readFile(store.filePath, 'utf8'), repaired);
  const merged = await store.update({ 'appearance.theme': 'dark' }, { expectedRevision: next.revision }); assert.equal(merged.values['appearance.fontSize'], 22);
});
test('UI write preflight accepts an unseen external edit before checking the revision guard', async t => {
  const { store } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 20 });
  const external = json({ ...first.values, 'appearance.fontSize': 26 }); await fs.writeFile(store.filePath, external);
  await assert.rejects(store.update({ 'appearance.theme': 'dark' }, { expectedRevision: first.revision }), error => error.code === 'SETTINGS_CONFLICT');
  assert.equal((await store.get()).values['appearance.fontSize'], 26); assert.equal(await fs.readFile(store.filePath, 'utf8'), external);
});
test('a temporarily deleted settings file preserves live state and explicit config opening can recreate it', async t => {
  const { store } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 23 });
  await fs.unlink(store.filePath); const missing = await store.reload();
  assert.equal(missing.values['appearance.fontSize'], 23); assert.ok(missing.externalError);
  const restored = await store.ensureFile(); assert.equal(restored.values['appearance.fontSize'], 23); assert.equal(restored.externalError, undefined);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, 'utf8')).values['appearance.fontSize'], 23);
  assert.ok(restored.revision > first.revision);
});
test('invalid existing config stays openable for repair without replacing user bytes', async t => {
  const { store } = await fixture(t); await store.update({ 'appearance.fontSize': 21 });
  await fs.writeFile(store.filePath, '{working on it'); await store.reload(); await store.ensureFile();
  assert.equal(await fs.readFile(store.filePath, 'utf8'), '{working on it');
});
test('oversized and unknown runtime configs keep the previous settings intact', async t => {
  const { store, directory } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 22 });
  for (const text of ['x'.repeat(MAX_SETTINGS_BYTES + 1), json({ madeUp: true }), json({ 'appearance.fontSize': 99 })]) {
    await fs.writeFile(store.filePath, text); const next = await store.reload();
    assert.deepEqual(next.values, first.values); assert.ok(next.externalError);
    assert.equal(await fs.readFile(store.filePath, 'utf8'), text);
  }
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('settings.invalid-')), []);
});
test('runtime symlink config is rejected without following it or moving the link', async t => {
  const { store, directory } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 22 });
  const outside = path.join(directory, 'outside.json'); await fs.writeFile(outside, json({ 'appearance.fontSize': 31 }));
  await fs.unlink(store.filePath); await fs.symlink(outside, store.filePath);
  const next = await store.reload(); assert.deepEqual(next.values, first.values); assert.ok(next.externalError); assert.equal((await fs.lstat(store.filePath)).isSymbolicLink(), true);
  await assert.rejects(store.ensureFile(), /普通文件/); assert.equal(JSON.parse(await fs.readFile(outside, 'utf8')).values['appearance.fontSize'], 31);
});
test('live watcher delivers valid external updates and diagnostics, not duplicate self-written settings', async t => {
  const { store } = await fixture(t); const first = await store.update({ 'appearance.fontSize': 20 });
  const events = []; const stop = store.watch(snapshot => events.push(snapshot));
  await new Promise(resolve => setTimeout(resolve, 40));
  await store.update({ 'appearance.fontSize': 21 });
  await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(events.length, 0);
  await fs.writeFile(store.filePath, '{partial'); await until(() => events.some(event => event.externalError), 'Missing invalid-file diagnostic');
  assert.equal(events.at(-1).values['appearance.fontSize'], 21);
  const temporary = path.join(store.directory, '.external-settings.tmp'); await fs.writeFile(temporary, json({ ...first.values, 'appearance.fontSize': 27 })); await fs.rename(temporary, store.filePath);
  await until(() => events.some(event => event.values['appearance.fontSize'] === 27 && !event.externalError), 'Missing repaired settings event');
  assert.equal((await store.get()).values['appearance.fontSize'], 27);
  stop(); store.dispose(); await assert.rejects(store.reload(), /关闭/);
});
