'use strict';

// Native capabilities only. Renderer settings controls are exercised by the
// separate preferences UI suite; this script does not substitute for OS IME tests.
const { _electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-native-settings-'));
  const report = { platform: process.platform, generatedAt: new Date().toISOString(), results: [], limitations: ['Native capability tests; not a Typora parity, OS dictionary availability or real IME certification.'] };
  let app;
  const check = async (name, operation) => {
    try { const details = await operation(); report.results.push({ name, status: 'pass', ...(details ? { details } : {}) }); }
    catch (error) { report.results.push({ name, status: 'fail', error: error.message }); throw error; }
  };
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.join(root, 'electron/main.cjs')],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(temporary, 'profile') },
    });
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => !!window.desktop);
    await check('settings IPC returns app defaults and toggles native spellchecking', async () => {
      const initial = await page.evaluate(() => desktop.getSettings());
      assert.equal(initial.values['general.spellcheck'], false);
      const changed = await page.evaluate(revision => desktop.updateSettings({ patch: { 'general.spellcheck': true, 'appearance.theme': 'system' }, expectedRevision: revision }), initial.revision);
      assert.equal(changed.revision, initial.revision + 1);
      assert.equal(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()), true);
      assert.ok(['light', 'dark'].includes(changed.systemTheme));
    });
    await check('native Preferences menu exposes the platform accelerator', async () => {
      const entries = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).filter(item => item.accelerator === (process.platform === 'darwin' ? 'Command+,' : 'Ctrl+,')).map(item => item.label));
      assert.ok(entries.includes('设置…'));
    });
    await check('IPC rejects unknown keys without applying valid siblings', async () => {
      const before = await page.evaluate(() => desktop.getSettings());
      await assert.rejects(page.evaluate(() => desktop.updateSettings({ patch: { 'appearance.theme': 'dark', 'unknown.key': true } })), /未知设置/);
      assert.deepEqual(await page.evaluate(() => desktop.getSettings()), before);
    });
    await check('canceled native import and export leave current settings intact', async () => {
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); dialog.showSaveDialog = async () => ({ canceled: true }); });
      const before = await page.evaluate(() => desktop.getSettings());
      assert.equal(await page.evaluate(() => desktop.importSettings()), null);
      assert.deepEqual(await page.evaluate(() => desktop.exportSettings()), { saved: false });
      assert.deepEqual(await page.evaluate(() => desktop.getSettings()), before);
    });
    await check('reference-image policy inserts an encoded original URL without copying', async () => {
      const image = path.join(temporary, '原图 (测).svg');
      await fs.writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
      await page.evaluate(() => desktop.updateSettings({ patch: { 'images.insertAction': 'reference' } }));
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, image);
      const images = await page.evaluate(() => desktop.chooseImages());
      assert.equal(images.length, 1);
      assert.match(images[0].markdown, /file:\/\//);
      assert.match(images[0].markdown, /%28/);
      assert.ok(!(await fs.readdir(temporary)).some(name => name.endsWith('.assets')));
    });
    await check('export and native import round-trip validated settings', async () => {
      const destination = path.join(temporary, 'settings-export.json');
      await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, destination);
      const before = await page.evaluate(() => desktop.getSettings());
      assert.deepEqual(await page.evaluate(() => desktop.exportSettings()), { saved: true, path: destination });
      const exported = JSON.parse(await fs.readFile(destination, 'utf8'));
      assert.deepEqual(exported.values, before.values);
      await page.evaluate(() => desktop.updateSettings({ patch: { 'appearance.fontSize': 24 } }));
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, destination);
      const imported = await page.evaluate(() => desktop.importSettings());
      assert.deepEqual(imported.values, before.values);
      assert.ok(imported.revision > before.revision);
    });
    await check('invalid import is rejected without altering the current preferences', async () => {
      const invalid = path.join(temporary, 'invalid-settings.json');
      await fs.writeFile(invalid, JSON.stringify({ schemaVersion: 1, values: { 'appearance.theme': 'dark', 'unknown.key': true } }));
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, invalid);
      const before = await page.evaluate(() => desktop.getSettings());
      await assert.rejects(page.evaluate(() => desktop.importSettings()), /未知设置/);
      assert.deepEqual(await page.evaluate(() => desktop.getSettings()), before);
    });
    await check('reset persists defaults and disables the native spellchecker', async () => {
      const reset = await page.evaluate(() => desktop.resetSettings());
      assert.equal(reset.values['general.spellcheck'], false);
      assert.equal(reset.values['images.insertAction'], 'copy');
      assert.equal(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()), false);
      const disk = JSON.parse(await fs.readFile(path.join(temporary, 'profile/settings.json'), 'utf8'));
      assert.deepEqual(disk.values, reset.values);
    });
    report.pass = true;
  } catch (error) {
    report.pass = false;
    report.error = error.stack || error.message;
    process.exitCode = 1;
  } finally {
    if (app) {
      const process = app.process();
      const exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await exited;
    }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    await fs.writeFile(path.join(root, 'tests/native-settings-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
