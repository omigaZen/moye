'use strict';
// Actual Electron input/paint/state checks. Original Typora runtime parity remains unverified.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-focus-'));
  const results = [], pageErrors = [], remoteRequests = []; let app, page, application;
  const executable = process.env.MOYE_FOCUS_EXECUTABLE ? path.resolve(process.env.MOYE_FOCUS_EXECUTABLE) : require('electron');
  async function probe(name, callback) { const started = Date.now(); try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); } catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); } }
  async function settle() { await page.waitForTimeout(100); }
  async function apply(values) { await page.evaluate(async values => {
    if (window.focusTestBridge) {
      const known = moye.settings.getValues(), patch = {};
      for (const [key, value] of Object.entries(values)) { if (Object.hasOwn(known, key)) patch[key] = value; else window.focusTestOverrides[key] = value; }
      await moye.settings.apply(patch); moye.editor.vditor.options.typewriterMode = false; window.focusTestBridge.refresh();
    } else await moye.settings.apply(values);
  }, values); await settle(); }
  async function open(content, mode = 'ir') { await page.evaluate(({ content, mode }) => { moye.loadDocument({ name: 'focus-fixture.md', content, path: null, documentId: crypto.randomUUID() }); moye.setMode(mode); }, { content, mode }); await settle(); }
  async function state() { return page.evaluate(() => moye.getState()); }
  async function dimmed(selector) {
    return page.evaluate(selector => {
      const block = moye.editor.vditor.ir.element.querySelector(selector), highlight = CSS.highlights.get('moye-focus-dim');
      if (!block) throw new Error(`Missing ${selector}`);
      const ranges = [...(highlight || [])];
      return { text: block.textContent, dimmedText: ranges.filter(range => block.contains(range.startContainer)).map(range => range.toString()).join(''), rangeCount: ranges.length };
    }, selector);
  }
  async function caretMetrics() { return page.evaluate(() => {
    const mode = moye.editor.getCurrentMode(), el = moye.editor.vditor[mode].element, box = el.getBoundingClientRect();
    if (mode === 'ir') {
      const s = getSelection(), range = document.createRange(); range.setStart(s.focusNode, s.focusOffset); range.collapse(true);
      const r = range.getBoundingClientRect(); return { middle: r.top + r.height / 2, center: box.top + el.clientTop + el.clientHeight / 2, scrollTop: el.scrollTop, height: el.clientHeight };
    }
    const masks = document.querySelector('.moye-focus-source-mask'), before = masks.children[0].getBoundingClientRect(), after = masks.children[1].getBoundingClientRect();
    return { middle: (before.bottom + after.top) / 2, center: box.top + el.clientTop + el.clientHeight / 2, scrollTop: el.scrollTop, height: el.clientHeight };
  }); }
  try {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_FOCUS_EXECUTABLE ? [] : [path.join(root, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); }); await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready, null, { timeout: 25000 });
    // This fallback also allows running this isolated module while renderer integration is in progress.
    if (!(await page.evaluate(() => !!window.MoyeFocus))) {
      assert.equal(application.isPackaged, false, 'Packaged application must include the focus module; source injection is forbidden');
      await page.addStyleTag({ path: path.join(root, 'src/editor-focus.css') }); await page.addScriptTag({ url: require('node:url').pathToFileURL(path.join(root, 'src/editor-focus.js')).href });
      await page.evaluate(() => { window.focusTestOverrides = {}; moye.editor.vditor.options.typewriterMode = false; window.focusTestBridge = MoyeFocus.create({ editor: moye.editor, isEnabled: () => moye.settings.getValues()['editor.focusMode'], isTypewriterEnabled: () => moye.settings.getValues()['editor.typewriterMode'], alwaysCenter: () => (window.focusTestOverrides['editor.typewriterAlwaysCenter'] ?? moye.settings.getValues()['editor.typewriterAlwaysCenter']) !== false }); });
    }
    await apply({ 'editor.typewriterMode': false, 'editor.focusMode': true, 'appearance.sidebarVisible': true, 'appearance.toolbarVisible': true });
    const fixture = '# Heading alpha\n\nFirst paragraph one.\n\nSecond paragraph two.\n\n- outer text\n  - nested item\n- sibling item\n\n| Col A | Col B |\n| --- | --- |\n| cell one | cell two |\n\n```js\nfirst();\nsecond();\nthird();\n```\n\nLast paragraph.\n';
    await probe('focus fades other paragraphs and heading without hiding application controls', async () => {
      await open(fixture); await page.locator('.vditor-ir p').filter({ hasText: 'First paragraph' }).click(); await settle();
      assert.equal((await dimmed('p')).dimmedText, ''); assert.ok((await dimmed('h1')).dimmedText.includes('Heading alpha'));
      if (process.env.MOYE_FOCUS_SCREENSHOT) await page.screenshot({ path: process.env.MOYE_FOCUS_SCREENSHOT });
      if (process.env.MOYE_FOCUS_SCREENSHOT_DIR) {
        const screenshots = path.resolve(process.env.MOYE_FOCUS_SCREENSHOT_DIR); await fs.mkdir(screenshots, { recursive: true });
        for (const theme of ['light', 'dark']) { await apply({ 'appearance.theme': theme }); await page.screenshot({ path: path.join(screenshots, `packaged-focus-${theme}-030.png`), animations: 'disabled' }); }
        await page.evaluate(() => moye.performAction('preferences')); await page.locator('#settings-search').fill('专注'); await settle();
        await page.screenshot({ path: path.join(screenshots, 'packaged-focus-preferences-030.png'), animations: 'disabled' });
        await page.evaluate(() => moye.settings.panel.close());
      }
      assert.equal(await page.locator('.app-header').isVisible(), true); assert.equal(await page.locator('.vditor-toolbar').isVisible(), true); assert.equal(await page.locator('#outline-sidebar').isVisible(), true);
      const before = await state(); assert.equal(before.content, fixture); assert.equal(before.dirty, false); return { dimmedHeading: (await dimmed('h1')).dimmedText, controlsVisible: true };
    });
    await probe('nested list highlights its own item while fading outer and sibling items', async () => {
      await page.locator('.vditor-ir li li').click(); await settle();
      assert.equal((await dimmed('li li')).dimmedText, '');
      const outer = await dimmed('li'); assert.ok(outer.dimmedText.includes('outer text')); assert.ok(!outer.dimmedText.includes('nested item'));
      const sibling = await dimmed(':scope>ul>li:last-child'); assert.ok(sibling.dimmedText.length > 0); return { outerDimmed: outer.dimmedText, activeNested: true };
    });
    await probe('table cell stays active while adjacent cells fade', async () => {
      await page.locator('.vditor-ir td').first().click(); await settle();
      const result = await page.evaluate(() => [...moye.editor.vditor.ir.element.querySelectorAll('td')].map(cell => ({ text: cell.textContent, dimmed: [...CSS.highlights.get('moye-focus-dim')].some(range => cell.contains(range.startContainer)) })));
      assert.equal(result[0].dimmed, false); assert.equal(result[1].dimmed, true); return result;
    });
    await probe('active IR code fence fades noncurrent lines with editable source unchanged', async () => {
      await page.locator('.vditor-ir [data-type="code-block"] .vditor-ir__preview').click(); await settle();
      await page.evaluate(() => { const root = moye.editor.vditor.ir.element, code = root.querySelector('[data-type="code-block"] pre code'), node = code.firstChild, at = node.textContent.indexOf('second'); const range = document.createRange(); range.setStart(node, at + 3); range.collapse(true); root.focus(); getSelection().removeAllRanges(); getSelection().addRange(range); }); await page.keyboard.press('ArrowRight'); await settle();
      const result = await dimmed('[data-type="code-block"] pre code'); assert.ok(result.dimmedText.includes('first();')); assert.ok(result.dimmedText.includes('third();')); assert.ok(!result.dimmedText.includes('second();')); assert.equal((await state()).dirty, false); return result;
    });
    await probe('focus toggling preserves raw Markdown selection scroll and undo history in light and dark', async () => {
      await open('First paragraph one.\n\nSecond paragraph two.\n');
      await page.locator('.vditor-ir p').first().click(); await page.keyboard.press('End'); await page.keyboard.insertText('X'); await settle();
      const before = await page.evaluate(() => ({ state: moye.getState(), selected: getSelection().toString(), anchor: getSelection().anchorOffset, scroll: moye.editor.vditor.ir.element.scrollTop, html: moye.editor.vditor.ir.element.innerHTML }));
      for (const theme of ['light', 'dark']) { await apply({ 'appearance.theme': theme, 'editor.focusMode': false }); await apply({ 'editor.focusMode': true }); }
      const after = await page.evaluate(() => ({ state: moye.getState(), selected: getSelection().toString(), anchor: getSelection().anchorOffset, scroll: moye.editor.vditor.ir.element.scrollTop, html: moye.editor.vditor.ir.element.innerHTML }));
      assert.equal(after.state.content, before.state.content); assert.equal(after.state.dirty, true); assert.equal(after.selected, before.selected); assert.equal(after.anchor, before.anchor); assert.equal(after.scroll, before.scroll); assert.equal(after.html, before.html);
      await page.evaluate(() => moye.performAction('undo')); assert.equal((await state()).content, 'First paragraph one.\n\nSecond paragraph two.\n');
      await page.evaluate(() => moye.performAction('redo')); assert.equal((await state()).content, before.state.content); return { themes: ['light', 'dark'], exactEditableDOM: true, undoRedo: true };
    });
    await probe('source mask tracks actual mouse and keyboard selection with caret line unobscured', async () => {
      await open('source first\nsource second\nsource third\n', 'sv'); await page.locator('.vditor-sv').click({ position: { x: 100, y: 60 } }); await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await settle();
      const result = await page.evaluate(() => { const source = moye.editor.vditor.sv.element, mask = document.querySelector('.moye-focus-source-mask'), top = mask.children[0].getBoundingClientRect(), bottom = mask.children[1].getBoundingClientRect(); return { selection: source.selectionStart, gap: bottom.top - top.bottom, lineHeight: parseFloat(getComputedStyle(source).lineHeight), pointerEvents: getComputedStyle(mask).pointerEvents, opacity: getComputedStyle(mask.firstChild).opacity, editable: !source.readOnly, text: source.value }; });
      assert.ok(result.selection > 0); assert.ok(Math.abs(result.gap - result.lineHeight) < 1); assert.equal(result.pointerEvents, 'none'); assert.equal(result.editable, true); assert.equal(result.text, 'source first\nsource second\nsource third\n');
      await page.keyboard.insertText('X'); assert.equal((await state()).dirty, true); return result;
    });
    await probe('source focus toggling in both themes preserves scroll selection raw text and undo', async () => {
      const raw = Array.from({ length: 90 }, (_, index) => `source line ${index}: words with emoji 😀`).join('\n') + '\n'; await open(raw, 'sv');
      await page.locator('.vditor-sv').click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.insertText('X'); await settle();
      await page.evaluate(() => { const source = moye.editor.vditor.sv.element; source.setSelectionRange(350, 360, 'backward'); source.scrollTop = 300; }); await settle();
      const inspect = () => page.evaluate(() => { const source = moye.editor.vditor.sv.element; return { raw: moye.getState().content, value: source.value, dirty: moye.getState().dirty, start: source.selectionStart, end: source.selectionEnd, direction: source.selectionDirection, scroll: source.scrollTop }; });
      const before = await inspect();
      for (const theme of ['light', 'dark']) { await apply({ 'appearance.theme': theme, 'editor.focusMode': false }); await apply({ 'editor.focusMode': true }); }
      assert.deepEqual(await inspect(), before); await page.evaluate(() => moye.performAction('undo')); assert.equal((await state()).content, raw); await page.evaluate(() => moye.performAction('redo')); assert.equal((await state()).content, before.raw);
      return { themes: ['light', 'dark'], raw: true, selection: true, scroll: before.scroll, undoRedo: true };
    });
    for (const mode of ['ir', 'sv']) await probe(`typewriter ${mode}: mouse click centers only with always-center; typing centers in both cases`, async () => {
      const raw = Array.from({ length: 80 }, (_, index) => `Paragraph ${String(index).padStart(3, '0')} contains text.`).join('\n\n') + '\n';
      const observations = [];
      for (const always of [false, true]) {
        await apply({ 'editor.typewriterMode': true, 'editor.typewriterAlwaysCenter': always, 'editor.focusMode': true }); await open(raw, mode);
        if (mode === 'ir') {
          await page.evaluate(() => { const root = moye.editor.vditor.ir.element; root.querySelectorAll('p')[35].scrollIntoView({ block: 'start' }); });
          await page.locator('.vditor-ir p').nth(35).click({ position: { x: 80, y: 8 } });
        } else {
          await page.evaluate(() => { const source = moye.editor.vditor.sv.element; source.scrollTop = 35 * 2 * parseFloat(getComputedStyle(source).lineHeight); });
          await page.locator('.vditor-sv').click({ position: { x: 110, y: 60 } });
        }
        await settle(); const clicked = await caretMetrics();
        if (always) assert.ok(Math.abs(clicked.middle - clicked.center) < 5, JSON.stringify(clicked));
        else assert.ok(Math.abs(clicked.middle - clicked.center) > 70, JSON.stringify(clicked));
        await page.keyboard.insertText('x'); await settle(); const typed = await caretMetrics(); assert.ok(Math.abs(typed.middle - typed.center) < 6, JSON.stringify(typed)); observations.push({ always, clickDistance: Math.abs(clicked.middle - clicked.center), typingDistance: Math.abs(typed.middle - typed.center) });
      }
      await apply({ 'editor.typewriterMode': false }); return observations;
    });
    await probe('typewriter reserves space to center first and last lines in both editor modes', async () => {
      const observations = [];
      await apply({ 'editor.typewriterMode': true, 'editor.typewriterAlwaysCenter': true, 'editor.focusMode': true });
      for (const mode of ['ir', 'sv']) {
        await open('First line.\n\nLast line.\n', mode); await page.locator(mode === 'ir' ? '.vditor-ir p:first-child' : '.vditor-sv').click();
        await page.keyboard.press('Control+Home'); await settle(); const first = await caretMetrics(); assert.ok(Math.abs(first.middle - first.center) < 6, JSON.stringify({ mode, first }));
        await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowLeft'); await settle(); const last = await caretMetrics(); assert.ok(Math.abs(last.middle - last.center) < 6, JSON.stringify({ mode, last }));
        observations.push({ mode, firstDistance: Math.abs(first.middle - first.center), lastDistance: Math.abs(last.middle - last.center) });
      }
      await apply({ 'editor.typewriterMode': false }); return observations;
    });
    await probe('composition defers focus and typewriter paint until committed', async () => {
      await open('First paragraph.\n\nSecond paragraph.\n'); await page.locator('.vditor-ir p').first().click(); await settle();
      const before = (await dimmed('p:last-child')).dimmedText;
      await page.evaluate(() => { const root = moye.editor.vditor.ir.element; root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); const p = root.querySelectorAll('p')[1], range = document.createRange(); range.selectNodeContents(p); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); }); await settle();
      assert.equal((await dimmed('p:last-child')).dimmedText, before);
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))); await settle();
      assert.equal((await dimmed('p:last-child')).dimmedText, ''); assert.equal((await state()).dirty, false); return { deferred: true, committedRefresh: true, systemIME: 'not exercised' };
    });
    await probe('Escape exits focus and removes source masks and dim ranges', async () => {
      await page.keyboard.press('Escape'); await settle(); assert.equal((await page.evaluate(() => moye.settings.getValues()))['editor.focusMode'], false); assert.equal(await page.evaluate(() => CSS.highlights.has('moye-focus-dim')), false); assert.equal(await page.locator('.moye-focus-source-mask').isVisible(), false); return { cleaned: true };
    });
  } finally { if (app) { const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; } await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); }
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, executable, application, purpose: 'Moye focus and typewriter behavior regressions; original Typora runtime comparison and system IME pending', results, pageErrors, remoteRequests };
  await fs.writeFile(path.resolve(process.env.MOYE_FOCUS_OUTPUT || path.join(root, 'tests/focus-report.json')), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); if (results.some(result => result.status !== 'pass') || pageErrors.length || remoteRequests.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
