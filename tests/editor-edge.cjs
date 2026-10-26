'use strict';

// Independent packaged-renderer checks in real Electron/Chromium on Linux.
// Synthetic composition events verify application guards, NOT a system IME.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-edge-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.resolve(__dirname, '../electron/main.cjs')],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
  });
  const results = [], errors = [];
  const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.moye?.ready, { timeout: 20000 });
  let documentIndex = 0;
  async function open(content) {
    const destination = path.join(work, `case-${++documentIndex}.md`);
    await fs.writeFile(destination, content, 'utf8');
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, destination);
    await page.evaluate(async () => {
      const element = moye.editor.vditor[moye.editor.getCurrentMode()].element;
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      await moye.performAction('open');
      moye.setMode('ir');
    });
    await page.waitForTimeout(450);
    return destination;
  }
  async function caret(paragraph = 0, offset = null, end = null) {
    return page.evaluate(({ paragraph, offset, end }) => {
      const root = moye.editor.vditor.ir.element;
      const p = root.querySelectorAll('p')[paragraph];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), nodes = [];
      let text; while ((text = walker.nextNode())) if (text.length) nodes.push(text);
      const length = nodes.reduce((sum, node) => sum + node.length, 0);
      const point = at => { for (const node of nodes) { if (at <= node.length) return [node, at]; at -= node.length; } return [nodes.at(-1), nodes.at(-1).length]; };
      const start = offset === null ? length : offset, finish = end === null ? start : end;
      const range = document.createRange();
      range.setStart(...point(start)); range.setEnd(...point(finish));
      root.focus();
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { text: p.textContent, selected: selection.toString() };
    }, { paragraph, offset, end });
  }
  async function probe(name, callback) {
    const started = Date.now();
    try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.message }); }
  }

  try {
    await probe('rapid live input -> source keeps trailing characters', async () => {
      await open('plain\n'); await caret();
      await page.keyboard.insertText('尾字');
      const result = await page.evaluate(() => { moye.setMode('sv'); return { state: moye.getState(), source: moye.editor.vditor.sv.element.value }; });
      assert.equal(result.state.mode, 'sv'); assert.match(result.source, /plain尾字/); assert.match(result.state.content, /plain尾字/);
      return result;
    });
    await probe('rapid live input -> native save includes trailing characters', async () => {
      const destination = await open('save\n'); await caret(); await page.keyboard.insertText('尾字');
      await page.evaluate(() => moye.performAction('save'));
      const saved = await fs.readFile(destination, 'utf8'); assert.match(saved, /save尾字/);
      return { saved };
    });
    await probe('synthetic composition guards switching and new document (not system IME)', async () => {
      await open('中文开始\n'); await caret();
      await page.evaluate(async () => {
        const el = moye.editor.vditor.ir.element;
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        document.execCommand('insertText', false, '输入');
        moye.setMode('sv'); await moye.performAction('new');
      });
      let result = await page.evaluate(() => ({ mode: moye.editor.getCurrentMode(), visible: moye.editor.getValue() }));
      assert.equal(result.mode, 'ir'); assert.match(result.visible, /中文开始输入/);
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入' })));
      await page.waitForTimeout(450);
      result = await page.evaluate(() => moye.getState()); assert.equal((result.content.match(/输入/g) || []).length, 1);
      return result;
    });
    await probe('copy selected strong text as Markdown preserves style', async () => {
      await open('A **bold** Z\n');
      await page.evaluate(() => {
        const node = moye.editor.vditor.ir.element.querySelector('strong');
        const range = document.createRange(); range.selectNodeContents(node);
        moye.editor.focus(); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      await page.evaluate(() => moye.performAction('copy-markdown'));
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      assert.equal(copied.trim(), '**bold**'); return { copied };
    });
    await probe('copy selected link text as Markdown preserves the destination', async () => {
      await open('[link](https://example.com)\n');
      await page.evaluate(() => {
        const node = moye.editor.vditor.ir.element.querySelector('.vditor-ir__link');
        const range = document.createRange(); range.selectNodeContents(node);
        moye.editor.focus(); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      await page.evaluate(() => moye.performAction('copy-markdown'));
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      assert.equal(copied.trim(), '[link](https://example.com)');
      await page.evaluate(() => {
        const text = moye.editor.vditor.ir.element.querySelector('.vditor-ir__link').firstChild;
        const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 4);
        moye.editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.evaluate(() => moye.performAction('copy-markdown'));
      const partial = await app.evaluate(({ clipboard }) => clipboard.readText());
      assert.equal(partial.trim(), '[ink](https://example.com)'); return { copied, partial };
    });
    await probe('source roundtrip preserves repeated paragraph caret and selection', async () => {
      const paragraph = '重复段落'.repeat(20);
      await open(`${paragraph}\n\n${paragraph}\n`);
      const before = await caret(1, 50, 57);
      const source = await page.evaluate(() => { moye.setMode('sv'); const el = moye.editor.vditor.sv.element; return { start: el.selectionStart, end: el.selectionEnd }; });
      assert.equal(source.start, paragraph.length + 2 + 50);
      assert.equal(source.end, paragraph.length + 2 + 57);
      const after = await page.evaluate(() => {
        moye.setMode('ir'); const selection = getSelection();
        const p = selection.anchorNode?.parentElement?.closest('p');
        return { selected: selection.toString(), paragraphIndex: [...moye.editor.vditor.ir.element.querySelectorAll('p')].indexOf(p) };
      });
      assert.equal(after.paragraphIndex, 1); assert.equal(after.selected, before.selected);
      return { before, source, after };
    });
    await probe('source edit -> live edit -> undo preserves unsaved source text', async () => {
      await open('old\n'); await page.evaluate(() => moye.setMode('sv'));
      const raw = 'new  \nline\n';
      await page.locator('.vditor-sv').fill(raw); await page.waitForTimeout(450);
      await page.evaluate(() => moye.setMode('ir')); await caret(0, 3); await page.keyboard.insertText('!');
      await page.waitForTimeout(450); await page.evaluate(() => moye.performAction('undo'));
      const content = await page.evaluate(() => moye.getState().content);
      assert.equal(content, raw); return { content };
    });
    await probe('unknown HTML and comments survive unrelated edit and save', async () => {
      const raw = 'editable\n\n<!-- keep 中文 -->\n\n<moye-custom data-note="keep">原始内容</moye-custom>\n';
      const destination = await open(raw);
      await page.evaluate(() => moye.performAction('save'));
      assert.equal(await fs.readFile(destination, 'utf8'), raw);
      await caret(0); await page.keyboard.insertText(' changed'); await page.waitForTimeout(450);
      await page.evaluate(() => moye.performAction('save'));
      const content = await fs.readFile(destination, 'utf8');
      assert.ok(content.includes('<!-- keep 中文 -->'));
      assert.ok(content.includes('<moye-custom data-note="keep">原始内容</moye-custom>'));
      return { content };
    });
    await probe('single replace uses fresh match positions after earlier source edit', async () => {
      await open('aaa foo\n'); await page.evaluate(() => { moye.setMode('sv'); moye.performAction('find'); });
      await page.locator('#find-input').fill('foo'); await page.locator('#find-next').click();
      await page.locator('#toggle-replace').click(); await page.locator('#replace-input').fill('BAR');
      await page.evaluate(() => {
        const el = moye.editor.vditor.sv.element;
        el.setSelectionRange(0, 0); el.focus();
      });
      await page.keyboard.insertText('XXX');
      await page.locator('#replace-one').click();
      const content = await page.evaluate(() => moye.editor.vditor.sv.element.value);
      assert.equal(content, 'XXXaaa BAR\n'); return { content };
    });
    await probe('immediate undo and redo include the latest un-debounced edit', async () => {
      await open('before\n'); await caret(); await page.keyboard.insertText('尾字');
      await page.evaluate(() => moye.performAction('undo'));
      const undone = await page.evaluate(() => moye.getState().content); assert.equal(undone, 'before\n');
      await page.evaluate(() => moye.performAction('redo'));
      const redone = await page.evaluate(() => moye.getState().content); assert.equal(redone, 'before尾字\n'); return { undone, redone };
    });
    await probe('source roundtrip preserves backward selection direction', async () => {
      await open('第一段文字\n\n第二段重复文字第二段重复文字\n');
      await page.evaluate(() => { const node = moye.editor.vditor.ir.element.querySelectorAll('p')[1].firstChild; moye.editor.focus(); getSelection().setBaseAndExtent(node, 10, node, 3); moye.setMode('sv'); });
      assert.equal(await page.evaluate(() => moye.editor.vditor.sv.element.selectionDirection), 'backward');
      const result = await page.evaluate(() => { moye.setMode('ir'); const s = getSelection(), r = s.getRangeAt(0); return { text: s.toString(), backward: s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset }; });
      assert.equal(result.backward, true); assert.equal(result.text, '重复文字第二段'); return result;
    });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  const report = { platform: `${process.platform}/${process.arch}`, engine: 'Electron 45', systemIME: 'not tested; composition events synthetic', results, pageErrors: errors };
  if (process.env.MOYE_EDGE_OUTPUT) await fs.writeFile(path.resolve(process.env.MOYE_EDGE_OUTPUT), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some(result => result.status === 'fail') || errors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
