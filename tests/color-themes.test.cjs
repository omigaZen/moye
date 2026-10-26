'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const config = require('../src/color-theme-config.js');
const { ThemeStore } = require('../electron/theme-store.cjs');
const raw = (name = '纸张', appearance = 'light', extra = '') => `[meta]\nname = ${JSON.stringify(name)}\nappearance = "${appearance}"\nbased_on = "moye"\n[colors]\npaper = "#faf8ef"\nbody = "#303030"\n${extra}`;
async function temporary(t) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-color-themes-'));
  const store = new ThemeStore({ directory: path.join(work, 'document-themes') });
  t.after(async () => { store.dispose(); await fs.rm(work, { recursive: true, force: true }); });
  return { work, store };
}

test('restricted theme TOML keeps quoted colour hashes and comments separate', () => {
  const theme = config.parse(raw('纸张 # 1') + '\n[chrome]\nbackground = \'#eeeeee\' # trailing comment\n', 'paper.toml');
  assert.equal(theme.id, 'custom:paper'); assert.equal(theme.name, '纸张 # 1');
  assert.equal(theme.variables['--paper'], '#faf8ef'); assert.equal(theme.variables['--chrome'], '#eeeeee');
  assert.deepEqual(theme.warnings, []);
});
test('a bad colour or unknown field skips one key while keeping valid theme fields', () => {
  const theme = config.parse(raw('纸张', 'light', 'link = "url(https://evil.test)"\nfuture = 10\nheading = "#123"\n'), 'paper.toml');
  assert.equal(theme.variables['--theme-heading'], '#123'); assert.equal(theme.variables['--theme-link'], undefined);
  assert.equal(theme.warnings.length, 2);
  assert.equal(config.resolve([theme], theme.id, 'light').valid, true);
});
test('theme parsing rejects traversal, invalid metadata, multiline syntax, duplicate keys and UTF-8 overflow', () => {
  for (const file of ['../paper.toml', '/paper.toml', 'paper.TOML', 'x/y.toml', '.paper.toml', 'a'.repeat(65) + '.toml']) assert.throws(() => config.parse(raw(), file));
  assert.throws(() => config.parse(raw().replace('"light"', '"auto"'), 'paper.toml'));
  assert.throws(() => config.parse(raw() + 'paper = "#fff"\n', 'paper.toml'), /重复/);
  assert.throws(() => config.parse(raw() + 'broken line\n', 'paper.toml'));
  assert.throws(() => config.parse(raw() + '#'.repeat(65536), 'paper.toml'));
  assert.throws(() => config.parse(raw('字'.repeat(22000)), 'paper.toml'));
});
test('theme inheritance merges colours and chrome without changing layout settings', () => {
  const base = config.parse(raw('基础') + '\n[chrome]\nbackground = "#ababab"\n', 'base.toml');
  const child = config.parse('[meta]\nname = "子主题"\nappearance = "light"\nbased_on = "custom:base"\n[colors]\nbody = "#111111"\n', 'child.toml');
  const result = config.resolve([base, child], child.id, 'light');
  assert.equal(result.valid, true); assert.equal(result.variables['--paper'], '#faf8ef'); assert.equal(result.variables['--chrome'], '#ababab'); assert.equal(result.variables['--ink'], '#111111');
  assert.ok(Object.keys(result.variables).every(key => config.variableKeys.includes(key)));
  assert.equal(result.variables['--font-size'], undefined);
});
test('missing references, appearance mismatches and inheritance cycles have explicit diagnostics', () => {
  const first = config.parse(raw('一').replace('"moye"', '"custom:two"'), 'one.toml');
  const second = config.parse(raw('二').replace('"moye"', '"custom:one"'), 'two.toml');
  assert.equal(config.resolve([first, second], first.id, 'light').valid, false);
  const missing = config.resolve([], 'custom:none', 'light'); assert.equal(missing.valid, false); assert.ok(missing.warnings.length);
  const wrongAppearance = config.resolve([first], first.id, 'dark'); assert.equal(wrongAppearance.valid, false); assert.match(wrongAppearance.warnings[0], /不匹配/);
  assert.deepEqual(wrongAppearance.variables, config.palette('moye', 'dark'));
});
test('copying the full resolved palette to a TOML file round-trips safe colours', () => {
  const variables = config.palette('nord', 'dark');
  const copied = config.parse(config.toTOML({ name: '我的 Nord', appearance: 'dark', basedOn: 'nord', variables }), 'nord-copy.toml');
  assert.deepEqual(config.resolve([copied], copied.id, 'dark').variables, variables);
  assert.equal(copied.warnings.length, 0);
});
test('theme store publishes complete files and rejects stale or colliding writes', async t => {
  const { store } = await temporary(t);
  let snapshot = await store.save({ fileName: 'paper.toml', content: raw(), expectedHash: null });
  assert.equal(snapshot.themes.length, 1); const first = snapshot.themes[0];
  await assert.rejects(store.save({ fileName: 'paper.toml', content: raw('覆盖'), expectedHash: null }), /已存在/);
  await assert.rejects(store.save({ fileName: 'paper.toml', content: raw('覆盖'), expectedHash: '0'.repeat(64) }), /外部修改/);
  snapshot = await store.save({ fileName: 'paper.toml', content: raw('新主题'), expectedHash: first.hash });
  assert.equal(snapshot.themes[0].name, '新主题'); assert.notEqual(snapshot.themes[0].hash, first.hash);
  assert.deepEqual((await fs.readdir(store.directory)).filter(name => name.startsWith('.')), []);
  assert.equal(await fs.readFile(path.join(store.directory, 'paper.toml'), 'utf8'), raw('新主题'));
});
test('theme store rejects unsafe paths, symlinks and hardlinks without reading their contents', async t => {
  const { work, store } = await temporary(t); await store.get();
  await assert.rejects(async () => store.save({ fileName: '../outside.toml', content: raw() }));
  const outside = path.join(work, 'outside.toml'); await fs.writeFile(outside, raw('外部文件'));
  await fs.symlink(outside, path.join(store.directory, 'symlink.toml'));
  await fs.link(outside, path.join(store.directory, 'hardlink.toml'));
  const snapshot = await store.get(); assert.equal(snapshot.themes.length, 0); assert.equal(snapshot.errors.length, 2);
  assert.ok(snapshot.errors.every(error => !Object.hasOwn(error, 'content')));
  await assert.rejects(store.save({ fileName: 'symlink.toml', content: raw(), expectedHash: null }));
  assert.equal(await fs.readFile(outside, 'utf8'), raw('外部文件'));
});
test('external malformed theme text has editable diagnostics while other themes remain available', async t => {
  const { store } = await temporary(t); await store.save({ fileName: 'good.toml', content: raw(), expectedHash: null });
  const bad = '[meta]\nname = "坏文件"\nappearance = "unexpected"\n';
  await fs.writeFile(path.join(store.directory, 'bad.toml'), bad);
  const snapshot = await store.get(); assert.equal(snapshot.themes.length, 1); assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.errors[0].fileName, 'bad.toml'); assert.equal(snapshot.errors[0].content, bad);
  assert.equal(snapshot.errors[0].hash, crypto.createHash('sha256').update(bad).digest('hex'));
});
test('external atomic theme replacement is delivered by the live file watcher', async t => {
  const { store } = await temporary(t); await store.save({ fileName: 'paper.toml', content: raw(), expectedHash: null });
  let unsubscribe;
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Theme watcher timed out')), 5000);
    unsubscribe = store.watch(snapshot => { if (snapshot.themes.some(theme => theme.name === '外部更改')) { clearTimeout(timeout); resolve(snapshot); } });
  });
  // The watcher installs asynchronously after the owned directory check.
  await new Promise(resolve => setTimeout(resolve, 40));
  await fs.writeFile(path.join(store.directory, '.replacement.tmp'), raw('外部更改'));
  await fs.rename(path.join(store.directory, '.replacement.tmp'), path.join(store.directory, 'paper.toml'));
  const snapshot = await changed; unsubscribe(); assert.equal(snapshot.themes[0].name, '外部更改');
});
test('theme removal checks the loaded version and leaves external edits intact', async t => {
  const { store } = await temporary(t); const first = (await store.save({ fileName: 'paper.toml', content: raw(), expectedHash: null })).themes[0];
  await fs.writeFile(path.join(store.directory, 'paper.toml'), raw('磁盘变化'));
  await assert.rejects(store.remove({ fileName: 'paper.toml', expectedHash: first.hash }), /外部修改/);
  const current = (await store.get()).themes[0];
  const next = await store.remove({ fileName: 'paper.toml', expectedHash: current.hash });
  assert.equal(next.themes.length, 0);
});
test('invalid or oversized themes are never written and disposal ends store operations', async t => {
  const { store } = await temporary(t);
  await assert.rejects(async () => store.save({ fileName: 'bad.toml', content: 'not TOML', expectedHash: null }));
  await assert.rejects(async () => store.save({ fileName: 'large.toml', content: raw() + ' '.repeat(65536), expectedHash: null }));
  assert.equal((await store.get()).themes.length, 0);
  store.dispose(); await assert.rejects(store.get(), /关闭/);
});
