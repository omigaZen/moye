'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-typography-'));
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye independent typography profiles, view-only mixed-script presentation and read-only paragraph optimisation; not Telari runtime differential acceptance', results: [], pageErrors: [], remoteRequests: [], limitations: ['Headless Linux checks do not cover real system IME, every font or native Windows/macOS.', 'Browser justification and native hanging-punctuation capability are separate from the bounded read-only box/glue/penalty optimiser.'] };
  let app, page, number = 0;
  const probe = async (name, operation) => {
    if (process.env.MOYE_TYPOGRAPHY_FILTER && !name.includes(process.env.MOYE_TYPOGRAPHY_FILTER)) return;
    const started = Date.now();
    try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  };
  async function launch() {
    app = await electron.launch({ executablePath: process.env.MOYE_TYPOGRAPHY_EXECUTABLE || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_TYPOGRAPHY_EXECUTABLE ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    await app.evaluate(({ app, session }) => { app.moyeTypographyRequests = []; session.defaultSession.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) app.moyeTypographyRequests.push(details.url); callback({ cancel: /^https?:/.test(details.url) }); }); });
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort()); await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && moye.typography && window.MoyeParagraphTypesetter, null, { timeout: 30000 });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (process.env.MOYE_TYPOGRAPHY_EXECUTABLE) assert.equal(report.application.isPackaged, true);
  }
  async function open(content) {
    const file = path.join(work, `typography-${++number}.md`); await fs.writeFile(file, content);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1 }); }, file);
    await page.evaluate(async () => { await moye.settings.panel.close(); moye.setReading(false); await moye.performAction('open'); moye.setMode('ir'); });
    return file;
  }
  async function profile(id) { return page.evaluate(async id => { await moye.settings.apply(MoyeTypography.applyProfile(id, moye.settings.getValues())); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, id); }
  async function state() { return page.evaluate(() => moye.getState()); }
  try {
    await launch();
    await probe('built-in profiles change actual typography and table settings without rewriting a clean document', async () => {
      const raw = '# 排版\n\n中文Unity开发文档与English text。\n\n| A | B |\n| --- | --- |\n| one | two |\n';
      const file = await open(raw), stages = [];
      for (const id of ['daily', 'technical', 'book', 'compact', 'daily']) {
        await profile(id);
        const details = await page.evaluate(() => { const root = moye.editor.vditor.ir.element, p = root.querySelector('p'), css = getComputedStyle(p), values = moye.settings.getValues(); return { active: values['typography.activeProfile'], modified: MoyeTypography.modified(values), fontSize: parseFloat(css.fontSize), lineHeight: parseFloat(css.lineHeight), indent: parseFloat(css.textIndent), tableLayout: values['table.layout'], tableStyle: values['table.style'], source: moye.getState().content, dirty: moye.getState().dirty }; });
        assert.equal(details.active, id); assert.equal(details.modified, false); assert.equal(details.source, raw); assert.equal(details.dirty, false);
        assert.equal(details.fontSize, id === 'book' ? 19 : id === 'compact' ? 15 : 17);
        assert.equal(details.indent > 0, id === 'book'); stages.push(details);
      }
      await page.evaluate(() => moye.performAction('save')); assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { stages, cleanDiskSourceExact: true };
    });
    await probe('custom profiles save and clone named current values, survive restart, and delete without resetting appearance', async () => {
      await profile('technical'); await page.evaluate(async () => { await moye.settings.apply({ 'appearance.fontSize': 20 }); await moye.settings.apply(MoyeTypography.saveProfile(moye.settings.getValues(), '用户方案')); });
      let before = await page.evaluate(() => ({ values: moye.settings.getValues(), baseline: MoyeTypography.baseline(moye.settings.getValues()), modified: MoyeTypography.modified(moye.settings.getValues()) }));
      const selected = before.values['typography.activeProfile']; assert.equal(before.baseline['appearance.fontSize'], 20); assert.equal(before.modified, false);
      report.remoteRequests.push(...await app.evaluate(({ app }) => app.moyeTypographyRequests || [])); await app.close(); app = null; await launch();
      const persisted = await page.evaluate(() => moye.settings.getValues()); assert.equal(persisted['typography.activeProfile'], selected); assert.equal(persisted['appearance.fontSize'], 20);
      const details = await page.evaluate(async () => {
        await moye.settings.apply(MoyeTypography.saveProfile(moye.settings.getValues(), '用户方案副本'));
        const cloned = moye.settings.getValues()['typography.activeProfile'];
        await moye.settings.apply(MoyeTypography.removeProfile(cloned, moye.settings.getValues()));
        const values = moye.settings.getValues(); return { cloned, values, modified: MoyeTypography.modified(values), profiles: MoyeTypography.profiles(values).map(p => p.name) };
      });
      assert.equal(details.values['appearance.fontSize'], 20); assert.equal(details.values['typography.activeProfile'], 'daily'); assert.equal(details.modified, true); assert.ok(details.profiles.includes('用户方案')); assert.ok(!details.profiles.includes('用户方案副本'));
      return { persistedProfile: selected, cloned: details.cloned, deletedWithoutAppearanceReset: true };
    });
    await probe('profile changes retain a backward source selection, pending edits and a meaningful undo step', async () => {
      await open('before\n'); await profile('daily');
      await page.evaluate(() => { moye.setMode('sv'); const source = moye.editor.vditor.sv.element; source.focus(); source.setSelectionRange(1, 5, 'backward'); });
      await profile('technical');
      const selection = await page.evaluate(() => { const e = moye.editor.vditor.sv.element; return [e.selectionStart, e.selectionEnd, e.selectionDirection, e.value]; });
      assert.deepEqual(selection, [1, 5, 'backward', 'before\n']);
      await page.evaluate(() => { const e = moye.editor.vditor.sv.element; e.focus(); e.setSelectionRange(6, 6); });
      await page.keyboard.insertText(' added'); await page.waitForTimeout(450); const edited = await state(); assert.equal(edited.content, 'before added\n'); assert.equal(edited.dirty, true);
      await profile('compact'); await page.locator('.vditor-sv').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await page.waitForTimeout(80);
      assert.equal((await state()).content, 'before\n');
      return { backwardSelection: selection.slice(0, 3), unsavedEditsPreserved: true, undoRestoredPriorText: true };
    });
    await probe('mixed-script view settings leave editable DOM intact and scope spacing away from code and formulas', async () => {
      await profile('daily'); await open('中文Unity开发，版本v1.2。\n\n`中文API` 与 $x$。\n');
      const details = await page.evaluate(() => {
        const ir = moye.editor.vditor.ir.element, host = ir.closest('.vditor'), original = ir.innerHTML, observer = new MutationObserver(() => {}); observer.observe(ir, { childList: true, characterData: true, subtree: true });
        MoyeTypographyView.applyTo(host, { ...moye.settings.getValues(), 'typography.cjkSpacing': true, 'typography.latinFontFamily': '"Liberation Serif", serif', 'typography.cjkFontFamily': '"Noto Sans SC", sans-serif' });
        const changes = observer.takeRecords().length; observer.disconnect();
        const code = ir.querySelector('p code'), result = { changes, exactDOM: ir.innerHTML === original, proseFont: getComputedStyle(ir.querySelector('p')).fontFamily, proseAutospace: getComputedStyle(ir.querySelector('p')).textAutospace, codeAutospace: code ? getComputedStyle(code).textAutospace : null, capabilities: MoyeTypographyView.capabilities() };
        const sample = document.createElement('div'); sample.dataset.settingsPreview = 'current'; sample.style.cssText = 'display:inline-block;position:fixed;left:-10000px;white-space:nowrap'; sample.textContent = '中文Unity开发'; document.body.append(sample);
        MoyeTypographyView.applyTo(sample, { ...moye.settings.getValues(), 'typography.cjkSpacing': false }); result.unspacedWidth = sample.getBoundingClientRect().width;
        MoyeTypographyView.applyTo(sample, { ...moye.settings.getValues(), 'typography.cjkSpacing': true }); result.spacedWidth = sample.getBoundingClientRect().width; sample.remove();
        moye.typography.refresh(); return result;
      });
      assert.equal(details.changes, 0); assert.equal(details.exactDOM, true); assert.match(details.proseFont, /MoyeRole-Latin/);
      if (details.capabilities.textAutospace) { assert.equal(details.proseAutospace, 'normal'); assert.equal(details.codeAutospace, 'no-autospace'); assert.ok(details.spacedWidth > details.unspacedWidth + 1, JSON.stringify(details)); }
      return details;
    });
    await probe('colour themes repaint without changing paragraph geometry or reading text', async () => {
      await profile('daily'); await open('第一段中文English。\n\n第二段文字。\n');
      const stages = [];
      for (const theme of ['moye', 'mono', 'solarized', 'nord', 'moye']) {
        await page.evaluate(async theme => { await moye.settings.apply({ 'typography.colorTheme': theme }); await new Promise(resolve => requestAnimationFrame(resolve)); }, theme);
        stages.push(await page.evaluate(() => { const p = moye.editor.vditor.ir.element.querySelector('p'), r = p.getBoundingClientRect(); return { width: r.width, height: r.height, font: getComputedStyle(p).font, ink: getComputedStyle(p).color, paper: getComputedStyle(p).backgroundColor, source: moye.getState().content }; }));
      }
      assert.ok(new Set(stages.map(stage => stage.ink)).size >= 3);
      for (const stage of stages) { assert.equal(stage.width, stages[0].width); assert.equal(stage.height, stages[0].height); assert.equal(stage.font, stages[0].font); assert.equal(stage.source, stages[0].source); }
      return { stages, geometryUnchanged: true };
    });
    await probe('read-only paragraph optimisation uses chosen line breaks and preserves text, inline formatting and editable source', async () => {
      const raw = '# 阅读排版\n\n' + '中文混排English与Unity阅读测试，保持文字和标点。'.repeat(16) + '**重点内容**与[参考链接](https://example.test)。\n';
      await open(raw); await profile('daily'); await page.evaluate(() => moye.setReading(true));
      const original = await page.evaluate(() => moye.reading.getRoot().textContent);
      await profile('book');
      await page.waitForFunction(() => moye.reading.getRoot()?.querySelector('[data-moye-typeset="optimal"]'), null, { timeout: 10000 });
      const details = await page.evaluate(() => {
        const root = moye.reading.getRoot(), paragraph = root.querySelector('[data-moye-typeset="optimal"]'), bounds = paragraph.getBoundingClientRect();
        const lines = [...paragraph.querySelectorAll(':scope > [data-moye-typeset-line]')].map(line => ({ text: line.textContent, top: line.getBoundingClientRect().top, left: line.getBoundingClientRect().left, width: [...line.children].reduce((sum, box) => sum + box.getBoundingClientRect().width, 0) }));
        const copy = document.createElement('div'); copy.append(root.cloneNode(true)); MoyeParagraphTypesetter.unwrapCopy(copy);
        return { text: root.textContent, lines, width: bounds.width, bold: root.querySelectorAll('strong').length, links: root.querySelectorAll('a[href="https://example.test"]').length, copyText: copy.textContent, copyHasVisualBoxes: !!copy.querySelector('[data-moye-typeset-line],[data-moye-typeset-box]'), source: moye.getState().content, dirty: moye.getState().dirty };
      });
      assert.equal(details.text, original); assert.equal(details.copyText, original); assert.equal(details.source, raw); assert.equal(details.dirty, false); assert.ok(details.lines.length >= 3); assert.ok(details.bold > 0 && details.links > 0); assert.equal(details.copyHasVisualBoxes, false);
      for (const line of details.lines) assert.ok(line.width <= details.width + 24, JSON.stringify(line));
      if (process.env.MOYE_TYPOGRAPHY_SCREENSHOT_DIR) { await fs.mkdir(process.env.MOYE_TYPOGRAPHY_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.MOYE_TYPOGRAPHY_SCREENSHOT_DIR, 'typography-reading-optimal.png') }); }
      await page.evaluate(() => moye.setReading(false)); assert.equal((await state()).content, raw);
      return { lineCount: details.lines.length, exactTextAndSource: true, formattingAndCopyPreserved: true };
    });
    await probe('paragraph optimisation reuses unchanged colour-only layouts and falls back for bounded or complex paragraphs', async () => {
      const raw = '适合优化的中文段落，保持阅读位置。'.repeat(20) + '\n\n带有 `inline code` 的段落。\n\n' + '超长段落'.repeat(250) + '\n';
      await open(raw); await profile('book'); await page.evaluate(() => moye.setReading(true));
      const details = await page.evaluate(async () => {
        await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(resolve));
        const root = moye.reading.getRoot(); MoyeParagraphTypesetter.apply(root, moye.settings.getValues());
        const before = root.querySelector('[data-moye-typeset-line]');
        const first = MoyeParagraphTypesetter.apply(root, moye.settings.getValues());
        await moye.settings.apply({ 'typography.colorTheme': 'mono' });
        const second = MoyeParagraphTypesetter.apply(root, moye.settings.getValues());
        return { first, second, sameNode: before === root.querySelector('[data-moye-typeset-line]'), source: moye.getState().content };
      });
      assert.ok(details.first.optimizedParagraphs >= 1); assert.ok(details.first.fallbackParagraphs >= 2); assert.equal(details.second.reused, true); assert.equal(details.sameNode, true); assert.equal(details.source, raw);
      return details;
    });
    await probe('invalid imported display profiles have no partial renderer or durable setting effect', async () => {
      await page.evaluate(() => moye.setReading(false)); await profile('daily');
      const details = await page.evaluate(async () => {
        const before = moye.settings.getValues(); let rejected = '';
        try { await moye.settings.apply({ 'appearance.fontSize': 25, 'typography.savedProfiles': '[{"id":"user-9","name":"坏方案","values":{"general.autoSave":true}}]' }); } catch (error) { rejected = error.message; }
        return { rejected, unchanged: JSON.stringify(before) === JSON.stringify(moye.settings.getValues()) };
      });
      assert.ok(details.rejected); assert.equal(details.unchanged, true); return details;
    });
    await probe('typography view defers refresh during active composition and changes only noneditable ancestor state', async () => {
      const details = await page.evaluate(async () => {
        const host = document.createElement('div'); host.className = 'vditor'; const ir = document.createElement('div'); ir.contentEditable = 'true'; ir.textContent = '组合输入'; host.append(ir); document.body.append(host);
        let composing = false, values = { ...MoyeTypography.defaults }, view = MoyeTypographyView.install({ editor: { vditor: { ir: { element: ir } } }, getValues: () => values, isComposing: () => composing });
        composing = true; values = { ...values, 'typography.paragraphStyle': 'indented' }; view.refresh(); const during = host.dataset.moyeParagraphStyle;
        composing = false; ir.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await Promise.resolve();
        const after = host.dataset.moyeParagraphStyle, text = ir.textContent; view.destroy(); host.remove(); moye.typography.refresh(); return { during, after, text };
      });
      assert.deepEqual(details, { during: 'spaced', after: 'indented', text: '组合输入' }); return { ...details, syntheticCompositionOnly: true };
    });
    report.remoteRequests.push(...await app.evaluate(({ app }) => app.moyeTypographyRequests || []));
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally { if (app) await app.close().catch(() => {}); await fs.rm(work, { recursive: true, force: true }); }
  report.pass = !report.fatalError && report.results.length > 0 && report.results.every(result => result.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  const output = process.env.MOYE_TYPOGRAPHY_OUTPUT || path.join(root, 'tests/typography-report.json'); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failed: report.results.filter(result => result.status !== 'pass'), errors: report.pageErrors, remoteRequests: report.remoteRequests, fatalError: report.fatalError }, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
