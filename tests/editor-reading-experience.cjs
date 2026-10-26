'use strict';
// Actual Electron checks for the independent reading surface and image viewer.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-reading-'));
  const executable = process.env.MOYE_READING_EXECUTABLE ? path.resolve(process.env.MOYE_READING_EXECUTABLE) : require('electron');
  const results = [], pageErrors = [], remoteRequests = []; let app, page, application;
  const reading = '.moye-reading:not([hidden]) .moye-reading-content';
  async function probe(name, task) { const start = Date.now(); try { const details = await task(); results.push({ name, status: 'pass', elapsedMs: Date.now() - start, details }); } catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.stack || error.message }); } }
  async function settle(ms = 100) { await page.waitForTimeout(ms); }
  async function open(content, mode = 'ir', name = 'reading-fixture.md') { await page.evaluate(({ content, mode, name }) => { const r = window.readingTestBridge || moye.reading; r.setEnabled(false); moye.loadDocument({ name, path: null, content, documentId: crypto.randomUUID() }); moye.setMode(mode); }, { content, mode, name }); await settle(450); }
  async function enable(value = true) { await page.evaluate(async value => { const reading = window.readingTestBridge || moye.reading; reading.setEnabled(value); if (value) await reading.whenReady(); }, value); await settle(); }
  async function apply(values) { await page.evaluate(async values => {
    const known = moye.settings.getValues(), patch = {};
    for (const [key, value] of Object.entries(values)) { if (Object.hasOwn(known, key)) patch[key] = value; else window.readingTestOverrides[key] = value; }
    if (Object.keys(patch).length) await moye.settings.apply(patch);
    (window.readingTestBridge || moye.reading).refresh({ displayOnly: true });
  }, values); await settle(); }
  async function inspect() { return page.evaluate(() => ({ state: (({reading,...state})=>state)(moye.getState()), editorHTML: moye.editor.vditor.ir.element.innerHTML, mode: moye.editor.getCurrentMode() })); }
  try {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_READING_EXECUTABLE ? [] : [path.join(root, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile'), FONTCONFIG_FILE: path.resolve(root, '..', 'system-deps', 'fonts.conf') } });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); }); await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready, null, { timeout: 30000 });
    await app.evaluate(({ shell }) => { global.readingOpenedLinks = []; shell.openExternal = async href => { global.readingOpenedLinks.push(href); }; });
    if (!(await page.evaluate(() => !!moye.reading))) {
      assert.equal(application.isPackaged, false, 'Packaged reading tests must run built-in implementation; source injection is forbidden');
      await page.addStyleTag({ path: path.join(root, 'src/reading-experience.css') }); await page.addScriptTag({ url: pathToFileURL(path.join(root, 'src/reading-experience.js')).href });
      await page.evaluate(() => { window.readingTestOverrides = {}; window.readingOpenedLinks = []; window.readingTestBridge = MoyeReading.install({ editor: moye.editor, getValues: () => ({ ...moye.settings.getValues(), ...window.readingTestOverrides }), isComposing: () => window.readingComposition === true, getDocumentName: () => moye.getState().name, getDocumentKey: () => moye.getState().documentId, getSource: () => moye.getState().content, onOpenLink: href => window.readingOpenedLinks.push(href), onImage: image => { window.readingImageViewer = MoyeImageViewer.open(image); } }); });
    } else await page.evaluate(() => { window.readingTestOverrides = {}; });
    const long = '# Start\n\n' + Array.from({ length: 100 }, (_, i) => `Paragraph ${String(i).padStart(3, '0')}: 中文混排 with English and a longer sentence repeated to create visual wrapping. `.repeat(3)).join('\n\n') + '\n\n## Last heading\n\nLast paragraph.\n';
    await probe('reading is a separate non-editable semantic document and keeps source, dirty and editable DOM unchanged', async () => {
      const raw = '# Reading\n\nA **bold** paragraph with `code` and a [link](https://example.test).\n\n- [x] Done\n- [ ] Pending\n'; await open(raw);
      const before = await inspect(); await enable();
      const actual = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(); return { editable: root.isContentEditable, role: root.getAttribute('role'), bold: root.querySelector('strong')?.textContent, checks: [...root.querySelectorAll('input')].map(x => ({ disabled: x.disabled, checked: x.checked })), sourceMarkers: root.querySelectorAll('.vditor-ir__marker').length, underlyingInert: !!moye.editor.vditor.ir.element.closest('[inert]') }; });
      assert.equal(actual.editable, false); assert.equal(actual.role, 'document'); assert.equal(actual.bold, 'bold'); assert.equal(actual.sourceMarkers, 0); assert.equal(actual.underlyingInert, true); assert.ok(actual.checks.every(x => x.disabled));
      await page.keyboard.insertText('must not edit'); assert.deepEqual(await inspect(), before); return actual;
    });
    await probe('leaving reading restores an IR backward selection and existing undo/redo history', async () => {
      await open('First paragraph.\n\nSecond paragraph.\n'); await page.locator('.vditor-ir p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('X'); await settle(450);
      const before = await page.evaluate(() => { const root = moye.editor.vditor.ir.element, t = root.querySelector('p').firstChild; root.focus(); getSelection().setBaseAndExtent(t, 5, t, 1); return { raw: moye.getState().content, selected: getSelection().toString(), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset }; });
      const historyBefore = await page.evaluate(() => JSON.stringify(moye.editor.vditor.undo.ir)); await enable(); await enable(false); assert.equal(await page.evaluate(() => JSON.stringify(moye.editor.vditor.undo.ir)), historyBefore);
      const after = await page.evaluate(() => ({ raw: moye.getState().content, selected: getSelection().toString(), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset })); assert.deepEqual(after, before);
      await page.evaluate(() => moye.performAction('undo')); assert.equal((await inspect()).state.content, 'First paragraph.\n\nSecond paragraph.\n'); await page.evaluate(() => moye.performAction('redo')); assert.equal((await inspect()).state.content, before.raw); return { backwardRange: true, undoRedo: true };
    });
    await probe('source-mode reading preserves source selection direction and latest source content', async () => {
      await open('Source first\n\nSource second\n', 'sv'); await page.locator('.vditor-sv').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('Latest'); await settle(450);
      const before = await page.evaluate(() => { const el = moye.editor.vditor.sv.element; el.setSelectionRange(2, 10, 'backward'); el.scrollTop = 5; return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, scrollTop: el.scrollTop }; });
      const historyBefore = await page.evaluate(() => JSON.stringify(moye.editor.vditor.undo.sv));
      await page.evaluate(async () => { if (window.readingTestBridge) readingTestBridge.setEnabled(true); else moye.setReading(true); await (window.readingTestBridge || moye.reading).whenReady(); }); assert.ok(await page.locator(reading).innerText().then(text => text.includes('Latest')));
      await page.evaluate(() => { if (window.readingTestBridge) readingTestBridge.setEnabled(false); else moye.setReading(false); });
      assert.deepEqual(await page.evaluate(() => { const el = moye.editor.vditor.sv.element; return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, scrollTop: el.scrollTop }; }), before);
      assert.equal(await page.evaluate(() => JSON.stringify(moye.editor.vditor.undo.sv)), historyBefore); return { latestSource: true, backwardRange: true, historyUnchanged: true };
    });
    await probe('Space and PageDown page by complete visual lines with two-line overlap', async () => {
      await open(long); await enable();
      const first = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(); return { before: root.scrollTop, height: root.clientHeight }; });
      await page.keyboard.press('Space');
      const second = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); assert.ok(second - first.before > first.height / 2 && second - first.before < first.height + 1, JSON.stringify({ first, second }));
      await page.keyboard.press('PageDown'); const third = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); assert.ok(third - second > first.height / 2); assert.ok(third - second < first.height + 1);
      await page.keyboard.press('Shift+Space'); const back = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); assert.ok(back < third); return { viewportHeight: first.height, firstPage: second, nextPage: third, previousPage: back };
    });
    await probe('paging is bounded, respects Reduce Motion and does not intercept input-field spaces', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' }); await page.keyboard.press('Home'); await page.keyboard.press('PageUp'); assert.equal(await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop), 0);
      await page.keyboard.press('End'); const end = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); await page.keyboard.press('PageDown'); assert.equal(await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop), end);
      await page.evaluate(() => { const input = document.createElement('input'); input.id = 'reading-external-input'; document.body.append(input); input.focus(); }); await page.keyboard.type('A B'); assert.equal(await page.locator('#reading-external-input').inputValue(), 'A B'); await page.locator('#reading-external-input').evaluate(x => x.remove()); await page.emulateMedia({ reducedMotion: 'no-preference' }); return { bounded: true, reduceMotion: true, inputSpacePreserved: true };
    });
    await probe('editing Space still inserts a literal space', async () => {
      await open('Editable\n'); await page.locator('.vditor-ir p').click(); await page.keyboard.press('End'); await page.keyboard.press('Space'); await page.keyboard.insertText('text'); assert.ok((await inspect()).state.content.includes('Editable text')); return { noReadingShortcutInEditor: true };
    });
    await probe('headings and footnote links navigate inside reading and Back restores the previous position', async () => {
      await open('# Top\n\n[Go last](#Last) and note[^one].\n\n' + long + '\n\n# Last\n\nDestination.\n\n[^one]: Footnote destination.\n'); await enable();
      const before = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); await page.locator(reading + ' a').filter({ hasText: 'Go last' }).click();
      const atLast = await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop); assert.ok(atLast > 2000); await page.locator('.moye-reading:not([hidden]) [data-reading-action=back]').click(); assert.ok(Math.abs(await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop) - before) < 2);
      await page.locator(reading + ' sup.footnotes-ref a').click(); assert.ok(await page.evaluate(() => (window.readingTestBridge || moye.reading).getRoot().scrollTop) >= atLast - 2); return { localAnchors: true, footnotes: true, return: true };
    });
    await probe('external links use the explicit callback and cannot navigate the application frame', async () => {
      await open('[External](https://example.test/path)\n'); await enable(); const before = page.url(); await page.locator(reading + ' a').click(); assert.equal(page.url(), before);
      const opened = await page.evaluate(() => window.readingOpenedLinks || []); const nativeOpened = await app.evaluate(() => global.readingOpenedLinks); assert.ok(opened.includes('https://example.test/path') || nativeOpened.includes('https://example.test/path')); return { noFrameNavigation: true };
    });
    await probe('reading sanitizes active HTML, event attributes and duplicate SVG IDs while retaining rendered math and diagrams', async () => {
      await open('# Math\n\nInline $a^2$ and formula.\n\n$$\nx=2\n$$\n\n```mermaid\ngraph LR; A-->B;\n```\n\n<script>window.BAD=1</script>\n<img src="bad.png" onerror="window.BAD=2">\n'); await settle(900); await enable();
      const actual = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(); return { math: root.querySelectorAll('mjx-container,.katex').length, diagrams: root.querySelectorAll('svg.flowchart').length, activeNodes: root.querySelectorAll('script,iframe,object,[onclick],[onerror],[contenteditable="true"]').length, duplicateIds: [...root.querySelectorAll('[id]')].filter(x => document.querySelectorAll('#' + CSS.escape(x.id)).length !== 1).length, bad: window.BAD || 0 }; });
      assert.equal(actual.math, 2); assert.equal(actual.diagrams, 1); assert.equal(actual.activeNodes, 0); assert.equal(actual.duplicateIds, 0); assert.equal(actual.bad, 0);
      const diagrams = {
        flowchart: 'st=>start: Begin\ne=>end: End\nst->e', graphviz: 'digraph G { A -> B; }',
        echarts: '{"xAxis":{"type":"category","data":["A","B"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[1,2]}]}',
        mindmap: '# Root\n## One\n## Two', markmap: '# Root\n\n- One\n- Two',
        abc: 'X:1\nT:Simple\nM:4/4\nK:C\nCDEF GABc|', wavedrom: '{"signal":[{"name":"clk","wave":"p..."}]}', smiles: 'CCO',
        mermaid: 'flowchart LR\nFreshA[Latest source] --> FreshB[Reading]',
      };
      const latest = Object.entries(diagrams).map(([language, source]) => '```' + language + '\n' + source + '\n```').join('\n\n') + '\n';
      await open('# Stale IR\n', 'sv'); await page.locator('.vditor-sv').fill(latest);
      await page.evaluate(async () => { moye.setReading(true); await moye.reading.whenReady(); });
      const independent = await page.evaluate(() => [...moye.reading.getRoot().querySelectorAll('[data-reading-diagram]')].map(element => ({ language: element.dataset.readingDiagram, ready: element.dataset.readingDiagramReady === 'true', error: element.dataset.readingDiagramError || '', images: element.querySelectorAll('svg,canvas').length })));
      assert.equal(independent.length, 8, JSON.stringify(independent)); assert.ok(independent.every(diagram => diagram.ready && diagram.images), JSON.stringify(independent)); assert.equal((await inspect()).state.content, latest);
      const freshMermaid = await page.locator(reading + ' .language-mermaid svg').allTextContents(); assert.equal(freshMermaid.length, 1); assert.ok(freshMermaid[0].includes('Latest source'), JSON.stringify(freshMermaid));
      return { ...actual, independentDiagramsFromLatestSource: independent, sourceMermaidAwaited: true };
    });
    await probe('reading copy preserves table cells as TSV and rendered formulas as Markdown source', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n| empty | |\n\n$$\nx=2\n$$\n'); await enable();
      const table = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), range = document.createRange(); range.selectNodeContents(root.querySelector('table')); getSelection().removeAllRanges(); getSelection().addRange(range); const clipboardData = new DataTransfer(); root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData })); return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') }; }); assert.ok(table.text.includes('A\tB')); assert.ok(table.text.includes('one\ttwo')); assert.ok(table.html.includes('<table') || table.html.includes('<tbody'));
      const formula = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), range = document.createRange(); range.selectNode(root.querySelector('[data-reading-markdown]')); getSelection().removeAllRanges(); getSelection().addRange(range); const clipboardData = new DataTransfer(); root.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData })); return clipboardData.getData('text/plain'); }); assert.equal(formula, '$$\nx=2\n$$'); return { tsv: table.text, formula };
    });
    await probe('display-only refresh retains reading DOM, backward range and current visible paragraph', async () => {
      await open(long); await enable();
      const before = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading, root = r.getRoot(), p = root.querySelectorAll('p')[35]; root.scrollTop += p.getBoundingClientRect().top - root.getBoundingClientRect().top - 35; window.readingOriginalParagraph = p; const text = p.firstChild; getSelection().setBaseAndExtent(text, 12, text, 2); return { selected: getSelection().toString(), anchor: getSelection().anchorOffset, y: p.getBoundingClientRect().top - root.getBoundingClientRect().top }; }); await settle();
      await apply({ 'appearance.theme': 'dark' });
      const after = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), p = root.querySelectorAll('p')[35]; return { sameNode: p === window.readingOriginalParagraph, selected: getSelection().toString(), anchor: getSelection().anchorOffset, y: p.getBoundingClientRect().top - root.getBoundingClientRect().top }; }); assert.equal(after.sameNode, true); assert.equal(after.selected, before.selected); assert.equal(after.anchor, before.anchor); assert.ok(Math.abs(after.y - before.y) < 2, JSON.stringify({ before, after })); return after;
    });
    await probe('immersive controls overlay without moving text and remain keyboard accessible', async () => {
      const before = await page.evaluate(() => { const r = (window.readingTestBridge || moye.reading).getRoot(); return { top: r.getBoundingClientRect().top, height: r.clientHeight }; }); await apply({ 'reading.immersive': true });
      const actual = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading, root = r.getRoot(), controls = r.getSurface().querySelector('.moye-reading__controls'); return { top: root.getBoundingClientRect().top, height: root.clientHeight, position: getComputedStyle(controls).position, opacity: getComputedStyle(controls).opacity }; }); assert.equal(actual.top, before.top); assert.equal(actual.height, before.height); assert.equal(actual.position, 'absolute');
      await page.locator('.moye-reading:not([hidden]) [data-reading-action=edit]').focus(); await settle(200); assert.equal(await page.locator('.moye-reading:not([hidden]) .moye-reading__controls').evaluate(x => getComputedStyle(x).opacity), '1'); await apply({ 'reading.immersive': false }); return { overlay: true, focusReveals: true };
    });
    await probe('refresh switches documents without retaining old text and leaves underlying document clean', async () => {
      await page.evaluate(() => { moye.loadDocument({ name: 'new-reading.md', content: '# Fresh\n\nBrand new text.\n', path: null, documentId: crypto.randomUUID() }); (window.readingTestBridge || moye.reading).refresh({ preservePosition: false }); }); await settle(); assert.ok((await page.locator(reading).innerText()).includes('Brand new text.')); assert.ok(!(await page.locator(reading).innerText()).includes('Paragraph 035')); assert.equal((await inspect()).state.dirty, false); return { documentIsolation: true };
    });
    await probe('image viewer supports fit, 100 percent, zoom, pan and Escape with focus restored', async () => {
      await enable(false); await page.locator('#live-mode').focus();
      await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1400; const c = canvas.getContext('2d'); c.fillStyle = '#47705b'; c.fillRect(0, 0, 1800, 1400); c.fillStyle = 'white'; c.font = '64px sans-serif'; c.fillText('Full size image', 60, 100); window.readingImageViewer = MoyeImageViewer.open({ src: canvas.toDataURL(), alt: 'Large image' }); });
      await page.waitForFunction(() => window.readingImageViewer?.picture.complete && readingImageViewer.picture.naturalWidth === 1800); const fit = await page.evaluate(() => readingImageViewer.getScale()); assert.ok(fit < 1);
      await page.locator('[data-image-action=original]').click(); assert.equal(await page.evaluate(() => readingImageViewer.getScale()), 1);
      await page.locator('[data-image-action=in]').click(); assert.equal(await page.evaluate(() => readingImageViewer.getScale()), 1.25);
      const stage = page.locator('.moye-image-viewer__stage'), bounds = await stage.boundingBox(); await page.mouse.move(bounds.x + 180, bounds.y + 160); await page.mouse.down(); await page.mouse.move(bounds.x + 70, bounds.y + 60, { steps: 3 }); await page.mouse.up(); assert.ok(await stage.evaluate(x => x.scrollLeft > 0 && x.scrollTop > 0));
      await page.keyboard.press('Escape'); await page.locator('.moye-image-viewer').waitFor({ state: 'detached' }); assert.equal(await page.locator('.moye-image-viewer').count(), 0); assert.equal(await page.locator('#live-mode').evaluate(x => x === document.activeElement), true); return { fit, original: 1, zoom: 1.25, pan: true, escape: true };
    });
    await probe('image and linked image distinguish opening a link from viewing the original', async () => {
      const url = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 60; c.height = 40; return c.toDataURL(); }); await open(`![Plain](${url})\n\n[![Linked](${url})](https://example.test/image-link)\n`); await enable();
      await page.locator(reading + ' img[alt=Plain]').click(); assert.equal(await page.locator('.moye-image-viewer').count(), 1); await page.keyboard.press('Escape');
      await page.locator(reading + ' img[alt=Linked]').click(); assert.equal(await page.locator('.moye-image-viewer').count(), 0);
      await page.locator(reading + ' img[alt=Linked]').click({ modifiers: ['Alt'] }); assert.equal(await page.locator('.moye-image-viewer').count(), 1); await page.keyboard.press('Escape'); return { plainPreview: true, linkedOpensLink: true, altPreviewsLinkedImage: true };
    });
    await probe('Escape exits reading while preserving the document and editable focus', async () => {
      const before = (await inspect()).state; await page.locator(reading).focus(); await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => (window.readingTestBridge || moye.reading).isEnabled()), false); assert.deepEqual((await inspect()).state, before); return { escaped: true, unchanged: true };
    });
    await probe('TXT auto mode shows literal Markdown and HTML while detecting Chinese and English chapters', async () => {
      await apply({ 'reading.txtMode': 'auto', 'reading.chapterDetection': true, 'reading.paragraphRule': 'lines' });
      const raw = '# This is literal\r\n\r\n第一章 开始\r\n**literal** <b>HTML</b> $x$ [link](https://example.test)\r\n\r\nChapter IV: Next\r\nAnother paragraph.\r\n'; await open(raw, 'ir', 'novel.txt'); await enable();
      const actual = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading, root = r.getRoot(); return { plain: r.isPlainText(), outline: r.getOutline(), text: root.textContent, rich: root.querySelectorAll('strong,b,a,mjx-container').length }; }); assert.equal(actual.plain, true); assert.equal(actual.outline.length, 2); assert.equal(actual.rich, 0); assert.ok(actual.text.includes('# This is literal')); assert.ok(actual.text.includes('<b>HTML</b>')); assert.equal((await inspect()).state.content, raw); assert.equal((await inspect()).state.dirty, false); return { chapters: actual.outline.map(x => x.text), literalMarkup: true, originalCRLFPreserved: true };
    });
    await probe('composition blocks entering reading and composition-tagged paging keys remain untouched', async () => {
      await open('Composition text.\n');
      const blocked = await page.evaluate(() => { const root = moye.editor.vditor.ir.element, reading = window.readingTestBridge || moye.reading; window.readingComposition = true; root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); reading.setEnabled(true); return reading.isEnabled(); }); assert.equal(blocked, false);
      await page.evaluate(() => { window.readingComposition = false; moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })); }); await enable();
      const result = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), top = root.scrollTop, event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', isComposing: true, bubbles: true, cancelable: true }); root.dispatchEvent(event); return { prevented: event.defaultPrevented, unchanged: root.scrollTop === top }; }); assert.equal(result.prevented, false); assert.equal(result.unchanged, true); return { entryBlockedDuringComposition: true, taggedKeyPreserved: true, realSystemIME: 'not exercised' };
    });
    await probe('TXT paragraph rules and chapter toggle affect only its reading presentation', async () => {
      const raw = '第一章 开始\nline one\nline two\n\nline three\n'; await open(raw, 'ir', 'paragraphs.txt'); await apply({ 'reading.paragraphRule': 'blankLines', 'reading.chapterDetection': true }); await enable();
      const before = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading; return { headings: r.getOutline().length, paragraphs: r.getRoot().querySelectorAll('p').length }; }); assert.equal(before.headings, 1); assert.equal(before.paragraphs, 2);
      await apply({ 'reading.paragraphRule': 'lines', 'reading.chapterDetection': false }); await page.evaluate(() => (window.readingTestBridge || moye.reading).refresh());
      const after = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading; return { headings: r.getOutline().length, paragraphs: r.getRoot().querySelectorAll('p').length }; }); assert.equal(after.headings, 0); assert.ok(after.paragraphs > before.paragraphs); assert.equal((await inspect()).state.content, raw); return { before, after, sourceUnchanged: true };
    });
    await probe('TXT can be read as Markdown and explicit plain-text override stays scoped to its document', async () => {
      await apply({ 'reading.txtMode': 'markdown', 'reading.chapterDetection': true }); await open('**Bold**\n', 'ir', 'marked.txt'); await enable(); assert.equal(await page.locator(reading + ' strong').textContent(), 'Bold');
      await page.evaluate(() => (window.readingTestBridge || moye.reading).setPlainText(true)); assert.equal(await page.locator(reading + ' strong').count(), 0); assert.ok((await page.locator(reading).textContent()).includes('**Bold**'));
      await open('**Other**\n', 'ir', 'another.txt'); await enable(); assert.equal(await page.locator(reading + ' strong').textContent(), 'Other'); return { markdownOption: true, perDocumentOverride: true };
    });
    await probe('long TXT lines use bounded Unicode-safe display chunks and preserve complete source', async () => {
      await apply({ 'reading.txtMode': 'auto', 'reading.paragraphRule': 'blankLines' }); const raw = '汉字😀 mixed text '.repeat(8000) + '\n'; await open(raw, 'ir', 'long.txt'); await enable();
      const actual = await page.evaluate(() => { const r = window.readingTestBridge || moye.reading, parts = [...r.getRoot().querySelectorAll('p')].map(x => x.textContent); return { chunks: parts.length, joined: parts.join(''), brokenSurrogate: parts.some(x => /[\uD800-\uDBFF]$/.test(x) || /^[\uDC00-\uDFFF]/.test(x)), contentVisibility: getComputedStyle(r.getRoot().querySelector('p')).contentVisibility }; }); assert.ok(actual.chunks > 4); assert.equal(actual.joined, raw.replace(/\n$/, '')); assert.equal(actual.brokenSurrogate, false); assert.equal(actual.contentVisibility, 'auto'); assert.equal((await inspect()).state.content, raw); return { chunks: actual.chunks, unicodeSafe: true, completeOriginal: true, offscreenLayout: actual.contentVisibility };
    });
    await probe('native Select All and Copy stay inside the read-only document', async () => {
      await open('# Native heading\n\nNative copy paragraph.\n'); await enable(); await page.locator(reading).focus();
      const modifier = process.platform === 'darwin' ? 'meta' : 'control';
      await app.evaluate(({ BrowserWindow, clipboard }, modifier) => { const win = BrowserWindow.getAllWindows()[0]; win.focus(); clipboard.clear(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] }); }, modifier); await settle();
      const selection = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), s = getSelection(); return { inside: root.contains(s.anchorNode) && root.contains(s.focusNode), text: s.toString() }; }); assert.equal(selection.inside, true); assert.equal(selection.text.split('Native copy paragraph.').length - 1, 1);
      await app.evaluate(({ BrowserWindow }, modifier) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: [modifier] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: [modifier] }); }, modifier); await settle();
      const text = await app.evaluate(({ clipboard }) => clipboard.readText()); assert.ok(text.includes('Native copy paragraph.')); assert.equal(text.split('Native copy paragraph.').length - 1, 1); assert.ok(!text.includes('墨页')); return { nativeMenuInput: true, localSelection: true, noUnderlyingEditorDuplicate: true };
    });
    await probe('reading position survives leaving and reopening the same file independently from the editing caret', async () => {
      await apply({ 'reading.rememberPosition': true, 'reading.txtMode': 'auto' }); await enable(false);
      await page.evaluate(content => moye.loadDocument({ name: 'remember-reading.md', path: '/virtual/remember-reading.md', content, documentId: crypto.randomUUID() }), long); await settle(450); await enable();
      const before = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), p = root.querySelectorAll('p')[35]; root.scrollTop += p.getBoundingClientRect().top - root.getBoundingClientRect().top - 32; return { y: p.getBoundingClientRect().top - root.getBoundingClientRect().top, text: p.textContent }; }); await settle(200); await enable(false);
      await page.evaluate(content => moye.loadDocument({ name: 'remember-reading.md', path: '/virtual/remember-reading.md', content, documentId: crypto.randomUUID() }), long); await settle(450); await enable(); await settle(450);
      const after = await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), p = root.querySelectorAll('p')[35]; return { y: p.getBoundingClientRect().top - root.getBoundingClientRect().top, text: p.textContent }; }); assert.equal(after.text, before.text); assert.ok(Math.abs(after.y - before.y) < 5, JSON.stringify({ before, after })); return { sameFileReadingMemory: true, viewportDelta: after.y - before.y };
    });
    await probe('reading semantic anchor holds the same text through font, column and viewport reflow', async () => {
      await open(long); await apply({ 'appearance.fontSize': 17, 'appearance.contentWidth': 780 }); await enable();
      await page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), p = root.querySelectorAll('p')[35]; root.scrollTop += p.getBoundingClientRect().top - root.getBoundingClientRect().top; }); await settle(250);
      const metrics = () => page.evaluate(() => { const root = (window.readingTestBridge || moye.reading).getRoot(), p = root.querySelectorAll('p')[35], range = document.createRange(); range.setStart(p.firstChild, 0); range.setEnd(p.firstChild, 1); return { glyphY: range.getBoundingClientRect().top - root.getBoundingClientRect().top, text: p.textContent, source: moye.getState().content }; });
      const before = await metrics(); await apply({ 'appearance.fontSize': 22, 'appearance.contentWidth': 620 }); await settle(350); const changedFont = await metrics(); assert.equal(changedFont.text, before.text); assert.equal(changedFont.source, before.source); assert.ok(Math.abs(changedFont.glyphY - before.glyphY) < 6, JSON.stringify({ before: before.glyphY, changed: changedFont.glyphY }));
      await page.setViewportSize({ width: 800, height: 760 }); await settle(350); const resized = await metrics(); assert.ok(Math.abs(resized.glyphY - before.glyphY) < 6, JSON.stringify({ before: before.glyphY, resized: resized.glyphY })); await page.setViewportSize({ width: 1280, height: 860 }); await apply({ 'appearance.fontSize': 17, 'appearance.contentWidth': 780 }); return { fontDelta: changedFont.glyphY - before.glyphY, viewportDelta: resized.glyphY - before.glyphY, sourceUnchanged: true };
    });
    if (process.env.MOYE_READING_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.MOYE_READING_SCREENSHOT_DIR, { recursive: true }); await open(long); await enable();
      for (const theme of ['light', 'dark']) { await apply({ 'appearance.theme': theme }); await page.screenshot({ path: path.join(process.env.MOYE_READING_SCREENSHOT_DIR, `reading-${theme}.png`), animations: 'disabled' }); }
    }
  } finally {
    if (app) { const child = app.process(), done = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await done; }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, application, purpose: 'Independent reading/paging/image-viewer behavior; original Telari runtime and native OS IME are not tested', results, pageErrors, remoteRequests, pass: results.every(x => x.status === 'pass') && !pageErrors.length && !remoteRequests.length };
  await fs.writeFile(path.resolve(process.env.MOYE_READING_OUTPUT || path.join(root, 'tests/reading-experience-report.json')), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
