'use strict';

// Moye settings-experience regressions; not Telari or Typora differential tests.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-settings-experience-'));
  const profile = path.join(work, 'profile');
  const executable = process.env.MOYE_SETTINGS_EXPERIENCE_EXECUTABLE;
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye typography profile and settings experience regression, not original-app parity', results: [], pageErrors: [], remoteRequests: [], application: null };
  let app, page;
  const setting = key => page.locator(`input[data-setting-key="${key}"],select[data-setting-key="${key}"],textarea[data-setting-key="${key}"]`);
  async function launch() {
    app = await electron.launch({ executablePath: executable || require('electron'), args: [
      ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []),
      ...(executable ? [] : [path.join(root, 'electron/main.cjs')]),
    ], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    if (executable) assert.equal(report.application.isPackaged, true, 'A requested packaged run must load the actual package');
    page = await app.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => window.moye?.ready && window.MoyeTypography && window.MoyeTypographyView, null, { timeout: 30000 });
  }
  async function exit() {
    if (!app) return;
    const child = app.process();
    const done = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await done; app = null;
  }
  async function close() { await page.evaluate(() => moye.settings.panel.close()); }
  async function openSettings(key = 'appearance.fontSize') { await page.evaluate(key => moye.settings.panel.open(key), key); }
  async function values() { return page.evaluate(() => moye.settings.getValues()); }
  async function apply(patch) { await page.evaluate(patch => moye.settings.apply(patch), patch); }
  async function flush() { assert.equal(await page.evaluate(() => moye.settings.panel.flush()), true); }
  async function chooseProfile(id) {
    await page.locator('[data-typography-profile]').selectOption(id);
    await page.waitForFunction(id => moye.settings.getValues()['typography.activeProfile'] === id && document.getElementById('settings-dialog').getAttribute('aria-busy') !== 'true', id);
  }
  async function probe(name, run) {
    const started = Date.now();
    try { const details = await run(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  const file = path.join(work, 'mixed-profile.md');
  const original = '# 方案验收\r\n\r\n中文 English 2026 与 `Update()`。\r\n\r\n$$E=mc^2$$\r\n';
  let savedProfile;
  try {
    await fs.writeFile(file, original);
    await launch();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1 }); }, file);
    await page.evaluate(() => moye.performAction('open'));
    await probe('built-in profile changes real typography as one durable display operation and preserves CRLF document', async () => {
      await openSettings();
      const ids = await page.locator('[data-typography-profile] option').evaluateAll(options => options.map(option => option.value));
      assert.deepEqual(ids.slice(0, 4), ['daily', 'technical', 'book', 'compact']);
      const before = await page.evaluate(() => moye.getState());
      await chooseProfile('book');
      const current = await values();
      assert.equal(current['appearance.fontSize'], 19); assert.equal(current['appearance.contentWidth'], 720);
      assert.equal(current['typography.paragraphStyle'], 'indented');
      const actual = await page.evaluate(() => getComputedStyle(moye.editor.vditor.ir.element).fontSize);
      assert.equal(actual, '19px');
      assert.deepEqual(await page.evaluate(() => moye.getState()), before);
      assert.equal(await fs.readFile(file, 'utf8'), original);
      return { profile: current['typography.activeProfile'], fontSize: actual, documentUnchanged: true };
    });
    await probe('each typography field restores the selected profile baseline instead of global defaults', async () => {
      await setting('appearance.fontSize').fill('23'); await flush();
      assert.equal((await values())['appearance.fontSize'], 23);
      assert.equal(await page.locator('.moye-settings__profile-state').textContent(), '已调整');
      const reset = page.locator('[data-reset-setting="appearance.fontSize"]');
      assert.equal(await reset.textContent(), '恢复方案值');
      await reset.click();
      await page.waitForFunction(() => moye.settings.getValues()['appearance.fontSize'] === 19);
      assert.equal(await page.locator('.moye-settings__profile-state').textContent(), '与方案一致');
      assert.notEqual((await values())['appearance.fontSize'], await page.evaluate(() => MoyeSettingsSchema.defaults['appearance.fontSize']));
      return { restoredFontSize: 19, globalDefault: 17 };
    });
    await probe('draft sample previews immediately and before/current comparison does not revert durable settings', async () => {
      await close(); await openSettings();
      const before = await values();
      await page.locator('[data-typography-action="compare"]').check();
      const result = await page.evaluate(() => {
        const field = document.querySelector('input[data-setting-key="appearance.fontSize"]');
        field.value = '24'; field.dispatchEvent(new Event('input', { bubbles: true }));
        return { durable: moye.settings.getValues()['appearance.fontSize'], current: getComputedStyle(document.querySelector('[data-settings-preview="current"]')).fontSize, before: getComputedStyle(document.querySelector('[data-settings-preview="before"]')).fontSize };
      });
      assert.equal(result.durable, before['appearance.fontSize']); assert.equal(result.current, '24px'); assert.equal(result.before, '19px');
      await flush(); assert.equal((await values())['appearance.fontSize'], 24);
      await page.locator('[data-typography-action="compare"]').uncheck();
      assert.equal((await values())['appearance.fontSize'], 24);
      assert.equal(await page.locator('[data-settings-preview="current"] math').count(), 1);
      assert.ok(await page.locator('[data-settings-preview="current"] code').count() >= 1);
      return result;
    });
    await probe('current settings can be saved as a named profile and duplicate names fail without partial changes', async () => {
      await page.locator('[data-typography-name]').fill('我的中文方案');
      await page.locator('[data-typography-action="save"]').click();
      await page.waitForFunction(() => moye.settings.getValues()['typography.activeProfile'].startsWith('user-'));
      savedProfile = (await values())['typography.activeProfile'];
      const before = await values();
      const profile = await page.evaluate(id => MoyeTypography.getProfile(id, moye.settings.getValues()), savedProfile);
      assert.equal(profile.name, '我的中文方案'); assert.equal(profile.values['appearance.fontSize'], 24);
      await page.locator('[data-typography-name]').fill('我的中文方案');
      await page.locator('[data-typography-action="save"]').click();
      await page.waitForFunction(() => document.querySelector('.moye-settings__status').dataset.state === 'error');
      assert.deepEqual(await values(), before);
      return { id: savedProfile, name: profile.name, invalidSaveAtomic: true };
    });
    await probe('copy and confirmed delete manage profiles while preserving current typography', async () => {
      await page.locator('[data-typography-action="copy"]').click();
      await page.waitForFunction(id => moye.settings.getValues()['typography.activeProfile'] !== id && document.getElementById('settings-dialog').getAttribute('aria-busy') !== 'true', savedProfile);
      const copied = await values();
      const all = await page.evaluate(() => MoyeTypography.profiles(moye.settings.getValues()));
      assert.equal(all.filter(item => !item.builtin).length, 2);
      await page.locator('[data-typography-action="delete"]').click();
      assert.equal((await values())['typography.activeProfile'], copied['typography.activeProfile']);
      await page.locator('[data-typography-action="delete-cancel"]').click();
      assert.equal((await values())['typography.activeProfile'], copied['typography.activeProfile']);
      await page.locator('[data-typography-action="delete"]').click();
      await page.locator('[data-typography-action="delete"]').click();
      await page.waitForFunction(() => moye.settings.getValues()['typography.activeProfile'] === 'daily' && document.getElementById('settings-dialog').getAttribute('aria-busy') !== 'true');
      const next = await values();
      for (const key of await page.evaluate(() => [...MoyeTypography.profileKeys])) assert.equal(next[key], copied[key], key);
      return { copyRetainsValues: true, deleteRetainsValues: true };
    });
    await probe('search keeps unrelated results focused and profile cards can be found by typography words', async () => {
      await page.locator('#settings-search').fill('公式宏');
      assert.equal(await page.locator('.moye-settings__profile-card').isVisible(), false);
      assert.equal(await setting('math.macros').isVisible(), true);
      await page.locator('#settings-search').fill('排版方案');
      assert.equal(await page.locator('.moye-settings__profile-card').isVisible(), true);
      assert.equal(await page.locator('.moye-settings__preview-card').isVisible(), true);
      await page.locator('#settings-search').fill('');
      return { dedicatedTypographySearch: true };
    });
    await probe('settings input composition is not saved mid-composition and closes only after committed text', async () => {
      await openSettings('appearance.fontFamily');
      const before = (await values())['appearance.fontFamily'];
      await setting('appearance.fontFamily').evaluate(control => {
        control.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        control.value = '"Noto Sans SC", serif';
        control.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: '宋' }));
      });
      await page.waitForTimeout(450);
      assert.equal((await values())['appearance.fontFamily'], before);
      assert.equal(await page.evaluate(() => moye.settings.panel.flush()), false);
      assert.equal(await page.evaluate(() => moye.settings.panel.isOpen()), true);
      await setting('appearance.fontFamily').evaluate(control => control.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '宋' })));
      await flush();
      assert.equal((await values())['appearance.fontFamily'], '"Noto Sans SC", serif');
      return { syntheticCompositionGuard: true, realSystemIMEUntested: true };
    });
    await probe('profile operations retain disabled formula controls for the selected engine', async () => {
      await apply({ 'math.engine': 'KaTeX' });
      await openSettings('appearance.fontSize'); await chooseProfile('daily');
      await openSettings('math.autoNumber');
      for (const key of ['math.autoNumber', 'math.numberingStyle', 'math.physics']) {
        assert.equal(await setting(key).isDisabled(), true);
        assert.equal(await page.locator(`[data-reset-setting="${key}"]`).isDisabled(), true);
      }
      await apply({ 'math.engine': 'MathJax' });
      return { engineDependenciesRetained: true };
    });
    await probe('profiles persist across an actual application restart', async () => {
      await openSettings('appearance.fontSize'); await chooseProfile(savedProfile); await close();
      const before = await values();
      await exit(); await launch();
      const after = await values();
      assert.equal(after['typography.savedProfiles'], before['typography.savedProfiles']);
      assert.equal(after['typography.activeProfile'], savedProfile);
      assert.equal(after['appearance.fontSize'], 24);
      return { activeProfile: savedProfile, fontSize: after['appearance.fontSize'] };
    });
    await probe('compact settings remain usable with profile controls and comparison on a narrow viewport', async () => {
      await page.setViewportSize({ width: 480, height: 760 });
      await openSettings(); await page.locator('[data-typography-action="compare"]').check();
      const geometry = await page.locator('#settings-dialog').evaluate(dialog => ({ width: dialog.getBoundingClientRect().width, viewport: innerWidth, overflow: dialog.scrollWidth > dialog.clientWidth + 1 }));
      assert.ok(geometry.width <= geometry.viewport); assert.equal(geometry.overflow, false);
      await page.locator('[data-typography-name]').fill('窄屏方案');
      await page.locator('[data-typography-action="save"]').click();
      await page.waitForFunction(() => MoyeTypography.getProfile(moye.settings.getValues()['typography.activeProfile'], moye.settings.getValues())?.name === '窄屏方案');
      if (process.env.MOYE_SETTINGS_EXPERIENCE_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.MOYE_SETTINGS_EXPERIENCE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.MOYE_SETTINGS_EXPERIENCE_SCREENSHOT_DIR, 'settings-experience-narrow.png') });
      }
      await close(); await page.setViewportSize({ width: 1280, height: 900 });
      return geometry;
    });
    assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
    assert.equal(report.remoteRequests.length, 0, 'settings samples must remain offline');
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally {
    await exit().catch(() => {});
    report.pass = !report.fatalError && report.pageErrors.length === 0 && report.remoteRequests.length === 0 && report.results.length === 10 && report.results.every(result => result.status === 'pass');
    await fs.writeFile(process.env.MOYE_SETTINGS_EXPERIENCE_OUTPUT || path.join(root, 'tests/settings-experience-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failures: report.results.filter(result => result.status !== 'pass'), fatalError: report.fatalError }, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
