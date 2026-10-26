'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const schema = require('../src/settings-schema.js');
const { SettingsStore, parseSettings, MAX_SETTINGS_BYTES } = require('../electron/settings-store.cjs');
const { atomicWrite } = require('../electron/file-store.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const json = (values, revision = 0) => JSON.stringify({ schemaVersion: 1, revision, values });

test('fresh preferences use declared app defaults and independent snapshots', async t => {
  const store = new SettingsStore(await fixture(t));
  const first = await store.get();
  assert.deepEqual(first.values, schema.defaults);
  assert.equal(first.revision, 0);
  assert.ok(schema.definitions.every(definition => definition.referenceDefaultVerified === false));
  first.values['appearance.fontSize'] = 31;
  first.warnings.push('fake');
  assert.equal((await store.get()).values['appearance.fontSize'], 17);
  assert.deepEqual((await store.get()).warnings, []);
});

test('valid multi-key update survives a new process/store and increments a single revision', async t => {
  const directory = await fixture(t), store = new SettingsStore(directory);
  const updated = await store.update({ 'appearance.fontSize': 21, 'appearance.theme': 'system', 'editor.tabSize': 2 });
  assert.equal(updated.revision, 1);
  const restarted = await new SettingsStore(directory).get();
  assert.deepEqual(restarted.values, updated.values);
  assert.equal(restarted.revision, 1);
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('invalid value in a multi-key patch cannot partly apply or rewrite persisted data', async t => {
  const store = new SettingsStore(await fixture(t));
  await store.update({ 'appearance.fontSize': 20 });
  const before = await fs.readFile(store.filePath, 'utf8');
  assert.throws(() => store.update({ 'appearance.fontSize': 24, 'editor.tabSize': 3 }), /无效/);
  assert.throws(() => store.update({ 'appearance.theme': 'dark', unknown: true }), /未知设置/);
  assert.equal((await store.get()).values['appearance.fontSize'], 20);
  assert.equal((await store.get()).values['appearance.theme'], 'light');
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
});

test('settings reject prototype keys, accessors and nonplain objects without evaluating getters', () => {
  let evaluated = false;
  const accessor = Object.defineProperty({}, 'appearance.theme', { enumerable: true, get() { evaluated = true; return 'dark'; } });
  assert.throws(() => schema.validatePatch(accessor), /getter/);
  assert.equal(evaluated, false);
  assert.throws(() => schema.validatePatch(JSON.parse('{"__proto__":{"polluted":true}}')), /未知设置/);
  assert.throws(() => schema.validatePatch(JSON.parse('{"constructor":true}')), /未知设置/);
  assert.throws(() => schema.validatePatch(Object.create({ 'appearance.theme': 'dark' })), /键值对象/);
  assert.throws(() => schema.validatePatch({ [Symbol('appearance.theme')]: 'dark' }), /Symbol/);
  assert.equal({}.polluted, undefined);
});

test('bounded values reject NaN, Infinity, out-of-range and incorrectly typed values', () => {
  for (const value of [NaN, Infinity, -1, 33, '17', 17.4]) assert.throws(() => schema.validatePatch({ 'appearance.fontSize': value }), /无效/);
  assert.throws(() => schema.validatePatch({ 'general.autoSave': 1 }), /无效/);
  assert.throws(() => schema.validatePatch({ 'appearance.theme': 'arbitrary' }), /无效/);
  assert.throws(() => schema.validatePatch({ 'appearance.fontFamily': 'font; color:red' }), /无效/);
});

test('step-invalid patches and imports cannot partially mutate settings or bypass UI value grids', async t => {
  const store = new SettingsStore(await fixture(t));
  await store.update({ 'appearance.fontSize': 20, 'appearance.lineHeight': 1.85 });
  const before = await store.get(), bytes = await fs.readFile(store.filePath, 'utf8');
  assert.throws(() => store.update({ 'appearance.fontSize': 22, 'appearance.contentWidth': 777 }), /无效/);
  assert.throws(() => store.update({ 'appearance.lineHeight': 1.81 }), /无效/);
  assert.throws(() => store.import(json({ 'appearance.theme': 'dark', 'appearance.contentWidth': 777 })), /无效/);
  assert.throws(() => store.import(json({ 'appearance.lineHeight': 1.81 })), /无效/);
  assert.deepEqual(await store.get(), before);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), bytes);
  assert.equal(schema.validatePatch({ 'appearance.lineHeight': 2.35 })['appearance.lineHeight'], 2.35);
});

test('formula macros are data-only JSON with bounded string definitions', () => {
  assert.equal(schema.validatePatch({ 'math.macros': '{"RR":"\\\\mathbb{R}"}' })['math.macros'], '{"RR":"\\\\mathbb{R}"}');
  for (const value of ['{"macro": ["#1",1]}', '{"macro": ["#1 + #2",2,"x"]}']) assert.equal(schema.validatePatch({ 'math.macros': value })['math.macros'], value);
  for (const value of ['{broken', '[]', 'null', '{"macro": ["definition",10]}', '{"macro": ["definition",1,99]}', '{"macro": ["definition",1, "x", "extra"]}', '{"__proto__":"anything"}', '{"not-a-command":"x"}', '{"macro":42}']) {
    assert.throws(() => schema.validatePatch({ 'math.macros': value }), /无效/);
  }
});

test('corrupt preferences are quarantined intact before app defaults are used', async t => {
  const directory = await fixture(t), original = '{broken json';
  await fs.writeFile(path.join(directory, 'settings.json'), original);
  const store = new SettingsStore(directory), snapshot = await store.get();
  assert.deepEqual(snapshot.values, schema.defaults);
  assert.equal(snapshot.warnings.length, 1);
  const quarantined = (await fs.readdir(directory)).filter(name => name.startsWith('settings.invalid-'));
  assert.equal(quarantined.length, 1);
  assert.equal(await fs.readFile(path.join(directory, quarantined[0]), 'utf8'), original);
  await store.update({ 'appearance.theme': 'dark' });
  assert.equal((await store.get()).warnings.length, 0);
  assert.equal((await new SettingsStore(directory).get()).values['appearance.theme'], 'dark');
  assert.equal(await fs.readFile(path.join(directory, quarantined[0]), 'utf8'), original);
});

test('unsupported schema version and unknown stored keys are preserved as invalid originals', async t => {
  for (const content of [JSON.stringify({ schemaVersion: 99, values: {} }), json({ invented: true })]) {
    const directory = await fixture(t);
    await fs.writeFile(path.join(directory, 'settings.json'), content);
    const snapshot = await new SettingsStore(directory).get();
    assert.equal(snapshot.warnings.length, 1);
    const names = await fs.readdir(directory);
    assert.equal(names.length, 1);
    assert.equal(await fs.readFile(path.join(directory, names[0]), 'utf8'), content);
  }
});

test('oversized persisted and imported settings are rejected without reading unbounded data', async t => {
  const directory = await fixture(t);
  await fs.writeFile(path.join(directory, 'settings.json'), ' '.repeat(MAX_SETTINGS_BYTES + 1));
  const store = new SettingsStore(directory);
  assert.equal((await store.get()).warnings.length, 1);
  assert.throws(() => store.import(' '.repeat(MAX_SETTINGS_BYTES + 1)), /64 KB/);
  assert.equal((await store.get()).revision, 0);
});

test('durable write failure rolls back memory/revision and does not poison the queue', async t => {
  const directory = await fixture(t);
  let fail = false;
  const store = new SettingsStore(directory, { write: async (...args) => {
    if (fail) throw new Error('disk full');
    return atomicWrite(...args);
  } });
  await store.update({ 'appearance.fontSize': 20 });
  fail = true;
  await assert.rejects(store.update({ 'appearance.fontSize': 25, 'appearance.theme': 'dark' }), /disk full/);
  assert.equal((await store.get()).values['appearance.fontSize'], 20);
  assert.equal((await store.get()).revision, 1);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, 'utf8')).values['appearance.fontSize'], 20);
  fail = false;
  assert.equal((await store.update({ 'appearance.theme': 'dark' })).revision, 2);
});

