'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-math-reading-'));
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Read-only extra TeX delimiters with isolated current-engine rendering, exact delimiter copy and shared editor counter protection', results: [], pageErrors: [], remoteRequests: [], limitations: ['Not Telari or Typora runtime differential acceptance.', 'Input-method checks remain synthetic; parser budgets and conservative HTML/code protection are explicit.'] };
  let app, page, number = 0;
  const probe = async (name, operation) => { if (process.env.MOYE_MATH_READING_FILTER && !name.includes(process.env.MOYE_MATH_READING_FILTER)) return; const started = Date.now(); try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); } catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); } };
  try {
    app = await electron.launch({ executablePath: process.env.MOYE_MATH_READING_EXECUTABLE || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_MATH_READING_EXECUTABLE ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    await app.evaluate(({ app, session }) => { app.moyeMathReadingRequests = []; session.defaultSession.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) app.moyeMathReadingRequests.push(details.url); callback({ cancel: /^https?:/.test(details.url) }); }); });
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(error.message)); await page.route(/^https?:/, route => route.abort()); await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && moye.reading?.whenReady && window.MoyeMathReadingSyntax, null, { timeout: 30000 });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath })); if (process.env.MOYE_MATH_READING_EXECUTABLE) assert.equal(report.application.isPackaged, true);
    async function configure(patch = {}) { await page.evaluate(async patch => { moye.setReading(false); await moye.settings.apply({ 'math.engine': 'MathJax', 'math.autoNumber': false, 'math.physics': false, 'math.macros': '{}', 'markdown.inlineMath': true, 'markdown.mathBlock': true, 'markdown.codeBlockMath': true, ...patch }); await moye.settings.reload(); }, patch); }
    async function open(raw) { const file = path.join(work, `math-reading-${++number}.md`); await fs.writeFile(file, raw); await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1 }); }, file); await page.evaluate(async () => { await moye.settings.panel.close(); moye.setReading(false); await moye.performAction('open'); moye.setMode('ir'); }); return file; }
    async function read() { await page.evaluate(async () => { moye.setReading(true); await moye.reading.whenReady(); }); }
    async function mathDetails() { return page.evaluate(() => {
      const root = moye.reading.getRoot(); const glyphText = element => [...element.querySelectorAll('[data-c]')].map(g => String.fromCodePoint(parseInt(g.getAttribute('data-c'), 16))).join('');
      return { report: moye.reading.getMathReport(), count: root.querySelectorAll('mjx-container,.katex').length, aliases: [...root.querySelectorAll('[data-reading-alias-id]')].map(node => ({ original: node.dataset.readingMarkdown, rendered: !!node.querySelector('mjx-container,.katex'), fractions: node.querySelectorAll('[data-mml-node="mfrac"],.mfrac').length, glyphs: glyphText(node), error: node.classList.contains('vditor-reset--error') })), labels: [...root.querySelectorAll('mjx-container')].map(element => [...element.querySelectorAll('[data-mml-node="mtext"]')].map(glyphText).join('')), text: root.textContent, source: moye.getState().content, dirty: moye.getState().dirty };
    }); }
    await probe('extra TeX delimiters render real inline/display SVG while preserving exact source and clipboard delimiters', async () => {
      await configure(); const raw = '公式 \\(x^2+1\\)。\r\n\r\n\\[\r\n\\frac{a}{b}\r\n\\]\r\n'; const file = await open(raw); await read(); const details = await mathDetails();
      assert.equal(details.aliases.length, 2); assert.ok(details.aliases.every(alias => alias.rendered)); assert.ok(details.aliases[1].fractions > 0); assert.equal(details.source, raw.replace(/\r\n/g, '\n')); assert.equal(details.dirty, false);
      const copied = await page.evaluate(() => { const root = moye.reading.getRoot(), selection = getSelection(), range = document.createRange(); range.selectNodeContents(root); selection.removeAllRanges(); selection.addRange(range); const clipboard = new DataTransfer(); root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: clipboard })); return clipboard.getData('text/plain'); });
      assert.ok(copied.includes('\\(x^2+1\\)')); assert.ok(copied.includes('\\[\n\\frac{a}{b}\n\\]'), JSON.stringify(copied));
      await page.evaluate(async () => { moye.setReading(false); await moye.performAction('save'); }); assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { ...details, copied, exactDiskSource: true };
    });
    await probe('standard and extra formulas share one isolated numbering sequence without changing editor counters or SVG references', async () => {
      await configure({ 'math.autoNumber': true, 'math.numberingStyle': 'all' });
      const raw = '$$\na=1\n$$\n\n\\[b=2\\]\n\n$$\nc=3\n$$\n\n\\(d=4\\)\n'; await open(raw);
      await page.waitForFunction(() => moye.editor.vditor.ir.element.querySelectorAll('mjx-container').length >= 2, null, { timeout: 15000 });
      const before = await page.evaluate(() => ({ counter: MathJax.startup.input.tex.parseOptions.tags.counter, html: moye.editor.vditor.ir.element.innerHTML }));
      await read(); const details = await mathDetails(); assert.equal(details.count, 4); assert.equal(details.report.errors.length, 0); assert.deepEqual(details.labels, ['(1)', '(2)', '(3)', '']);
      for (let i = 0; i < 3; i++) await page.evaluate(async () => { moye.setReading(false); moye.setReading(true); await moye.reading.whenReady(); });
      const after = await page.evaluate(() => {
        const root = moye.reading.getRoot(), ids = [...document.querySelectorAll('[id]')].map(element => element.id); const references = [...root.querySelectorAll('use')].map(element => element.getAttribute('href') || element.getAttribute('xlink:href')).filter(value => value?.startsWith('#'));
        return { counter: MathJax.startup.input.tex.parseOptions.tags.counter, unique: new Set(ids).size === ids.length, refsValid: references.every(value => root.querySelector('[id="' + value.slice(1) + '"]')), source: moye.getState().content };
      });
      assert.equal(after.counter, before.counter); assert.equal(after.unique, true); assert.equal(after.refsValid, true); assert.equal(after.source, raw);
      const ordinaryRaw = '$x$\n\n$$\n  y=2  \n$$\n\n~~~math\nz=3\n~~~\n'; await open(ordinaryRaw); await read(); const ordinary = await mathDetails();
      assert.equal(ordinary.aliases.length, 0); assert.equal(ordinary.count, 3); assert.equal(ordinary.report.errors.length, 0);
      const originals = await page.evaluate(() => [...moye.reading.getRoot().querySelectorAll('.language-math')].map(node => ({ source: node.dataset.readingMarkdown, fenceChrome: !!node.closest('pre') })));
      assert.deepEqual(originals.map(node => node.source), ['$x$', '$$\n  y=2  \n$$', '~~~math\nz=3\n~~~']); assert.ok(originals.every(node => !node.fenceChrome));
      return { labels: details.labels, beforeCounter: before.counter, afterCounter: after.counter, uniqueSvgIdsAndValidReferences: true, ordinaryOnly: { report: ordinary.report, originals } };
    });
    await probe('macros and the active physics package work in isolated extra-delimiter formulas and disabling physics removes stale expansion', async () => {
      const raw = '\\(\\RR\\)\n\n\\[\\dv{x}{t}\\]\n'; const stages = [];
      for (const physics of [true, false, true]) {
        await configure({ 'math.physics': physics, 'math.macros': '{"RR":"\\\\mathbb{R}"}' }); await open(raw); await read(); const details = await mathDetails();
        assert.ok(details.aliases[0].rendered); assert.ok(details.aliases[0].glyphs.length > 0);
        assert.equal(details.aliases[1].rendered && details.aliases[1].fractions > 0, physics, JSON.stringify(details)); stages.push({ physics, aliases: details.aliases, mathReport: details.report });
      }
      return { stages };
    });
    await probe('KaTeX renders extra delimiters with the selected macro configuration using only local resources', async () => {
      await configure({ 'math.engine': 'KaTeX', 'math.macros': '{"RR":"\\\\mathbb{R}"}' }); await open('\\(\\RR+x\\)\n\n\\[\\frac{1}{2}\\]\n'); await read(); const details = await mathDetails();
      assert.equal(details.report.engine, 'KaTeX'); assert.equal(details.count, 2); assert.ok(details.aliases.every(alias => alias.rendered)); assert.equal(details.report.errors.length, 0); return details;
    });
    await probe('code, HTML, URL destinations and escaped literal delimiters are never promoted into math or leaked token strings', async () => {
      await configure(); const raw = '普通 (x+1) [a,b] 价格 $5 和 $6。\n\n`<span> \\(code\\)`\n\n```text\n\\[fence\\]\n```\n\n<div>\\(html\\)</div>\n\n[link](https://example.test/\\(url\\))\n\n\\\\(escaped\\\\)\n\n真实 \\(x+1\\)。\n'; await open(raw); await read(); const details = await mathDetails();
      assert.equal(details.aliases.length, 1); assert.equal(details.count, 1); assert.equal(details.aliases[0].original, '\\(x+1\\)'); assert.equal(details.source, raw); assert.ok(!details.text.includes('MOYEMATHREADING')); return details;
    });
    await probe('invalid TeX retains copyable original delimiters while valid sibling formulas still render', async () => {
      await configure(); const raw = '\\(\\unknownCommandForMoye{x}\\) 与 \\(x+1\\)。\n'; await open(raw); await read(); const details = await mathDetails();
      assert.equal(details.aliases.length, 2); assert.equal(details.aliases[0].error, true); assert.equal(details.aliases[0].rendered, false); assert.equal(details.aliases[1].rendered, true); assert.ok(details.text.includes('\\(\\unknownCommandForMoye{x}\\)')); assert.equal(details.source, raw); return details;
    });
    await probe('inline and block parsing switches independently control extra delimiters without modifying clean source', async () => {
      const raw = '\\(x\\)\n\n\\[y\\]\n', stages = [];
      for (const [inline, block] of [[true, false], [false, true], [false, false], [true, true]]) {
        await configure({ 'markdown.inlineMath': inline, 'markdown.mathBlock': block }); await open(raw); await read(); const details = await mathDetails();
        assert.equal(details.aliases.length, Number(inline) + Number(block)); assert.equal(details.count, Number(inline) + Number(block)); assert.equal(details.source, raw); assert.equal(details.dirty, false); stages.push({ inline, block, count: details.count });
      }
      return { stages };
    });
    report.remoteRequests = await app.evaluate(({ app }) => app.moyeMathReadingRequests || []);
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally { if (app) await app.close().catch(() => {}); await fs.rm(work, { recursive: true, force: true }); }
  report.pass = !report.fatalError && report.results.length > 0 && report.results.every(result => result.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  await fs.writeFile(process.env.MOYE_MATH_READING_OUTPUT || path.join(root, 'tests/math-reading-report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failed: report.results.filter(result => result.status !== 'pass'), pageErrors: report.pageErrors, remoteRequests: report.remoteRequests, fatalError: report.fatalError }, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
