'use strict';

// Real app feature regression. Official labels/docs motivate these controls;
// no Typora differential process or complete configuration coverage is claimed.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-markdown-settings-'));
  const report = {
    generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`,
    purpose: 'Moye real-editor Markdown/math settings integration; not Typora differential acceptance',
    referenceSources: ['https://support.typora.io/Line-Break/', 'https://support.typora.io/Math/'],
    limitations: ['Typora runtime defaults, application timing and step-by-step behavior remain unverified.', 'This suite does not test Strict Mode, legacy inline math parsing or smart punctuation.'],
    results: [], pageErrors: [], remoteRequests: [],
  };
  let app, page, number = 0;
  const probe = async (name, operation) => {
    if (process.env.MOYE_MARKDOWN_SETTINGS_FILTER && !name.includes(process.env.MOYE_MARKDOWN_SETTINGS_FILTER)) return;
    const started = Date.now();
    try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  };
  try {
    app = await electron.launch({
      executablePath: process.env.MOYE_MARKDOWN_SETTINGS_EXECUTABLE || require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_MARKDOWN_SETTINGS_EXECUTABLE ? [] : [root])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
    });
    await app.evaluate(({ app, session }) => {
      app.moyeMarkdownSettingsRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/^https?:/.test(details.url)) app.moyeMarkdownSettingsRequests.push(details.url);
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
      const file = path.join(work, `markdown-document-${++number}.md`);
      await fs.writeFile(file, content);
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBox = async () => ({ response: 1 });
      }, file);
      await page.evaluate(async () => { await moye.settings.panel.close(); await moye.performAction('open'); moye.setMode('ir'); });
      return file;
    }
    async function source() { return page.evaluate(() => moye.getState()); }
    async function math(count) {
      await page.waitForFunction(count => {
        const root = moye.editor.vditor.ir.element;
        return root.querySelectorAll('mjx-container').length === count && root.querySelectorAll('.vditor-ir__preview .language-math:not([data-math])').length === 0;
      }, count, { timeout: 15000 });
      return page.evaluate(() => {
        const containers = [...moye.editor.vditor.ir.element.querySelectorAll('mjx-container')];
        const glyphText = element => [...element.querySelectorAll('[data-c]')].map(glyph => String.fromCodePoint(parseInt(glyph.getAttribute('data-c'), 16))).join('');
        return {
          count: containers.length,
          labels: containers.map(container => [...container.querySelectorAll('[data-mml-node="mtext"]')].map(glyphText).join('')),
          glyphs: containers.map(glyphText),
          fractions: containers.map(container => container.querySelectorAll('[data-mml-node="mfrac"]').length),
          errors: [...moye.editor.vditor.ir.element.querySelectorAll('.vditor-reset--error')].map(element => element.textContent),
        };
      });
    }

    await probe('whitespace setting changes real paragraph geometry and preserves explicit breaks and code spacing', async () => {
      const raw = 'Alpha    Beta\nGamma\n\nhard  \nbreak\n\n`keep    code`\n\n```text\nkeep    code\n```\n';
      await applyAndReload({ 'markdown.preserveWhitespace': true });
      const file = await open(raw), stages = [];
      for (const preserve of [true, false, true]) {
        await applyAndReload({ 'markdown.preserveWhitespace': preserve });
        const view = await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, paragraph = root.querySelector('p'), text = paragraph.firstChild;
          if (text.nodeType !== 3 || text.textContent !== 'Alpha    Beta\nGamma') throw new Error('Unexpected paragraph text fixture.');
          const rect = (start, end) => { const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end); const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; };
          return { whiteSpace: getComputedStyle(paragraph).whiteSpace, alpha: rect(0, 5), gap: rect(5, 9), gamma: rect(14, 19), explicitBreaks: root.querySelectorAll('p br').length, inlineCodeWhiteSpace: getComputedStyle(root.querySelector('p code')).whiteSpace, codeWhiteSpace: getComputedStyle(root.querySelector('pre.vditor-ir__preview code')).whiteSpace };
        });
        assert.equal(view.whiteSpace, preserve ? 'pre-wrap' : 'normal');
        assert.equal(view.gamma.y > view.alpha.y + 1, preserve, JSON.stringify(view));
        assert.ok(view.explicitBreaks >= 1, JSON.stringify(view));
        assert.ok(['pre', 'pre-wrap', 'break-spaces'].includes(view.inlineCodeWhiteSpace), JSON.stringify(view));
        assert.ok(['pre', 'pre-wrap', 'break-spaces'].includes(view.codeWhiteSpace), JSON.stringify(view));
        assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
        await page.evaluate(() => moye.performAction('save'));
        assert.equal(await fs.readFile(file, 'utf8'), raw);
        stages.push({ preserve, ...view });
      }
      assert.ok(stages[0].gap.width > stages[1].gap.width * 2, JSON.stringify(stages));
      return { stages, cleanSourceSavedExactly: true };
    });

    await probe('AMS and all-equation numbering produce different actual labels and none removes them', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.autoNumber': true, 'math.numberingStyle': 'all', 'markdown.mathBlock': true });
      const raw = '$$\nx=1\n$$\n\n$$\n\\begin{equation}\ny=2\n\\end{equation}\n$$\n\n$$\n\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}\n$$\n';
      const file = await open(raw), stages = [];
      for (const [enabled, style] of [[true, 'all'], [true, 'ams'], [false, 'ams'], [true, 'all']]) {
        await applyAndReload({ 'math.autoNumber': enabled, 'math.numberingStyle': style });
        const result = await math(3); assert.deepEqual(result.errors, []);
        assert.deepEqual(result.labels, !enabled ? ['', '', ''] : style === 'all' ? ['(1)', '(2)', '(3)(4)'] : ['', '(1)', '(2)(3)']);
        assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
        stages.push({ enabled, style, labels: result.labels });
      }
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { stages, cleanSourceSavedExactly: true };
    });

    await probe('physics package really enables derivative commands and OFF removes their stale expansion', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.autoNumber': false, 'math.physics': false, 'markdown.mathBlock': true });
      const raw = '$$\n\\dv{x}{t}\n$$\n';
      const file = await open(raw), stages = [];
      for (const enabled of [false, true, false, true]) {
        await applyAndReload({ 'math.physics': enabled });
        const result = await math(1); assert.deepEqual(result.errors, []);
        assert.equal(result.fractions[0] > 0, enabled, JSON.stringify(result));
        assert.equal(result.glyphs[0].includes('\\'), !enabled, JSON.stringify(result));
        assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
        stages.push({ enabled, fractions: result.fractions, glyphs: result.glyphs });
      }
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { stages, oldExpansionRemoved: true, cleanSourceSavedExactly: true };
    });

    await probe('math code fence preview toggles independently of dollar block and inline math', async () => {
      const raw = 'Inline $x+1$.\n\n$$\ny=2\n$$\n\n```math\nz=3\n```\n\n```javascript\nconst n = 1;\n```\n';
      await applyAndReload({ 'math.engine': 'MathJax', 'math.physics': false, 'math.autoNumber': false, 'markdown.inlineMath': true, 'markdown.mathBlock': true, 'markdown.codeBlockMath': true });
      const file = await open(raw), stages = [];
      for (const [inline, block, fence] of [[true, true, true], [true, true, false], [false, false, true], [false, false, false], [true, true, true]]) {
        await applyAndReload({ 'markdown.inlineMath': inline, 'markdown.mathBlock': block, 'markdown.codeBlockMath': fence });
        const count = Number(inline) + Number(block) + Number(fence);
        await page.waitForFunction(count => moye.editor.vditor.ir.element.querySelectorAll('mjx-container').length === count, count, { timeout: 15000 });
        const result = await page.evaluate(() => ({ math: moye.editor.vditor.ir.element.querySelectorAll('mjx-container').length, normalCode: moye.editor.vditor.ir.element.querySelectorAll('pre.vditor-ir__preview code.language-javascript.hljs').length, fenceText: moye.editor.vditor.ir.element.querySelector('[data-type="code-block"] code.language-math')?.textContent }));
        assert.equal(result.math, count); assert.equal(result.normalCode, 1);
        if (!fence) assert.match(result.fenceText, /z=3/);
        assert.equal((await source()).content, raw); assert.equal((await source()).dirty, false);
        stages.push({ inline, block, fence, ...result });
      }
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { stages, cleanSourceSavedExactly: true };
    });

    await probe('combined parsing reload keeps dirty source, backward selection and disk bytes then saves the real edit', async () => {
      const raw = 'Alpha    Beta\nGamma\n\n$$\nx=1\n$$\n';
      const file = await open(raw);
      await page.evaluate(() => moye.setMode('sv'));
      await page.locator('.vditor-sv').focus();
      await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('unsaved edit');
      await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(2, 8, 'backward'));
      const before = await source(); assert.equal(before.dirty, true);
      const values = await page.evaluate(() => moye.settings.getValues());
      await applyAndReload({ 'markdown.preserveWhitespace': !values['markdown.preserveWhitespace'], 'math.autoNumber': true, 'math.numberingStyle': 'ams', 'math.physics': true, 'markdown.codeBlockMath': false });
      const after = await source();
      assert.equal(after.content, before.content); assert.equal(after.dirty, true);
      assert.deepEqual(await page.evaluate(() => { const e = moye.editor.vditor.sv.element; return [e.selectionStart, e.selectionEnd, e.selectionDirection]; }), [2, 8, 'backward']);
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), before.content);
      return { sourcePreserved: true, dirtyPreserved: true, selection: [2, 8, 'backward'], reloadDidNotWrite: true, editedSourceSavedExactly: true };
    });

    await probe('disabled math fence remains editable in the real IR editor and saves the typed source', async () => {
      await applyAndReload({ 'math.engine': 'MathJax', 'math.physics': false, 'markdown.codeBlockMath': false });
      const file = await open('```math\nz=3\n```\n');
      await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element;
        const code = root.querySelector('pre.vditor-ir__marker code.language-math');
        const text = code.firstChild;
        const range = document.createRange();
        range.setStart(text, text.textContent.indexOf('z=3') + 3); range.collapse(true);
        root.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.keyboard.insertText('+4');
      const edited = await source();
      assert.equal(edited.dirty, true); assert.match(edited.content, /z=3\+4/);
      assert.equal(await page.locator('.vditor-ir mjx-container').count(), 0);
      await applyAndReload({ 'markdown.codeBlockMath': true });
      await page.waitForFunction(() => moye.editor.vditor.ir.element.querySelectorAll('mjx-container').length === 1, null, { timeout: 15000 });
      assert.equal((await source()).content, edited.content); assert.equal((await source()).dirty, true);
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), edited.content);
      return { irEdit: 'z=3+4', disabledHasNoFormula: true, reenabledRendersEditedFormula: true, editedSourceSavedExactly: true };
    });

    report.remoteRequests = await app.evaluate(({ app }) => app.moyeMarkdownSettingsRequests);
    report.pass = report.results.every(result => result.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; }
  finally {
    if (app) {
      const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.writeFile(path.resolve(process.env.MOYE_MARKDOWN_SETTINGS_OUTPUT || path.join(root, 'tests/markdown-settings-report.json')), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
