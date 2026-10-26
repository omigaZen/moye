'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-extras-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.resolve(__dirname, '../electron/main.cjs')],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
  });
  const page = await app.firstWindow(), results = [], pageErrors = [], requests = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.route(/^https?:/, route => route.abort());
  await page.waitForFunction(() => window.moye?.ready);
  let index = 0;
  async function openFile(destination) {
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, destination);
    await page.evaluate(async () => {
      document.getElementById('find-bar').hidden = true;
      document.getElementById('replace-row').hidden = true;
      await moye.performAction('open'); moye.setMode('ir');
    });
    await page.waitForTimeout(450);
    return destination;
  }
  async function open(content) {
    const destination = path.join(work, `extra-${++index}.md`);
    await fs.writeFile(destination, content, 'utf8');
    return openFile(destination);
  }
  async function caret(selector, at = 'end') {
    await page.evaluate(({ selector, at }) => {
      const root = moye.editor.vditor.ir.element;
      const node = root.querySelector(selector); const range = document.createRange();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); const texts = [];
      let leaf; while ((leaf = walker.nextNode())) texts.push(leaf);
      if (texts.length) { const text = at === 'start' ? texts[0] : texts[texts.length - 1]; range.setStart(text, at === 'start' ? 0 : text.length); range.collapse(true); }
      else { range.selectNodeContents(node); range.collapse(at === 'start'); }
      root.focus(); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, { selector, at });
  }
  async function probe(name, callback) {
    const start = Date.now();
    try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - start, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.message }); }
  }
  async function replace(query, replacement) {
    await page.evaluate(() => moye.performAction('find'));
    await page.locator('#find-input').fill(query);
    const count = await page.locator('#find-count').textContent();
    await page.locator('#toggle-replace').click();
    await page.locator('#replace-input').fill(replacement);
    await page.locator('#replace-all').click();
    await page.waitForTimeout(400);
    return { count, content: await page.evaluate(() => moye.getState().content) };
  }
  try {
    await probe('complete sample renders 8 Mermaid diagrams and 5 formulae offline', async () => {
      await openFile(path.resolve(__dirname, '../samples/完整语法验收.md'));
      await page.waitForFunction(() => document.querySelectorAll('.language-mermaid svg').length === 8, { timeout: 15000 });
      await page.waitForFunction(() => document.querySelectorAll('.katex,mjx-container').length >= 5);
      const result = await page.evaluate(() => ({ diagrams: document.querySelectorAll('.language-mermaid svg').length,
        math: document.querySelectorAll('.katex,mjx-container').length, errors: [...document.querySelectorAll('.vditor-reset--error')].map(node => node.textContent) }));
      assert.equal(result.diagrams, 8); assert.equal(result.math, 5); assert.deepEqual(result.errors, []);
      return result;
    });
    await probe('live replace-all changes visible text and preserves hidden link URL', async () => {
      await open('[same](https://same.example) and same\n\n**same**\n');
      const result = await replace('same', 'CHANGED');
      assert.equal(result.count, '0/3', JSON.stringify(result));
      assert.ok(result.content.includes('https://same.example'));
      assert.equal((result.content.match(/CHANGED/g) || []).length, 3);
      return result;
    });
    await probe('code block source remains searchable while syntax markers stay excluded', async () => {
      await open('```csharp\nConsole.WriteLine("needle");\n```\n\nneedle\n');
      const result = await replace('needle', 'changed');
      assert.equal(result.count, '0/2');
      assert.equal((result.content.match(/changed/g) || []).length, 2); return result;
    });
    await probe('literal replacement preserves angle brackets as text', async () => {
      await open('one target two\n');
      const result = await replace('target', '<item>');
      assert.match(result.content, /(?:<item>|&lt;item&gt;)/);
      assert.equal(await page.locator('.vditor-ir item').count(), 0);
      return result;
    });
    await probe('table Tab/Shift+Tab navigate cells and text does not bleed', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n\nafter\n');
      await caret('td'); await page.keyboard.insertText('中文'); await page.keyboard.press('Tab');
      const nextCell = await page.evaluate(() => { const anchor = getSelection().anchorNode; return [...moye.editor.vditor.ir.element.querySelectorAll('td')].indexOf((anchor.nodeType === 1 ? anchor : anchor.parentElement).closest('td')); });
      assert.equal(nextCell, 1);
      await page.keyboard.insertText('第二格'); await page.keyboard.press('Shift+Tab');
      const result = await page.evaluate(() => ({ cells: [...moye.editor.vditor.ir.element.querySelectorAll('td')].map(node => node.textContent),
        currentCell: [...moye.editor.vditor.ir.element.querySelectorAll('td')].indexOf((getSelection().anchorNode.nodeType === 1 ? getSelection().anchorNode : getSelection().anchorNode.parentElement).closest('td')) }));
      assert.deepEqual(result.cells, ['one中文', '第二格']); assert.equal(result.currentCell, 0);
      return result;
    });
    await probe('table Enter inserts a cell line break and undo preserves table', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n'); await caret('td');
      await page.keyboard.press('Enter');
      const afterEnter = await page.evaluate(() => ({ cell: moye.editor.vditor.ir.element.querySelector('td').innerHTML,
        anchor: getSelection().anchorNode.nodeName, offset: getSelection().anchorOffset,
        parent: getSelection().anchorNode.parentElement.outerHTML }));
      await page.keyboard.insertText('line'); await page.waitForTimeout(450);
      const before = await page.evaluate(() => ({ tables: moye.editor.vditor.ir.element.querySelectorAll('table').length,
        cells: [...moye.editor.vditor.ir.element.querySelectorAll('td')].map(node => node.innerHTML), content: moye.getState().content }));
      assert.equal(before.tables, 1); assert.match(before.cells[0], /<br>/, JSON.stringify({afterEnter, before})); assert.match(before.cells[0], /line/);
      await page.evaluate(() => moye.performAction('undo'));
      assert.equal(await page.locator('.vditor-ir table').count(), 1); return before;
    });
    await probe('local image chooser creates relative asset and reloads from disk', async () => {
      const destination = await open('image here\n'); await caret('p');
      const image = path.resolve(__dirname, '../samples/assets/书写 测试.svg');
      await app.evaluate(({ dialog }, image) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] }); }, image);
      await page.evaluate(() => moye.performAction('image'));
      await page.waitForFunction(() => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(img => img.complete && img.naturalWidth === 640));
      await page.evaluate(() => moye.performAction('save'));
      const saved = await fs.readFile(destination, 'utf8');
      const match = saved.match(/!\[[^\]]*\]\(([^)]+)\)/); assert.ok(match);
      assert.ok(match[1].startsWith('./')); assert.ok(!match[1].includes('file:'));
      const asset = path.resolve(path.dirname(destination), decodeURIComponent(match[1]));
      await fs.access(asset); await openFile(destination);
      await page.waitForFunction(() => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(img => img.complete && img.naturalWidth === 640));
      return { saved, asset: path.basename(asset) };
    });
    await probe('empty list Enter exits to an ordinary paragraph', async () => {
      await open('- one\n- \n'); await caret('li:last-child'); await page.keyboard.press('Enter'); await page.keyboard.insertText('after');
      await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ content: moye.getState().content,
        inList: !!getSelection().anchorNode.parentElement.closest('li'), itemCount: moye.editor.vditor.ir.element.querySelectorAll('li').length }));
      assert.equal(result.inList, false); assert.equal(result.itemCount, 1); assert.match(result.content, /\n\nafter/); return result;
    });
    await probe('list Tab and Shift+Tab indent and outdent without text loss', async () => {
      await open('- first\n- second\n'); await caret('li:last-child'); await page.keyboard.press('Tab');
      const nested = await page.evaluate(() => moye.editor.vditor.ir.element.querySelectorAll('li li').length);
      assert.equal(nested, 1); await page.keyboard.press('Shift+Tab');
      const result = await page.evaluate(() => ({ nested: moye.editor.vditor.ir.element.querySelectorAll('li li').length,
        items: [...moye.editor.vditor.ir.element.querySelectorAll('li')].map(node => node.textContent.trim()) }));
      assert.equal(result.nested, 0); assert.deepEqual(result.items, ['first', 'second']); return result;
    });
    await probe('list indentation preserves a backward text selection and supports undo', async () => {
      await open('- first\n- second\n');
      await page.evaluate(() => {
        const text = moye.editor.vditor.ir.element.querySelector('li:last-child').firstChild;
        moye.editor.focus(); getSelection().setBaseAndExtent(text, 4, text, 1);
      });
      await page.keyboard.press('Tab');
      const indented = await page.evaluate(() => { const selection = getSelection(), range = selection.getRangeAt(0); return { selected: selection.toString(),
        backward: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset && !range.collapsed,
        nested: moye.editor.vditor.ir.element.querySelectorAll('li li').length }; });
      assert.equal(indented.nested, 1); assert.equal(indented.selected, 'eco'); assert.equal(indented.backward, true);
      await page.evaluate(() => moye.performAction('undo'));
      assert.equal(await page.locator('.vditor-ir li li').count(), 0); return indented;
    });
    await probe('code block Tab still inserts spaces when nested in a list', async () => {
      await open('- first\n- second\n\n  ```csharp\n  abc\n  ```\n');
      await caret('[data-type="code-block"] pre code'); await page.keyboard.press('Tab');
      await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ content: moye.getState().content,
        nestedLists: moye.editor.vditor.ir.element.querySelectorAll('li li').length,
        code: moye.editor.vditor.ir.element.querySelector('[data-type="code-block"] pre code').textContent }));
      assert.equal(result.nestedLists, 0); assert.ok(result.code.includes('    ')); assert.match(result.code, /abc/); return result;
    });
    await probe('table Shift+Enter inside text preserves both sides and the line break', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n');
      await page.evaluate(() => {
        const text = moye.editor.vditor.ir.element.querySelector('td').firstChild;
        const range = document.createRange(); range.setStart(text, 1); range.collapse(true);
        moye.editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      });
      await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('X'); await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ html: moye.editor.vditor.ir.element.querySelector('td').innerHTML, content: moye.getState().content }));
      assert.equal(result.html, 'o<br>Xne'); assert.match(result.content, /o<br \/>Xne/); return result;
    });
    await probe('table Ctrl+Enter inserts a row and undo restores the previous rows', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n'); await caret('td');
      await page.keyboard.press('Control+Enter'); await page.keyboard.insertText('new row'); await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ rows: [...moye.editor.vditor.ir.element.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent.replace(/\u200b/g, '').trim())), content: moye.getState().content }));
      assert.deepEqual(result.rows, [['one', 'two'], ['new row', '']]);
      await page.evaluate(() => moye.performAction('undo'));
      await page.evaluate(() => moye.performAction('undo'));
      assert.equal(await page.locator('.vditor-ir tbody tr').count(), 1); return result;
    });
    await probe('Tab from the last table cell appends a new row', async () => {
      await open('| A | B |\n| --- | --- |\n| one | two |\n'); await caret('td:last-child');
      await page.keyboard.press('Tab'); await page.keyboard.insertText('added'); await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ rows: [...moye.editor.vditor.ir.element.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent.replace(/\u200b/g, '').trim())), content: moye.getState().content }));
      assert.deepEqual(result.rows, [['one', 'two'], ['added', '']]); return result;
    });
    await probe('invalid Mermaid source remains editable and recovers after correction', async () => {
      const invalid = '```mermaid\nflowchart TD\nA --> [broken\n```\n\nafter\n';
      await open(invalid);
      await page.waitForFunction(() => document.querySelector('.language-mermaid[data-processed="true"]'));
      await page.evaluate(() => moye.setMode('sv'));
      const preserved = await page.locator('.vditor-sv').inputValue(); assert.equal(preserved, invalid);
      const valid = '```mermaid\nflowchart TD\nA[Start] --> B[Finish]\n```\n\nafter\n';
      await page.locator('.vditor-sv').fill(valid); await page.evaluate(() => moye.setMode('ir'));
      await page.waitForFunction(() => document.querySelector('.language-mermaid[data-processed="true"] svg'));
      const result = await page.evaluate(() => {
        const diagram = moye.editor.vditor.ir.element.querySelector('.language-mermaid[data-processed="true"] svg').cloneNode(true);
        diagram.querySelectorAll('style').forEach(node => node.remove());
        return { content: moye.getState().content, graph: diagram.textContent };
      });
      assert.equal(result.content, valid); assert.match(result.graph, /Start/); assert.match(result.graph, /Finish/); return result;
    });
    await probe('invalid formula source survives error and recovers after correction', async () => {
      const invalid = '$$\n\\frac{1}{\n$$\n\nafter\n';
      await open(invalid); await page.waitForFunction(() => document.querySelector('.vditor-reset--error'));
      await page.evaluate(() => moye.setMode('sv'));
      assert.equal(await page.locator('.vditor-sv').inputValue(), invalid);
      const valid = '$$\n\\frac{1}{2}\n$$\n\nafter\n';
      await page.locator('.vditor-sv').fill(valid); await page.evaluate(() => moye.setMode('ir'));
      await page.waitForFunction(() => document.querySelector('.katex,mjx-container'));
      const result = await page.evaluate(() => ({ content: moye.getState().content,
        errors: moye.editor.vditor.ir.element.querySelectorAll('.vditor-reset--error').length }));
      assert.equal(result.content, valid); assert.equal(result.errors, 0); return result;
    });
    await probe('quote start Backspace removes quote structure without losing text', async () => {
      await open('> quoted\n\nplain\n'); await caret('blockquote p', 'start'); await page.keyboard.press('Backspace');
      await page.waitForTimeout(450);
      const result = await page.evaluate(() => ({ content: moye.getState().content, quotes: moye.editor.vditor.ir.element.querySelectorAll('blockquote').length }));
      assert.match(result.content, /quoted/); assert.match(result.content, /plain/); assert.equal(result.quotes, 0); return result;
    });
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {});
  }
  const report = { platform: `${process.platform}/${process.arch}`, engine: 'Electron 45', network: 'all HTTP(S) requests blocked', requests, results, pageErrors };
  if (process.env.MOYE_EXTRAS_OUTPUT) await fs.writeFile(path.resolve(process.env.MOYE_EXTRAS_OUTPUT), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (results.some(result => result.status === 'fail') || pageErrors.length || requests.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
