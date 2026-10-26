'use strict';
// Real layout/scroll checks; committed text and synthetic IME guards do not
// substitute for physical display or operating-system input-method testing.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function main() {
  const project = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-reading-anchor-'));
  const executable = process.env.MOYE_READING_ANCHOR_EXECUTABLE ? path.resolve(process.env.MOYE_READING_ANCHOR_EXECUTABLE) : require('electron');
  const results = [], pageErrors = [], remoteRequests = []; let app, page, application;
  async function probe(name, callback) { const start = Date.now(); try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - start, details }); } catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.stack || error.message }); } }
  const fixture = '# 阅读锚点\n\n' + Array.from({ length: 80 }, (_, index) => `第${String(index).padStart(3, '0')}段 ` + '排版改变之后，正在阅读的同一句话应当仍然留在视口附近。Mixed English words 12345。'.repeat(12)).join('\n\n') + '\n';
  async function settle(ms = 180) { await page.waitForTimeout(ms); }
  async function open(content = fixture, key = '/tmp/moye-anchor-a.md', mode = 'ir') {
    await page.evaluate(({ content, key, mode }) => {
      window.anchorProbeAnchor.remember();
      for (const element of [moye.editor.vditor.ir.element, moye.editor.vditor.sv.element]) { element.style.fontSize = ''; element.style.lineHeight = ''; }
      moye.loadDocument({ content, name: pathName(key), path: key, documentId: key || crypto.randomUUID() });
      moye.setMode(mode); window.anchorProbeDocumentKey = key;
      if (window.anchorProbeFallback) window.anchorProbeAnchor.documentChanged(key);
      function pathName(value) { return value ? value.split('/').at(-1) : '未命名.md'; }
    }, { content, key, mode }); await settle();
  }
  async function position(index = 32) {
    await page.evaluate(index => {
      const root = moye.editor.vditor.ir.element, paragraph = root.querySelectorAll(':scope>p')[index], node = paragraph.firstChild;
      const range = document.createRange(); range.setStart(node, Math.min(180, node.length)); range.collapse(true);
      root.scrollTop += range.getBoundingClientRect().top - root.getBoundingClientRect().top - 60;
      root.dispatchEvent(new Event('scroll'));
    }, index); await settle();
    return page.evaluate(() => {
      const book = anchorProbeAnchor.capture(), root = moye.editor.vditor.ir.element;
      const paragraph = root.children[book.block];
      if (paragraph.tagName !== 'P' || paragraph.firstChild.nodeType !== 3) throw new Error('Expected simple visible paragraph');
      const point = document.createRange(); point.setStart(paragraph.firstChild, book.offset); point.collapse(true);
      window.anchorProbePoint = { node: paragraph.firstChild, offset: book.offset, initialY: point.getBoundingClientRect().top - root.getBoundingClientRect().top, block: book.block };
      return { mode: book.mode, block: book.block, offset: book.offset, y: book.y, scrollTop: root.scrollTop };
    });
  }
  async function point() { return page.evaluate(() => {
    const p = anchorProbePoint, range = document.createRange(); range.setStart(p.node, p.offset); range.collapse(true);
    const root = moye.editor.vditor.ir.element;
    return { y: range.getBoundingClientRect().top - root.getBoundingClientRect().top, initialY: p.initialY, scrollTop: root.scrollTop, raw: moye.getState().content, dirty: moye.getState().dirty };
  }); }
  try {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_READING_ANCHOR_EXECUTABLE ? [] : [path.join(project, 'electron/main.cjs')])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); }); await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready, null, { timeout: 30000 });
    if (!(await page.evaluate(() => !!moye.readingAnchor))) {
      assert.equal(application.isPackaged, false, 'Packaged editor must integrate reading anchors; source fallback is forbidden');
      if (!(await page.evaluate(() => !!window.MoyeReadingAnchor))) await page.addScriptTag({ url: pathToFileURL(path.join(project, 'src/reading-anchor.js')).href });
      await page.evaluate(() => {
        window.anchorProbeFallback = true; window.anchorProbeRemember = true; window.anchorProbeDocumentKey = null;
        window.anchorProbeAnchor = MoyeReadingAnchor.install({ editor: moye.editor, getDocumentKey: () => anchorProbeDocumentKey, rememberPositions: () => anchorProbeRemember });
      });
    } else await page.evaluate(() => { window.anchorProbeAnchor = moye.readingAnchor; });
    await moyeApply({ 'editor.typewriterMode': false, 'editor.focusMode': false });
    await probe('font and line-height changes preserve the same visible text without changing document state', async () => {
      await open(); const before = await position();
      await page.evaluate(() => anchorProbeAnchor.preserve(() => { const root = moye.editor.vditor.ir.element; root.style.fontSize = '24px'; root.style.lineHeight = '2.1'; })); await settle();
      const after = await point(); assert.ok(Math.abs(after.y - after.initialY) < 2, JSON.stringify(after)); assert.equal(after.raw, fixture); assert.equal(after.dirty, false);
      return { before, afterY: after.y, differencePx: after.y - after.initialY, rawUnchanged: true };
    });
    await probe('window resize keeps a long paragraph text anchor rather than its old pixel scroll position', async () => {
      await open(); await position(); const original = await point();
      await page.setViewportSize({ width: 920, height: 860 }); await settle(250);
      const after = await point(); assert.ok(Math.abs(after.y - original.y) < 3, JSON.stringify({ original: original.y, after: after.y }));
      await page.setViewportSize({ width: 1280, height: 860 }); await settle(250);
      const back = await point(); assert.ok(Math.abs(back.y - original.y) < 3, JSON.stringify({ original: original.y, narrow: after.y, back: back.y })); return { initialY: original.y, narrowY: after.y, restoredY: back.y };
    });
    await probe('late image height changes above the viewport do not move the reading line', async () => {
      await open('![image](data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E)\n\n' + fixture); await position();
      const before = await point();
      await page.evaluate(() => { const image = moye.editor.vditor.ir.element.querySelector('img'); image.style.width = '350px'; image.style.height = '320px'; image.dispatchEvent(new Event('load')); }); await settle(250);
      const after = await point(); assert.ok(Math.abs(after.y - before.y) < 3, JSON.stringify({ before: before.y, after: after.y })); return { differencePx: after.y - before.y };
    });
    await probe('reparsed duplicate paragraphs restore the nearest original block occurrence', async () => {
      const repeated = Array.from({ length: 75 }, () => 'Identical paragraph 中文 '.repeat(20)).join('\n\n') + '\n';
      await open(repeated); const before = await position(40);
      const restored = await page.evaluate(() => {
        const anchor = anchorProbeAnchor, bookmark = anchor.beforeLayout(), originalBlock = bookmark.block;
        moye.editor.setValue(moye.getState().content, true); anchor.afterLayout(bookmark);
        return { originalBlock, offset: bookmark.offset };
      }); await settle();
      const after = await page.evaluate(() => { const b = anchorProbeAnchor.capture(); return { block: b.block, offset: b.offset, y: b.y }; });
      assert.ok(Math.abs(after.block - before.block) <= 1, JSON.stringify({ before, after })); assert.ok(after.block > 30); return { ...restored, after };
    });
    await probe('source reflow preserves visible source context and backward selection', async () => {
      await open(fixture, '/tmp/moye-anchor-source.md', 'sv');
      await page.evaluate(() => { const root = moye.editor.vditor.sv.element; root.focus(); root.setSelectionRange(12000, 12300, 'backward'); root.scrollTop = root.scrollHeight * 0.46; root.dispatchEvent(new Event('scroll')); }); await settle();
      const before = await page.evaluate(() => { const root = moye.editor.vditor.sv.element; return { bookmark: anchorProbeAnchor.capture(), selection: [root.selectionStart, root.selectionEnd, root.selectionDirection], value: root.value }; });
      await page.evaluate(() => anchorProbeAnchor.preserve(() => { moye.editor.vditor.sv.element.style.fontSize = '20px'; moye.editor.vditor.sv.element.style.lineHeight = '1.9'; })); await settle();
      const after = await page.evaluate(() => { const root = moye.editor.vditor.sv.element; return { bookmark: anchorProbeAnchor.capture(), selection: [root.selectionStart, root.selectionEnd, root.selectionDirection], value: root.value }; });
      assert.deepEqual(after.selection, before.selection); assert.equal(after.value, before.value); assert.ok(Math.abs(after.bookmark.offset - before.bookmark.offset) < 100, JSON.stringify({ before: before.bookmark, after: after.bookmark }));
      return { oldOffset: before.bookmark.offset, newOffset: after.bookmark.offset, backwardSelection: after.selection, rawUnchanged: true };
    });
    await probe('explicit user scroll cancels an outstanding layout restoration', async () => {
      await open(); await position();
      const expected = await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element, b = anchorProbeAnchor.beforeLayout();
        root.style.fontSize = '23px'; anchorProbeAnchor.afterLayout(b);
        root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 })); root.scrollTop = 600;
        return root.scrollTop;
      }); await settle();
      const actual = await page.evaluate(() => moye.editor.vditor.ir.element.scrollTop); assert.ok(Math.abs(actual - expected) <= 1, JSON.stringify({ expected, actual })); return { expected, actual };
    });
    await probe('new input invalidates an old bookmark and remains undoable', async () => {
      await open('First line\n\nSecond line\n');
      await page.evaluate(() => { window.anchorStale = anchorProbeAnchor.capture(); const root = moye.editor.vditor.ir.element, node = root.querySelector('p').firstChild, range = document.createRange(); root.focus(); range.setStart(node, node.length); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); });
      await page.keyboard.insertText(' 增量'); await settle(350);
      const result = await page.evaluate(() => ({ restored: anchorProbeAnchor.restore(anchorStale), content: moye.editor.getValue() }));
      assert.equal(result.restored, false); assert.ok(result.content.includes('增量'));
      await page.evaluate(() => moye.performAction('undo')); await settle(); assert.equal(await page.evaluate(() => moye.editor.getValue()), 'First line\n\nSecond line\n'); return { staleRestoreRejected: true, undoRestoresSource: true };
    });
    await probe('composition defers automatic scroll work and never edits the document', async () => {
      await open(); await position();
      const result = await page.evaluate(() => {
        const root = moye.editor.vditor.ir.element, b = anchorProbeAnchor.capture();
        root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        root.style.fontSize = '21px'; const afterLayoutScroll = root.scrollTop, restored = anchorProbeAnchor.restore(b);
        root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
        return { restored, afterLayoutScroll, finalScroll: root.scrollTop, raw: moye.getState().content };
      });
      assert.equal(result.restored, false); assert.equal(result.finalScroll, result.afterLayoutScroll); assert.equal(result.raw, fixture); return { syntheticIMEGuard: true, rawUnchanged: true, realSystemIME: 'not exercised' };
    });
    await probe('reopening a named document restores its own position and keeps other documents isolated', async () => {
      await open(fixture, '/tmp/moye-anchor-memory-a.md'); const expected = await position(40); await page.evaluate(() => anchorProbeAnchor.remember());
      await open(fixture, '/tmp/moye-anchor-memory-b.md'); const newTop = await page.evaluate(() => moye.editor.vditor.ir.element.scrollTop); assert.ok(newTop < 3);
      await position(12); await page.evaluate(() => anchorProbeAnchor.remember());
      await open(fixture, '/tmp/moye-anchor-memory-a.md'); const actual = await page.evaluate(() => { const b = anchorProbeAnchor.capture(); return { block: b.block, offset: b.offset, scrollTop: moye.editor.vditor.ir.element.scrollTop }; });
      assert.ok(Math.abs(actual.block - expected.block) <= 1, JSON.stringify({ expected, actual })); assert.ok(actual.scrollTop > 10000); return { expected, actual, otherDocumentStartedAtTop: true };
    });
    await probe('position memory can be disabled without disabling layout anchors', async () => {
      await rememberSetting(false);
      await open(fixture, '/tmp/moye-anchor-disabled.md'); await position(38); await page.evaluate(() => anchorProbeAnchor.remember());
      await open(fixture, '/tmp/moye-anchor-other.md'); await open(fixture, '/tmp/moye-anchor-disabled.md');
      assert.ok(await page.evaluate(() => moye.editor.vditor.ir.element.scrollTop < 3));
      await position(); await page.evaluate(() => anchorProbeAnchor.preserve(() => { moye.editor.vditor.ir.element.style.fontSize = '22px'; })); await settle();
      const after = await point(); assert.ok(Math.abs(after.y - after.initialY) < 3);
      await rememberSetting(true); return { reopenAtTop: true, layoutAnchorStillActive: true };
    });
    await probe('stored positions are bounded metadata with no document content or raw file paths', async () => {
      const value = await page.evaluate(() => localStorage.getItem('moye.reading-positions.v1'));
      assert.ok(value); assert.ok(!value.includes('排版改变')); assert.ok(!value.includes('/tmp/')); const parsed = JSON.parse(value); assert.ok(Object.keys(parsed).length <= 80);
      for (const entry of Object.values(parsed)) for (const type of ['ir', 'sv']) if (entry[type]) assert.ok(Object.keys(entry[type]).every(key => ['mode', 'offset', 'y', 'ratio', 'block', 'hash'].includes(key)));
      return { entries: Object.keys(parsed).length, noRawTextOrPaths: true };
    });
  } finally {
    if (app) { const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, executable, application, purpose: 'Moye visible reading anchors and per-document position memory; independent implementation of publicly described reader behavior', results, pageErrors, remoteRequests };
  report.pass = results.every(result => result.status === 'pass') && !pageErrors.length && !remoteRequests.length;
  await fs.writeFile(path.resolve(process.env.MOYE_READING_ANCHOR_OUTPUT || path.join(project, 'tests/reading-anchor-report.json')), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
  async function moyeApply(patch) { await page.evaluate(patch => moye.settings.apply(patch), patch); await settle(); }
  async function rememberSetting(value) {
    await page.evaluate(async value => {
      if (Object.hasOwn(moye.settings.getValues(), 'reading.rememberPosition')) await moye.settings.apply({ 'reading.rememberPosition': value });
      else { if (!anchorProbeFallback) throw new Error('Production memory setting not connected'); window.anchorProbeRemember = value; }
    }, value); await settle();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
