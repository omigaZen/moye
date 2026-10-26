'use strict';

// These are Moye feature/regression checks. They do not establish Typora parity.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-settings-ui-'));
  const profile = path.join(work, 'profile');
  const results = [], pageErrors = [], remoteRequests = [];
  let app, page, application = null, documentNumber = 0;
  async function launch(userData = profile) {
    app = await electron.launch({
      executablePath: process.env.MOYE_SETTINGS_EXECUTABLE || require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []),
        ...(process.env.MOYE_SETTINGS_EXECUTABLE ? [] : [path.join(root, 'electron/main.cjs')])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: userData },
    });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }));
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && window.moye.settings, null, { timeout: 20000 });
  }
  async function exit() {
    if (!app) return;
    const process = app.process();
    const exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exited;
    app = null;
  }
  async function closeSettings() {
    await page.evaluate(async () => { await moye.settings.panel.close(); });
  }
  async function apply(patch) {
    return page.evaluate(async patch => { await moye.settings.apply(patch); return moye.settings.getValues(); }, patch);
  }
  async function applyAndReload(patch) {
    const result = await apply(patch);
    await page.evaluate(() => moye.settings.reload());
    return result;
  }
  async function values() { return page.evaluate(() => moye.settings.getValues()); }
  async function open(content) {
    await closeSettings();
    const file = path.join(work, `settings-document-${++documentNumber}.md`);
    await fs.writeFile(file, content, 'utf8');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, file);
    await page.evaluate(async () => {
      document.getElementById('find-bar').hidden = true;
      await moye.performAction('open');
      moye.setMode('ir');
    });
    await page.waitForTimeout(100);
    return file;
  }
  async function sourceState() { return page.evaluate(() => moye.getState()); }
  async function caret(selector, offset) {
    await page.evaluate(({ selector, offset }) => {
      const root = moye.editor.vditor.ir.element;
      const element = root.querySelector(selector);
      if (!element) throw new Error(`Missing caret target ${selector}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node) throw new Error('Caret target has no text');
      const range = document.createRange();
      range.setStart(node, offset === 'end' ? node.length : offset);
      range.collapse(true);
      root.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
    }, { selector, offset });
  }
  async function probe(name, callback) {
    const filter = process.env.MOYE_SETTINGS_FILTER || process.env.MOYE_SETTINGS_MATCH;
    if (filter && !name.includes(filter)) return;
    if (process.env.MOYE_SETTINGS_SKIP && name.includes(process.env.MOYE_SETTINGS_SKIP)) return;
    const started = Date.now();
    try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }

  try {
    await launch();
    await probe('native Preferences menu opens an accessible modal with real settings', async () => {
      const menu = await app.evaluate(({ Menu }) => {
        const walk = items => {
          for (const item of items) {
            if (item.label === '设置…') return item;
            const nested = item.submenu && walk(item.submenu.items); if (nested) return nested;
          }
        };
        const item = walk(Menu.getApplicationMenu().items);
        if (!item) throw new Error('Preferences native menu is missing');
        item.click(); return { label: item.label, accelerator: item.accelerator };
      });
      assert.equal(menu.accelerator, process.platform === 'darwin' ? 'Command+,' : 'Ctrl+,');
      const dialog = page.locator('#settings-dialog');
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
      const count = await dialog.locator('input[data-setting-key],select[data-setting-key],textarea[data-setting-key]').count();
      const total = await page.evaluate(() => MoyeSettingsSchema.definitions.length);
      assert.ok(total >= 20 && count >= 1, `Total ${total}; visible category controls ${count}`);
      await page.screenshot({ path: path.join(root, 'artifacts/settings-preferences-1280.png'), animations: 'disabled', timeout: 10000 });
      return { controls: count, accessibleName: await dialog.getAttribute('aria-labelledby'), menu };
    });
    await probe('settings search finds items outside the active category and clears cleanly', async () => {
      const search = page.locator('#settings-search');
      await search.fill('公式宏');
      await page.locator('input[data-setting-key="math.macros"],select[data-setting-key="math.macros"],textarea[data-setting-key="math.macros"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('input[data-setting-key="appearance.fontSize"],select[data-setting-key="appearance.fontSize"],textarea[data-setting-key="appearance.fontSize"]').isVisible(), false);
      await search.fill('');
      return { found: 'math.macros' };
    });
    await probe('font size UI changes actual rendered font and survives closing the modal', async () => {
      await page.locator('#settings-search').fill('正文字号');
      const control = page.locator('input[data-setting-key="appearance.fontSize"],select[data-setting-key="appearance.fontSize"],textarea[data-setting-key="appearance.fontSize"]');
      await control.fill('22'); await control.press('Tab');
      await page.waitForFunction(() => moye.settings.getValues()['appearance.fontSize'] === 22);
      await closeSettings();
      const actual = await page.evaluate(() => getComputedStyle(moye.editor.vditor.ir.element).fontSize);
      assert.equal(actual, '22px');
      return { fontSize: actual };
    });
    await probe('light/dark/system settings affect appearance and follow native theme changes', async () => {
      await apply({ 'appearance.theme': 'dark' });
      assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), true);
      await apply({ 'appearance.theme': 'light' });
      assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), false);
      await apply({ 'appearance.theme': 'system' });
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
      await page.waitForFunction(() => document.body.classList.contains('dark'));
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
      await page.waitForFunction(() => !document.body.classList.contains('dark'));
      return { dark: true, light: true, followsSystem: true };
    });
    await probe('content width and line height affect measured layout without editing Markdown', async () => {
      const raw = '# 外观\n\n这一段用于检测正文布局。\n';
      await open(raw);
      await apply({ 'appearance.contentWidth': 620, 'appearance.lineHeight': 2, 'appearance.fontSize': 20 });
      const result = await page.evaluate(() => {
        const element = moye.editor.vditor.ir.element, style = getComputedStyle(element);
        const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { width, lineHeight: style.lineHeight, fontSize: style.fontSize, state: moye.getState() };
      });
      assert.ok(Math.abs(result.width - 620) < 3, JSON.stringify(result));
      assert.equal(result.fontSize, '20px'); assert.equal(result.lineHeight, '40px');
      assert.equal(result.state.content, raw); assert.equal(result.state.dirty, false);
      return { width: result.width, lineHeight: result.lineHeight };
    });
    await probe('sidebar and format-toolbar settings change visible controls and remain independent', async () => {
      await apply({ 'appearance.sidebarVisible': false, 'appearance.toolbarVisible': false });
      assert.equal(await page.locator('#outline-sidebar').isVisible(), false);
      assert.equal(await page.locator('.vditor-toolbar').isVisible(), false);
      await apply({ 'appearance.sidebarVisible': true });
      assert.equal(await page.locator('#outline-sidebar').isVisible(), true);
      assert.equal(await page.locator('.vditor-toolbar').isVisible(), false);
      await apply({ 'appearance.toolbarVisible': true });
      return { sidebar: true, toolbar: true };
    });
    await probe('Escape leaves focus mode and persists the changed setting', async () => {
      await apply({ 'editor.focusMode': true });
      assert.equal(await page.locator('.app-header').isVisible(), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !moye.settings.getValues()['editor.focusMode']);
      assert.equal(await page.locator('.app-header').isVisible(), true);
      const snapshot = await page.evaluate(() => desktop.getSettings());
      assert.equal(snapshot.values['editor.focusMode'], false);
      return { persisted: true };
    });
    await probe('changing text settings then pressing Escape flushes the pending edit', async () => {
      await page.evaluate(() => moye.performAction('preferences'));
      await page.locator('#settings-search').fill('正文字体');
      const control = page.locator('input[data-setting-key="appearance.fontFamily"],select[data-setting-key="appearance.fontFamily"],textarea[data-setting-key="appearance.fontFamily"]');
      await control.fill('"Noto Sans SC", serif');
      await page.keyboard.press('Escape');
      await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
      const snapshot = await page.evaluate(() => desktop.getSettings());
      assert.equal(snapshot.values['appearance.fontFamily'], '"Noto Sans SC", serif');
      return { value: snapshot.values['appearance.fontFamily'] };
    });
    await probe('invalid multi-key updates have no partial renderer or durable effect', async () => {
      const before = await page.evaluate(() => desktop.getSettings());
      const rejection = await page.evaluate(async () => {
        try { await moye.settings.apply({ 'appearance.fontSize': 28, 'math.macros': '{not-json}' }); return null; }
        catch (error) { return error.message; }
      });
      assert.ok(rejection);
      const after = await page.evaluate(() => desktop.getSettings());
      assert.equal(after.revision, before.revision); assert.deepEqual(after.values, before.values);
      assert.equal((await values())['appearance.fontSize'], before.values['appearance.fontSize']);
      return { rejected: rejection };
    });
    await probe('source Tab uses the selected two and eight-space indent widths', async () => {
      await open('alpha\n');
      await page.evaluate(() => moye.setMode('sv'));
      const outputs = [];
      for (const width of [2, 8]) {
        await apply({ 'editor.tabSize': width });
        await page.locator('.vditor-sv').fill('alpha\n');
        await page.evaluate(() => { const e = moye.editor.vditor.sv.element; e.focus(); e.setSelectionRange(0, 0); });
        await page.keyboard.press('Tab');
        const actual = await page.locator('.vditor-sv').inputValue();
        assert.equal(actual, `${' '.repeat(width)}alpha\n`); outputs.push({ width, prefix: actual.slice(0, width) });
      }
      return outputs;
    });
    await probe('bracket auto-pair can be enabled/disabled and keeps the caret between the pair', async () => {
      await open('text\n');
      await page.evaluate(() => moye.setMode('sv'));
      const outputs = [];
      for (const enabled of [true, false]) {
        await apply({ 'editor.autoPairBrackets': enabled });
        await page.locator('.vditor-sv').fill(''); await page.locator('.vditor-sv').focus();
        await page.keyboard.insertText('(');
        const actual = await page.evaluate(() => { const e = moye.editor.vditor.sv.element; return { text: e.value, start: e.selectionStart, end: e.selectionEnd }; });
        assert.equal(actual.text, enabled ? '()' : '('); assert.equal(actual.start, 1); assert.equal(actual.end, 1);
        outputs.push({ enabled, ...actual });
      }
      return outputs;
    });
    await probe('Markdown pairing wraps an existing selected word when enabled', async () => {
      await apply({ 'editor.autoPairMarkdown': true });
      await page.locator('.vditor-sv').fill('word');
      await page.evaluate(() => { const e = moye.editor.vditor.sv.element; e.focus(); e.setSelectionRange(0, 4); });
      await page.keyboard.insertText('=');
      assert.equal(await page.locator('.vditor-sv').inputValue(), '=word=');
      return { text: '=word=' };
    });
    await probe('highlight toggle changes rendered structure while retaining CRLF and clean document state', async () => {
      const raw = '# 标题\r\n\r\n==高亮== 和普通正文\r\n';
      await applyAndReload({ 'markdown.mark': true }); const file = await open(raw);
      const normalized = (await sourceState()).content;
      assert.equal(await page.locator('.vditor-ir mark').count(), 1);
      await apply({ 'markdown.mark': false });
      assert.equal(await page.evaluate(() => moye.settings.isReloadPending()), true);
      assert.equal(await page.locator('.vditor-ir mark').count(), 1, 'Parsing changes must wait for explicit reload');
      await page.evaluate(() => moye.settings.reload());
      assert.equal(await page.locator('.vditor-ir mark').count(), 0);
      assert.equal((await sourceState()).content, normalized); assert.equal((await sourceState()).dirty, false);
      await applyAndReload({ 'markdown.mark': true });
      assert.equal(await page.locator('.vditor-ir mark').count(), 1);
      assert.equal((await sourceState()).content, normalized);
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(file, 'utf8'), raw);
      return { sourcePreserved: true, crlfSavedExactly: true, markRestored: true };
    });
    await probe('superscript and subscript settings independently change parsing', async () => {
      await applyAndReload({ 'markdown.sup': true, 'markdown.sub': true });
      const raw = 'x^2^ H~2~O\n'; await open(raw);
      assert.equal(await page.locator('.vditor-ir sup').count(), 1); assert.equal(await page.locator('.vditor-ir sub').count(), 1);
      await applyAndReload({ 'markdown.sup': false });
      assert.equal(await page.locator('.vditor-ir sup').count(), 0); assert.equal(await page.locator('.vditor-ir sub').count(), 1);
      await applyAndReload({ 'markdown.sub': false });
      assert.equal(await page.locator('.vditor-ir sub').count(), 0); assert.equal((await sourceState()).content, raw);
      return { independent: true };
    });
    await probe('footnotes and TOC can be disabled and re-enabled without deleting their source', async () => {
      await applyAndReload({ 'markdown.footnotes': true, 'markdown.toc': true });
      const raw = '# Navigation\n\n[toc]\n\nText[^one]\n\n[^one]: Definition\n'; await open(raw);
      assert.equal(await page.locator('.vditor-ir .vditor-toc').count(), 1);
      assert.equal(await page.locator('.vditor-ir [data-type="footnotes-ref"]').count(), 1);
      await applyAndReload({ 'markdown.footnotes': false, 'markdown.toc': false });
      assert.equal(await page.locator('.vditor-ir .vditor-toc').count(), 0);
      assert.equal(await page.locator('.vditor-ir [data-type="footnotes-ref"]').count(), 0);
      assert.equal((await sourceState()).content, raw);
      await applyAndReload({ 'markdown.footnotes': true, 'markdown.toc': true });
      assert.equal(await page.locator('.vditor-ir [data-type="footnotes-ref"]').count(), 1);
      return { restored: true, sourcePreserved: true };
    });
    await probe('inline math setting removes rendering and restores the original expression offline', async () => {
      await applyAndReload({ 'markdown.inlineMath': true });
      const raw = 'Text $\\frac{1}{2}$ after.\n'; await open(raw);
      await page.waitForFunction(() => document.querySelector('.vditor-ir mjx-container,.vditor-ir .katex'));
      await applyAndReload({ 'markdown.inlineMath': false });
      assert.equal(await page.locator('.vditor-ir mjx-container,.vditor-ir .katex').count(), 0);
      assert.equal((await sourceState()).content, raw);
      await applyAndReload({ 'markdown.inlineMath': true });
      await page.waitForFunction(() => document.querySelector('.vditor-ir mjx-container,.vditor-ir .katex'));
      return { offlineRenderRestored: true };
    });
    await probe('formula numbering control is disabled for KaTeX and enabled for MathJax', async () => {
      await closeSettings();
      await page.evaluate(() => moye.performAction('preferences'));
      await page.locator('#settings-search').fill('公式自动编号');
      const control = page.locator('input[data-setting-key="math.autoNumber"]');
      await apply({ 'math.engine': 'KaTeX' });
      assert.equal(await control.isDisabled(), true);
      await apply({ 'math.engine': 'MathJax' });
      assert.equal(await control.isDisabled(), false);
      await closeSettings(); await page.evaluate(() => moye.settings.reload());
      return { KaTeX: 'disabled', MathJax: 'enabled' };
    });
    await probe('live appearance settings preserve an existing source selection and undo history', async () => {
      const sequences = [];
      for (const changeAppearance of [false, true]) {
        await open('before\n'); await page.evaluate(() => moye.setMode('sv'));
        await page.locator('.vditor-sv').focus();
        await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('added');
        await page.waitForTimeout(400);
        await page.evaluate(() => { const e = moye.editor.vditor.sv.element; e.setSelectionRange(2, 5, 'backward'); });
        const before = await sourceState();
        if (changeAppearance) await apply({ 'appearance.fontSize': 19 });
        const selection = await page.evaluate(() => { const e = moye.editor.vditor.sv.element; return [e.selectionStart, e.selectionEnd, e.selectionDirection]; });
        assert.deepEqual(selection, [2, 5, 'backward']); assert.equal((await sourceState()).content, before.content);
        const undo = [];
        for (let index = 0; index < 3; index++) {
          await page.evaluate(() => moye.performAction('undo'));
          const content = (await sourceState()).content; undo.push(content);
          if (content === 'before\n') break;
        }
        assert.equal(undo.at(-1), 'before\n', 'Pre-appearance text history must still be reachable');
        sequences.push(undo);
      }
      assert.deepEqual(sequences[1], sequences[0], 'Appearance change must not alter undo behavior relative to the same selection-only sequence');
      return { selection: [2, 5, 'backward'], undoSequences: sequences, undoPreserved: true };
    });
    await probe('explicit parsing reload retains unsaved edits and does not write the document to disk', async () => {
      const original = 'Paragraph before\n';
      const file = await open(original);
      await caret('p', 'end'); await page.keyboard.insertText(' 中文修改');
      const before = await sourceState(); assert.equal(before.dirty, true);
      await apply({ 'markdown.mark': !(await values())['markdown.mark'] });
      await page.evaluate(() => moye.settings.reload());
      const after = await sourceState();
      assert.equal(after.content, before.content); assert.equal(after.dirty, true);
      assert.equal(await fs.readFile(file, 'utf8'), original);
      return { unsavedTextPreserved: true, notAutoSavedByReload: true };
    });
    await probe('configuration updates are rejected during active composition and can succeed after it ends', async () => {
      await page.evaluate(() => moye.setMode('sv'));
      const before = await values();
      await page.evaluate(() => moye.editor.vditor.sv.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
      let rejected;
      try {
        rejected = await page.evaluate(async () => { try { await moye.settings.apply({ 'appearance.fontSize': 26 }); return false; } catch { return true; } });
        assert.equal(rejected, true); assert.equal((await values())['appearance.fontSize'], before['appearance.fontSize']);
      } finally {
        await page.evaluate(() => moye.editor.vditor.sv.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
      }
      await apply({ 'appearance.fontSize': 26 }); assert.equal((await values())['appearance.fontSize'], 26);
      return { syntheticCompositionGuard: true, realSystemIMEStillUntested: true };
    });
    await probe('asynchronous parsing reload blocks editing and mode changes, serializes new-document actions, and retains newer pending settings', async () => {
      await applyAndReload({ 'markdown.mark': true });
      const original = '# Old document\n\nUnique old content.\n';
      const file = await open(original);
      await caret('p', 'end');
      await apply({ 'markdown.mark': false });
      await page.evaluate(() => {
        window.__settingsRealMath = window.MoyeMath;
        const gate = window.__settingsReloadGate = { entered: false };
        window.MoyeMath = { ...window.MoyeMath, configure: async options => {
          gate.entered = true;
          await new Promise(resolve => { gate.release = resolve; });
          return window.__settingsRealMath.configure(options);
        } };
        window.__settingsReloadPromise = moye.settings.reload();
      });
      try {
        await page.waitForFunction(() => window.__settingsReloadGate.entered);
        const before = await sourceState();
        assert.equal(await page.evaluate(() => moye.editor.vditor.ir.element.getAttribute('contenteditable')), 'false');
        await page.keyboard.insertText('SHOULD-NOT-APPEAR');
        await page.evaluate(() => moye.setMode('sv'));
        assert.equal((await sourceState()).mode, 'ir'); assert.equal((await sourceState()).content, original);
        await apply({ 'markdown.mark': true });
        await page.evaluate(() => { window.__settingsQueuedNew = moye.performAction('new'); });
        assert.equal((await sourceState()).documentId, before.documentId, 'New document must remain queued until reload finishes');
        await page.evaluate(async () => {
          window.__settingsReloadGate.release();
          await window.__settingsReloadPromise; await window.__settingsQueuedNew;
        });
        const after = await sourceState();
        assert.equal(after.content, ''); assert.equal(after.path, null);
        assert.equal(await page.evaluate(() => moye.settings.isReloadPending()), true, 'A newer preference must not be mistaken for the frozen configuration applied by the first reload');
        assert.equal(await fs.readFile(file, 'utf8'), original);
        assert.equal(await page.evaluate(() => moye.editor.vditor.ir.element.getAttribute('contenteditable')), 'true');
        return { editingBlocked: true, modeChangeBlocked: true, queuedNewDocumentIsEmpty: true, newerSettingPending: true };
      } finally {
        await page.evaluate(async () => {
          window.__settingsReloadGate?.release?.();
          await Promise.allSettled([window.__settingsReloadPromise, window.__settingsQueuedNew]);
          window.MoyeMath = window.__settingsRealMath;
          delete window.__settingsRealMath; delete window.__settingsReloadGate;
          delete window.__settingsReloadPromise; delete window.__settingsQueuedNew;
        });
      }
    });
    await probe('code-wrap and line-number settings affect the displayed code block', async () => {
      await apply({ 'code.wrap': false, 'code.lineNumbers': false });
      await open('```javascript\nconst longName = "' + 'abcdefgh'.repeat(40) + '";\nconsole.log(longName);\n```\n');
      await page.waitForFunction(() => document.querySelector('.vditor-ir .vditor-ir__preview code'));
      const before = await page.evaluate(() => getComputedStyle(document.querySelector('.vditor-ir .vditor-ir__preview code')).whiteSpace);
      assert.equal(before, 'pre');
      await apply({ 'code.wrap': true, 'code.lineNumbers': true });
      const after = await page.evaluate(() => {
        const code = document.querySelector('.vditor-ir .vditor-ir__preview code');
        return { whiteSpace: getComputedStyle(code).whiteSpace,
          lineNumbers: code.querySelectorAll('.vditor-linenumber__rows > span,.hljs-ln-numbers,.highlight-ln,.hljs-linenumber,[data-line-number]').length };
      });
      assert.ok(['pre-wrap', 'break-spaces'].includes(after.whiteSpace), JSON.stringify(after));
      assert.ok(after.lineNumbers >= 2, JSON.stringify(after));
      return { before, ...after };
    });
    await probe('remaining: disabled block-math preview shows editable formula source and restores rendering after an edit', async () => {
      await applyAndReload({ 'markdown.mathBlock': true, 'math.engine': 'MathJax' });
      const raw = '$$\n\\frac{3}{7}\n$$\n\nAfter math.\n';
      await open(raw);
      await page.waitForFunction(() => document.querySelector('.vditor-ir mjx-container'));
      await applyAndReload({ 'markdown.mathBlock': false });
      assert.equal(await page.locator('.vditor-ir mjx-container,.vditor-ir .katex').count(), 0);
      const visible = await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const offset = node.data.indexOf('\\frac{3}{7}'); if (offset < 0) continue;
          const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 11);
          const rect = range.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const parent = node.parentElement;
          if (!parent.isContentEditable) continue;
          parent.scrollIntoView({ block: 'center' }); root.focus();
          range.setStart(node, offset + '\\frac{3}{'.length); range.setEnd(node, offset + '\\frac{3}{'.length + 1);
          getSelection().removeAllRanges(); getSelection().addRange(range);
          return { width: rect.width, height: rect.height, editable: parent.isContentEditable };
        }
        return null;
      });
      assert.ok(visible, 'Disabling preview must leave visible, editable formula text, not an empty block');
      await page.keyboard.insertText('8');
      assert.match((await sourceState()).content, /\\frac\{3\}\{8\}/);
      await applyAndReload({ 'markdown.mathBlock': true });
      await page.waitForFunction(() => document.querySelector('.vditor-ir mjx-container'));
      assert.match((await sourceState()).content, /\\frac\{3\}\{8\}/);
      return { sourceVisible: visible, editRetained: true, renderingRestored: true };
    });
    await probe('remaining: diagram toggle leaves source visible, preserves ordinary code highlighting, and restores diagrams', async () => {
      await applyAndReload({ 'markdown.diagrams': true });
      const raw = '```mermaid\nflowchart LR\n A[Alpha] --> B[Beta]\n```\n\n```csharp\npublic int Count = 3;\n```\n';
      await open(raw);
      await page.waitForFunction(() => document.querySelector('.vditor-ir .language-mermaid svg'));
      await page.waitForFunction(() => document.querySelector('.vditor-ir .language-csharp .hljs-keyword'));
      await applyAndReload({ 'markdown.diagrams': false });
      assert.equal(await page.locator('.vditor-ir .language-mermaid svg').count(), 0);
      assert.ok(await page.locator('.vditor-ir .language-csharp .hljs-keyword').count());
      const visible = await page.evaluate(() => {
        const walker = document.createTreeWalker(moye.editor.vditor.ir.element, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
          if (!node.data.includes('flowchart LR')) continue;
          const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
        return false;
      });
      assert.equal(visible, true); assert.equal((await sourceState()).content, raw); assert.equal((await sourceState()).dirty, false);
      await applyAndReload({ 'markdown.diagrams': true });
      await page.waitForFunction(() => document.querySelector('.vditor-ir .language-mermaid svg'));
      assert.equal((await sourceState()).content, raw);
      return { diagramCodeVisible: true, ordinaryCodeHighlighted: true, sourceUnchanged: true };
    });
    await probe('remaining: automatic-link setting changes parsed links without rewriting the source', async () => {
      await applyAndReload({ 'markdown.autoLink': true });
      const raw = 'Visit https://example.com/path and https://example.test/path and www.example.com today.\n\nCode `https://example.com/code`.\n\n```text\nhttps://example.com/fenced\n```\n';
      await open(raw);
      const expected = await page.evaluate(raw => {
        const parser = Lute.New(); parser.SetVditorIR(false); parser.SetGFMAutoLink(true);
        const html = new DOMParser().parseFromString(parser.Md2HTML(raw), 'text/html');
        return [...html.querySelectorAll('a[href]')].map(link => ({ text: link.textContent, url: link.getAttribute('href') }));
      }, raw);
      assert.ok(expected.some(link => link.url === 'https://example.com/path'));
      try { await page.waitForFunction(count => moye.autoLinks?.getLinks().length === count, expected.length, { timeout: 5000 }); }
      catch (error) {
        const actual = await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, ancestors = []; let node = root;
          while (node && ancestors.length < 4) { ancestors.push({ tag: node.tagName, class: node.className, contenteditable: node.getAttribute('contenteditable') }); node = node.parentElement; }
          return { mode: moye.editor.getCurrentMode(), root: root.outerHTML.slice(0, 1000), ancestors,
            values: moye.settings.getValues()['markdown.autoLink'], pending: moye.settings.isReloadPending(),
            before: moye.autoLinks?.getLinks().map(({ text, url }) => ({ text, url })),
            refresh: moye.autoLinks?.refresh().map(({ text, url }) => ({ text, url })) };
        });
        throw new Error(`${error.message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
      }
      const highlighted = await page.evaluate(() => {
        const links = moye.autoLinks.getLinks(), highlight = CSS.highlights.get('moye-autolink');
        const sameRange = (a, b) => a.startContainer === b.startContainer && a.endContainer === b.endContainer && a.startOffset === b.startOffset && a.endOffset === b.endOffset;
        return { links: links.map(link => ({ text: link.text, url: link.url, selectedText: link.range.toString(), connected: link.range.startContainer.isConnected })),
          highlightCount: highlight?.size || 0,
          allRangesHighlighted: !!highlight && links.every(link => [...highlight].some(range => sameRange(range, link.range))) };
      });
      assert.deepEqual(highlighted.links.map(({ text, url }) => ({ text, url })), expected);
      assert.equal(highlighted.highlightCount, expected.length); assert.equal(highlighted.allRangesHighlighted, true);
      assert.ok(highlighted.links.every(link => link.connected && link.selectedText === link.text));
      assert.equal((await sourceState()).content, raw); assert.equal((await sourceState()).dirty, false);
      await app.evaluate(({ app, BrowserWindow }) => {
        app.__moyeSettingsOpenedUrls = [];
        BrowserWindow.getAllWindows()[0].webContents.setWindowOpenHandler(({ url }) => { app.__moyeSettingsOpenedUrls.push(url); return { action: 'deny' }; });
      });
      const point = await page.evaluate(() => {
        const link = moye.autoLinks.getLinks().find(link => link.url === 'https://example.com/path');
        const rect = link.range.getClientRects()[0]; return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
      assert.deepEqual(await app.evaluate(({ app }) => app.__moyeSettingsOpenedUrls), []);
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.down(modifier); await page.mouse.click(point.x, point.y); await page.keyboard.up(modifier);
      let opened = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        opened = await app.evaluate(({ app }) => app.__moyeSettingsOpenedUrls);
        if (opened.length) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual(opened, ['https://example.com/path']);
      await apply({ 'markdown.autoLink': false });
      assert.equal(await page.evaluate(() => moye.autoLinks.getLinks().length), expected.length, 'The saved Markdown setting should apply only after explicit reload');
      await page.evaluate(() => moye.settings.reload());
      await page.waitForFunction(() => moye.autoLinks.getLinks().length === 0);
      assert.equal(await page.evaluate(() => CSS.highlights.get('moye-autolink')?.size || 0), 0);
      assert.equal((await sourceState()).content, raw); assert.equal((await sourceState()).dirty, false);
      await applyAndReload({ 'markdown.autoLink': true });
      await page.waitForFunction(count => moye.autoLinks.getLinks().length === count, expected.length);
      await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element, link = moye.autoLinks.getLinks().find(link => link.url === 'https://example.com/path');
        const range = link.range.cloneRange(); range.collapse(false); root.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.keyboard.insertText('/edit');
      await page.waitForFunction(() => moye.autoLinks.getLinks().some(link => link.url === 'https://example.com/path/edit'));
      assert.ok((await sourceState()).content.includes('https://example.com/path/edit'));
      await page.waitForTimeout(400); await page.evaluate(() => moye.performAction('undo'));
      await page.waitForFunction(() => moye.autoLinks.getLinks().some(link => link.url === 'https://example.com/path') && !moye.autoLinks.getLinks().some(link => link.url.endsWith('/edit')));
      assert.equal((await sourceState()).content, raw);
      return { expectedFromIndependentLute: expected, highlighted, normalClickOpensNothing: true, ctrlClickOpened: opened,
        disabledHighlights: 0, editingAndUndoTracked: true, sourceUnchangedByHighlighting: true,
        typoraTldComparison: 'not executed; independent Lute output is a parser reference, not proof of Typora parity' };
    });
    await probe('remaining: code default language applies to toolbar creation without duplicating an unselected document', async () => {
      await apply({ 'code.defaultLanguage': 'python' });
      const original = 'Existing paragraph.\n'; await open(original); await caret('p', 'end');
      await page.locator('.vditor-toolbar button[data-type="code"]').click();
      let actual = (await sourceState()).content;
      assert.match(actual, /^```python$/m); assert.equal(actual.split('Existing paragraph.').length - 1, 1);
      assert.equal(actual.split('```python')[1].split('```')[0].includes('Existing paragraph.'), false, 'Empty selection must produce an empty block, never copy the entire document into it');
      await open('print("hello")\n');
      await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element, p = root.querySelector('p'), range = document.createRange();
        root.focus(); range.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.locator('.vditor-toolbar button[data-type="code"]').click();
      actual = (await sourceState()).content;
      assert.match(actual, /^```python$/m); assert.equal(actual.split('print("hello")').length - 1, 1);
      assert.match(actual.split('```python')[1].split('```')[0], /print\("hello"\)/);
      await apply({ 'code.defaultLanguage': '' });
      return { defaultLanguageInCreatedFence: 'python', unselectedParagraphCopied: false, selectedBodyWrappedExactlyOnce: true };
    });
    await probe('remaining: code theme loads local styles and changes the actual keyword colour', async () => {
      await apply({ 'code.theme': 'github' }); await open('```csharp\npublic class ThemeTest { public int Count = 3; }\n```\n');
      await page.waitForFunction(() => document.querySelector('.vditor-ir .language-csharp .hljs-keyword'));
      let previous = await page.evaluate(() => getComputedStyle(document.querySelector('.vditor-ir .language-csharp .hljs-keyword')).color);
      const colours = new Map([['github', previous]]), observations = [];
      for (const [theme, lineNumbers] of [['monokai', false], ['github', true], ['monokai', true], ['github', false]]) {
        await apply({ 'code.theme': theme, 'code.lineNumbers': lineNumbers });
        await page.waitForFunction(({ previous, theme }) => {
          const keyword = document.querySelector('.vditor-ir .language-csharp .hljs-keyword'), sheet = document.getElementById('vditorHljsStyle');
          return keyword && sheet?.href.includes(`/${theme}.min.css`) && getComputedStyle(keyword).color !== previous;
        }, { previous, theme });
        const actual = await page.evaluate(() => ({ colour: getComputedStyle(document.querySelector('.vditor-ir .language-csharp .hljs-keyword')).color,
          stylesheet: document.getElementById('vditorHljsStyle').href,
          keywords: document.querySelectorAll('.vditor-ir .language-csharp .hljs-keyword').length,
          lineNumbers: document.querySelectorAll('.vditor-ir .language-csharp .vditor-linenumber__rows > span').length }));
        assert.match(actual.stylesheet, /^file:/); assert.ok(actual.keywords > 0);
        assert.equal(actual.lineNumbers > 0, lineNumbers);
        if (colours.has(theme)) assert.equal(actual.colour, colours.get(theme));
        else colours.set(theme, actual.colour);
        previous = actual.colour; observations.push({ theme, ...actual });
      }
      return observations;
    });
    await probe('remaining: monospace setting changes both rendered code and source-editor computed fonts', async () => {
      await apply({ 'appearance.monospaceFontFamily': '"Liberation Mono", monospace' });
      const raw = '正文 `inline-code`。\n\n```csharp\nint value = 1;\n```\n'; await open(raw);
      const code = await page.evaluate(() => [...moye.editor.vditor.ir.element.querySelectorAll('code')].map(element => getComputedStyle(element).fontFamily));
      assert.ok(code.length >= 2); assert.ok(code.every(value => /Liberation Mono/.test(value)), JSON.stringify(code));
      await page.evaluate(() => moye.setMode('sv'));
      const sourceFont = await page.evaluate(() => getComputedStyle(moye.editor.vditor.sv.element).fontFamily);
      assert.match(sourceFont, /Liberation Mono/); assert.equal((await sourceState()).content, raw);
      return { codeFonts: [...new Set(code)], sourceFont };
    });
    await probe('remaining: typewriter mode centres the caret after Enter in the middle of a long document', async () => {
      const raw = Array.from({ length: 80 }, (_, index) => `第${String(index).padStart(3, '0')}段：用于检测打字机模式的实际滚动位置。`).join('\n\n') + '\n';
      const observations = [];
      for (const enabled of [false, true]) {
        await apply({ 'editor.typewriterMode': enabled, 'appearance.fontSize': 17, 'appearance.lineHeight': 1.85 });
        await open(raw);
        await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, p = root.querySelectorAll('p')[35];
          root.focus(); const range = document.createRange(); range.selectNodeContents(p); range.collapse(false);
          getSelection().removeAllRanges(); getSelection().addRange(range); p.scrollIntoView({ block: 'start' });
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        const observed = await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, range = getSelection().getRangeAt(0), rect = range.getBoundingClientRect();
          const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
          const fallback = (node.closest('p') || node).getBoundingClientRect();
          const caretTop = rect.height ? rect.top + rect.height / 2 : fallback.top + Math.min(fallback.height, parseFloat(getComputedStyle(root).lineHeight)) / 2;
          const editorRect = root.getBoundingClientRect(), centre = editorRect.top + root.clientHeight / 2;
          return { caretTop, centre, distance: Math.abs(caretTop - centre), scrollTop: root.scrollTop };
        });
        observations.push({ enabled, ...observed });
      }
      assert.ok(observations[0].distance > 120, JSON.stringify(observations));
      assert.ok(observations[1].distance < 70, JSON.stringify(observations));
      await apply({ 'editor.typewriterMode': false });
      return observations;
    });
    await probe('remaining: selected indent width changes actual Tab insertion inside an IR code block', async () => {
      const observations = [];
      for (const width of [2, 8]) {
        await apply({ 'editor.tabSize': width }); await open('```csharp\nCall();\n```\n');
        await page.locator('.vditor-ir .vditor-ir__preview code.language-csharp').click();
        const before = await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, code = root.querySelector('[data-type="code-block"] .vditor-ir__marker--pre code');
          const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT), node = walker.nextNode();
          const range = document.createRange(); range.setStart(node, 0); range.collapse(true); root.focus();
          getSelection().removeAllRanges(); getSelection().addRange(range);
          return { html: code.outerHTML, focused: document.activeElement === root, position: getSelection().anchorOffset, container: node.data };
        });
        await page.keyboard.press('Tab');
        await page.waitForFunction(width => moye.getState().content.includes(`\n${' '.repeat(width)}Call();`), width, { timeout: 1500 });
        const actual = (await sourceState()).content;
        assert.match(actual, new RegExp(`^ {${width}}Call\\(\\);$`, 'm'), JSON.stringify({ before, after: await page.evaluate(() => moye.editor.vditor.ir.element.innerHTML) }));
        observations.push({ width, source: actual });
      }
      return observations;
    });
    await probe('copying may use Markdown in the plain-text clipboard while retaining HTML', async () => {
      await open('**Bold** and [Link](https://example.test)\n');
      const captures = [];
      for (const enabled of [false, true]) {
        await apply({ 'editor.copyPlainTextAsMarkdown': enabled });
        const selection = await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, p = root.querySelector('p');
          root.focus(); const range = document.createRange(); range.selectNodeContents(p);
          getSelection().removeAllRanges(); getSelection().addRange(range);
          return { selected: getSelection().toString(), html: p.innerHTML, source: moye.getState().content };
        });
        await page.keyboard.press('ControlOrMeta+C');
        const result = await app.evaluate(async ({ clipboard }) => {
          const entries = await clipboard.read(), htmlEntry = entries.find(item => item.types.includes('text/html'));
          return { plain: await clipboard.readText(), html: htmlEntry ? await (await htmlEntry.getType('text/html')).text() : '' };
        });
        if (enabled) { assert.match(result.plain, /\*\*Bold\*\*/); assert.match(result.plain, /https:\/\/example\.test/); }
        else { assert.match(result.plain, /Bold.*and.*Link/, JSON.stringify({ clipboard: result, selection })); assert.equal(result.plain.includes('**'), false); }
        assert.ok(result.html.length, 'Copying must retain rich HTML data'); captures.push({ enabled, plain: result.plain, htmlPresent: true });
      }
      return captures;
    });
    await probe('cutting uses the selected clipboard format, removes only the selection, and undo restores formatted source', async () => {
      const captures = [];
      for (const enabled of [false, true]) {
        await apply({ 'editor.copyPlainTextAsMarkdown': enabled });
        const original = '# Keep\n\n**Bold** and [Link](https://example.test)\n\nTail 中文\n';
        await open(original);
        const before = (await sourceState()).content;
        await page.evaluate(() => {
          const root = moye.editor.vditor.ir.element, p = root.querySelector('p');
          root.focus(); const range = document.createRange(); range.selectNodeContents(p);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        });
        await page.keyboard.press('ControlOrMeta+X');
        const clipboard = await app.evaluate(async ({ clipboard }) => {
          const entries = await clipboard.read(), entry = entries.find(item => item.types.includes('text/html'));
          return { plain: await clipboard.readText(), html: entry ? await (await entry.getType('text/html')).text() : '' };
        });
        if (enabled) {
          assert.match(clipboard.plain, /\*\*Bold\*\*/); assert.match(clipboard.plain, /\[Link\]\(https:\/\/example\.test\)/);
        } else assert.equal(clipboard.plain.trim(), 'Bold and Link');
        assert.match(clipboard.html, /<strong(?:\s|>)/); assert.match(clipboard.html, /<a\s[^>]*href="https:\/\/example\.test"/);
        assert.equal(clipboard.html.includes('vditor-ir__marker'), false);
        const remaining = (await sourceState()).content;
        assert.equal(remaining.replace(/\n{3,}/g, '\n\n'), '# Keep\n\nTail 中文\n');
        await page.evaluate(() => moye.performAction('undo'));
        assert.equal((await sourceState()).content, before, 'One Undo should restore the complete cut, formatting and link destination');
        captures.push({ enabled, plain: clipboard.plain, semanticHtml: true, remaining, undoRestoredExactSource: true });
      }
      return captures;
    });
    await probe('copy-image policy creates a document-owned image and reference policy retains the original location', async () => {
      const doc = await open('Image policy test.\n');
      const image = path.join(work, '原图 空格.svg');
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="green"/></svg>');
      await fs.writeFile(image, bytes);
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, image);
      await apply({ 'images.insertAction': 'copy' });
      const copied = await page.evaluate(() => desktop.chooseImages());
      assert.equal(copied.length, 1); assert.notEqual(copied[0].path, image);
      assert.equal(path.dirname(copied[0].path), path.join(path.dirname(doc), `${path.basename(doc, '.md')}.assets`));
      assert.deepEqual(await fs.readFile(copied[0].path), bytes); assert.match(copied[0].markdown, /\.\/.*\.assets\//);
      await apply({ 'images.insertAction': 'reference' });
      const referenced = await page.evaluate(() => desktop.chooseImages());
      assert.equal(referenced[0].path, image); assert.match(referenced[0].markdown, /file:\/\//); assert.match(referenced[0].markdown, /%20/);
      return { copiedToDocumentAssets: true, referencedOriginal: true };
    });
    await probe('automatic save writes committed edits on its configured timer without opening a save dialog', async () => {
      const file = await open('autosave before\n');
      await page.clock.install();
      await apply({ 'general.autoSaveIntervalMinutes': 1, 'general.autoSave': true });
      await page.evaluate(() => moye.setMode('sv')); await page.locator('.vditor-sv').fill('autosave after 中文\n');
      await page.clock.fastForward(61000);
      let actual = '';
      for (let attempt = 0; attempt < 80; attempt++) {
        actual = await fs.readFile(file, 'utf8');
        if (actual === 'autosave after 中文\n') break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(actual, 'autosave after 中文\n');
      // The native atomic write becomes visible to this host process before
      // its IPC reply necessarily reaches the renderer. Check the two stages
      // separately, retaining a bounded gate on the renderer acknowledgement.
      const dirtyWhenDiskWriteObserved = (await sourceState()).dirty;
      const acknowledgementStarted = Date.now();
      await page.waitForFunction(() => !moye.getState().dirty, null, { timeout: 5000, polling: 25 });
      assert.equal((await sourceState()).dirty, false);
      await apply({ 'general.autoSave': false }); await page.clock.resume();
      return { configuredMinutes: 1, committedSourceWritten: true, dirtyWhenDiskWriteObserved, rendererAcknowledgementWaitMs: Date.now() - acknowledgementStarted };
    });
    await probe('invalid settings import is rejected atomically and leaves the open document intact', async () => {
      const raw = 'A document retained across imports.\n'; await open(raw);
      const file = path.join(work, 'invalid-settings.json');
      await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, values: { 'appearance.theme': 'dark', 'editor.tabSize': 3 } }));
      const before = await page.evaluate(() => desktop.getSettings());
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
      const error = await page.evaluate(async () => { try { await desktop.importSettings(); return null; } catch (error) { return error.message; } });
      assert.ok(error);
      const after = await page.evaluate(() => desktop.getSettings());
      assert.deepEqual(after.values, before.values); assert.equal(after.revision, before.revision);
      assert.equal((await sourceState()).content, raw);
      return { rejected: true, documentPreserved: true };
    });
    await probe('exported settings round-trip through native import and change actual appearance', async () => {
      await apply({ 'appearance.fontSize': 23, 'appearance.theme': 'dark', 'editor.tabSize': 8 });
      const file = path.join(work, 'exported-settings.json');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
      const exported = await page.evaluate(() => desktop.exportSettings()); assert.equal(exported.saved, true);
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(data.values['appearance.fontSize'], 23);
      await apply({ 'appearance.fontSize': 15, 'appearance.theme': 'light', 'editor.tabSize': 2 });
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
      await page.evaluate(() => desktop.importSettings());
      await page.waitForFunction(() => moye.settings.getValues()['appearance.fontSize'] === 23 && document.body.classList.contains('dark'));
      assert.equal((await values())['editor.tabSize'], 8);
      return { exported: true, imported: true, renderedFontSize: await page.evaluate(() => getComputedStyle(moye.editor.vditor.ir.element).fontSize) };
    });
    await probe('restarting the actual Electron process restores durable settings and appearance', async () => {
      await apply({ 'appearance.theme': 'dark', 'appearance.fontSize': 21, 'editor.tabSize': 2, 'code.wrap': false });
      await exit(); await launch();
      const result = await page.evaluate(() => ({ values: moye.settings.getValues(), dark: document.body.classList.contains('dark'), font: getComputedStyle(moye.editor.vditor.ir.element).fontSize }));
      assert.equal(result.values['appearance.fontSize'], 21); assert.equal(result.values['editor.tabSize'], 2); assert.equal(result.values['code.wrap'], false);
      assert.equal(result.dark, true); assert.equal(result.font, '21px');
      return { durableFontSize: result.font, durableTabSize: 2 };
    });
    await probe('legacy theme, outline, and zoom migrate atomically once and cannot override newer native settings', async () => {
      const legacyProfile = path.join(work, 'legacy-profile');
      await exit();
      try {
        await launch(legacyProfile);
        await page.evaluate(() => {
          localStorage.setItem('moye.theme', 'dark');
          localStorage.setItem('moye.outline', 'false');
          localStorage.setItem('moye.zoom', '110');
        });
        await exit();
        // This is the isolated profile generated by this test, never a real
        // user profile. Preserve its legacy Chromium storage while removing
        // only the native settings file to emulate an old app installation.
        const file = path.join(legacyProfile, 'settings.json');
        assert.equal(path.dirname(file), legacyProfile);
        await fs.rm(file, { force: true });
        await launch(legacyProfile);
        const migrated = await page.evaluate(async () => ({ snapshot: await desktop.getSettings(), dark: document.body.classList.contains('dark'), fontSize: getComputedStyle(moye.editor.vditor.ir.element).fontSize }));
        assert.equal(migrated.snapshot.revision, 1, 'All legacy fields should be committed in one atomic migration');
        assert.equal(migrated.snapshot.values['appearance.theme'], 'dark');
        assert.equal(migrated.snapshot.values['appearance.sidebarVisible'], false);
        assert.equal(migrated.snapshot.values['appearance.fontSize'], 19);
        assert.equal(migrated.dark, true); assert.equal(migrated.fontSize, '19px');
        assert.equal(await page.locator('#outline-sidebar').isVisible(), false);
        await apply({ 'appearance.theme': 'light', 'appearance.sidebarVisible': true, 'appearance.fontSize': 16 });
        const revision = (await page.evaluate(() => desktop.getSettings())).revision;
        await page.evaluate(() => { localStorage.setItem('moye.zoom', '170'); });
        await exit(); await launch(legacyProfile);
        const current = await page.evaluate(async () => ({ snapshot: await desktop.getSettings(), dark: document.body.classList.contains('dark'), fontSize: getComputedStyle(moye.editor.vditor.ir.element).fontSize }));
        assert.equal(current.snapshot.revision, revision, 'Startup must not run migration again after native settings exist');
        assert.equal(current.snapshot.values['appearance.theme'], 'light');
        assert.equal(current.snapshot.values['appearance.sidebarVisible'], true);
        assert.equal(current.snapshot.values['appearance.fontSize'], 16);
        assert.equal(current.dark, false); assert.equal(current.fontSize, '16px');
        assert.equal(await page.locator('#outline-sidebar').isVisible(), true);
        return { migratedRevision: migrated.snapshot.revision, migratedFont: migrated.fontSize, laterRevision: revision, laterNativeFontRetained: current.fontSize };
      } finally { await exit(); await launch(); }
    });
    await probe('narrow preferences layout fits the viewport and all controls stay reachable', async () => {
      await page.setViewportSize({ width: 520, height: 700 });
      await page.evaluate(() => moye.performAction('preferences'));
      await page.locator('#settings-search').fill('公式宏');
      const result = await page.evaluate(() => {
        const dialog = document.getElementById('settings-dialog'), bounds = dialog.getBoundingClientRect();
        const control = dialog.querySelector('[data-setting-key="math.macros"]');
        control.scrollIntoView({ block: 'center' });
        const rect = control.getBoundingClientRect();
        return { dialog: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
          control: { left: rect.left, right: rect.right }, viewport: { width: innerWidth, height: innerHeight } };
      });
      assert.ok(result.dialog.left >= 0 && result.dialog.right <= result.viewport.width, JSON.stringify(result));
      assert.ok(result.dialog.top >= 0 && result.dialog.bottom <= result.viewport.height, JSON.stringify(result));
      assert.ok(result.control.left >= result.dialog.left && result.control.right <= result.dialog.right, JSON.stringify(result));
      await closeSettings(); return result;
    });
  } finally {
    await exit();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const report = { platform: `${process.platform}/${process.arch}`, application, kind: 'Moye settings feature regression, not Typora differential acceptance', network: 'HTTP(S) blocked', remoteRequests, results, pageErrors };
    await fs.writeFile(path.resolve(process.env.MOYE_SETTINGS_OUTPUT || path.join(root, 'tests/settings-report.json')), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (results.some(result => result.status === 'fail') || pageErrors.length || remoteRequests.length) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
