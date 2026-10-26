'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-color-theme-ui-'));
  const profile = path.join(work, 'profile');
  const executable = process.env.MOYE_COLOR_THEMES_EXECUTABLE;
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Independent Moye custom colour theme regression; restricted TOML, not Telari theme-format parity', application: null, results: [], pageErrors: [], remoteRequests: [] };
  const raw = (name, body = '#123456', appearance = 'light', base = 'moye', extra = '') => `[meta]\nname = ${JSON.stringify(name)}\nappearance = "${appearance}"\nbased_on = "${base}"\n[colors]\nbody = "${body}"\npaper = "#faf8ef"\n${extra}`;
  let app, page, themeDirectory;
  const source = () => page.locator('[data-color-theme-source]');
  async function launch() {
    app = await electron.launch({ executablePath: executable || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(executable ? [] : [path.join(root, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    if (executable) assert.equal(report.application.isPackaged, true, 'Packaged runs cannot fall back to source');
    page = await app.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => window.moye?.ready && window.desktop?.getThemes && window.MoyeColorThemes && document.querySelector('.moye-theme-editor'), null, { timeout: 30000 });
    themeDirectory = await page.evaluate(async () => (await desktop.getThemes()).directory);
  }
  async function exit() {
    if (!app) return;
    const child = app.process(), finished = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await finished; app = null;
  }
  async function showEditor() {
    await page.evaluate(() => moye.settings.panel.open('typography.colorTheme'));
    await page.locator('.moye-theme-editor').evaluate(details => { details.open = true; });
    await page.locator('[data-color-theme-action="copy"]').waitFor({ state: 'visible' });
  }
  async function nativeSave(fileName, content, expectedHash = null) { return page.evaluate(payload => desktop.saveTheme(payload), { fileName, content, expectedHash }); }
  async function snapshot() { return page.evaluate(() => desktop.getThemes()); }
  async function apply(id, appearance = 'light') { await page.evaluate(async ({ id, appearance }) => moye.settings.apply({ 'appearance.theme': appearance, 'typography.colorTheme': id }), { id, appearance }); }
  async function ink(expected) { await page.waitForFunction(expected => getComputedStyle(document.body).getPropertyValue('--ink').trim().toLowerCase() === expected, expected); }
  async function probe(name, run) {
    const started = Date.now();
    try { const details = await run(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  let documentState;
  try {
    await launch();
    documentState = await page.evaluate(() => moye.getState());
    await probe('copying and editing a theme previews safe colours without applying the draft to the app', async () => {
      await showEditor(); await page.locator('[data-color-theme-action="copy"]').click();
      const before = await page.evaluate(() => ({ theme: moye.settings.getValues()['typography.colorTheme'], ink: getComputedStyle(document.body).getPropertyValue('--ink').trim() }));
      await page.locator('[data-color-theme-filename]').fill('paper.toml'); await source().fill(raw('纸张主题'));
      const preview = await page.locator('[data-color-theme-preview]').evaluate(element => getComputedStyle(element).color);
      assert.equal(preview, 'rgb(18, 52, 86)');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink').trim()), before.ink);
      assert.equal(await page.evaluate(() => moye.settings.getValues()['typography.colorTheme']), before.theme);
      assert.equal((await snapshot()).themes.length, 0);
      return { preview, appThemeUnchanged: true };
    });
    await probe('saving and applying a custom theme updates real UI colours without rewriting or relaying out content', async () => {
      const before = await page.evaluate(() => [...moye.editor.vditor.ir.element.children].map(element => [element.offsetTop, element.offsetHeight]));
      await page.locator('[data-color-theme-action="save"]').click();
      await page.waitForFunction(async () => (await desktop.getThemes()).themes.some(theme => theme.id === 'custom:paper'));
      await page.locator('[data-color-theme-action="apply"]').click(); await ink('#123456');
      assert.equal(await page.evaluate(() => moye.settings.getValues()['typography.colorTheme']), 'custom:paper');
      assert.deepEqual(await page.evaluate(() => [...moye.editor.vditor.ir.element.children].map(element => [element.offsetTop, element.offsetHeight])), before);
      assert.deepEqual(await page.evaluate(() => moye.getState()), documentState);
      const persisted = (await snapshot()).themes.find(theme => theme.id === 'custom:paper');
      assert.equal(persisted.content, raw('纸张主题')); assert.match(persisted.hash, /^[a-f0-9]{64}$/);
      return { actualBodyColour: '#123456', layoutUnchanged: true, sourceUnchanged: true };
    });
    await probe('custom themes inherit base colours and skip individual invalid colour keys offline', async () => {
      await nativeSave('child.toml', '[meta]\nname = "子主题"\nappearance = "light"\nbased_on = "custom:paper"\n[colors]\nheading = "#654321"\nlink = "url(https://invalid.test/a)"\n');
      await apply('custom:child'); await ink('#123456');
      const result = await page.evaluate(() => ({ heading: getComputedStyle(document.body).getPropertyValue('--theme-heading').trim(), link: getComputedStyle(document.body).getPropertyValue('--theme-link').trim() }));
      assert.equal(result.heading, '#654321'); assert.equal(result.link, '#47705b');
      const child = (await snapshot()).themes.find(theme => theme.id === 'custom:child'); assert.equal(child.warnings.length, 1);
      assert.equal(report.remoteRequests.length, 0);
      return { inheritedBody: '#123456', ...result, ignoredKeyDiagnostics: child.warnings.length };
    });
    await probe('external atomic file replacement live-updates an inherited active theme', async () => {
      const temporary = path.join(themeDirectory, '.external-paper.tmp');
      await fs.writeFile(temporary, raw('外部纸张', '#204060'));
      await fs.rename(temporary, path.join(themeDirectory, 'paper.toml'));
      await ink('#204060');
      assert.deepEqual(await page.evaluate(() => moye.getState()), documentState);
      return { hotReloadedBody: '#204060', documentUnchanged: true };
    });
    await probe('an external edit preserves the in-panel draft and stale save cannot overwrite disk', async () => {
      await showEditor(); await page.locator('[data-color-theme-file]').selectOption('paper.toml');
      await source().fill(raw('本地草稿', '#998877'));
      const disk = raw('新的外部版本', '#345678'); await fs.writeFile(path.join(themeDirectory, 'paper.toml'), disk);
      await page.locator('[data-color-theme-action="reload"]').waitFor({ state: 'visible' });
      assert.equal(await source().inputValue(), raw('本地草稿', '#998877'));
      await page.locator('[data-color-theme-action="save"]').click();
      await page.waitForFunction(() => document.querySelector('.moye-theme-editor__status').dataset.state === 'error');
      assert.equal(await fs.readFile(path.join(themeDirectory, 'paper.toml'), 'utf8'), disk);
      assert.equal(await source().inputValue(), raw('本地草稿', '#998877'));
      await page.locator('[data-color-theme-action="reload"]').click(); assert.equal(await source().inputValue(), disk);
      return { draftPreserved: true, externalVersionNotOverwritten: true };
    });
    await probe('malformed external files are isolated and remain editable through diagnostics', async () => {
      const invalid = '[meta]\nname = "有误"\nappearance = "unknown"\n';
      await fs.writeFile(path.join(themeDirectory, 'broken.toml'), invalid);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-color-theme-file] option')].some(option => option.value === 'broken.toml'));
      const current = await snapshot(); assert.ok(current.themes.some(theme => theme.id === 'custom:paper')); assert.ok(current.errors.some(error => error.fileName === 'broken.toml'));
      await page.locator('[data-color-theme-file]').selectOption('broken.toml'); assert.equal(await source().inputValue(), invalid);
      assert.equal(await page.locator('[data-color-theme-action="save"]').isDisabled(), true);
      await source().fill(raw('已修复', '#456789')); await page.locator('[data-color-theme-action="save"]').click();
      await page.waitForFunction(async () => (await desktop.getThemes()).themes.some(theme => theme.id === 'custom:broken'));
      assert.equal((await snapshot()).errors.some(error => error.fileName === 'broken.toml'), false);
      return { invalidFileIsolated: true, repairedThroughEditor: true };
    });
    await probe('switching theme files retains unsaved per-file drafts without writing them', async () => {
      await showEditor(); await page.locator('[data-color-theme-file]').selectOption('paper.toml');
      const disk = await fs.readFile(path.join(themeDirectory, 'paper.toml'), 'utf8');
      const draft = raw('尚未保存', '#445566'); await source().fill(draft);
      await page.locator('[data-color-theme-file]').selectOption('child.toml');
      await page.locator('[data-color-theme-file]').selectOption('paper.toml');
      assert.equal(await source().inputValue(), draft);
      assert.equal(await fs.readFile(path.join(themeDirectory, 'paper.toml'), 'utf8'), disk);
      await source().fill(disk); await page.locator('[data-color-theme-action="save"]').click();
      await page.waitForFunction(() => document.querySelector('.moye-theme-editor__status').dataset.state === 'saved');
      return { unsavedDraftRetained: true, diskNotChangedBySelection: true };
    });
    await probe('appearance mismatch is explicit and becomes usable after switching the app appearance', async () => {
      await nativeSave('night.toml', raw('夜间', '#abcabc', 'dark'));
      await apply('moye', 'light'); await showEditor();
      await page.locator('[data-color-theme-file]').selectOption('night.toml');
      const button = page.locator('[data-color-theme-action="apply"]');
      assert.equal(await button.isDisabled(), true); assert.match(await button.getAttribute('title'), /深色/);
      await page.evaluate(() => moye.settings.apply({ 'appearance.theme': 'dark' }));
      await button.click(); await ink('#abcabc');
      return { mismatchVisible: true, appliedAfterMatchingAppearance: true };
    });
    await probe('custom theme files and selected theme survive an actual app restart', async () => {
      await page.evaluate(() => moye.settings.panel.close()); await exit(); await launch(); await ink('#abcabc');
      assert.equal(await page.evaluate(() => moye.settings.getValues()['typography.colorTheme']), 'custom:night');
      assert.ok((await snapshot()).themes.some(theme => theme.id === 'custom:night'));
      return { theme: 'custom:night', persistedFile: true };
    });
    await probe('deleting the active theme is confirmed, leaves the document intact and reports missing selection safely', async () => {
      await showEditor(); await page.locator('[data-color-theme-file]').selectOption('night.toml');
      const before = await page.evaluate(() => moye.getState());
      await page.locator('[data-color-theme-action="delete"]').click(); assert.ok((await snapshot()).themes.some(theme => theme.id === 'custom:night'));
      await page.locator('[data-color-theme-action="delete"]').click();
      await page.waitForFunction(async () => !(await desktop.getThemes()).themes.some(theme => theme.id === 'custom:night'));
      assert.deepEqual(await page.evaluate(() => moye.getState()), before);
      await ink('#d5ddd5');
      return { confirmedDelete: true, sourceUnchanged: true, safeFallback: true };
    });
    if (process.env.MOYE_COLOR_THEMES_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.MOYE_COLOR_THEMES_SCREENSHOT_DIR, { recursive: true });
      await showEditor(); await page.locator('[data-color-theme-file]').selectOption('paper.toml');
      await source().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.MOYE_COLOR_THEMES_SCREENSHOT_DIR, 'custom-color-theme-editor.png') });
    }
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally {
    await exit().catch(() => {});
    report.pass = !report.fatalError && report.results.length === 10 && report.results.every(result => result.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
    await fs.writeFile(process.env.MOYE_COLOR_THEMES_OUTPUT || path.join(root, 'tests/color-themes-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failures: report.results.filter(result => result.status !== 'pass'), pageErrors: report.pageErrors, fatalError: report.fatalError }, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
