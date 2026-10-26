'use strict';
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-recent-ui-'));
  const folder = path.join(work, 'documents'), profile = path.join(work, 'profile'); await fs.mkdir(folder);
  const files = { first: path.join(folder, 'first.md'), second: path.join(folder, '中文 & notes.md'), preview: path.join(folder, 'preview.md'), gone: path.join(folder, 'gone.md'), saved: path.join(folder, 'saved-as.md') };
  const originals = { first: '# First\n\nOriginal first document.\n', second: '# Second\n\n中文 & notes.\n', preview: '# Preview\n\nTemporary document.\n', gone: '# Gone\n\nRemove history only.\n' };
  for (const key of Object.keys(originals)) await fs.writeFile(files[key], originals[key]);
  const packaged = process.env.MOYE_RECENT_EXECUTABLE, executable = packaged || require('electron');
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, purpose: 'Actual independent recent-file manager and protected native opens; not Telari original-runtime differential acceptance.', results: [], pageErrors: [], remoteRequests: [] };
  let app, page;
  async function launch() {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packaged ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.waitForFunction(() => window.moye?.ready, { timeout: 30000 });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  }
  async function quit() { if (!app) return; const current = app; app = null; const process = current.process(), exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve(); await current.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
  async function openFile(filename) { await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename); await page.evaluate(() => moye.performAction('open')); await page.waitForFunction(name => moye.getState().name === name, path.basename(filename)); }
  async function recent() { return page.evaluate(() => desktop.listRecentFiles()); }
  async function show() { await page.evaluate(() => moye.recentFiles.show()); await page.locator('.moye-recent[open]').waitFor(); }
  async function hide() { await page.evaluate(() => moye.recentFiles.hide()); }
  async function check(name, task) { try { const details = await task(); report.results.push({ name, status: 'pass', details }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); throw error; } }
  try {
    await launch(); report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (packaged) assert.equal(report.application.isPackaged, true);
    await check('successful opens and Save As populate and reorder canonical recent entries without duplicate IDs', async () => {
      await openFile(files.first); const first = (await recent()).entries.find(e => e.path === files.first); assert.ok(first);
      await openFile(files.second); await openFile(files.first);
      let entries = (await recent()).entries; assert.deepEqual(entries.map(e => e.path), [files.first, files.second]); assert.equal(entries[0].id, first.id);
      await page.evaluate(() => { moye.setMode('sv'); const source = moye.editor.vditor.sv.element; source.focus(); source.setSelectionRange(source.value.length, source.value.length); }); await page.keyboard.insertText('saved copy');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, files.saved); await page.evaluate(() => moye.performAction('save-as'));
      entries = (await recent()).entries; assert.deepEqual(entries.map(e => e.path), [files.saved, files.first, files.second]); assert.ok((await fs.readFile(files.saved, 'utf8')).includes('saved copy')); assert.equal(await fs.readFile(files.first, 'utf8'), originals.first);
      return { entries: entries.length, canonicalDuplicates: false, originalFileIntact: true };
    });
    await check('workspace previews stay out of history until the already-active preview is explicitly retained', async () => {
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder); await page.evaluate(() => moye.performAction('workspace'));
      const button = page.locator('.moye-workspace__item').filter({ has: page.locator('.moye-workspace__name', { hasText: /^preview\.md$/ }) });
      await button.click(); await page.waitForFunction(() => moye.getState().name === 'preview.md'); assert.ok(!(await recent()).entries.some(e => e.path === files.preview));
      await button.press('Enter'); await page.waitForFunction(async filename => (await desktop.listRecentFiles()).entries.some(e => e.path === filename), files.preview);
      assert.equal((await recent()).entries.filter(e => e.path === files.preview).length, 1); return { previewExcluded: true, activePreviewPinRecorded: true };
    });
    await check('recent-file search, actual keyboard navigation and opening preserve literal Unicode names and paths', async () => {
      await show(); const search = page.locator('.moye-recent__search'); await search.fill('中文 &'); const matches = page.locator('.moye-recent [data-recent-open]'); assert.equal(await matches.count(), 1);
      assert.equal(await matches.locator('.moye-recent__name').textContent(), '中文 & notes.md'); assert.equal(await matches.locator('.moye-recent__path').textContent(), files.second);
      await search.press('ArrowDown'); assert.equal(await matches.evaluate(element => document.activeElement === element), true); await page.keyboard.press('Enter');
      await page.waitForFunction(() => moye.getState().name === '中文 & notes.md' && !moye.recentFiles.isOpen()); assert.equal(await page.evaluate(() => moye.getState().content), originals.second);
      assert.equal(await page.locator('#workspace-tabs [role="tab"][aria-selected="true"]').count(), 0); assert.equal(await page.evaluate(() => moye.workspace.getActiveId()), null);
      return { exactNameAndPath: true, keyboardOpen: true, actualNativeFile: true, previousWorkspaceActiveCleared: true };
    });
    await check('canceling a recent-file open retains unsaved source, selection and undo in the original document', async () => {
      await openFile(files.first); await page.evaluate(() => { moye.setMode('sv'); const source = moye.editor.vditor.sv.element; source.focus(); source.setSelectionRange(3, 3); }); await page.keyboard.insertText('LOCAL_EDIT');
      const before = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; return { content: moye.getState().content, selection: [s.selectionStart, s.selectionEnd, s.selectionDirection] }; });
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 2 }); }); await show(); await page.locator('.moye-recent__search').fill('preview.md'); await page.locator('.moye-recent [data-recent-open]').click(); await page.waitForFunction(() => document.querySelector('.moye-recent').getAttribute('aria-busy') === 'false');
      const after = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; return { name: moye.getState().name, content: moye.getState().content, dirty: moye.getState().dirty, selection: [s.selectionStart, s.selectionEnd, s.selectionDirection], recentOpen: moye.recentFiles.isOpen() }; });
      assert.equal(after.name, 'first.md'); assert.equal(after.content, before.content); assert.equal(after.dirty, true); assert.deepEqual(after.selection, before.selection); assert.equal(after.recentOpen, true);
      await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => moye.recentFiles.isOpen()), false); await page.evaluate(() => moye.performAction('undo')); assert.equal(await page.evaluate(() => moye.getState().content), originals.first);
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }); return { canceledOpenKeptSource: true, selectionExact: true, undoRetained: true };
    });
    await check('missing-file records remain visible and removable without changing the current document or other files', async () => {
      await openFile(files.gone); await openFile(files.first); await fs.unlink(files.gone); const before = await page.evaluate(() => moye.getState().content); await show(); await page.locator('.moye-recent__search').fill('gone.md');
      const missing = page.locator('.moye-recent [data-recent-open]'); assert.equal(await missing.getAttribute('aria-disabled'), 'true'); await missing.focus(); await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => moye.getState().content), before);
      await page.locator('.moye-recent [data-recent-remove]').click(); await page.waitForFunction(async filename => !(await desktop.listRecentFiles()).entries.some(e => e.path === filename), files.gone); assert.equal(await fs.readFile(files.first, 'utf8'), originals.first); await hide();
      return { missingClearlyMarked: true, currentDocumentIntact: true, removedOnlyHistory: true };
    });
    await check('opaque recent-file IPC rejects forged IDs and path payloads without replacing the editor', async () => {
      const result = await page.evaluate(async () => { const before = moye.getState().content; let rejected = 0; for (const payload of [{ id: '../../etc/passwd' }, { path: '/etc/passwd' }]) { try { await desktop.openRecentFile(payload); } catch { rejected++; } } try { await desktop.removeRecentFile({ id: '../document' }); } catch { rejected++; } return { rejected, unchanged: moye.getState().content === before }; });
      assert.deepEqual(result, { rejected: 3, unchanged: true }); return result;
    });
    await check('clear-history only removes records, keeps files byte-exact and leaves document state intact', async () => {
      const keys = ['first', 'second', 'preview', 'saved'], bytes = new Map(await Promise.all(keys.map(async key => [key, await fs.readFile(files[key])]))); const state = await page.evaluate(() => moye.getState());
      await show(); await page.locator('[data-recent-action="clear"]').click(); await page.waitForFunction(async () => (await desktop.listRecentFiles()).entries.length === 0); assert.equal(await page.locator('.moye-recent [data-recent-open]').count(), 0);
      for (const key of keys) assert.deepEqual(await fs.readFile(files[key]), bytes.get(key)); assert.equal((await page.evaluate(() => moye.getState())).content, state.content); assert.equal((await page.evaluate(() => moye.getState())).dirty, state.dirty); await hide(); return { originalFilesByteExact: true, onlyRecordsCleared: true };
    });
    await check('recent history and capabilities survive a complete restart, and Escape restores editor focus', async () => {
      await openFile(files.first); await openFile(files.second); const before = (await recent()).entries; await quit(); await launch(); const after = (await recent()).entries;
      assert.deepEqual(after.map(e => [e.id, e.path]), before.map(e => [e.id, e.path])); await page.evaluate(() => { const e = moye.editor.vditor[moye.editor.getCurrentMode()].element; e.focus(); }); await show(); await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => moye.recentFiles.isOpen()), false); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#editor')), true);
      // A pending rich-editor undo checkpoint must not restore its Range over
      // the application control that the user has just opened.
      const initial = await page.evaluate(() => moye.getState().content);
      await page.keyboard.insertText('MENU_FOCUS_CHECKPOINT'); await page.locator('#more-button').click(); await page.waitForTimeout(450);
      assert.equal(await page.locator('#more-menu').isVisible(), true);
      assert.equal(await page.evaluate(() => document.getElementById('more-menu').contains(document.activeElement)), true);
      await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('#more-menu button:not([hidden]):not(:disabled)')].at(-1)), true);
      await page.keyboard.press('Escape'); await page.evaluate(() => { moye.editor.vditor.ir.element.focus(); return moye.performAction('undo'); });
      assert.equal(await page.evaluate(() => moye.getState().content), initial); assert.equal(await page.evaluate(() => moye.getState().dirty), false);
      return { restartPreservedIdsAndOrder: true, escapeReturnedVisibleFocus: true, delayedUndoPreservedMenuFocusAndHistory: true };
    });
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.remoteRequests, []); report.pass = true;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; process.exitCode = 1; }
  finally { await quit(); await fs.writeFile(process.env.MOYE_RECENT_OUTPUT || path.join(root, 'tests/recent-files-report.json'), JSON.stringify(report, null, 2) + '\n'); await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, results: report.results.map(({ name, status, error }) => ({ name, status, error })), fatalError: report.fatalError }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
