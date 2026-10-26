'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright');

async function main() {
  const project = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-package-viewport-'));
  const binary = process.argv[2] ? path.resolve(process.argv[2]) : path.join(project, 'release', `Moye-${process.platform}-${process.arch}`,
    process.platform === 'darwin' ? 'Moye.app/Contents/MacOS/Moye' : process.platform === 'win32' ? 'Moye.exe' : 'Moye');
  const app = await electron.launch({ executablePath: binary,
    args: process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
  const results = [], errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.moye?.ready);
    await page.setViewportSize({ width: 1280, height: 860 });
    const source = '# 发布包光标验收\n\n' + '长段落换行检查，中文与 English 混排。'.repeat(28) +
      '\n\n| 配置 | 内容 |\n| --- | --- |\n| 定位目标 | 表格内容 |\n\n' +
      Array.from({ length: 100 }, (_, index) => `第${String(index).padStart(3, '0')}段：这是用于检查源码光标视口的正文。\n\n`).join('');
    const documentPath = path.join(work, '表格与源码视口.md');
    await fs.writeFile(documentPath, source);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, documentPath);
    await page.evaluate(() => moye.performAction('open'));
    await page.evaluate(() => {
      const root = moye.editor.vditor.ir.element, cell = root.querySelector('tbody td');
      root.focus(); cell.scrollIntoView({ block: 'center' });
      const range = document.createRange(); range.selectNodeContents(cell); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      moye.setMode('sv');
    });
    async function metrics() {
      return page.evaluate(() => {
        const field = moye.editor.vditor.sv.element, style = getComputedStyle(field);
        const mirror = document.createElement('div');
        for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth', 'borderStyle', 'boxSizing', 'wordBreak', 'overflowWrap']) mirror.style[property] = style[property];
        Object.assign(mirror.style, { position: 'absolute', left: '-20000px', top: '0', width: `${field.offsetWidth}px`, height: 'auto', whiteSpace: field.wrap === 'off' ? 'pre' : 'pre-wrap', visibility: 'hidden', overflow: 'visible' });
        mirror.textContent = field.value.slice(0, field.selectionStart);
        const caret = document.createElement('span'); caret.textContent = '|'; mirror.append(caret); document.body.append(mirror);
        const caretTop = caret.getBoundingClientRect().top - mirror.getBoundingClientRect().top - parseFloat(style.borderTopWidth || 0);
        const result = { selectionStart: field.selectionStart, selectionEnd: field.selectionEnd, selected: field.value.slice(field.selectionStart, field.selectionEnd),
          caretTop, scrollTop: field.scrollTop, visibleCaretTop: caretTop - field.scrollTop, viewportHeight: field.clientHeight,
          lineHeight: parseFloat(style.lineHeight), fontSize: style.fontSize, fontFamily: style.fontFamily, wrap: field.wrap };
        mirror.remove(); return result;
      });
    }
    const mode = await metrics();
    assert.equal(mode.selectionStart, source.indexOf('定位目标') + '定位目标'.length);
    assert.equal(mode.fontSize, '14px');
    assert.match(mode.fontFamily, /monospace/i);
    assert.ok(mode.visibleCaretTop >= 0 && mode.visibleCaretTop + mode.lineHeight <= mode.viewportHeight, JSON.stringify(mode));
    results.push({ name: 'table caret -> source is visible with wrapped Chinese prefix', status: 'pass', details: mode });
    await page.evaluate(() => { const field = moye.editor.vditor.sv.element; field.scrollTop = field.scrollHeight; return moye.performAction('find'); });
    await page.locator('#find-input').fill('第005段');
    await page.locator('#find-next').click();
    const find = await metrics();
    assert.equal(find.selected, '第005段');
    assert.ok(find.visibleCaretTop >= 0 && find.visibleCaretTop + find.lineHeight <= find.viewportHeight, JSON.stringify(find));
    results.push({ name: 'source find scrolls offscreen match into the visible textarea', status: 'pass', details: find });
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    const report = { binary, platform: process.platform, results, pageErrors: errors };
    await fs.writeFile(path.join(project, 'tests', 'packaged-viewport-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