test('concurrent updates enforce revision guards and preserve the winning committed value', async t => {
  const store = new SettingsStore(await fixture(t));
  const results = await Promise.allSettled([
    store.update({ 'appearance.fontSize': 22 }, { expectedRevision: 0 }),
    store.update({ 'appearance.theme': 'dark' }, { expectedRevision: 0 }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'SETTINGS_CONFLICT');
  const snapshot = await store.get();
  assert.equal(snapshot.values['appearance.fontSize'], 22);
  assert.equal(snapshot.values['appearance.theme'], 'light');
  assert.equal(snapshot.revision, 1);
});

test('caller mutation after submitting a patch cannot change the queued operation', async t => {
  const store = new SettingsStore(await fixture(t));
  const patch = { 'appearance.fontSize': 20 }, pending = store.update(patch);
  patch['appearance.fontSize'] = 30;
  assert.equal((await pending).values['appearance.fontSize'], 20);
});

test('import validates every setting before replacing state and does not adopt foreign revisions', async t => {
  const store = new SettingsStore(await fixture(t));
  await store.update({ 'appearance.fontSize': 25, 'editor.tabSize': 8 });
  assert.throws(() => store.import(json({ 'appearance.theme': 'dark', unknown: true }, 400)), /未知设置/);
  assert.equal((await store.get()).values['appearance.fontSize'], 25);
  const imported = await store.import(json({ 'appearance.theme': 'dark' }, 400), { expectedRevision: 1 });
  assert.equal(imported.revision, 2);
  assert.equal(imported.values['appearance.fontSize'], 17);
  assert.equal(imported.values['appearance.theme'], 'dark');
});

test('export round-trips the complete settings while reset preserves unrelated user files', async t => {
  const directory = await fixture(t), store = new SettingsStore(directory);
  const document = path.join(directory, 'my-document.md');
  await fs.writeFile(document, 'private document');
  await store.update({ 'appearance.fontSize': 23, 'images.insertAction': 'reference' });
  const exported = parseSettings(await store.export());
  assert.equal(exported.values['appearance.fontSize'], 23);
  const reset = await store.reset({ expectedRevision: 1 });
  assert.deepEqual(reset.values, schema.defaults);
  assert.equal(reset.revision, 2);
  assert.equal(await fs.readFile(document, 'utf8'), 'private document');
  assert.deepEqual((await new SettingsStore(directory).get()).values, schema.defaults);
});

test('no-op patches do not rewrite preferences or advance revision', async t => {
  const store = new SettingsStore(await fixture(t));
  await store.update({ 'appearance.fontSize': 20 });
  const bytes = await fs.readFile(store.filePath, 'utf8');
  assert.equal((await store.update({ 'appearance.fontSize': 20 })).revision, 1);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), bytes);
});
