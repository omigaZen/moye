'use strict';
// Actual Electron feature/regression checks; these do not establish Typora parity.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-pairing-'));
  const results = [], pageErrors = [];
  let app, page;
  async function open(content, mode = 'ir') {
    await page.evaluate(({ content, mode }) => {
      moye.loadDocument({ name: 'pairing-fixture.md', content, path: null, documentId: crypto.randomUUID() });
      moye.setMode(mode);
    }, { content, mode });
    await page.waitForTimeout(80);
  }
  async function selectWord(word, selector = 'p') {
    await page.evaluate(({ word, selector }) => {
      const root = moye.editor.vditor.ir.element, block = root.querySelector(selector);
      if (!block) throw new Error(`Missing ${selector}: ${root.innerHTML}`);
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode(node) { return node.parentElement.closest('.vditor-ir__marker,.vditor-ir__preview') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
      });
      let node;
      while ((node = walker.nextNode())) {
        const at = node.data.indexOf(word);
        if (at < 0) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
        root.focus(); getSelection().removeAllRanges(); getSelection().addRange(range); return;
      }
      throw new Error(`Missing selected word ${word}`);
    }, { word, selector });
  }
  async function sourceCaret(offset) {
    await page.evaluate(offset => { const el = moye.editor.vditor.sv.element; el.focus(); el.setSelectionRange(offset, offset); }, offset);
  }
  async function content() { return page.evaluate(() => moye.getState().content); }
  async function probe(name, callback) {
    if (process.env.MOYE_PAIRING_MATCH && !name.includes(process.env.MOYE_PAIRING_MATCH)) return;
    const started = Date.now();
    try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.join(root, 'electron/main.cjs')], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready, null, { timeout: 25000 });
    await page.evaluate(() => moye.settings.apply({ 'editor.autoPairBrackets': true, 'editor.autoPairMarkdown': true }));

    for (const word of ['😀', 'e\u0301', '👨‍👩‍👧‍👦']) await probe(`IR exact selection survives wrapping Unicode ${word}`, async () => {
      await open(`left ${word} right\n`); await selectWord(word); await page.keyboard.press('Shift+Digit9');
      assert.equal(await page.evaluate(() => getSelection().toString()), word);
      assert.equal(await content(), `left (${word}) right\n`);
      await page.keyboard.insertText('X'); assert.equal(await content(), 'left (X) right\n');
      return { original: word, afterReplacement: await content() };
    });
    for (const item of [{ name: 'bold', source: 'left **word** right\n', selector: 'strong' }, { name: 'link', source: 'left [word](https://example.test/path) right\n', selector: '[data-type="a"]' }]) await probe(`IR wrapping preserves selected ${item.name} markup`, async () => {
      await open(item.source); await selectWord('word', item.selector); await page.keyboard.press('Shift+Digit9');
      assert.equal(await page.evaluate(() => getSelection().toString()), 'word');
      const actual = await content();
      if (item.name === 'bold') assert.match(actual, /\*\*[^\n]*word[^\n]*\*\*/);
      else assert.match(actual, /\[[^\n]*word[^\n]*\]\(https:\/\/example\.test\/path\)/);
      await page.keyboard.insertText('X');
      assert.match(await content(), /\(X\)/); return { wrapped: actual, replacement: await content() };
    });
    await probe('IR Markdown wrapper preserves selected Unicode and backward direction', async () => {
      await open('left 😀 word right\n'); await selectWord('😀 word');
      await page.evaluate(() => { const s = getSelection(), r = s.getRangeAt(0); s.setBaseAndExtent(r.endContainer, r.endOffset, r.startContainer, r.startOffset); });
      await page.keyboard.press('Shift+Digit8');
      assert.equal(await page.evaluate(() => getSelection().toString()), '😀 word');
      const actual = await content(); assert.match(actual, /\*😀 word\*/);
      const backward = await page.evaluate(() => { const s = getSelection(), r = s.getRangeAt(0); return s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset; });
      assert.equal(backward, true); return { actual, backward };
    });
    await probe('IR inline code backspace stays literal and closed source fences resume pairing', async () => {
      await open('`**`\n'); await selectWord('*', '[data-type="code"]');
      await page.evaluate(() => getSelection().collapseToEnd()); await page.keyboard.press('Backspace');
      assert.equal(await content(), '`*`\n');
      const prefix = '````text\n```\ncode\n````\n\n';
      await open(prefix, 'sv'); await sourceCaret(prefix.length); await page.keyboard.press('Shift+Digit8');
      assert.equal(await content(), prefix + '**'); assert.equal(await page.evaluate(() => moye.editor.vditor.sv.element.value), prefix + '**'); return { inlineCode: '`*`', sourceSuffix: '**', sourceHasNoInventedTrailingLF: true };
    });
    await probe('SV code fences honor delimiter kind, length and up to three spaces', async () => {
      const samples = [
        { start: '````text\n```\n', end: '\n````\n' },
        { start: '   ```text\n', end: '\n   ```\n' },
        { start: '~~~text\n```\n', end: '\n~~~\n' },
        { start: '`````text\n````\n', end: '\n`````\n' },
      ];
      for (const sample of samples) {
        await open(sample.start + sample.end, 'sv'); await sourceCaret(sample.start.length); await page.keyboard.insertText('*');
        assert.equal(await content(), sample.start + '*' + sample.end);
      }
      return { scenarios: samples.length };
    });
    await probe('Markdown backspace is inactive in source fenced and inline code', async () => {
      const samples = [{ before: '````text\n```\n*', after: '*\n````\n' }, { before: 'a `*', after: '*` b\n' }];
      for (const sample of samples) {
        await open(sample.before + sample.after, 'sv'); await sourceCaret(sample.before.length); await page.keyboard.press('Backspace');
        assert.equal(await content(), sample.before.slice(0, -1) + sample.after);
      }
      return { scenarios: samples.length };
    });
    await probe('disabled inline math does not skip an existing dollar in either mode', async () => {
      await page.evaluate(async () => { await moye.settings.apply({ 'markdown.inlineMath': false }); await moye.settings.reload(); });
      for (const mode of ['sv', 'ir']) {
        await open('a $ b\n', mode);
        if (mode === 'sv') await sourceCaret(2);
        else {
          await selectWord('$');
          await page.evaluate(() => { const s = getSelection(); s.collapseToStart(); });
        }
        await page.keyboard.insertText('$'); assert.equal(await content(), 'a $$ b\n');
      }
      return { modes: ['sv', 'ir'] };
    });
    await probe('IR adjacent letter checks work at an inline-element boundary', async () => {
      await open('left **word** right\n');
      await page.evaluate(() => {
        const el = moye.editor.vditor.ir.element, strong = el.querySelector('strong'), range = document.createRange();
        range.setStart(strong, strong.childNodes.length); range.collapse(true); el.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.keyboard.insertText("'");
      const actual = await content(); assert.equal((actual.match(/'/g) || []).length, 1); return { actual };
    });
    await probe('empty bracket backspace in both modes has reversible undo/redo', async () => {
      const details = [];
      for (const mode of ['sv', 'ir']) {
        await open('left  right\n', mode);
        if (mode === 'sv') await sourceCaret(5);
        else { await selectWord('left '); await page.evaluate(() => getSelection().collapseToEnd()); }
        await page.keyboard.insertText('('); assert.equal(await content(), 'left () right\n');
        await page.keyboard.press('Backspace'); assert.equal(await content(), 'left  right\n');
        await page.evaluate(() => moye.performAction('undo')); assert.equal(await content(), 'left () right\n');
        await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), 'left  right\n');
        details.push({ mode, undoneAndRedone: true });
      }
      return details;
    });
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const report = { generatedAt: new Date().toISOString(), purpose: 'Moye pairing regressions, not Typora equivalence proof', results, pageErrors };
  await fs.writeFile(path.join(root, 'tests/pairing-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (results.some(result => result.status !== 'pass') || pageErrors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
