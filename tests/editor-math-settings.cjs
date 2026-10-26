'use strict';

// Actual editor/settings integration. Standalone resource rendering and these
// app regressions do not certify Typora behavior or real operating-system IME.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-math-settings-'));
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye real-editor settings integration; not Typora differential acceptance', results: [], pageErrors: [], remoteRequests: [] };
  let app, page, number = 0;
  const probe = async (name, operation) => {
    const started = Date.now();
    try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  };
  try {
    app = await electron.launch({
      executablePath: process.env.MOYE_MATH_SETTINGS_EXECUTABLE || require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_MATH_SETTINGS_EXECUTABLE ? [] : [root])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
    });
    await app.evaluate(({ app, session }) => {
      app.moyeMathSettingsRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/^https?:/.test(details.url)) app.moyeMathSettingsRequests.push(details.url);
        callback({ cancel: /^https?:/.test(details.url) });
      });
    });
    page = await app.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && window.moye.settings, null, { timeout: 30000 });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath() }));

    async function applyAndReload(patch) {
      await page.evaluate(async patch => { await moye.settings.apply(patch); await moye.settings.reload(); }, patch);
    }
    async function open(content) {
      const filename = path.join(work, `math-document-${++number}.md`);
      await fs.writeFile(filename, content);
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, filename);
      await page.evaluate(async () => { await moye.performAction('open'); moye.setMode('ir'); });
      return filename;
    }
    async function rendered(count, engine = 'MathJax') {
      await page.waitForFunction(({ count, engine }) => {
        const root = moye.editor.vditor.ir.element;
        return root.querySelectorAll(engine === 'MathJax' ? 'mjx-container' : '.katex').length === count;
      }, { count, engine }, { timeout: 15000 });
      return page.evaluate(() => {
        const root = moye.editor.vditor.ir.element;
        return {
          mathjax: root.querySelectorAll('mjx-container').length,
          katex: root.querySelectorAll('.katex').length,
          errors: [...root.querySelectorAll('.vditor-reset--error')].map(node => node.textContent),
          glyphs: [...new Set([...root.querySelectorAll('mjx-container svg [data-c]')].map(node => node.getAttribute('data-c')))],
          // MathJax 4 emits separate mtext nodes for "(", digits and ")".
          // Group by actual rendered equation rather than treating each token
          // as a complete label. These fixtures contain no other mtext.
          labels: [...root.querySelectorAll('mjx-container')].map(container => [...container.querySelectorAll('[data-mml-node="mtext"]')].map(node => [...node.querySelectorAll('[data-c]')].map(glyph => String.fromCodePoint(parseInt(glyph.getAttribute('data-c'), 16))).join('') || node.textContent.trim()).join('')).filter(Boolean),
        };
      });
    }
    async function source() { return page.evaluate(() => moye.getState()); }

    await probe('body font preference changes the real editor and paragraph computed font family', async () => {
      const raw = 'Font family probe 中文 ABC.\n'; await open(raw);
      const before = await page.evaluate(() => getComputedStyle(moye.editor.vditor.ir.element.querySelector('p')).fontFamily);
      await page.evaluate(() => moye.settings.apply({ 'appearance.fontFamily': 'serif' }));
      const after = await page.evaluate(() => ({ editor: getComputedStyle(moye.editor.vditor.ir.element).fontFamily, paragraph: getComputedStyle(moye.editor.vditor.ir.element.querySelector('p')).fontFamily }));
      assert.equal(after.editor, 'serif'); assert.equal(after.paragraph, 'serif'); assert.notEqual(after.paragraph, before);
      assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
      return { before, ...after, sourceUnchanged: true };
    });

    await probe('real editor switches MathJax to KaTeX and back after explicit settings reload', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.autoNumber': false, 'math.macros': '{}', 'markdown.inlineMath': true, 'markdown.mathBlock': true });
      const raw = 'Inline $x+1$.\n\n$$\ny=2\n$$\n'; await open(raw);
      const stages = [];
      for (const engine of ['MathJax', 'KaTeX', 'MathJax']) {
        await applyAndReload({ 'math.engine': engine });
        const result = await rendered(2, engine);
        assert.deepEqual(result.errors, []);
        assert.equal(engine === 'MathJax' ? result.katex : result.mathjax, 0);
        assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
        stages.push({ engine, mathjax: result.mathjax, katex: result.katex });
      }
      return { stages, sourceUnchanged: true };
    });

    await probe('macro preference expands then removes a macro in the actual editor without stale expansion', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.autoNumber': false, 'math.macros': '{"moyeprobe":"42"}' });
      const raw = '$$\n\\moyeprobe\n$$\n'; await open(raw);
      const added = await rendered(1);
      assert.deepEqual(added.errors, []);
      assert.ok(added.glyphs.includes('34') && added.glyphs.includes('32'), JSON.stringify(added));
      assert.equal(added.glyphs.includes('5C'), false);
      await applyAndReload({ 'math.macros': '{}' });
      const removed = await rendered(1);
      assert.ok(removed.glyphs.includes('5C') || removed.errors.length > 0, JSON.stringify(removed));
      assert.equal(removed.glyphs.includes('34') && removed.glyphs.includes('32'), false, 'Old macro expansion must disappear after removal');
      assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
      return { addedGlyphs: added.glyphs, removedGlyphs: removed.glyphs, oldExpansionRemoved: true, sourceUnchanged: true };
    });

    await probe('numbering preference affects real equation labels and resets between documents', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.macros': '{}', 'math.autoNumber': false });
      const raw = '$$\nx=1\n$$\n\n$$\ny=2\n$$\n'; await open(raw);
      const off = await rendered(2); assert.deepEqual(off.labels, []);
      await applyAndReload({ 'math.autoNumber': true });
      const on = await rendered(2);
      assert.ok(on.labels.includes('(1)') && on.labels.includes('(2)'), JSON.stringify(on));
      assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
      const nextRaw = '$$\nz=3\n$$\n'; await open(nextRaw);
      const next = await rendered(1);
      assert.deepEqual(next.labels, ['(1)'], JSON.stringify(next));
      await applyAndReload({ 'math.autoNumber': false });
      const disabled = await rendered(1); assert.deepEqual(disabled.labels, []);
      assert.equal((await source()).content, nextRaw); assert.equal((await source()).dirty, false);
      return { offLabels: off.labels, onLabels: on.labels, newDocumentLabels: next.labels, disabledLabels: disabled.labels, sourceUnchanged: true };
    });
    report.remoteRequests = await app.evaluate(({ app }) => app.moyeMathSettingsRequests);
    report.pass = report.results.every(item => item.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; }
  finally {
    if (app) {
      const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.writeFile(path.resolve(process.env.MOYE_MATH_SETTINGS_OUTPUT || path.join(root, 'tests/math-settings-report.json')), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
