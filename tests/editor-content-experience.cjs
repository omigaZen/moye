'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const project = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-content-'));
  const executable = process.env.MOYE_CONTENT_EXECUTABLE ? path.resolve(process.env.MOYE_CONTENT_EXECUTABLE) : require('electron');
  const results = [], pageErrors = [], remoteRequests = []; let app, page, application;
  const codeSelector = '.vditor-ir .vditor-ir__preview>code';
  async function probe(name, callback) { const started = Date.now(); try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); } catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); await page?.evaluate(() => { window.contentDelay = 0; const root = moye.editor.vditor.ir.element; root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })); }).catch(() => {}); } }
  async function settle(ms = 100) { await page.waitForTimeout(ms); }
  async function apply(patch) { await page.evaluate(patch => moye.settings.apply(patch), patch); await settle(); }
  async function open(content) { await page.evaluate(content => { if (moye.reading?.isEnabled()) moye.reading.setEnabled(false); moye.loadDocument({ name: 'content-experience.md', path: null, documentId: crypto.randomUUID(), content }); moye.setMode('ir'); }, content); }
  async function highlighted() { await page.waitForFunction(() => document.querySelector('.vditor-ir .vditor-ir__preview>code .hljs-keyword'), null, { timeout: 10000 }); }
  const code = 'public int Count = 3;\n// 中文注释\n', fenced = '```csharp\n' + code + '```\n\nAfter code.\n';
  try {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_CONTENT_EXECUTABLE ? [] : [path.join(project, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); }); await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => !!moye.contentExperience), true, 'The application must integrate the real content controller; source injection is forbidden');
    await page.evaluate(() => {
      window.contentDelay = 0; window.contentMainHighlightCalls = 0; window.contentWorkerMessages = 0;
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message && typeof message.source === 'string') window.contentWorkerMessages++;
        if (window.contentDelay && message && typeof message.source === 'string') { const worker = this; setTimeout(() => { try { original.call(worker, message, ...rest); } catch (_) {} }, contentDelay); }
        else return original.call(this, message, ...rest);
      };
      window.hljs = { highlight() { contentMainHighlightCalls++; throw new Error('Forbidden synchronous main-thread highlighting'); }, getLanguage() { contentMainHighlightCalls++; throw new Error('Forbidden main-thread grammar lookup'); } };
    });
    await apply({ 'code.highlight': true, 'code.languageBadge': true, 'code.lineNumbers': false, 'code.wrap': true });
    await probe('real dedicated worker highlights local code without calling the main-thread grammar engine', async () => {
      await open(fenced); const ready = await page.evaluate(() => moye.contentExperience.whenReady()); assert.equal(ready.ready, true); await highlighted();
      const actual = await page.evaluate(() => ({ jobs: moye.contentExperience.stats.workerJobs, results: moye.contentExperience.stats.workerResults, messages: contentWorkerMessages, mainCalls: contentMainHighlightCalls, content: moye.getState().content, dirty: moye.getState().dirty }));
      assert.ok(actual.jobs > 0 && actual.results > 0 && actual.messages > 0); assert.equal(actual.mainCalls, 0); assert.equal(actual.content, fenced); assert.equal(actual.dirty, false); return actual;
    });
    await probe('plain code is readable before the delayed real worker response arrives', async () => {
      await page.evaluate(() => { window.contentDelay = 250; }); await open('```javascript\nconst value = "visible first";\n```\n\nAfter.\n');
      const before = await page.locator(codeSelector).first().evaluate(element => ({ text: element.textContent, keywords: element.querySelectorAll('.hljs-keyword').length }));
      assert.ok(before.text.includes('visible first')); assert.equal(before.keywords, 0);
      const boundedWait = await page.evaluate(async () => { try { await moye.contentExperience.whenReady({ timeoutMs: 50 }); return false; } catch (error) { return error.message.includes('尚未完成'); } }); assert.equal(boundedWait, true);
      await highlighted(); await page.evaluate(() => { window.contentDelay = 0; }); return { plainBeforeResult: true, eventuallyHighlighted: true, renderBarrierTimeoutIsBounded: true };
    });
    await probe('highlight preference toggles generated colour while preserving source, dirty state and selection', async () => {
      await open(fenced); await highlighted();
      await page.evaluate(() => { const paragraph = moye.editor.vditor.ir.element.querySelector('p'), range = document.createRange(); range.setStart(paragraph.firstChild, 1); range.setEnd(paragraph.firstChild, 5); getSelection().removeAllRanges(); getSelection().addRange(range); });
      await apply({ 'code.highlight': false }); assert.equal(await page.locator(`${codeSelector} .hljs-keyword`).count(), 0);
      assert.equal(await page.locator(codeSelector).first().textContent(), code);
      const off = await page.evaluate(() => ({ content: moye.getState().content, dirty: moye.getState().dirty, selected: getSelection().toString(), pending: moye.settings.isReloadPending() }));
      assert.equal(off.content, fenced); assert.equal(off.dirty, false); assert.equal(off.selected, 'fter'); assert.equal(off.pending, false);
      await apply({ 'code.highlight': true }); await highlighted(); return { off, colourRestored: true };
    });
    await probe('language badge is display-only and code copy excludes decorations', async () => {
      await open(fenced); await highlighted();
      const badge = await page.locator('.vditor-ir .moye-code-preview').first().getAttribute('data-code-language'); assert.equal(badge, 'csharp');
      await page.locator('.vditor-ir p').click(); await page.locator('.vditor-ir .moye-code-preview').first().hover(); await page.locator('.vditor-ir .moye-code-copy').first().click();
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText()); assert.equal(copied, code.replace(/\n$/, ''));
      await apply({ 'code.languageBadge': false }); assert.equal(await page.locator('.vditor-ir .moye-code-preview').first().getAttribute('data-code-language'), null); await apply({ 'code.languageBadge': true }); return { badge, copiedExactly: true };
    });
    await probe('wrapped line numbers track rendered line heights and retain exact code text', async () => {
      const body = 'public string Long = "' + 'word 中文 '.repeat(70) + '";\nreturn Long;\n'; await apply({ 'code.lineNumbers': true }); await open('```csharp\n' + body + '```\n\nAfter.\n'); await highlighted(); await page.locator('.vditor-ir p').click(); await settle(180);
      const actual = await page.locator(codeSelector).first().evaluate(element => ({ text: element.textContent, lines: [...element.querySelectorAll(':scope>.moye-code-line')].map(line => line.getBoundingClientRect().height), numbers: [...element.querySelectorAll(':scope>.vditor-linenumber__rows>span')].map(line => line.getBoundingClientRect().height), lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
      assert.equal(actual.text, body); assert.equal(actual.lines.length, 2); assert.equal(actual.numbers.length, 2); assert.ok(actual.lines[0] > actual.lineHeight * 2); actual.lines.forEach((height, index) => assert.ok(Math.abs(height - actual.numbers[index]) < 1));
      await apply({ 'code.lineNumbers': false }); assert.equal(await page.locator('.vditor-ir .vditor-linenumber__rows').count(), 0); return actual;
    });
    await probe('unknown grammars preserve Unicode and escape markup as plain code', async () => {
      const body = '<script>window.CONTENT_INJECTED=1</script> 中文 & value\n'; await open('```unknown_language\n' + body + '```\n\nAfter.\n');
      await page.waitForFunction(() => document.querySelector('.vditor-ir .moye-code-preview>code.hljs'));
      await settle(); assert.equal(await page.locator(codeSelector).first().textContent(), body); assert.equal(await page.evaluate(() => window.CONTENT_INJECTED), undefined); assert.equal(await page.locator(`${codeSelector} script`).count(), 0); return { sourceExact: true, noExecutableMarkup: true };
    });
    await probe('a late response from a replaced document cannot overwrite the newer preview', async () => {
      await page.evaluate(() => { window.contentDelay = 300; }); await open('```javascript\nconst oldDocument = 1;\n```\n'); await settle(50); await open('```javascript\nconst newDocument = 2;\n```\n'); await highlighted(); await settle(350); await page.evaluate(() => { window.contentDelay = 0; });
      const visible = await page.locator(codeSelector).first().textContent(); assert.ok(visible.includes('newDocument')); assert.ok(!visible.includes('oldDocument')); assert.equal(await page.evaluate(() => moye.getState().dirty), false); return { visible, staleCannotOverwrite: true };
    });
    await probe('invalid Mermaid displays exact editable source and a concrete reason', async () => {
      const invalid = '```mermaid\nflowchart TD\nA --> [broken\n```\n\nafter\n'; await open(invalid);
      await page.waitForFunction(() => [...document.querySelectorAll('.vditor-ir .moye-diagram-preview')].some(element => element.dataset.contentNote?.includes('无法绘制')), null, { timeout: 15000 });
      assert.equal(await page.locator('.vditor-ir .moye-diagram-source').textContent(), 'flowchart TD\nA --> [broken\n'); assert.equal(await page.evaluate(() => moye.getState().content), invalid); assert.equal(await page.locator('.vditor-ir .language-mermaid svg').count(), 0);
      return { sourcePreserved: true, reason: await page.locator('.vditor-ir .moye-diagram-preview').getAttribute('data-content-note') };
    });
    await probe('correcting a failed Mermaid block renders the current diagram', async () => {
      const valid = '```mermaid\nflowchart TD\nA[Start] --> B[Finish]\n```\n\nafter\n'; await page.evaluate(() => moye.setMode('sv')); await page.locator('.vditor-sv').fill(valid); await page.evaluate(() => moye.setMode('ir'));
      const ready = await page.evaluate(() => moye.contentExperience.whenReady()); assert.equal(ready.ready, true);
      await page.waitForFunction(() => document.querySelector('.vditor-ir .language-mermaid svg'), null, { timeout: 15000 });
      const text = await page.locator('.vditor-ir .language-mermaid svg').textContent(); assert.ok(text.includes('Start') && text.includes('Finish')); assert.equal(await page.evaluate(() => moye.getState().content), valid); return { sourceMatchesCorrection: true, renderedLabels: ['Start', 'Finish'] };
    });
    await probe('oversized Mermaid is rejected before calling the renderer and remains readable', async () => {
      await page.evaluate(() => { window.contentMermaidCalls = 0; const original = mermaid.render; mermaid.render = function (...args) { contentMermaidCalls++; return original.apply(this, args); }; });
      const body = 'flowchart LR\n' + Array.from({ length: 200 }, (_, index) => `N${index} --> N${index + 1}`).join('\n') + '\n'; await open('```mermaid\n' + body + '```\n\nAfter graph.\n'); await settle();
      const actual = await page.evaluate(() => ({ calls: contentMermaidCalls, note: document.querySelector('.vditor-ir .moye-diagram-preview').dataset.contentNote, source: document.querySelector('.vditor-ir .moye-diagram-source').textContent }));
      assert.equal(actual.calls, 0); assert.match(actual.note, /超过/); assert.equal(actual.source, body); return { calls: actual.calls, reason: actual.note, sourceExact: true };
    });
    await probe('block formula overflow is local and fit mode scales it without a syntax reload', async () => {
      await apply({ 'math.overflow': 'scroll' }); const formula = '$$\n' + Array.from({ length: 42 }, (_, index) => `x_{${index}}`).join(' + ') + '\n$$\n\nAfter formula.\n'; await open(formula);
      await page.waitForFunction(() => document.querySelector('.vditor-ir .moye-block-math mjx-container svg'), null, { timeout: 15000 });
      const wide = await page.locator('.vditor-ir .moye-block-math').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, overflow: getComputedStyle(element).overflowX })); assert.equal(wide.overflow, 'auto'); assert.ok(wide.scrollWidth > wide.width);
      await apply({ 'math.overflow': 'fit' }); await settle(180);
      const fit = await page.locator('.vditor-ir .moye-block-math').evaluate(element => ({ width: element.clientWidth, renderedWidth: element.querySelector('svg').getBoundingClientRect().width, scale: Number(element.dataset.mathScale), overflow: getComputedStyle(element).overflowX }));
      assert.ok(fit.scale < 1 && fit.scale > 0); assert.ok(fit.renderedWidth <= fit.width + 3, JSON.stringify(fit)); assert.equal(fit.overflow, 'hidden'); assert.equal(await page.evaluate(() => moye.settings.isReloadPending()), false); assert.equal(await page.evaluate(() => moye.getState().content), formula);
      await page.locator('.vditor-ir [data-type="math-block"] .vditor-ir__preview').click();
      await page.waitForFunction(() => document.querySelector('.vditor-ir__node--expand[data-type="math-block"]'));
      assert.equal(await page.evaluate(() => document.activeElement === moye.editor.vditor.ir.element), true);
      assert.equal(await page.evaluate(() => moye.getState().content), formula);
      await page.locator('.vditor-ir p').last().click(); await apply({ 'math.overflow': 'scroll' }); return { wide, fit, rawUnchanged: true, fitFormulaClickKeepsEditorFocus: true };
    });
    await probe('an in-flight worker result waits until synthetic composition commits', async () => {
      await page.evaluate(() => { window.contentDelay = 230; }); await open(fenced); await settle(70);
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))); await settle(350);
      assert.equal(await page.locator(`${codeSelector} .hljs-keyword`).count(), 0);
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))); await highlighted(); await page.evaluate(() => { window.contentDelay = 0; }); assert.equal(await page.evaluate(() => moye.getState().content), fenced); return { deferredUntilCompositionEnd: true, systemIME: 'not exercised' };
    });
    await probe('a late worker response preserves an active code-text selection until the selection moves away', async () => {
      await page.evaluate(() => { window.contentDelay = 250; }); await open(fenced); await settle(60);
      await page.evaluate(() => { const code = document.querySelector('.vditor-ir .vditor-ir__preview>code'), range = document.createRange(); range.setStart(code.firstChild, 0); range.setEnd(code.firstChild, 6); getSelection().removeAllRanges(); getSelection().addRange(range); }); await settle(350);
      const ready = await page.evaluate(() => moye.contentExperience.whenReady({ timeoutMs: 1000 })); assert.equal(ready.ready, true); assert.ok(ready.deferredPreviews > 0);
      assert.equal(await page.evaluate(() => getSelection().toString()), 'public'); assert.equal(await page.locator(`${codeSelector} .hljs-keyword`).count(), 0);
      await page.evaluate(() => getSelection().removeAllRanges()); await highlighted(); await page.evaluate(() => { window.contentDelay = 0; }); return { selectedTextPreserved: 'public', highlightedAfterSelectionCleared: true };
    });
    await probe('read-only reading surface receives the same worker highlighting', async () => {
      await open(fenced); await highlighted(); await page.evaluate(() => moye.reading.setEnabled(true));
      await page.waitForFunction(() => document.querySelector('.moye-reading-content pre>code .hljs-keyword'), null, { timeout: 10000 });
      await page.locator('.moye-reading-content .moye-code-preview').first().hover(); await page.locator('.moye-reading-content .moye-code-copy').first().click(); assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), code.replace(/\n$/, ''));
      assert.equal(await page.evaluate(() => moye.getState().content), fenced); assert.equal(await page.evaluate(() => moye.getState().dirty), false); await page.evaluate(() => moye.reading.setEnabled(false)); return { readonlyCodeColoured: true, copyButtonBoundAfterClone: true, documentUnchanged: true };
    });
  } finally {
    if (app) { const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, executable, application, purpose: 'Actual worker code rendering, bounded Mermaid fallback and formula overflow; no Telari original-runtime parity claim', results, pageErrors, remoteRequests };
  report.pass = results.every(result => result.status === 'pass') && !pageErrors.length && !remoteRequests.length;
  await fs.writeFile(path.resolve(process.env.MOYE_CONTENT_OUTPUT || path.join(project, 'tests/content-experience-report.json')), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
