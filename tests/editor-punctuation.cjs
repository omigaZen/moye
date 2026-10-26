'use strict';
// Fresh-profile Electron input checks; no Typora equivalence or real OS IME claim.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-punctuation-'));
  const results = [], pageErrors = [], remoteRequests = [];
  const packagedRun = !!process.env.MOYE_PUNCTUATION_EXECUTABLE;
  const executable = packagedRun ? path.resolve(process.env.MOYE_PUNCTUATION_EXECUTABLE) : require('electron');
  let app, page, application = null, fatalError = null;
  async function open(content, mode = 'ir') {
    await page.evaluate(({ content, mode }) => { moye.loadDocument({ name: 'punctuation.md', content, path: null, documentId: crypto.randomUUID() }); moye.setMode(mode); }, { content, mode });
    await page.waitForTimeout(80);
  }
  async function settings(patch) { await page.evaluate(patch => moye.settings.apply(patch), patch); }
  async function sourceCaret(offset) { await page.evaluate(offset => { const el = moye.editor.vditor.sv.element; el.focus(); el.setSelectionRange(offset, offset); }, offset); }
  async function select(word, { selector = 'p', collapse, backward = false } = {}) {
    await page.evaluate(({ word, selector, collapse, backward }) => {
      const el = moye.editor.vditor.ir.element, block = el.querySelector(selector);
      if (!block) throw new Error(`Missing ${selector}: ${el.innerHTML}`);
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement.closest(selector === '[data-type="html-inline"]' ? '.vditor-ir__preview' : '.vditor-ir__preview,.vditor-ir__marker:not(.vditor-ir__marker--pre)') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
      let node;
      while ((node = walker.nextNode())) {
        const at = node.data.indexOf(word); if (at < 0) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
        if (collapse) range.collapse(collapse === 'start');
        el.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
        if (backward) getSelection().setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
        return;
      }
      throw new Error(`Missing ${word}: ${block.innerHTML}`);
    }, { word, selector, collapse, backward });
  }
  async function content() { return page.evaluate(() => moye.getState().content); }
  async function type(text) { await page.keyboard.type(text); }
  async function undoRedoStructure() {
    const created = await content(); await page.evaluate(() => moye.performAction('undo'));
    assert.notEqual(await content(), created, 'Undo reverses the structure insertion');
    await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), created); return created;
  }
  async function probe(name, callback) {
    if (process.env.MOYE_PUNCTUATION_MATCH && !name.includes(process.env.MOYE_PUNCTUATION_MATCH)) return;
    const started = Date.now();
    try { await settings({ 'editor.smartQuotes': true, 'editor.smartDashes': true, 'editor.autoPairBrackets': false, 'editor.autoPairMarkdown': false }); const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  try {
    app = await electron.launch({ executablePath: executable, args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packagedRun ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }));
    if (packagedRun) assert.equal(application.isPackaged, true, 'MOYE_PUNCTUATION_EXECUTABLE must launch an actual packaged app; source fallback is forbidden');
    await app.evaluate(({ app, session }) => {
      app.moyePunctuationRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const remote = /^https?:/.test(details.url);
        if (remote) app.moyePunctuationRequests.push(details.url);
        callback({ cancel: remote });
      });
    });
    page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready, null, { timeout: 25000 });
    assert.equal(await page.evaluate(() => !!window.MoyePunctuation), true, 'punctuation module loaded');
    await settings({ 'editor.smartQuotes': true, 'editor.smartDashes': true, 'editor.autoPairBrackets': false, 'editor.autoPairMarkdown': false });
    await probe('structural horizontal rule remains ASCII while later prose converts', async () => {
      await open('lead\n'); await select('lead', { collapse: 'end' }); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await type('---'); await undoRedoStructure(); await page.keyboard.press('Enter'); await type('body--...');
      const actual = await content(); assert.match(actual, /(?:^|\n)---(?:\n|$)/); assert.match(actual, /body–…/);
      assert.equal(await page.evaluate(() => moye.editor.vditor.ir.element.querySelectorAll('hr').length), 1);
      await page.evaluate(() => moye.performAction('undo')); assert.match(await content(), /body–\.\.\./); assert.match(await content(), /(?:^|\n)---(?:\n|$)/);
      await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), actual);
      return { actual, rule: 'ASCII ---', undoRedo: true, scope: 'syntax protection; not Unicode remapping' };
    });
    await probe('structural first-line YAML delimiters remain ASCII', async () => {
      await open(''); await type('---'); await undoRedoStructure(); await type('title: "alpha--..."'); await page.keyboard.press('ArrowDown'); await type('body--...');
      const actual = await content(); assert.equal(actual, '---\ntitle: "alpha--..."\n---\nbody–…\n');
      assert.equal(await page.evaluate(() => moye.editor.vditor.ir.element.querySelectorAll('[data-type="yaml-front-matter"][data-block]').length), 1);
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await content(), '---\ntitle: "alpha--..."\n---\nbody–...\n');
      await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), actual);
      return { actual, opening: 'actual --- keys', closing: 'existing editor template', undoRedo: true, rawParity: 'Moye preserves ASCII; Typora input plus remap may save Unicode. Original runtime not compared.' };
    });
    await probe('structural HTML comment delimiters remain ASCII', async () => {
      await open(''); await type('<!--comment-->'); await undoRedoStructure(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await type('body--...');
      const actual = await content(); assert.equal(actual, '<!--comment-->\n\nbody–…\n');
      assert.equal(await page.evaluate(() => moye.editor.vditor.ir.element.querySelectorAll('[data-type="html-block"][data-block]').length), 1);
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await content(), '<!--comment-->\n\nbody–...\n');
      await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), actual);
      return { actual, comment: 'ASCII delimiters', undoRedo: true, baseline: 'already protected before the hyphen-line fix' };
    });
    await probe('IR actual keys convert nested quotes and apostrophes', async () => {
      await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"It\'s a \'word\' in a quoted sentence."');
      const actual = await content(); assert.equal(actual, 'prefix “It’s a ‘word’ in a quoted sentence.”\n'); return { actual };
    });
    await probe('IR actual -- --- and ... produce en/em dash and ellipsis', async () => {
      await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('a--b---c...d');
      const actual = await content(); assert.equal(actual, 'prefix a–b—c…d\n'); return { actual };
    });
    await probe('a newly loaded literal en dash is not a prior typed double hyphen', async () => {
      await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('--'); assert.equal(await content(), 'prefix –\n');
      await open('prefix –\n'); await select('–', { collapse: 'end' }); await type('-'); assert.equal(await content(), 'prefix –-\n');
      return { actual: await content() };
    });
    await probe('smart dashes and quotes change behavior independently and immediately', async () => {
      await settings({ 'editor.smartQuotes': false, 'editor.smartDashes': true }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a" -- ...');
      assert.equal(await content(), 'prefix "a" – …\n');
      await settings({ 'editor.smartQuotes': true, 'editor.smartDashes': false }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a" -- ...');
      assert.equal(await content(), 'prefix “a” -- ...\n');
      await settings({ 'editor.smartQuotes': false, 'editor.smartDashes': false }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a" -- ...');
      assert.equal(await content(), 'prefix "a" -- ...\n');
      await settings({ 'editor.smartQuotes': true, 'editor.smartDashes': true }); return { combinations: 3 };
    });
    await probe('all sixteen smart punctuation and pairing boolean combinations', async () => {
      const details = [];
      for (let bits = 0; bits < 16; bits++) {
        const smartQuotes = !!(bits & 1), smartDashes = !!(bits & 2), brackets = !!(bits & 4), markdown = !!(bits & 8);
        await settings({ 'editor.smartQuotes': smartQuotes, 'editor.smartDashes': smartDashes, 'editor.autoPairBrackets': brackets, 'editor.autoPairMarkdown': markdown });
        await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a" -- ...');
        const expected = `prefix ${smartQuotes ? '“a”' : '"a"'} ${smartDashes ? '– …' : '-- ...'}\n`;
        assert.equal(await content(), expected, `combination ${bits}`); details.push({ smartQuotes, smartDashes, brackets, markdown, actual: await content() });
      }
      return { combinations: details.length, details };
    });
    await probe('source mode keeps ASCII literal with smart options enabled', async () => {
      await open('prefix \n', 'sv'); await sourceCaret(7); await type('"It\'s" -- --- ...');
      const actual = await content(); assert.equal(actual, 'prefix "It\'s" -- --- ...\n'); return { actual };
    });
    await probe('IR escapes prevent quote and dash conversion', async () => {
      await settings({ 'editor.autoPairBrackets': true });
      await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('\\"word\\" \\-- \\---');
      const actual = await content(); assert.equal(actual.includes('“'), false); assert.equal(actual.includes('”'), false); assert.equal(/[–—]/.test(actual), false); return { actual };
    });
    await probe('IR code math YAML HTML and URL destinations stay literal', async () => {
      const fixtures = [
        { text: '`alpha`\n', selector: '[data-type="code"]', word: 'alpha' },
        { text: '```text\nalpha\n```\n', selector: '[data-type="code-block"] code', word: 'alpha' },
        { text: '$alpha$\n', selector: '[data-type="math-inline"]', word: 'alpha' },
        { text: '$$\nalpha\n$$\n', selector: '[data-type="math-block"] code', word: 'alpha' },
        { text: '---\nname: alpha\n---\n\ntext\n', selector: '[data-type="yaml-front-matter"]', word: 'alpha' },
        { text: '<span title="alpha">html</span>\n', selector: '[data-type="html-inline"]', word: 'alpha' },
      ];
      const details = [];
      for (const fixture of fixtures) {
        await open(fixture.text); await select(fixture.word, { selector: fixture.selector, collapse: 'end' }); await type('"--...');
        const actual = await content(); assert.equal(/[“”‘’–—…]/.test(actual), false, fixture.selector); details.push({ selector: fixture.selector, actual });
      }
      return details;
    });
    await probe('unparsed URL and unfinished HTML attributes stay literal', async () => {
      for (const prefix of ['https://example.test/a', '<span title=']) {
        await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type(prefix + '"--...'); assert.equal(/[“”‘’–—…]/.test(await content()), false);
      }
      return { scenarios: 2 };
    });
    await probe('input conversion Undo restores literal punctuation and Redo restores conversion', async () => {
      const details = [];
      for (const [input, literal, converted] of [['"', '"', '“'], ['--', '--', '–'], ['---', '---', '—'], ['...', '...', '…']]) {
        await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type(input); assert.equal(await content(), `prefix ${converted}\n`);
        await page.evaluate(() => moye.performAction('undo')); assert.equal(await content(), `prefix ${literal}\n`);
        await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), `prefix ${converted}\n`);
        details.push({ input, literal, converted });
      }
      return details;
    });
    await probe('curly quote pairing skips existing close and pair Backspace is reversible', async () => {
      await settings({ 'editor.autoPairBrackets': true }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a"');
      assert.equal(await content(), 'prefix “a”\n'); await type('!'); assert.equal(await content(), 'prefix “a”!\n');
      await open('left  right\n'); await select('left ', { collapse: 'end' }); await type('"'); assert.equal(await content(), 'left “” right\n'); await page.keyboard.press('Backspace'); assert.equal(await content(), 'left  right\n');
      await page.evaluate(() => moye.performAction('undo')); assert.equal(await content(), 'left “” right\n'); await page.evaluate(() => moye.performAction('redo')); assert.equal(await content(), 'left  right\n');
      return { pair: '“”', emptyDeletionUndoRedo: true };
    });
    for (const word of ['😀', 'e\u0301', '👨‍👩‍👧‍👦']) await probe(`curly quotes preserve selected Unicode ${word}`, async () => {
      await settings({ 'editor.autoPairBrackets': true });
      await open(`left ${word} right\n`); await select(word, { backward: true }); await type('"');
      assert.equal(await page.evaluate(() => getSelection().toString()), word); assert.equal(await content(), `left “${word}” right\n`);
      const backward = await page.evaluate(() => { const s = getSelection(), r = s.getRangeAt(0); return s.anchorNode === r.endContainer && s.anchorOffset === r.endOffset; }); assert.equal(backward, true);
      await type('X'); assert.equal(await content(), 'left “X” right\n'); return { original: word, replacement: await content(), backward };
    });
    await probe('curly quotes preserve selected bold and linked text markup', async () => {
      await settings({ 'editor.autoPairBrackets': true });
      for (const fixture of [{ source: 'left **word** right\n', selector: 'strong' }, { source: 'left [word](https://example.test) right\n', selector: '[data-type="a"]' }]) {
        await open(fixture.source); await select('word', { selector: fixture.selector }); await type('"');
        assert.equal(await page.evaluate(() => getSelection().toString()), 'word'); assert.match(await content(), /“word”/);
        if (fixture.selector === 'strong') assert.match(await content(), /\*\*[^\n]*word[^\n]*\*\*/);
        else assert.match(await content(), /\[[^\n]*word[^\n]*\]\(https:\/\/example.test\)/);
      }
      return { scenarios: 2 };
    });
    await probe('composition events do not convert provisional or committed IME text', async () => {
      await settings({ 'editor.autoPairBrackets': false }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' ');
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
      await type('"--...');
      await page.evaluate(() => moye.editor.vditor.ir.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '"--...' })));
      assert.equal(/[“”‘’–—…]/.test(await content()), false); return { syntheticOnly: true, actual: await content(), realOSIME: 'not tested' };
    });
    await probe('plain paste is not transformed by input conversion', async () => {
      await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' ');
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), '"plain" -- --- ...'); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V'); await page.waitForTimeout(200);
      assert.equal(await content(), 'prefix "plain" -- --- ...\n'); return { actual: await content() };
    });
    await probe('focus/typewriter and dark theme keep punctuation editing behavior', async () => {
      await settings({ 'appearance.theme': 'dark', 'editor.focusMode': true, 'editor.typewriterMode': true }); await open('prefix\n'); await select('prefix', { collapse: 'end' }); await type(' '); await type('"a"--...');
      const actual = await content(); assert.equal(actual, 'prefix “a”–…\n'); return { actual, theme: 'dark', focus: true, typewriter: true };
    });
  } catch (error) { fatalError = error.stack || error.message; }
  finally {
    if (app) {
      const sessionRequests = await app.evaluate(({ app }) => app.moyePunctuationRequests || []).catch(() => []);
      remoteRequests.push(...sessionRequests);
      const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const attemptedRemoteRequests = [...new Set(remoteRequests)];
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, application, reference: 'https://support.typora.io/SmartyPants/', purpose: 'Moye input regressions; original defaults, render-only/remap, OS quote patterns, and real IME remain unverified/unimplemented', network: 'HTTP(S) blocked at session and page', remoteRequests: attemptedRemoteRequests, results, pageErrors, fatalError, pass: !fatalError && results.every(result => result.status === 'pass') && !pageErrors.length && !attemptedRemoteRequests.length };
  const output = path.resolve(process.env.MOYE_PUNCTUATION_OUTPUT || path.join(root, 'tests/punctuation-report.json'));
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
