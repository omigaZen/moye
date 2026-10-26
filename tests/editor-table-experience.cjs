'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-table-experience-'));
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye table presentation and structured copying regression; public Telari behavior inspired, not native Telari differential evidence', results: [], pageErrors: [], remoteRequests: [] };
  let app, page, number = 0;
  const defaults = { 'table.layout': 'body', 'table.style': 'grid', 'table.alignment': 'start' };
  const sample = '# 表格\n\n| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 甲 |  | 丙 |\n| 丁 | 戊 | 己 |\n\n尾部正文\n';
  async function probe(name, operation) {
    const started = Date.now();
    try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  }
  try {
    app = await electron.launch({ executablePath: process.env.MOYE_TABLE_EXPERIENCE_EXECUTABLE || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_TABLE_EXPERIENCE_EXECUTABLE ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    await app.evaluate(({ app, session }) => { app.moyeTableExperienceRequests = []; session.defaultSession.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) app.moyeTableExperienceRequests.push(details.url); callback({ cancel: /^https?:/.test(details.url) }); }); });
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(error.message)); await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && moye.tablePresentation && MoyeTableTools.clipboardPayload, null, { timeout: 30000 });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }));
    if (process.env.MOYE_TABLE_EXPERIENCE_EXECUTABLE) assert.equal(report.application.isPackaged, true);
    async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    async function screenshot(name) { if(process.env.MOYE_TABLE_EXPERIENCE_SCREENSHOT_DIR){const directory=path.resolve(process.env.MOYE_TABLE_EXPERIENCE_SCREENSHOT_DIR);await fs.mkdir(directory,{recursive:true});await page.screenshot({path:path.join(directory,`table-${name}.png`)});} }
    async function apply(patch = {}) { await page.evaluate(async patch => { await moye.settings.apply(patch); moye.tablePresentation.refresh(); }, { ...defaults, ...patch }); await settle(); }
    async function open(content = sample) {
      const filename = path.join(work, `table-${++number}.md`); await fs.writeFile(filename, content);
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, filename);
      await page.evaluate(async () => { if (moye.reading?.isEnabled()) await moye.reading.setEnabled(false); await moye.performAction('open'); moye.setMode('ir'); moye.tablePresentation.refresh(); }); await settle(); return filename;
    }
    async function select(row = 1, column = 0, endRow = row, endColumn = column, backward = false) {
      await page.evaluate(({ row, column, endRow, endColumn, backward }) => {
        const root = moye.editor.vditor.ir.element, table = root.querySelector('table'); root.focus({ preventScroll: true });
        const start = table.rows[row].cells[column], end = table.rows[endRow].cells[endColumn];
        const range = document.createRange(); range.selectNodeContents(start); range.collapse(true);
        const stop = document.createRange(); stop.selectNodeContents(end); stop.collapse(false);
        const selection = getSelection(); selection.removeAllRanges();
        if (backward) selection.setBaseAndExtent(stop.endContainer, stop.endOffset, range.startContainer, range.startOffset);
        else selection.setBaseAndExtent(range.startContainer, range.startOffset, stop.endContainer, stop.endOffset);
        document.dispatchEvent(new Event('selectionchange'));
      }, { row, column, endRow, endColumn, backward }); await settle();
    }
    async function geometry() { return page.evaluate(() => { const root = moye.editor.vditor.ir.element, table = root.querySelector('table'), region = document.querySelector('.editor-region'), r = table.getBoundingClientRect(), p = region.getBoundingClientRect(), c = getComputedStyle(root); return { table: { left: r.left, right: r.right, width: r.width, height: r.height, scrollWidth: table.scrollWidth, clientWidth: table.clientWidth }, bodyWidth: root.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight), region: { left: p.left, right: p.right }, editorWidth: root.clientWidth, editorScrollWidth: root.scrollWidth, alignment: [...table.rows].map(row => [...row.cells].map(cell => cell.getAttribute('align'))) }; }); }
    await probe('natural tables shrink to content without altering source or clean state', async () => {
      await open(); const before = await page.evaluate(() => moye.getState()); await select(); await apply({ 'table.layout': 'natural' }); const g = await geometry();
      assert.ok(g.table.width < g.bodyWidth - 100, JSON.stringify(g));
      const after = await page.evaluate(() => moye.getState()); assert.equal(after.content, before.content); assert.equal(after.dirty, false); return g;
    });
    const wide = '# 宽表\n\n| ' + Array.from({ length: 12 }, (_, i) => `第${i + 1}列`).join(' | ') + ' |\n| ' + Array(12).fill('---').join(' | ') + ' |\n| ' + Array.from({ length: 12 }, (_, i) => `value_${i}`).join(' | ') + ' |\n\n尾部\n';
    await probe('window tables borrow body margins while staying inside the editor', async () => {
      await open(wide); await apply({ 'table.layout': 'window' }); const g = await geometry();
      assert.ok(g.table.width > g.bodyWidth + 20, JSON.stringify(g)); assert.ok(g.table.left >= g.region.left + 22, JSON.stringify(g)); assert.ok(g.table.right <= g.region.right - 22, JSON.stringify(g)); assert.ok(g.editorScrollWidth <= g.editorWidth + 1, JSON.stringify(g)); await screenshot('window');return g;
    });
    await probe('narrow tables scroll locally without a horizontally scrolling document', async () => {
      await page.setViewportSize({ width: 480, height: 800 }); await apply({ 'table.layout': 'window' }); const g = await geometry();
      assert.ok(g.table.scrollWidth > g.table.clientWidth + 20, JSON.stringify(g)); assert.ok(g.editorScrollWidth <= g.editorWidth + 1, JSON.stringify(g));
      const moved = await page.evaluate(() => { const table = moye.editor.vditor.ir.element.querySelector('table'); table.scrollLeft = 100; return table.scrollLeft; }); assert.ok(moved > 0);await screenshot('narrow');await page.setViewportSize({ width: 1440, height: 860 }); return { ...g, localScrollLeft: moved };
    });
    await probe('booktabs changes visible rules without moving cells or column alignment', async () => {
      await open(); await apply({ 'table.layout': 'natural' }); await select(1, 1); const before = await geometry(), original = await page.evaluate(() => moye.getState().content);
      await apply({ 'table.layout': 'natural', 'table.style': 'booktabs' }); const after = await geometry();
      assert.ok(Math.abs(before.table.height - after.table.height) <= 1, JSON.stringify({ before, after })); assert.ok(Math.abs(before.table.width - after.table.width) <= 1); assert.deepEqual(after.alignment, before.alignment); assert.equal(await page.evaluate(() => moye.getState().content), original);
      const borders = await page.evaluate(() => { const t=moye.editor.vditor.ir.element.querySelector('table');return { body:getComputedStyle(t.tBodies[0].rows[0].cells[0]).borderRightColor, header:getComputedStyle(t.tHead.rows[0].cells[0]).borderBottomColor }; }); assert.notEqual(borders.body, borders.header);await screenshot('booktabs');return { geometryStable: true, borders };
    });
    await probe('whole-table visual alignment does not rewrite per-column Markdown alignment', async () => {
      await open(); await apply({ 'table.layout': 'natural' }); const source = await page.evaluate(() => moye.getState().content), start = await geometry();
      await apply({ 'table.layout': 'natural', 'table.alignment': 'center' }); const center = await geometry(); await apply({ 'table.layout': 'natural', 'table.alignment': 'end' }); const end = await geometry();
      assert.ok(start.table.left < center.table.left && center.table.left < end.table.left, JSON.stringify({ start, center, end })); assert.deepEqual(start.alignment, end.alignment); assert.equal(await page.evaluate(() => moye.getState().content), source); return { start: start.table.left, center: center.table.left, end: end.table.left };
    });
    await probe('dedicated whole-table copy writes TSV and safe HTML through the native clipboard', async () => {
      await open(); await apply(); await select(); const before = await page.evaluate(() => moye.getState());
      assert.equal(await page.evaluate(() => moye.tableTools.action('table-copy')), true);
      const clipboard = await app.evaluate(async ({ clipboard }) => { const entries=await clipboard.read(),entry=entries.find(item=>item.types.includes('text/html'));return {text:await clipboard.readText(),html:entry?await(await entry.getType('text/html')).text():''}; });
      assert.equal(clipboard.text.replace(/\r\n/g, '\n'), '左\t中\t右\n甲\t\t丙\n丁\t戊\t己'); assert.match(clipboard.html, /<table>/); assert.match(clipboard.html, /<td[^>]*><\/td>/); assert.doesNotMatch(clipboard.html, /data-block|contenteditable|onclick|<wbr/);
      const after = await page.evaluate(() => moye.getState()); assert.equal(after.content, before.content); assert.equal(after.dirty, false); return { text: clipboard.text, structuredHtml: true, documentUnchanged: true };
    });
    await probe('reverse rectangle copy preserves its shape and empty cells independently of normal Markdown copy', async () => {
      await open(); await select(1, 1, 2, 2, true); await page.evaluate(() => moye.settings.apply({ 'editor.copyPlainTextAsMarkdown': true }));
      assert.equal(await page.evaluate(() => moye.tableTools.action('selection-copy')), true); const text = await app.evaluate(({ clipboard }) => clipboard.readText()); assert.equal(text.replace(/\r\n/g, '\n'), '\t丙\n戊\t己');
      assert.equal(await page.evaluate(() => getSelection().anchorNode === getSelection().getRangeAt(0).endContainer), true); return { text, backwardSelectionRetained: true };
    });
    await probe('cell serialization keeps spaces, line breaks and literal markup without executable HTML', async () => {
      const payload = await page.evaluate(() => { const t = document.createElement('table');t.innerHTML='<tbody><tr><td>  padded  </td><td></td><td>a<br>b</td><td>&lt;img onerror=x&gt;</td></tr></tbody>';return MoyeTableTools.clipboardPayload(t); });
      assert.equal(payload.text, '  padded  \t\t"a\nb"\t<img onerror=x>'); assert.match(payload.html, /&lt;img onerror=x&gt;/); assert.doesNotMatch(payload.html, /<img/); return payload;
    });
    await probe('copy failure leaves source, selection and dirty state unchanged', async () => {
      await open(); await select(); const result = await page.evaluate(async () => { const before = moye.getState(), selection = getSelection().toString(); /* Exercise an isolated toolbar with a failing clipboard adapter. */ const tools = MoyeTableTools.install(moye.editor, { writeClipboard: async () => { throw new Error('injected clipboard failure'); } }); const success = await tools.action('table-copy'); tools.destroy(); return { success, before, after: moye.getState(), selection, afterSelection: getSelection().toString() }; });
      assert.equal(result.success, false); assert.equal(result.after.content, result.before.content); assert.equal(result.after.dirty, result.before.dirty); assert.equal(result.afterSelection, result.selection); return { failureHandled: true, editorUnchanged: true };
    });
    await probe('composition guards table changes and structured copy until text is committed', async () => {
      await open(); await select(); const result = await page.evaluate(async () => { const root=moye.editor.vditor.ir.element,before=moye.getState().content;root.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));const edit=moye.tableTools.action('row-after'),copy=moye.tableTools.action('table-copy');root.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));return {edit,copy,unchanged:moye.getState().content===before}; }); assert.equal(result.edit,false);assert.equal(result.copy,false);assert.equal(result.unchanged,true); return result;
    });
    await probe('reading header hover offers copy actions while mutation commands stay unavailable', async () => {
      await open(); const before=await page.evaluate(()=>moye.getState().content);
      await page.evaluate(async()=>{await moye.reading.setEnabled(true);moye.tablePresentation.refresh();});await settle();
      await page.locator('.moye-reading-content thead').hover();
      await page.locator('.moye-table-tools').waitFor({state:'visible'});
      assert.equal(await page.locator('.moye-table-tools [data-command="row-after"]').isVisible(),false);
      assert.equal(await page.locator('.moye-table-tools [data-command="table-copy"]').isVisible(),true);
      await screenshot('reading-copy');
      assert.equal(await page.evaluate(()=>moye.tableTools.action('row-after')),false);
      assert.equal(await page.evaluate(()=>moye.tableTools.action('table-copy')),true);
      const text=await app.evaluate(({clipboard})=>clipboard.readText());assert.match(text,/甲\t\t丙/);
      assert.equal(await page.evaluate(()=>moye.getState().content),before);
      await page.evaluate(()=>moye.reading.setEnabled(false));return {copyOnly:true,sourceUnchanged:true};
    });
    await probe('readonly rectangular selection copies the selected cells after leaving the header', async () => {
      await open();await page.evaluate(()=>moye.reading.setEnabled(true));await settle();
      await page.evaluate(()=>{const t=moye.reading.getRoot().querySelector('table'),a=t.rows[1].cells[1],b=t.rows[2].cells[2];const r=document.createRange();r.selectNodeContents(a);r.collapse(true);const e=document.createRange();e.selectNodeContents(b);e.collapse(false);getSelection().setBaseAndExtent(e.endContainer,e.endOffset,r.startContainer,r.startOffset);document.dispatchEvent(new Event('selectionchange'));});
      assert.equal(await page.evaluate(()=>moye.tableTools.action('selection-copy')),true);
      const text=await app.evaluate(({clipboard})=>clipboard.readText());assert.equal(text.replace(/\r\n/g,'\n'),'\t丙\n戊\t己');
      await page.evaluate(()=>moye.reading.setEnabled(false));return {selectedCellsCopied:true,text};
    });
    await probe('the edit toolbar moves away from a cell at the bottom of the viewport', async () => {
      const long=sample.replace('| 丁 | 戊 | 己 |',Array.from({length:35},(_,i)=>`| row${i} | 乙 | 丙 |`).join('\n'));await open(long);await select(35,0);
      await page.evaluate(()=>{const t=moye.editor.vditor.ir.element.querySelector('table');t.rows[35].cells[0].scrollIntoView({block:'end'});moye.tableTools.refresh();});await settle();
      const g=await page.evaluate(()=>{const c=moye.tableTools.getCurrentCell().getBoundingClientRect(),t=moye.tableTools.element.getBoundingClientRect();return {cell:{top:c.top,bottom:c.bottom},toolbar:{top:t.top,bottom:t.bottom}};});
      assert.ok(g.toolbar.bottom<=g.cell.top||g.toolbar.top>=g.cell.bottom,JSON.stringify(g));return g;
    });
    await probe('presentation and copying preserve the prior real edit undo step', async () => {
      await open();await select(1,0);await page.keyboard.insertText('新内容');await page.waitForTimeout(420);
      await apply({'table.layout':'natural','table.style':'booktabs','table.alignment':'center'});
      await page.evaluate(()=>moye.tableTools.action('table-copy'));await page.evaluate(()=>moye.performAction('undo'));
      const text=await page.evaluate(()=>moye.editor.vditor.ir.element.querySelector('table').rows[1].cells[0].textContent.replace(/\u200b/g,''));
      assert.equal(text,'甲');return {realEditUndoRetained:true};
    });
    report.remoteRequests = await app.evaluate(({ app }) => app.moyeTableExperienceRequests);
    report.pass = report.results.every(item => item.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; }
  finally {
    if (app) { const child=app.process(),exited=child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await exited; }
    await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    await fs.writeFile(path.resolve(process.env.MOYE_TABLE_EXPERIENCE_OUTPUT || path.join(root,'tests/table-experience-report.json')),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1});
