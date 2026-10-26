'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-settings-live-ui-'));
  const executable = process.env.MOYE_SETTINGS_LIVE_EXECUTABLE;
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye live configuration file behaviour; not original-app differential verification', application: null, results: [], pageErrors: [], remoteRequests: [] };
  let app, page, configuration, originalState;
  const json = (values, revision = 0) => JSON.stringify({ schemaVersion: 1, revision, values }, null, 2) + '\n';
  async function probe(name, run) {
    const start = Date.now();
    try { const details = await run(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - start, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.stack || error.message }); }
  }
  async function font(size) { await page.waitForFunction(size => moye.settings.getValues()['appearance.fontSize'] === size && getComputedStyle(moye.editor.vditor.ir.element).fontSize === `${size}px`, size); }
  try {
    app = await electron.launch({ executablePath: executable || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(executable ? [] : [path.join(root, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    if (executable) assert.equal(report.application.isPackaged, true, 'A requested packaged run cannot use source');
    page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 900 });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.waitForFunction(() => window.moye?.ready && window.desktop?.openSettingsFile && window.desktop?.reloadSettings, null, { timeout: 30000 });
    configuration = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'settings.json');
    originalState = await page.evaluate(() => moye.getState());
    await probe('configuration file opens through the real settings UI at its single whitelisted path', async () => {
      await app.evaluate(({ shell }) => { global.__moyeOpenedSettingsPaths = []; shell.openPath = async target => { global.__moyeOpenedSettingsPaths.push(target); return ''; }; });
      await page.evaluate(() => moye.settings.panel.open());
      await page.locator('[data-settings-action="open-configuration"]').click();
      await page.waitForFunction(() => document.querySelector('.moye-settings__status').textContent.includes('配置文件已打开'));
      const opened = await app.evaluate(() => global.__moyeOpenedSettingsPaths);
      assert.deepEqual(opened, [configuration]);
      const parsed = JSON.parse(await fs.readFile(configuration, 'utf8')); assert.equal(parsed.schemaVersion, 1); assert.ok(parsed.values);
      assert.deepEqual(await page.evaluate(() => moye.getState()), originalState);
      return { pathMatchesAppSettingsFile: true, sourceUnchanged: true };
    });
    await probe('saving a valid external configuration live-updates rendered typography and panel controls', async () => {
      const native = await page.evaluate(() => desktop.getSettings());
      await fs.writeFile(configuration, json({ ...native.values, 'appearance.fontSize': 21 })); await font(21);
      assert.equal(await page.locator('input[data-setting-key="appearance.fontSize"]').inputValue(), '21');
      assert.deepEqual(await page.evaluate(() => moye.getState()), originalState);
      return { realFontSize: '21px', panelUpdated: true, sourceUnchanged: true };
    });
    await probe('an incomplete external edit keeps the last valid rendering and rejects UI overwrites without quarantine', async () => {
      const incomplete = '{"schemaVersion":1,"values":'; await fs.writeFile(configuration, incomplete);
      await page.waitForFunction(async () => Boolean((await desktop.getSettings()).externalError));
      await font(21);
      await page.locator('[data-settings-action="reload-configuration"]').click();
      await page.waitForFunction(() => document.querySelector('.moye-settings__status').dataset.state === 'error');
      assert.match(await page.locator('.moye-settings__status').textContent(), /外部设置文件/);
      const error = await page.evaluate(async () => { try { await moye.settings.apply({ 'appearance.fontSize': 30 }); return ''; } catch (error) { return error.message; } });
      assert.match(error, /外部设置文件/);
      assert.equal(await fs.readFile(configuration, 'utf8'), incomplete);
      assert.equal((await fs.readdir(path.dirname(configuration))).some(name => name.startsWith('settings.invalid-')), false);
      assert.deepEqual(await page.evaluate(() => moye.getState()), originalState);
      return { lastValidFontSize: 21, partialFilePreserved: true, writeRejected: true };
    });
    await probe('repair and explicit reload recover settings while leaving the external file bytes intact', async () => {
      const native = await page.evaluate(() => desktop.getSettings());
      const repaired = json({ ...native.values, 'appearance.fontSize': 23 }); await fs.writeFile(configuration, repaired);
      await page.locator('[data-settings-action="reload-configuration"]').click(); await font(23);
      await page.waitForFunction(() => document.querySelector('.moye-settings__status').textContent.includes('配置已重新载入'));
      assert.equal((await page.evaluate(() => desktop.getSettings())).externalError, undefined);
      assert.equal(await fs.readFile(configuration, 'utf8'), repaired);
      assert.deepEqual(await page.evaluate(() => moye.getState()), originalState);
      return { realFontSize: '23px', diagnosticsCleared: true, externalFileNotRewritten: true };
    });
    await probe('external display updates wait for committed composition before touching the editor layout', async () => {
      await page.evaluate(() => moye.settings.panel.close());
      const native = await page.evaluate(() => desktop.getSettings());
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
      try {
        await fs.writeFile(configuration, json({ ...native.values, 'appearance.fontSize': 24 }));
        await page.waitForFunction(async () => (await desktop.getSettings()).values['appearance.fontSize'] === 24);
        assert.equal(await page.evaluate(() => moye.settings.getValues()['appearance.fontSize']), 23);
        assert.equal(await page.evaluate(() => getComputedStyle(moye.editor.vditor.ir.element).fontSize), '23px');
      } finally { await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))); }
      await font(24); assert.deepEqual(await page.evaluate(() => moye.getState()), originalState);
      return { deferredDuringSyntheticComposition: true, appliedAfterCommit: true, realSystemIMEUntested: true };
    });
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally {
    if (app) { const child = app.process(), done = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await done; }
    report.pass = !report.fatalError && report.results.length === 5 && report.results.every(result => result.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
    await fs.writeFile(process.env.MOYE_SETTINGS_LIVE_OUTPUT || path.join(root, 'tests/settings-live-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failures: report.results.filter(result => result.status !== 'pass'), pageErrors: report.pageErrors, fatalError: report.fatalError }, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
