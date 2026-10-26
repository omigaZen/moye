'use strict';

const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { MAX_DOCUMENT_BYTES } = require('../electron/file-store.cjs');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-file-refresh-ui-'));
  const documents = path.join(work, 'documents'), profile = path.join(work, 'profile'); await fs.mkdir(documents);
  const packaged = process.env.MOYE_REFRESH_EXECUTABLE, executable = packaged || require('electron');
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, purpose: 'Real external file changes, protected reload, native close/restart and ordinary-document neighbor navigation; Moye feature evidence, not original-application differential certification.', results: [], pageErrors: [], remoteRequests: [], limitations: ['One headless host. Synthetic native window flag/geometry checks do not certify physical fullscreen, multi-display hardware, touch or OS input methods.'] };
  let app, page, serial = 0;
  async function launch({ viewport = true } = {}) {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packaged ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile } });
    page = await app.firstWindow(); if (viewport) await page.setViewportSize({ width: 1280, height: 860 });
    page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
    await page.waitForFunction(() => window.moye?.ready, { timeout: 30000 });
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  }
  async function forceQuit() {
    if (!app) return; const current = app; app = null;
    const process = current.process(), exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
    await current.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
  }
  async function nativeQuit() {
    const current = app, process = current.process();
    const exited = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Native app.quit did not finish through renderer close confirmation.')), 15000); process.once('exit', code => { clearTimeout(timeout); resolve(code); }); });
    await current.evaluate(({ app }) => { setImmediate(() => app.quit()); return true; });
    const code = await exited; assert.equal(code, 0); app = null;
  }
  async function file(name, content) { const filename = path.join(documents, `${++serial}-${name}`); await fs.writeFile(filename, content); return filename; }
  async function openFile(filename, mode = 'sv') {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, filename);
    await page.evaluate(() => moye.performAction('open'));
    await page.waitForFunction(filename => moye.getState().path === filename && !document.getElementById('editor').inert, filename);
    await page.evaluate(mode => { if (moye.reading.isEnabled()) moye.setReading(false); moye.setMode(mode); }, mode);
  }
  async function changed({ missing = false } = {}) {
    await page.waitForFunction(missing => { const banner = document.getElementById('external-change-banner'), reload = document.getElementById('reload-external'); return !banner.hidden && reload.disabled === missing; }, missing, { timeout: 10000 });
  }
  async function reloadTo(expected) {
    await page.locator('#reload-external').click();
    await page.waitForFunction(expected => moye.getState().content === expected && !document.getElementById('editor').inert && document.getElementById('external-change-banner').hidden, expected, { timeout: 10000 });
  }
  async function check(name, task) { try { const details = await task(); report.results.push({ name, status: 'pass', details }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); throw error; } }
  async function confirmationCount() { const deadline = Date.now() + 3000; let count = 0; while (Date.now() < deadline) { count = await app.evaluate(() => global.__refreshConfirmCount); if (count) return count; await new Promise(resolve => setTimeout(resolve, 10)); } return count; }
  try {
    await launch(); report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath })); if (packaged) assert.equal(report.application.isPackaged, true);
    await check('real external prepends restore the same reading paragraph and reload resets obsolete undo history', async () => {
      const baseline = '# Reading reload\n\n' + Array.from({ length: 80 }, (_, index) => `PARAGRAPH_${String(index).padStart(3, '0')} ` + `这是唯一的阅读位置段落${index}，测试原文在外部追加内容后仍可找到同一段正文。`.repeat(6) + '\n\n').join('');
      const filename = await file('reading.md', baseline); await openFile(filename);
      await page.evaluate(() => { const source = moye.editor.vditor.sv.element; source.focus(); source.setSelectionRange(source.value.length, source.value.length); }); await page.keyboard.insertText('SAVED_LOCAL_UNDO_SENTINEL\n'); await page.evaluate(() => moye.performAction('save'));
      const saved = await fs.readFile(filename, 'utf8'); assert.ok(saved.includes('SAVED_LOCAL_UNDO_SENTINEL'));
      await page.evaluate(async () => { moye.setMode('ir'); moye.setReading(true); await moye.reading.whenReady(); });
      const before = await page.evaluate(() => { const root = moye.reading.getRoot(), target = [...root.querySelectorAll('p')].find(p => p.textContent.startsWith('PARAGRAPH_040 ')); if (!target) throw new Error('Reading target missing'); root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top + 24; return { top: target.getBoundingClientRect().top - root.getBoundingClientRect().top, scrollTop: root.scrollTop }; });
      const prefix = Array.from({ length: 15 }, (_, i) => `EXTERNAL_PREFIX_${i} 新增的真实磁盘段落。\n\n`).join(''), expected = prefix + saved;
      await fs.writeFile(filename, expected); await changed(); assert.equal(await page.evaluate(() => moye.getState().content), saved); await reloadTo(expected); await page.evaluate(() => moye.reading.whenReady());
      await page.waitForFunction(beforeTop => { const r = moye.reading.getRoot(), p = [...r.querySelectorAll('p')].find(p => p.textContent.startsWith('PARAGRAPH_040 ')); return moye.reading.isEnabled() && p && Math.abs(p.getBoundingClientRect().top - r.getBoundingClientRect().top - beforeTop) <= 4; }, before.top, { timeout: 8000 });
      const after = await page.evaluate(() => { const r = moye.reading.getRoot(), p = [...r.querySelectorAll('p')].find(p => p.textContent.startsWith('PARAGRAPH_040 ')); return { top: p.getBoundingClientRect().top - r.getBoundingClientRect().top, scrollTop: r.scrollTop, dirty: moye.getState().dirty }; });
      assert.equal(after.dirty, false); assert.ok(after.scrollTop > before.scrollTop, 'Prepending paragraphs requires a larger scroll offset for the same content.');
      await page.evaluate(async () => { moye.setReading(false); moye.setMode('sv'); await moye.performAction('undo'); }); assert.equal(await page.evaluate(() => moye.getState().content), expected);
      return { prependedParagraphs: 15, sameSemanticParagraph: true, verticalErrorPx: Math.abs(after.top - before.top), exactReloadedSource: true, oldUndoDidNotRevive: true };
    });
    await check('clean source reload preserves SV mode and the existing viewport when external text is appended below it', async () => {
      const baseline = Array.from({ length: 950 }, (_, i) => `SOURCE_${String(i).padStart(4, '0')} 可见源码行 abcdefghijklmnopqrstuvwxyz\n`).join(''), filename = await file('source.md', baseline); await openFile(filename);
      const before = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; s.focus(); const offset = s.value.indexOf('SOURCE_0400'); s.setSelectionRange(offset, offset + 8, 'backward'); s.scrollTop = s.scrollHeight * 0.43; return { scrollTop: s.scrollTop, viewport: s.clientHeight, mode: moye.editor.getCurrentMode() }; });
      assert.ok(before.scrollTop > 1000); const expected = baseline + '\nEXTERNAL_TAIL_ONLY\n'; await fs.writeFile(filename, expected); await changed(); await reloadTo(expected);
      await page.waitForFunction(before => moye.editor.getCurrentMode() === 'sv' && Math.abs(moye.editor.vditor.sv.element.scrollTop - before.scrollTop) <= 3, before, { timeout: 8000 });
      const after = await page.evaluate(() => ({ scrollTop: moye.editor.vditor.sv.element.scrollTop, mode: moye.editor.getCurrentMode(), dirty: moye.getState().dirty })); assert.equal(after.dirty, false);
      return { mode: after.mode, viewportRetained: true, scrollErrorPx: Math.abs(after.scrollTop - before.scrollTop) };
    });
    await check('canceling dirty external reload leaves local source, reverse selection and undo intact', async () => {
      const baseline = '# Dirty reload\n\nOriginal in-memory version.\n', filename = await file('dirty.md', baseline); await openFile(filename);
      await page.evaluate(() => { const s = moye.editor.vditor.sv.element; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }); await page.keyboard.insertText('LOCAL_UNSAVED');
      await page.evaluate(() => moye.editor.vditor.sv.element.setSelectionRange(3, 12, 'backward'));
      const before = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; return { source: moye.getState().content, selection: [s.selectionStart, s.selectionEnd, s.selectionDirection] }; });
      const external = '# EXTERNAL disk-only version\n'; await fs.writeFile(filename, external); await changed(); assert.equal(await page.evaluate(() => moye.getState().content), before.source);
      await app.evaluate(({ dialog }) => { global.__refreshConfirmCount = 0; dialog.showMessageBox = async () => { global.__refreshConfirmCount++; return { response: 2 }; }; }); await page.locator('#reload-external').click();
      const confirmations = await confirmationCount(); assert.equal(confirmations, 1);
      await page.waitForFunction(() => !document.getElementById('editor').inert);
      const after = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; return { source: moye.getState().content, dirty: moye.getState().dirty, selection: [s.selectionStart, s.selectionEnd, s.selectionDirection], bannerVisible: !document.getElementById('external-change-banner').hidden }; });
      assert.equal(after.source, before.source); assert.equal(after.dirty, true); assert.deepEqual(after.selection, before.selection); assert.equal(after.bannerVisible, true);
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await page.evaluate(() => moye.getState().content), baseline); assert.equal(await fs.readFile(filename, 'utf8'), external); await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      return { nativeConfirmationObserved: true, diskDidNotOverwriteLocal: true, reverseSelectionExact: true, undoRetained: true, diskExternalVersionIntact: true };
    });
    await check('real deletion and rename disable reload while Save As preserves the in-memory document', async () => {
      const evidence = [];
      for (const operation of ['delete', 'rename']) {
        const source = `# ${operation}\n\nMemory content survives a missing path.\n`, filename = await file(`${operation}.md`, source); await openFile(filename);
        const renamed = filename + '.renamed.md'; if (operation === 'delete') await fs.unlink(filename); else await fs.rename(filename, renamed);
        await changed({ missing: true }); assert.equal(await page.locator('#reload-external').isDisabled(), true); assert.equal(await page.evaluate(() => moye.getState().content), source);
        const destination = filename + '.rescued.md'; await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination); await page.evaluate(() => moye.performAction('save-as'));
        await page.waitForFunction(filename => moye.getState().path === filename && !moye.getState().dirty, destination); assert.equal(await fs.readFile(destination, 'utf8'), source); await assert.rejects(fs.access(filename), { code: 'ENOENT' }); if (operation === 'rename') assert.equal(await fs.readFile(renamed, 'utf8'), source);
        evidence.push({ operation, reloadDisabled: true, memorySavedByteExact: true, renamedOriginalRetained: operation === 'rename' });
      }
      return { operations: evidence };
    });
    await check('ignoring or reloading one external change does not suppress the next actual disk change', async () => {
      const initial = '# Initial watcher version\n', filename = await file('watcher.md', initial); await openFile(filename);
      await fs.writeFile(filename, '# External first\n'); await changed(); await page.locator('#ignore-external').click(); assert.equal(await page.locator('#external-change-banner').isVisible(), false);
      const second = '# External second with different length\n'; await fs.writeFile(filename, second); await changed(); assert.equal(await page.evaluate(() => moye.getState().content), initial); await reloadTo(second);
      const third = '# External third, after an accepted reload, remains a fresh notification\n'; await fs.writeFile(filename, third); await changed(); assert.equal(await page.evaluate(() => moye.getState().content), second); await page.locator('#ignore-external').click();
      return { distinctNotifications: 3, afterIgnore: true, afterAcceptedReload: true, noSilentOverwrite: true };
    });
    await check('invalid UTF8 and oversized external files report reload errors without replacing the loaded source', async () => {
      const baseline = '# Valid UTF8\n\nRetain this loaded source.\n', filename = await file('invalid.md', baseline); await openFile(filename);
      const before = await page.evaluate(() => moye.getState());
      await fs.writeFile(filename, Buffer.from([0xc3, 0x28])); await changed(); await page.locator('#reload-external').click(); await page.waitForFunction(() => !document.getElementById('toast').hidden && /UTF/i.test(document.getElementById('toast').textContent) && !document.getElementById('editor').inert, null, { timeout: 8000 });
      const invalid = await page.evaluate(() => moye.getState()); assert.equal(invalid.content, before.content); assert.equal(invalid.documentId, before.documentId); assert.equal(invalid.mode, before.mode);
      await fs.truncate(filename, MAX_DOCUMENT_BYTES + 1); await changed(); await page.locator('#reload-external').click(); await page.waitForFunction(() => !document.getElementById('toast').hidden && /32\s*MB/i.test(document.getElementById('toast').textContent) && !document.getElementById('editor').inert, null, { timeout: 8000 });
      const huge = await page.evaluate(() => moye.getState()); assert.equal(huge.content, before.content); assert.equal(huge.documentId, before.documentId); assert.equal(huge.dirty, before.dirty); await fs.writeFile(filename, baseline);
      return { invalidUTF8Rejected: true, over32MiBRejected: true, exactInMemorySourceAndIdentityRetained: true };
    });
    await check('native app.quit flushes normal window bounds before exit and a full restart restores them', async () => {
      const workArea = await app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0]; w.setFullScreen(false); w.unmaximize(); const a = screen.getDisplayMatching(w.getNormalBounds()).workArea;
        const width = Math.min(a.width, Math.max(Math.min(740, a.width), Math.min(1000, a.width - 40))), height = Math.min(a.height, Math.max(Math.min(520, a.height), Math.min(700, a.height - 40)));
        w.setBounds({ x: a.x + Math.min(20, a.width - width), y: a.y + Math.min(20, a.height - height), width, height });
        return a;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const expected = { bounds: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()), workArea };
      await nativeQuit(); const persisted = JSON.parse(await fs.readFile(path.join(profile, 'window-state.json'), 'utf8')); assert.deepEqual(persisted.bounds, expected.bounds); assert.equal(persisted.maximized, false); assert.equal(Object.hasOwn(persisted, 'fullscreen'), false);
      await launch({ viewport: false }); const restored = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { bounds: w.getNormalBounds(), fullscreen: w.isFullScreen() }; });
      assert.deepEqual(restored.bounds, expected.bounds); assert.equal(restored.fullscreen, false); return { nativeQuitUsed: true, closeFlushExact: true, restoredBounds: restored.bounds, workArea: expected.workArea };
    });
    await check('headless native fullscreen flags never replace the persisted normal size or reopen fullscreen', async () => {
      const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true)); await new Promise(resolve => setTimeout(resolve, 250));
      const during = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { entered: w.isFullScreen(), bounds: w.getBounds(), normal: w.getNormalBounds() }; });
      assert.deepEqual(during.normal, before);
      await nativeQuit(); const persisted = JSON.parse(await fs.readFile(path.join(profile, 'window-state.json'), 'utf8')); assert.deepEqual(persisted.bounds, before); assert.equal(Object.hasOwn(persisted, 'fullscreen'), false);
      await launch({ viewport: false }); const after = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return { normal: w.getNormalBounds(), fullscreen: w.isFullScreen() }; }); assert.deepEqual(after.normal, before); assert.equal(after.fullscreen, false); await page.setViewportSize({ width: 1280, height: 860 });
      if (!during.entered) report.limitations.push('The native fullscreen API did not enter fullscreen on this headless host. Only normal-size persistence and non-fullscreen reopening were observed; actual fullscreen-size substitution remains for native-host validation.');
      return { nativeFullscreenEntered: during.entered, nativeGeometryChanged: JSON.stringify(during.bounds) !== JSON.stringify(before), normalSizePersisted: true, reopenedFullscreen: false, physicalPlatformCertification: false };
    });
    const nav = path.join(work, 'ordinary-neighbors');
    await fs.mkdir(nav); const navTexts = { '1.md': '# One\n', '2.md': '# Two\n', '10.md': '# Ten\n', '2.txt': 'Text two\n', '3.txt': 'Text three\n', '12.txt': 'Text twelve\n' }; for (const [name, text] of Object.entries(navTexts)) await fs.writeFile(path.join(nav, name), text);
    await check('ordinary native document neighbors use natural Markdown order without a chosen workspace or TXT mixing', async () => {
      await openFile(path.join(nav, '1.md')); assert.equal(await page.evaluate(() => moye.workspace.getActiveId()), null);
      assert.equal(await page.evaluate(() => desktop.documentNeighbor({ direction: -1 })), null); const next = await page.evaluate(() => desktop.documentNeighbor({ direction: 1 })); assert.equal(next.name, '2.md'); assert.equal(next.navigation, 'document'); assert.notEqual(next.id, path.join(nav, '2.md'));
      const sequence = ['1.md']; for (const [action, name] of [['next-file', '2.md'], ['next-file', '10.md'], ['previous-file', '2.md'], ['previous-file', '1.md']]) { await page.evaluate(action => moye.performAction(action), action); await page.waitForFunction(name => moye.getState().name === name, name); sequence.push(name); }
      assert.deepEqual(sequence, ['1.md', '2.md', '10.md', '2.md', '1.md']); assert.equal(await page.evaluate(() => desktop.documentNeighbor({ direction: -1 })), null); return { withoutWorkspace: true, naturalSequence: sequence, textFilesExcluded: true };
    });
    await check('TXT native navigation stays in its own group and forged or stale neighbor capabilities cannot replace content', async () => {
      const old = await page.evaluate(() => desktop.documentNeighbor({ direction: 1 })); await openFile(path.join(nav, '3.txt'));
      const protectedResult = await page.evaluate(async old => { const owner = moye.getState().documentId, before = moye.getState().content; let rejected = 0; for (const options of [{ id: old.id, ownerDocumentId: old.ownerDocumentId }, { id: '../../etc/passwd', ownerDocumentId: owner }, { id: 'forged', ownerDocumentId: 'stale-owner' }]) { try { await desktop.openDocumentNeighbor(options); } catch { rejected++; } } try { await desktop.documentNeighbor({ direction: 0 }); } catch { rejected++; } return { rejected, unchanged: moye.getState().content === before }; }, old);
      assert.deepEqual(protectedResult, { rejected: 4, unchanged: true }); assert.equal((await page.evaluate(() => desktop.documentNeighbor({ direction: 1 }))).name, '12.txt');
      const sequence = ['3.txt']; for (const [action, name] of [['next-file', '12.txt'], ['previous-file', '3.txt'], ['previous-file', '2.txt']]) { await page.evaluate(action => moye.performAction(action), action); await page.waitForFunction(name => moye.getState().name === name, name); sequence.push(name); } assert.equal(await page.evaluate(() => desktop.documentNeighbor({ direction: -1 })), null);
      for (const [name, text] of Object.entries(navTexts)) assert.equal(await fs.readFile(path.join(nav, name), 'utf8'), text);
      return { rejectedCapabilities: protectedResult.rejected, sourceProtected: true, textSequence: sequence, originalFilesUnchanged: true };
    });
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.remoteRequests, []); report.pass = true;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; process.exitCode = 1; }
  finally { await forceQuit(); await fs.writeFile(process.env.MOYE_REFRESH_OUTPUT || path.join(root, 'tests/file-refresh-report.json'), JSON.stringify(report, null, 2) + '\n'); await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, results: report.results.map(({ name, status, error }) => ({ name, status, error })), limitations: report.limitations, fatalError: report.fatalError }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
