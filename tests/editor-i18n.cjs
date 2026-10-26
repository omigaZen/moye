'use strict';
// Real Electron UI, native adapters, persistence and document-safety regression.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-i18n-'));
  const executable = process.env.MOYE_I18N_EXECUTABLE, profile = path.join(work, 'profile');
  const file = path.join(work, '保存.md');
  const original = '# 保存\n\n偏好设置 文件 打开，不是界面标签。\n\n脚注[^保存] 与 $\\text{保存}+1$。\n\n[^保存]: 保存与偏好设置是原文。\n\n```js\nconst 保存 = "打开";\n```\n';
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye bilingual UI, native controls and document protection; not Telari language parity or real operating-system IME certification', results: [], pageErrors: [], remoteRequests: [] };
  let app, page;
  async function launch() {
    app = await electron.launch({ executablePath: executable || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(executable ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }));
    if (executable) assert.equal(report.application.isPackaged, true);
    page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.waitForFunction(() => window.moye?.ready && window.moye.i18n, null, { timeout: 30000 });
  }
  async function exit() {
    if (!app) return;
    const child = app.process(), done = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await done; app = null;
  }
  async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function apply(locale) { await page.evaluate(locale => moye.settings.apply({ 'ui.language': locale }), locale); await frames(); }
  async function probe(name, operation) { try { const details = await operation(); report.results.push({ name, status: 'pass', ...(details ? { details } : {}) }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); } }
  async function closeSettings() { await page.evaluate(() => moye.settings.panel.close()); await frames(); }
  try {
    await fs.writeFile(file, original); await launch();
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 2 }); }, file);
    await page.evaluate(() => moye.performAction('open')); await frames();
    await probe('language switches the actual header, preferences and native menu without restarting', async () => {
      assert.equal(await page.locator('#live-mode').textContent(), '书写');
      await apply('en-US');
      assert.equal(await page.locator('html').getAttribute('lang'), 'en-US');
      assert.equal(await page.locator('#live-mode').textContent(), 'Write'); assert.equal(await page.locator('#source-mode').textContent(), 'Source');
      assert.equal(await page.evaluate(() => window.VditorI18n.bold), 'Bold');
      const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label));
      assert.ok(labels.includes('File')); assert.ok(labels.includes('Edit')); assert.ok(labels.includes('View'));
      await page.evaluate(() => moye.settings.panel.open('appearance.fontSize')); await frames();
      assert.equal(await page.locator('.moye-settings__header h2').textContent(), 'Preferences');
      assert.equal(await page.locator('.moye-settings__row[data-setting="appearance.fontSize"] .moye-settings__label').textContent(), 'Body font size');
      return { locale: 'en-US', nativeMenuTranslated: true, preferencesTranslated: true };
    });
    await probe('English search, descriptions and composed theme warnings preserve canonical control values', async () => {
      const search = page.locator('#settings-search'); await search.fill('equation'); await frames();
      assert.equal(await page.locator('.moye-settings__row[data-setting="math.autoNumber"]').isVisible(), true);
      assert.equal(await page.locator('.moye-settings__row[data-setting="math.autoNumber"] .moye-settings__label').textContent(), 'Automatic equation numbering');
      await search.fill('font'); await frames();
      assert.equal(await page.locator('.moye-settings__row[data-setting="appearance.fontFamily"]').isVisible(), true);
      assert.equal(await page.locator('.moye-settings__profile-card').isVisible(), true);
      assert.match(await page.locator('.moye-settings__row[data-setting="appearance.fontFamily"] .moye-settings__description').textContent(), /CSS font-family/);
      assert.equal(await page.locator('select[data-setting-key="ui.language"]').inputValue(), 'en-US');
      const details = page.locator('.moye-theme-editor'); if (!await details.evaluate(element => element.open)) await details.locator('summary').first().click();
      const themeSource = '[meta]\nname = "保存"\nappearance = "light"\nbased_on = "custom:missing-theme"\n\n[colors]\ntext = "#111111"\n';
      await page.locator('[data-color-theme-source]').fill(themeSource); await frames();
      const themeStatus = page.locator('.moye-theme-editor__status');
      assert.ok(await themeStatus.locator('.moye-theme-editor__status-part').count() >= 2);
      assert.match(await themeStatus.textContent(), /^Draft preview\. Save before applying\./);
      assert.match(await themeStatus.textContent(), /custom:missing-theme/);
      assert.equal(/\p{Script=Han}/u.test(await themeStatus.textContent()), false);
      await apply('zh-CN'); assert.match(await themeStatus.textContent(), /^草稿预览，保存后才应用。/); assert.match(await themeStatus.textContent(), /找不到主题 custom:missing-theme/);
      await apply('en-US'); assert.match(await themeStatus.textContent(), /^Draft preview\. Save before applying\./);
      assert.equal(/\p{Script=Han}/u.test(await themeStatus.textContent()), false);
      assert.equal(await page.locator('[data-color-theme-source]').inputValue(), themeSource);
      await closeSettings(); return { englishSearch: true, composedWarningsTranslatedBothWays: true, themeSourceAndNamePreserved: true, configurationValuesUntranslated: true };
    });
    await probe('repeated locale changes preserve exact source, reverse selection and undo history', async () => {
      await page.evaluate(() => { moye.setMode('sv'); const e = moye.editor.vditor.sv.element; e.focus(); e.setSelectionRange(3, 15, 'backward'); }); await frames();
      const before = await page.evaluate(() => { const e = moye.editor.vditor.sv.element, u = moye.editor.vditor.undo.sv; return { state: moye.getState(), value: e.value, selection: [e.selectionStart, e.selectionEnd, e.selectionDirection], undo: JSON.stringify(u) }; });
      for (const locale of ['zh-CN', 'en-US', 'zh-CN', 'en-US']) await apply(locale);
      const after = await page.evaluate(() => { const e = moye.editor.vditor.sv.element, u = moye.editor.vditor.undo.sv; return { state: moye.getState(), value: e.value, selection: [e.selectionStart, e.selectionEnd, e.selectionDirection], undo: JSON.stringify(u) }; });
      assert.deepEqual(after, before); assert.equal(await fs.readFile(file, 'utf8'), original);
      assert.equal(await page.locator('#document-name').textContent(), '保存.md');
      return { exactSource: true, reverseSelection: after.selection, undoExact: true, diskUntouched: true };
    });
    await probe('custom preset names, recent file names, paths and search input are not translated', async () => {
      await page.evaluate(async () => { await moye.settings.apply(MoyeTypography.saveProfile(moye.settings.getValues(), '保存')); moye.settings.panel.open('appearance.fontSize'); }); await frames();
      const customName = await page.locator('[data-typography-profile] option:checked').textContent();
      assert.equal(customName, '保存 · Custom');
      await apply('zh-CN'); assert.equal(await page.locator('[data-typography-profile] option:checked').textContent(), '保存 · 自定义');
      await apply('en-US'); await closeSettings();
      await page.evaluate(() => moye.performAction('recent')); await frames();
      assert.equal(await page.locator('.moye-recent h2').textContent(), 'Recent files');
      assert.equal(await page.locator('.moye-recent__name').first().textContent(), '保存.md');
      assert.equal(await page.locator('.moye-recent__path').first().textContent(), file);
      assert.equal(await page.locator('[data-recent-open]').first().getAttribute('title'), file);
      assert.equal(/\p{Script=Han}/u.test(await page.locator('.moye-recent__time').first().textContent()), false);
      assert.equal(await page.locator('[data-recent-remove]').first().getAttribute('aria-label'), 'Remove record 保存.md');
      const input = page.locator('.moye-recent__search'); await input.fill('保存'); await apply('zh-CN'); await apply('en-US');
      assert.equal(await input.inputValue(), '保存');
      assert.equal(await page.locator('.moye-recent__name').first().textContent(), '保存.md');
      await page.locator('[data-recent-action="close"]').click();
      const directory = path.join(work, '保存'); await fs.mkdir(directory); const workspaceName = '保存：文件.md'; await fs.writeFile(path.join(directory, workspaceName), '# 文件\n');
      await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
      await page.evaluate(() => moye.performAction('workspace')); await frames();
      assert.equal(await page.locator('.moye-workspace__heading strong').textContent(), '保存');
      assert.equal(await page.locator('.moye-workspace__name').textContent(), workspaceName);
      assert.equal(await page.locator('.moye-workspace__item').getAttribute('title'), workspaceName);
      assert.equal(await page.locator('.moye-workspace__tree').getAttribute('aria-label'), 'Document file tree');
      await page.locator('.moye-workspace__filter').fill('nothing-matches-this-file');
      await page.waitForFunction(() => document.querySelector('.moye-workspace__message').textContent === 'No matching files in this workspace.');
      assert.equal(await page.locator('.moye-workspace__filter').inputValue(), 'nothing-matches-this-file');
      const empty = path.join(work, '空目录'); await fs.mkdir(empty);
      await app.evaluate(({ dialog }, empty) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [empty] }); }, empty);
      await page.evaluate(() => moye.performAction('workspace')); await frames();
      await page.locator('.moye-workspace__filter').fill('');
      await page.waitForFunction(() => document.querySelector('.moye-workspace__message').textContent === 'This folder contains no Markdown or TXT documents.');
      assert.equal(await page.locator('.moye-workspace__item').count(), 0);
      assert.equal(await page.locator('.moye-workspace__heading strong').textContent(), '空目录');
      await page.locator('[data-workspace-action="hide"]').click();
      return { customNamePreserved: true, fileNamePreserved: true, pathPreserved: true, folderNamePreserved: true, treeAriaTranslated: true, emptyAndFilteredMessagesTranslated: true, inputPreserved: true };
    });
    await probe('reading controls, editor accessibility and owned code-copy UI are translated without translating document text', async () => {
      await page.evaluate(async () => { moye.setMode('ir'); moye.setReading(true); await moye.reading.whenReady(); }); await frames();
      assert.equal(await page.locator('.moye-reading__controls [data-reading-action="edit"]').textContent(), 'Return to writing');
      const content = await page.evaluate(() => moye.reading.getRoot().textContent); assert.match(content, /偏好设置 文件 打开/); assert.match(content, /const 保存/);
      assert.match(await page.locator('.moye-reading-content').getAttribute('aria-label'), /^Read-only document/);
      const copy = page.locator('.moye-reading-content .moye-code-copy').first();
      await copy.waitFor(); assert.equal(await copy.getAttribute('aria-label'), 'Copy code');
      assert.equal(await page.evaluate(() => moye.getState().content), original);
      await page.evaluate(() => moye.setReading(false)); await frames();
      return { contentUntranslated: true, readingControlsTranslated: true, copyControlTranslated: true };
    });
    await probe('external language changes wait until composition ends and preserve committed text', async () => {
      await page.evaluate(() => { moye.setMode('sv'); const e = moye.editor.vditor.sv.element; e.focus(); e.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '临' })); });
      await page.evaluate(async () => { const s = await desktop.getSettings(); await desktop.updateSettings({ patch: { 'ui.language': 'zh-CN' }, expectedRevision: s.revision }); }); await frames();
      assert.equal(await page.locator('#live-mode').textContent(), 'Write');
      await page.evaluate(() => moye.editor.vditor.sv.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '临' })));
      await page.waitForFunction(() => moye.settings.getValues()['ui.language'] === 'zh-CN'); await frames();
      assert.equal(await page.locator('#live-mode').textContent(), '书写'); assert.equal(await page.evaluate(() => window.VditorI18n.bold), '粗体'); assert.equal(await page.evaluate(() => moye.getState().content), original);
      return { deferredDuringComposition: true, appliedAfterComposition: true, committedSourceExact: true };
    });
    await probe('English preference survives a full restart and native open dialog uses English application labels', async () => {
      await apply('en-US'); await exit(); await launch(); await frames();
      assert.equal(await page.evaluate(() => moye.settings.getValues()['ui.language']), 'en-US'); assert.equal(await page.locator('#live-mode').textContent(), 'Write');
      await app.evaluate(({ app, dialog }) => { dialog.showOpenDialog = async (...args) => { app.moyeI18nDialog = args.at(-1); return { canceled: true, filePaths: [] }; }; });
      await page.evaluate(() => moye.performAction('open'));
      const dialog = await app.evaluate(({ app }) => app.moyeI18nDialog);
      assert.equal(dialog.title, 'Open Markdown document'); assert.equal(dialog.buttonLabel, 'Open'); assert.equal(dialog.filters[0].name, 'Markdown documents');
      return { persisted: true, nativeDialogTranslated: true };
    });
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally { await exit(); await fs.rm(work, { recursive: true, force: true, maxRetries: 5 }); report.pass = report.results.length === 7 && report.results.every(result => result.status === 'pass') && !report.pageErrors.length && !report.remoteRequests.length && !report.fatalError; await fs.writeFile(process.env.MOYE_I18N_OUTPUT || path.join(root, 'tests/i18n-report.json'), JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
