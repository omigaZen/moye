'use strict';

// Real Linux Electron keyboard/menu tests plus independent simulated-platform
// validation in shortcuts.test.cjs. This does not certify OS IMEs or Typora parity.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-shortcuts-ui-'));
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, results: [], pageErrors: [], limitations: ['Moye keyboard/menu behavior only; latest Typora runtime comparison, Windows/macOS native execution, non-US hardware keyboard layouts and real system IMEs remain unverified.'] };
  let application, page, number = 0;
  async function launch() {
    application = await _electron.launch({
      executablePath: process.env.MOYE_SHORTCUT_EXECUTABLE || require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_SHORTCUT_EXECUTABLE ? [] : [path.join(root, 'electron/main.cjs')])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
    });
    report.application = await application.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (process.env.MOYE_SHORTCUT_EXECUTABLE) {
      assert.equal(report.application.isPackaged, true, 'An explicit executable must run a packaged application.');
      assert.notEqual(path.resolve(report.application.appPath), root, 'Packaged verification must load bundled modules, without a source-tree fallback.');
    }
    page = await application.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.waitForFunction(() => window.moye?.ready && !!window.MoyeEditorShortcuts, null, { timeout: 30000 });
  }
  async function exit() {
    if (!application) return;
    const process = application.process(), exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; application = null;
  }
  async function closeSettings() { await page.evaluate(() => moye.settings.panel.close()); }
  async function apply(bindings) { return page.evaluate(async bindings => { await moye.settings.apply({ 'editor.keyBindings': JSON.stringify(bindings) }); return moye.settings.getValues(); }, bindings); }
  async function open(content = 'alpha beta\n', mode = 'ir') {
    await closeSettings();
    const file = path.join(work, `document-${++number}.md`); await fs.writeFile(file, content);
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, file);
    await page.evaluate(async mode => { document.getElementById('find-bar').hidden = true; await moye.performAction('open'); moye.setMode(mode); }, mode);
    await page.waitForTimeout(80); return file;
  }
  async function state() { return page.evaluate(() => moye.getState()); }
  async function selectWord() {
    await page.evaluate(() => {
      if (moye.editor.getCurrentMode() === 'sv') { const field = moye.editor.vditor.sv.element; field.focus(); field.setSelectionRange(0, 5); return; }
      const field = moye.editor.vditor.ir.element, walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      let node; while ((node = walker.nextNode()) && !node.data.includes('alpha')) { /* Empty editor anchor nodes are not user text. */ }
      if (!node) throw new Error('Plain text selection target alpha was not found.');
      const offset = node.data.indexOf('alpha'), range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 5); field.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
    });
  }
  async function commandMenu(id, click = false) {
    return application.evaluate(({ Menu }, { id, click }) => { const item = Menu.getApplicationMenu().getMenuItemById(`command:${id}`); if (!item) throw new Error(`Missing native command ${id}`); const result = { id: item.id, accelerator: item.accelerator || '', label: item.label }; if (click) item.click(); return result; }, { id, click });
  }
  async function press(chord) {
    // CDP keyboard injection bypasses Electron's before-input-event and native
    // menu accelerators. Send through webContents to exercise both native menu
    // ownership and the renderer capture listener for the very same keystroke.
    await application.evaluate(({ BrowserWindow }, chord) => {
      const tokens = chord.split('+'), keyCode = tokens.pop();
      const aliases = { Control: 'control', Alt: 'alt', Shift: 'shift', Meta: 'meta' };
      const modifiers = tokens.map(token => aliases[token]);
      const window = BrowserWindow.getAllWindows()[0]; window.focus(); window.webContents.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: keyCode.length === 1 ? keyCode.toUpperCase() : keyCode, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: keyCode.length === 1 ? keyCode.toUpperCase() : keyCode, modifiers });
    }, chord);
    await page.waitForTimeout(100);
  }
  async function check(name, run) {
    if (process.env.MOYE_SHORTCUT_FILTER && !name.includes(process.env.MOYE_SHORTCUT_FILTER)) return;
    const started = Date.now();
    try { const details = await run(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, ...(details ? { details } : {}) }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  try {
    await launch();
    await check('native menu changes immediately, removes old accelerators, and reflects disabling', async () => {
      await apply({ source: 'Ctrl+Alt+P', bold: 'Ctrl+Alt+B', italic: '' });
      assert.equal((await commandMenu('source')).accelerator, 'Ctrl+Alt+P');
      assert.equal((await commandMenu('bold')).accelerator, 'Ctrl+Alt+B');
      assert.equal((await commandMenu('italic')).accelerator, '');
      const toolbar = await page.evaluate(() => ({ label: moye.editor.vditor.toolbar.elements.bold.querySelector('button').getAttribute('aria-label'), hotkeys: moye.editor.vditor.options.toolbar.filter(item => item.hotkey).map(item => item.name) }));
      assert.match(toolbar.label, /Ctrl\+Alt\+B/); assert.deepEqual(toolbar.hotkeys, []); return toolbar;
    });
    await check('changed source hotkey performs one mode switch and its old key is inert', async () => {
      await apply({ source: 'Ctrl+Alt+P' }); await open(); await selectWord();
      await press('Control+/'); assert.equal((await state()).mode, 'ir');
      await press('Control+Alt+p'); assert.equal((await state()).mode, 'sv');
      await press('Control+Alt+p'); assert.equal((await state()).mode, 'ir');
      await commandMenu('source', true); await page.waitForTimeout(100); assert.equal((await state()).mode, 'sv');
    });
    await check('custom bold applies once in live mode and one Undo restores the exact source', async () => {
      await apply({ bold: 'Ctrl+Alt+B' }); await open(); const before = (await state()).content; await selectWord();
      await press('Control+b'); assert.equal((await state()).content, before);
      await press('Control+Alt+b'); assert.equal((await state()).content, '**alpha** beta\n');
      await press('Control+z'); assert.equal((await state()).content, before);
    });
    await check('custom bold applies once in source mode and one Undo restores the exact source', async () => {
      await apply({ bold: 'Ctrl+Alt+B' }); await open('alpha beta\n', 'sv'); const before = (await state()).content; await selectWord();
      await press('Control+Alt+b'); assert.equal((await state()).content, '**alpha** beta\n');
      await press('Control+z'); assert.equal((await state()).content, before);
    });
    await check('native formatting menu uses the current editor selection and one Undo', async () => {
      await apply({}); await open(); const before = (await state()).content; await selectWord();
      await commandMenu('italic', true); await page.waitForTimeout(100);
      assert.equal((await state()).content, '*alpha* beta\n');
      await press('Control+z'); assert.equal((await state()).content, before);
    });
    await check('custom strike, inline code, link, code block, quote and list commands use one source transaction', async () => {
      const results = [];
      for (const [id, pattern] of [['strike', /~~alpha~~/], ['inline-code', /`alpha`/], ['link', /\[alpha\]\(https:\/\/\)/], ['code', /```[\s\S]*alpha/], ['quote', /^> alpha/], ['list', /^[*+-] alpha/], ['ordered-list', /^1\. alpha/]]) {
        await apply({ [id]: 'Ctrl+Alt+P' }); await open('alpha beta\n', 'sv'); const before = (await state()).content; await selectWord();
        await press('Control+Alt+p'); const formatted = (await state()).content; assert.match(formatted, pattern, id);
        await press('Control+z'); assert.equal((await state()).content, before, `${id}: one Undo`);
        results.push({ command: id, content: formatted });
      }
      return results;
    });
    await check('remapped Undo and Redo retire old editor keys and still perform a single history action', async () => {
      await apply({ undo: 'Ctrl+Alt+U', redo: 'Ctrl+Alt+R' }); await open('alpha beta\n', 'sv'); await selectWord();
      await page.keyboard.type('edited'); await page.waitForTimeout(450); const changed = (await state()).content;
      await press('Control+z'); assert.equal((await state()).content, changed);
      await press('Control+Alt+u'); assert.equal((await state()).content, 'alpha beta\n');
      await press('Control+Alt+r'); assert.equal((await state()).content, changed);
      await press('Control+Shift+z'); assert.equal((await state()).content, changed);
      assert.equal((await commandMenu('undo')).accelerator, 'Ctrl+Alt+U');
    });
    await check('unmanaged native zoom retains its Electron role while custom shortcuts are enabled', async () => {
      await apply({ source: 'Ctrl+Alt+P' }); await open(); await selectWord();
      const zoom = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());
      const before = await zoom(); await press('Control+-'); const after = await zoom(); assert.ok(after < before, `zoom ${before} -> ${after}`);
      await press('Control+0'); assert.equal(await zoom(), 0); return { before, after };
    });
    await check('disabled default and retired Vditor keys do not format or change modes', async () => {
      await apply({ bold: '', italic: '', strike: '', source: '' }); await open(); const before = (await state()).content;
      for (const key of ['Control+b', 'Control+i', 'Control+d', 'Alt+Shift+5', 'Control+/', 'Control+Alt+9']) { await selectWord(); await press(key); assert.equal((await state()).content, before, key); assert.equal((await state()).mode, 'ir', key); }
    });
    await check('default and custom shortcut conflicts fail atomically without changing menus or revision', async () => {
      await apply({ source: 'Ctrl+Alt+P' });
      const result = await page.evaluate(async () => {
        const before = await desktop.getSettings(); let message;
        try { await desktop.updateSettings({ patch: { 'appearance.fontSize': 23, 'editor.keyBindings': '{"bold":"Control+S"}' }, expectedRevision: before.revision }); } catch (error) { message = error.message; }
        return { before, after: await desktop.getSettings(), message };
      });
      assert.match(result.message, /快捷键/); assert.deepEqual(result.after, result.before); assert.equal((await commandMenu('source')).accelerator, 'Ctrl+Alt+P');
    });
    await check('find and replace fields keep text editing and never trigger configured editor or app actions', async () => {
      await apply({ source: 'Ctrl+Alt+P', bold: 'Ctrl+Alt+B' }); await open();
      await page.evaluate(() => moye.performAction('find')); await page.locator('#find-input').fill('needle');
      await press('Control+Alt+b'); await press('Control+Alt+p'); await press('F8');
      assert.equal((await state()).mode, 'ir'); assert.equal((await state()).content, 'alpha beta\n');
      assert.equal(await page.locator('#find-input').inputValue(), 'needle');
      assert.equal(await page.evaluate(() => moye.settings.getValues()['editor.focusMode']), false);
      await page.locator('#find-input').press('Control+a'); await page.keyboard.type('updated');
      assert.equal(await page.locator('#find-input').inputValue(), 'updated');
      await page.locator('#close-find').click();
    });
    await check('preferences JSON control saves valid shortcuts and rejects a fixed edit collision accessibly', async () => {
      await page.evaluate(() => moye.settings.panel.open('editor.keyBindings'));
      const field = page.locator('input[data-setting-key="editor.keyBindings"],textarea[data-setting-key="editor.keyBindings"]');
      await field.fill('{"source":"Ctrl+Alt+P","bold":"Ctrl+Alt+B"}'); await field.dispatchEvent('change');
      await page.waitForFunction(() => moye.settings.getValues()['editor.keyBindings'].includes('Ctrl+Alt+B'));
      await field.fill('{"bold":"Ctrl+C"}'); await field.dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('input[data-setting-key="editor.keyBindings"],textarea[data-setting-key="editor.keyBindings"]').getAttribute('aria-invalid') === 'true');
      assert.match(await field.inputValue(), /Ctrl\+Alt\+B/);
      assert.equal((await commandMenu('bold')).accelerator, 'Ctrl+Alt+B');
      // A subsequent valid change clears the error and permits normal closure.
      await field.fill('{"source":"Ctrl+Alt+P","bold":"Ctrl+Alt+B","italic":""}'); await field.dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('input[data-setting-key="editor.keyBindings"],textarea[data-setting-key="editor.keyBindings"]').getAttribute('aria-invalid') === 'false');
      await closeSettings();
    });
    await check('composition and AltGraph keyboard events preserve content, selection and modes', async () => {
      await apply({ source: 'Ctrl+Alt+P', bold: 'Ctrl+Alt+B' }); await open(); await selectWord();
      const result = await page.evaluate(async () => {
        const field = moye.editor.vditor.ir.element, before = moye.getState(), selected = getSelection().toString();
        field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        const key = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'p', ctrlKey: true, altKey: true, isComposing: true });
        field.dispatchEvent(key);
        await moye.performAction('source');
        const during = moye.getState(), duringSelected = getSelection().toString();
        field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
        const graph = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', ctrlKey: true, altKey: true });
        Object.defineProperty(graph, 'getModifierState', { value: name => name === 'AltGraph' }); field.dispatchEvent(graph);
        return { before, during, selected, duringSelected, composingPrevented: key.defaultPrevented, graphPrevented: graph.defaultPrevented, after: moye.getState() };
      });
      assert.equal(result.during.mode, result.before.mode); assert.equal(result.during.content, result.before.content);
      assert.equal(result.duringSelected, result.selected); assert.equal(result.composingPrevented, false); assert.equal(result.graphPrevented, false); assert.equal(result.after.content, result.before.content);
      return { syntheticEventsOnly: true };
    });
    await check('save, open and find remappings execute their real operations and retire defaults', async () => {
      await apply({ save: 'Ctrl+Alt+S', open: 'Ctrl+Alt+O', find: 'Ctrl+Alt+F' }); const file = await open('alpha beta\n', 'sv');
      await page.evaluate(() => { const field = moye.editor.vditor.sv.element; field.focus(); field.setSelectionRange(0, 5); });
      await page.keyboard.type('edited'); await page.waitForTimeout(80);
      await press('Control+s'); assert.equal(await fs.readFile(file, 'utf8'), 'alpha beta\n');
      await press('Control+Alt+s'); assert.equal(await fs.readFile(file, 'utf8'), 'edited beta\n');
      await press('Control+f'); assert.equal(await page.locator('#find-bar').isHidden(), true);
      await press('Control+Alt+f'); assert.equal(await page.locator('#find-bar').isHidden(), false); await page.locator('#close-find').click();
      const replacement = path.join(work, 'replacement.md'); await fs.writeFile(replacement, 'opened by binding\n');
      await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, replacement);
      await press('Control+o'); assert.equal((await state()).content, 'edited beta\n');
      await press('Control+Alt+o'); assert.equal((await state()).content, 'opened by binding\n');
    });
    await check('custom shortcuts persist through a real restart and reset restores defaults', async () => {
      await apply({ source: 'Ctrl+Alt+P', bold: 'Ctrl+Alt+B', italic: '' }); await exit(); await launch();
      const raw = await page.evaluate(() => moye.settings.getValues()['editor.keyBindings']); assert.deepEqual(JSON.parse(raw), { source: 'Ctrl+Alt+P', bold: 'Ctrl+Alt+B', italic: '' });
      assert.equal((await commandMenu('source')).accelerator, 'Ctrl+Alt+P'); assert.equal((await commandMenu('italic')).accelerator, '');
      await open(); await selectWord(); await press('Control+Alt+p'); assert.equal((await state()).mode, 'sv');
      await page.evaluate(() => moye.settings.reset());
      assert.equal((await commandMenu('source')).accelerator, 'Ctrl+/'); assert.equal((await commandMenu('bold')).accelerator, 'Ctrl+B');
      assert.equal(await page.evaluate(() => moye.settings.getValues()['editor.keyBindings']), '{}');
    });
  } finally {
    await exit();
    report.results.push({ name: 'renderer reports no uncaught errors', status: report.pageErrors.length ? 'fail' : 'pass', details: report.pageErrors });
    const output = process.env.MOYE_SHORTCUT_OUTPUT || path.join(__dirname, 'shortcuts-report.json'); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    await fs.rm(work, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.results.some(result => result.status !== 'pass')) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
