'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-table-tools-'));
  const app = await electron.launch({ executablePath: require('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.resolve(__dirname, '../electron/main.cjs')],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
  const page = await app.firstWindow(), results = [], pageErrors = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => window.moye?.ready);
  if (!await page.evaluate(() => !!window.MoyeTableTools)) await page.addScriptTag({ url: pathToFileURL(path.resolve(__dirname, '../src/table-tools.js')).href });
  if (!await page.locator('.moye-table-tools').count()) await page.evaluate(() => {
    const editor = moye.editor;
    window.testTableTools = MoyeTableTools.install(editor, { sync: () => editor.vditor.options.input(editor.getValue()), input: value => editor.vditor.options.input(value) });
  });
  await page.addStyleTag({ url: pathToFileURL(path.resolve(__dirname, '../src/table-tools.css')).href });
  const sample = '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 甲 | 乙 | 丙 |\n| 丁 | 戊 | 己 |\n\n尾部正文\n';
  const original = [['左', '中', '右'], ['甲', '乙', '丙'], ['丁', '戊', '己']];
  let index = 0;
  async function open(content = sample) {
    const destination = path.join(work, `table-${++index}.md`); await fs.writeFile(destination, content);
    await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); dialog.showMessageBox = async () => ({ response: 1 }); }, destination);
    await page.evaluate(async () => { await moye.performAction('open'); moye.setMode('ir'); });
    await page.waitForTimeout(400); return destination;
  }
  async function select(row, column) {
    await page.evaluate(({ row, column }) => {
      const cell = moye.editor.vditor.ir.element.querySelector('table').rows[row].cells[column];
      const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
      moye.editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }, { row, column });
    await page.locator('.moye-table-tools').waitFor({ state: 'visible' });
  }
  async function click(command) { await page.locator(`.moye-table-tools button[data-command="${command}"]`).click(); }
  async function matrix() { return page.evaluate(() => [...moye.editor.vditor.ir.element.querySelector('table').rows].map(row => [...row.cells].map(cell => cell.textContent.replace(/\u200b/g, '').trim()))); }
  async function undo() { await page.evaluate(() => moye.performAction('undo')); }
  async function probe(name, callback) {
    const start = Date.now();
    try { const details = await callback(); results.push({ name, status: 'pass', elapsedMs: Date.now() - start, details }); }
    catch (error) { results.push({ name, status: 'fail', elapsedMs: Date.now() - start, error: error.message }); }
  }
  try {
    await probe('toolbar follows the selected table cell and protects the header', async () => {
      await open(); await select(0, 0);
      assert.equal(await page.locator('[data-command="row-before"]').isDisabled(), true);
      assert.equal(await page.locator('[data-command="row-delete"]').isDisabled(), true);
      await page.evaluate(() => {
        const p = moye.editor.vditor.ir.element.querySelector('p');
        const range = document.createRange(); range.selectNodeContents(p); range.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new Event('selectionchange'));
      });
      assert.equal(await page.locator('.moye-table-tools').isVisible(), false);
      await select(1, 0); await page.evaluate(() => moye.setMode('sv'));
      await page.waitForTimeout(100); assert.equal(await page.locator('.moye-table-tools').isVisible(), false);
      return { headerProtected: true, sourceHidden: true };
    });
    await probe('add rows above and below preserves all existing cells and undoes', async () => {
      await open(); await select(1, 1); await click('row-after');
      assert.deepEqual(await matrix(), [original[0], original[1], ['', '', ''], original[2]]);
      await undo(); assert.deepEqual(await matrix(), original);
      await select(2, 0); await click('row-before');
      assert.deepEqual(await matrix(), [original[0], original[1], ['', '', ''], original[2]]);
      await undo(); assert.deepEqual(await matrix(), original); return { rowsRestored: true };
    });
    await probe('delete a data row preserves the header and undo restores Chinese text', async () => {
      await open(); await select(1, 0); await click('row-delete');
      assert.deepEqual(await matrix(), [original[0], original[2]]); await undo();
      assert.deepEqual(await matrix(), original); return { restored: await matrix() };
    });
    await probe('adding below the header creates a data row without changing the header', async () => {
      await open(); await select(0, 1); await click('row-after');
      assert.deepEqual(await matrix(), [original[0], ['', '', ''], original[1], original[2]]);
      await undo(); assert.deepEqual(await matrix(), original); return { headerPreserved: true };
    });
    await probe('deleting the last data row keeps a valid blank row and can be undone', async () => {
      await open('| 标题 |\n| --- |\n| 中文 |\n'); await select(1, 0); await click('row-delete');
      assert.deepEqual(await matrix(), [['标题'], ['']]); await undo();
      assert.deepEqual(await matrix(), [['标题'], ['中文']]); return { validTablePreserved: true };
    });
    await probe('add columns left and right preserves text and column alignment', async () => {
      await open(); await select(1, 1); await click('column-before');
      assert.deepEqual(await matrix(), [['左', '', '中', '右'], ['甲', '', '乙', '丙'], ['丁', '', '戊', '己']]);
      const alignment = await page.evaluate(() => [...moye.editor.vditor.ir.element.querySelectorAll('th')].map(cell => cell.getAttribute('align')));
      assert.deepEqual(alignment, ['left', 'center', 'center', 'right']);
      await undo(); assert.deepEqual(await matrix(), original);
      await select(1, 1); await click('column-after');
      assert.deepEqual(await matrix(), [['左', '中', '', '右'], ['甲', '乙', '', '丙'], ['丁', '戊', '', '己']]);
      await undo(); assert.deepEqual(await matrix(), original); return { alignment };
    });
    await probe('delete a column removes its cells consistently and supports undo', async () => {
      await open(); await select(2, 1); await click('column-delete');
      assert.deepEqual(await matrix(), [['左', '右'], ['甲', '丙'], ['丁', '己']]);
      await undo(); assert.deepEqual(await matrix(), original); return { restored: true };
    });
    await probe('left center right alignment affects the full column and persists on save', async () => {
      const destination = await open();
      for (const alignment of ['left', 'center', 'right']) {
        await select(1, 1); await click(`align-${alignment}`);
        const column = await page.evaluate(() => [...moye.editor.vditor.ir.element.querySelector('table').rows].map(row => row.cells[1].getAttribute('align')));
        assert.deepEqual(column, [alignment, alignment, alignment]);
      }
      await page.evaluate(() => moye.performAction('save'));
      const content = await fs.readFile(destination, 'utf8');
      const separator = content.split('\n')[1].split('|').slice(1, -1).map(value => value.trim());
      assert.match(separator[1], /^-+:$/); assert.ok(!separator[1].startsWith(':'));
      assert.deepEqual(await matrix(), original); return { content };
    });
    await probe('delete the entire table preserves surrounding text and is undoable', async () => {
      await open(); await select(1, 0); await click('table-delete');
      assert.equal(await page.locator('.vditor-ir table').count(), 0);
      assert.match(await page.evaluate(() => moye.getState().content), /尾部正文/);
      await undo(); assert.deepEqual(await matrix(), original); return { restored: true };
    });
    await probe('delete the last column removes the table and can be undone', async () => {
      await open('| 标题 |\n| --- |\n| 中文 |\n\n尾部正文\n'); await select(1, 0); await click('column-delete');
      assert.equal(await page.locator('.vditor-ir table').count(), 0); await undo();
      assert.deepEqual(await matrix(), [['标题'], ['中文']]); return { restored: true };
    });
    await probe('new cells accept Chinese and saved Markdown contains no editor artifacts', async () => {
      const destination = await open(); await select(1, 1); await click('column-after');
      await page.keyboard.insertText('新增中文'); await page.evaluate(() => moye.performAction('save'));
      const content = await fs.readFile(destination, 'utf8'); assert.match(content, /新增中文/); assert.match(content, /尾部正文/);
      assert.equal(content.includes('\u200b'), false); assert.equal(content.includes('data-block'), false); assert.equal(content.includes('<wbr>'), false);
      return { content };
    });
    await probe('toolbar wraps inside a narrow editor without horizontal overflow', async () => {
      await open(); await page.setViewportSize({ width: 480, height: 800 }); await select(1, 0);
      const layout = await page.evaluate(() => {
        const tools = document.querySelector('.moye-table-tools'), region = document.querySelector('.editor-region');
        const a = tools.getBoundingClientRect(), b = region.getBoundingClientRect();
        return { left: a.left, right: a.right, parentLeft: b.left, parentRight: b.right, height: a.height };
      });
      assert.ok(layout.left >= layout.parentLeft, JSON.stringify(layout)); assert.ok(layout.right <= layout.parentRight, JSON.stringify(layout)); assert.ok(layout.height > 38, JSON.stringify(layout)); return layout;
    });
  } finally { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  const report = { platform: `${process.platform}/${process.arch}`, engine: 'Electron 45', results, pageErrors };
  if (process.env.MOYE_TABLE_OUTPUT) await fs.writeFile(path.resolve(process.env.MOYE_TABLE_OUTPUT), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (results.some(result => result.status === 'fail') || pageErrors.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
