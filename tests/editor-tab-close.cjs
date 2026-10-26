'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-tab-close-ui-'));
  const folder = path.join(work, 'documents'), profile = path.join(work, 'profile'), closeCountFile = path.join(work, 'native-close-confirmations.txt'); await fs.mkdir(folder);
  const sources = { '1.md': '# Tab one\n\nOriginal first tab content.\n', '2.md': '# Tab two\n\nOriginal second tab content.\n' };
  for (const [name, source] of Object.entries(sources)) await fs.writeFile(path.join(folder, name), source);
  const packaged = process.env.MOYE_TAB_CLOSE_EXECUTABLE, executable = packaged || require('electron');
  const closeKey = process.platform === 'darwin' ? 'Meta+w' : 'Control+w';
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, purpose: 'Real contextual close shortcut, native whole-window close and dirty tab data protection; not a Telari original-runtime differential.', results: [], pageErrors: [], remoteRequests: [], limitations: ['Headless keyboard/native API checks do not certify physical desktop window controls, OS IME or multiple monitors.'] };
  let app, page;
  async function launch() {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packaged ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 }); page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('console', message => { if (message.text().startsWith('TAB_CLOSE_DEBUG')) (report.debugConsole ||= []).push(message.text()); }); page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); }); await page.waitForFunction(() => window.moye?.ready, { timeout: 30000 }); await confirmations([]);
  }
  async function forceQuit() { if (!app) return; const current = app; app = null; const process = current.process(), exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve(); await current.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
  async function confirmations(responses, countFile = null) {
    await app.evaluate(({ dialog }, options) => {
      global.__tabCloseConfirmCount = 0; global.__tabCloseResponses = [...options.responses];
      dialog.showMessageBox = async () => { global.__tabCloseConfirmCount++; if (options.countFile) await process.getBuiltinModule('node:fs/promises').writeFile(options.countFile, String(global.__tabCloseConfirmCount)); return { response: global.__tabCloseResponses.length ? global.__tabCloseResponses.shift() : 1 }; };
    }, { responses, countFile });
  }
  async function countAtLeast(count) { const deadline = Date.now() + 5000; let observed = 0; while (Date.now() < deadline) { observed = await app.evaluate(() => global.__tabCloseConfirmCount); if (observed >= count) return observed; await new Promise(resolve => setTimeout(resolve, 10)); } return observed; }
  async function chooseWorkspace() { await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder); await page.evaluate(() => moye.performAction('workspace')); await page.locator('.moye-workspace__name', { hasText: /^1\.md$/ }).waitFor(); }
  function fileButton(name) { return page.locator('.moye-workspace__item').filter({ has: page.locator('.moye-workspace__name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }); }
  async function openTab(name) { await fileButton(name).press('Enter'); await page.waitForFunction(name => moye.getState().name === name && !document.getElementById('editor').inert, name); await page.evaluate(() => moye.setMode('sv')); }
  async function editorFocus() { await page.evaluate(() => moye.editor.vditor[moye.editor.getCurrentMode()].element.focus({ preventScroll: true })); }
  async function dirty(text) { await page.evaluate(() => { const s = moye.editor.vditor.sv.element; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); await page.keyboard.insertText(text); await page.waitForFunction(() => moye.getState().dirty); }
  async function settled() { await page.waitForFunction(() => !document.getElementById('editor').inert && !document.getElementById('editor').hasAttribute('aria-busy')); }
  async function snapshot() { return page.evaluate(() => { const s = moye.editor.vditor.sv.element; return { name: moye.getState().name, content: moye.getState().content, dirty: moye.getState().dirty, selection: [s.selectionStart, s.selectionEnd, s.selectionDirection], tabs: document.querySelectorAll('#workspace-tabs [role=tab]').length }; }); }
  async function check(name, task) { try { const details = await task(); report.results.push({ name, status: 'pass', details }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); throw error; } }
  try {
    await launch(); report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath })); if (packaged) assert.equal(report.application.isPackaged, true);
    await check('real close shortcut closes only the active tab with multiple tabs and closes the window at the final-tab boundary', async () => {
      await chooseWorkspace(); await openTab('1.md'); await openTab('2.md'); assert.equal(await page.locator('#workspace-tabs [role=tab]').count(), 2); await editorFocus(); await page.keyboard.press(closeKey);
      await page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role=tab]').length === 1 && moye.getState().name === '1.md'); assert.equal(await page.evaluate(() => moye.getState().content), sources['1.md']); assert.equal(page.isClosed(), false); assert.equal(app.windows().length, 1);
      const closed = page.waitForEvent('close', { timeout: 15000 }); await editorFocus(); await page.keyboard.press(closeKey).catch(error => { if (!page.isClosed()) throw error; }); await closed;
      await forceQuit(); await launch(); await chooseWorkspace();
      return { realShortcut: closeKey, multipleTabsKeptWindowOpen: true, nextTabSourceExact: true, finalTabShortcutClosedWindow: true };
    });
    await check('canceling dirty tab close preserves reverse source selection and undo, then discard confirms exactly once', async () => {
      await openTab('1.md'); await openTab('2.md'); await dirty('LOCAL_UNSAVED_TAB_EDIT'); await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(3, 14, 'backward')); const before = await snapshot();
      await confirmations([2]); await page.keyboard.press(closeKey); assert.equal(await countAtLeast(1), 1); await settled(); const canceled = await snapshot();
      assert.deepEqual(canceled, before); assert.equal(page.isClosed(), false);
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await page.evaluate(() => moye.getState().content), sources['2.md']); await page.evaluate(() => moye.performAction('redo')); assert.equal(await page.evaluate(() => moye.getState().content), before.content); await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(3, 14, 'backward'));
      await confirmations([1]); await editorFocus(); await page.keyboard.press(closeKey); await page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role=tab]').length === 1 && moye.getState().name === '1.md'); await settled(); assert.equal(await app.evaluate(() => global.__tabCloseConfirmCount), 1); assert.equal(await page.evaluate(() => moye.getState().content), sources['1.md']); assert.equal(await fs.readFile(path.join(folder, '2.md'), 'utf8'), sources['2.md']);
      return { cancelKeptSourceAndReverseSelection: true, undoRedoSurvived: true, discardConfirmationCount: 1, discardedChangesNotWritten: true };
    });
    await check('closing an inactive tab leaves the active dirty document, selection and disk bytes unchanged', async () => {
      await openTab('2.md'); await dirty('ACTIVE_DIRTY_WHILE_OTHER_TAB_CLOSES'); await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(4, 15, 'backward')); const before = await snapshot(); assert.equal(before.tabs, 2); await confirmations([]);
      const inactive = page.locator('#workspace-tabs .document-tab').filter({ has: page.getByRole('tab', { name: '1.md', exact: true }) }); await inactive.locator('button').last().click(); await page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role=tab]').length === 1); const after = await snapshot();
      assert.deepEqual({ ...after, tabs: before.tabs }, before); assert.equal(after.dirty, true); assert.equal(await app.evaluate(() => global.__tabCloseConfirmCount), 0); assert.equal(await fs.readFile(path.join(folder, '1.md'), 'utf8'), sources['1.md']); assert.equal(await fs.readFile(path.join(folder, '2.md'), 'utf8'), sources['2.md']);
      await editorFocus(); await page.evaluate(() => moye.performAction('undo')); assert.equal(await page.evaluate(() => moye.getState().content), sources['2.md']);
      await page.evaluate(() => moye.performAction('redo')); assert.equal(await page.evaluate(() => moye.getState().content), before.content);
      // Save As must create a distinct association, rather than turning the
      // retained old-path tab into a second view of the new document.
      const savedAs = path.join(folder, '3.md'); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, savedAs); await page.evaluate(() => moye.performAction('save-as'));
      await page.waitForFunction(filename => moye.getState().path === filename && !moye.getState().dirty, savedAs); assert.equal(await fs.readFile(savedAs, 'utf8'), before.content); assert.equal(await fs.readFile(path.join(folder, '2.md'), 'utf8'), sources['2.md']);
      assert.equal(await page.locator('#document-name').textContent(), '3.md'); assert.equal(await page.locator('#document-name').getAttribute('title'), savedAs); assert.equal(await page.locator('#workspace-tabs [role=tab][aria-selected="true"]').textContent(), '3.md'); assert.equal(await page.getByRole('tab', { name: '2.md', exact: true }).count(), 1);
      await page.getByRole('tab', { name: '2.md', exact: true }).click(); await page.waitForFunction(filename => moye.getState().path === filename && !document.getElementById('editor').inert, path.join(folder, '2.md'));
      assert.equal(await page.evaluate(() => moye.getState().content), sources['2.md']); assert.equal(await page.locator('#document-name').textContent(), '2.md'); assert.equal(await page.locator('#document-name').getAttribute('title'), path.join(folder, '2.md')); assert.equal(await page.locator('#workspace-tabs [role=tab][aria-selected="true"]').textContent(), '2.md');
      await page.evaluate(() => moye.recentFiles.show()); await page.locator('.moye-recent__search').fill('3.md'); await page.locator('.moye-recent [data-recent-open]').click(); await page.waitForFunction(filename => moye.getState().path === filename && !moye.recentFiles.isOpen() && !document.getElementById('editor').inert, savedAs);
      assert.equal(await page.locator('#workspace-tabs [role=tab]').count(), 2); assert.equal(await page.locator('#workspace-tabs [role=tab][aria-selected="true"]').textContent(), '3.md'); assert.equal(await page.locator('#document-name').textContent(), '3.md'); assert.equal(await page.locator('#document-name').getAttribute('title'), savedAs); assert.equal(await page.evaluate(() => moye.getState().content), before.content);
      await app.evaluate(({ dialog }) => { global.__tabOriginalOpenDialog = dialog.showOpenDialog; });
      try {
        for (const [name, filename, expected] of [['2.md', path.join(folder, '2.md'), sources['2.md']], ['3.md', savedAs, before.content]]) {
          await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename); await page.evaluate(() => moye.performAction('open')); await page.waitForFunction(filename => moye.getState().path === filename && !document.getElementById('editor').inert, filename);
          assert.equal(await page.locator('#workspace-tabs [role=tab]').count(), 2); assert.equal(await page.locator('#workspace-tabs [role=tab][aria-selected="true"]').textContent(), name); assert.equal(await page.locator('#document-name').textContent(), name); assert.equal(await page.locator('#document-name').getAttribute('title'), filename); assert.equal(await page.evaluate(() => moye.getState().content), expected);
        }
      } finally { await app.evaluate(({ dialog }) => { dialog.showOpenDialog = global.__tabOriginalOpenDialog; delete global.__tabOriginalOpenDialog; }); }
      await page.getByRole('tab', { name: '2.md', exact: true }).click(); await page.waitForFunction(filename => moye.getState().path === filename && !document.getElementById('editor').inert, path.join(folder, '2.md')); assert.equal(await page.locator('#workspace-tabs [role=tab][aria-selected="true"]').textContent(), '2.md');
      // Selecting the same file from recent history is a focus operation; it
      // must not prompt for discard or re-open the saved bytes over local edits.
      await dirty('SAME_RECENT_FILE_LOCAL_EDIT'); await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(4, 15, 'backward')); const sameBefore = await snapshot(); await confirmations([]); await page.evaluate(() => moye.recentFiles.show());
      const afterRecentShow = await snapshot(); await page.locator('.moye-recent__search').fill('2.md'); const afterRecentSearch = await snapshot(); assert.equal(await page.locator('.moye-recent [data-recent-open]').count(), 1); await page.locator('.moye-recent [data-recent-open]').click(); await page.waitForFunction(() => !moye.recentFiles.isOpen() && !document.getElementById('editor').inert); const afterSameRecent = await snapshot();
      if (JSON.stringify(afterSameRecent) !== JSON.stringify(sameBefore)) report.sameRecentSelectionDiagnostics = { before: sameBefore, afterShow: afterRecentShow, afterSearch: afterRecentSearch, afterOpen: afterSameRecent };
      assert.deepEqual(afterSameRecent, sameBefore); assert.equal(await app.evaluate(() => global.__tabCloseConfirmCount), 0);
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await page.evaluate(() => moye.getState().content), sources['2.md']); assert.equal(await page.evaluate(() => moye.getState().dirty), false);
      const savedRow = page.locator('#workspace-tabs .document-tab').filter({ has: page.getByRole('tab', { name: '3.md', exact: true }) }); await savedRow.locator('button').last().click(); await page.waitForFunction(() => document.querySelectorAll('#workspace-tabs [role=tab]').length === 1); assert.equal(await page.evaluate(() => moye.getState().name), '2.md'); assert.equal(await fs.readFile(savedAs, 'utf8'), before.content);
      return { activeDirtySourceExact: true, reverseSelectionRetained: true, confirmations: 0, diskBytesUnchanged: true, saveAsAssociatedNewTab: true, originalTabReopenedOriginalDisk: true, headerPathAndActiveTabConsistent: true, recentExistingTabReused: true, nativeOpenExistingTabReloadedFresh: true, sameRecentFileKeptDirtySourceAndUndo: true };
    });
    await check('actual native BrowserWindow.close keeps whole-window semantics with multiple tabs, including cancel and discard', async () => {
      await openTab('1.md'); assert.equal(await page.locator('#workspace-tabs [role=tab]').count(), 2); await dirty('NATIVE_WINDOW_CLOSE_LOCAL_EDIT'); const before = await snapshot();
      await page.evaluate(() => { window.__tabCloseDebug = true; window.__tabNativeActionTrace = []; desktop.onAction(name => window.__tabNativeActionTrace.push({ name, at: performance.now() })); });
      await app.evaluate(({ BrowserWindow }) => { global.__tabNativeCloseTrace = []; for (const w of BrowserWindow.getAllWindows()) { w.on('close', event => global.__tabNativeCloseTrace.push({ type: 'close', id: w.id, prevented: event.defaultPrevented })); w.webContents.on('ipc-message', (_event, channel) => global.__tabNativeCloseTrace.push({ type: 'ipc-message', channel })); } });
      await confirmations([2]); await app.evaluate(({ BrowserWindow }) => { global.__tabNativeCloseTrace.push({ type: 'before-schedule', windows: BrowserWindow.getAllWindows().map(w => ({ id: w.id, title: w.getTitle(), url: w.webContents.getURL() })) }); setImmediate(() => { global.__tabNativeCloseTrace.push({ type: 'immediate-fired' }); BrowserWindow.getAllWindows()[0].close(); }); return true; });
      const observedConfirmations = await countAtLeast(1);
      if (observedConfirmations !== 1) report.nativeCloseDiagnostics = { main: await app.evaluate(() => global.__tabNativeCloseTrace), renderer: await page.evaluate(() => ({ actions: window.__tabNativeActionTrace, state: moye.getState(), dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.className), toast: document.getElementById('toast').textContent, editorInert: document.getElementById('editor').inert, activeElement: document.activeElement?.className })) };
      assert.equal(observedConfirmations, 1); await settled(); assert.deepEqual(await snapshot(), before); assert.equal(page.isClosed(), false);
      await confirmations([1], closeCountFile); const closed = page.waitForEvent('close', { timeout: 15000 }); await app.evaluate(({ BrowserWindow }) => { setImmediate(() => BrowserWindow.getAllWindows()[0].close()); return true; }); await closed;
      assert.equal(await fs.readFile(closeCountFile, 'utf8'), '1'); assert.equal(await fs.readFile(path.join(folder, '1.md'), 'utf8'), sources['1.md']); assert.equal(await fs.readFile(path.join(folder, '2.md'), 'utf8'), sources['2.md']);
      return { nativeWindowCloseUsed: true, cancelKeptAllTabsAndSource: true, discardClosedWholeWindow: true, discardConfirmationCount: 1, discardedChangesNotWritten: true };
    });
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.remoteRequests, []); report.pass = true;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; process.exitCode = 1; }
  finally { await forceQuit(); await fs.writeFile(process.env.MOYE_TAB_CLOSE_OUTPUT || path.join(root, 'tests/tab-close-report.json'), JSON.stringify(report, null, 2) + '\n'); await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, results: report.results.map(({ name, status, error }) => ({ name, status, error })), fatalError: report.fatalError }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
