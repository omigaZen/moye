'use strict';

// Exercises the actual packaged binary and ASAR, not the development tree.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(root, 'release', `Moye-${process.platform}-${process.arch}`);
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(directory,
    process.platform === 'darwin' ? 'Moye.app/Contents/MacOS/Moye' : process.platform === 'win32' ? 'Moye.exe' : 'Moye');
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-packaged-smoke-'));
  const app = await electron.launch({
    executablePath,
    args: process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: userData },
    timeout: 30000,
  });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    const pageErrors = [], remoteRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.waitForFunction(() => window.moye?.ready, undefined, { timeout: 30000 });
    const initial = await page.evaluate(() => ({ title: document.title, mode: moye.editor.getCurrentMode(), text: moye.getState().content.slice(0, 80) }));
    await page.evaluate(() => moye.performAction('syntax'));
    await page.waitForFunction(() => document.querySelectorAll('.language-mermaid svg').length === 8, undefined, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('.katex,mjx-container').length >= 5, undefined, { timeout: 30000 });
    const render = await page.evaluate(async () => {
      const faces = await document.fonts.load('16px "Noto Sans SC"', '墨页中文输入测试');
      return {
        diagrams: document.querySelectorAll('.language-mermaid svg').length,
        formulas: document.querySelectorAll('.katex,mjx-container').length,
        font: document.fonts.check('16px "Noto Sans SC"', '墨页中文输入测试'),
        fontFaces: faces.length,
        diagramFonts: [...document.querySelectorAll('.language-mermaid svg')].map(svg => getComputedStyle(svg).fontFamily),
        images: [...document.querySelectorAll('.vditor-ir img')].map(image => ({ src: image.getAttribute('src'), complete: image.complete, width: image.naturalWidth })),
        errors: [...document.querySelectorAll('.vditor-reset--error')].map(node => node.textContent),
      };
    });
    const binary = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, path: app.getAppPath() }));
    const report = { initial, render, binary, errors: pageErrors, remote: remoteRequests };
    await fs.writeFile(path.join(root, 'tests', `packaged-${process.platform}-report.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert.equal(binary.packaged, true);
    assert.equal(initial.mode, 'ir');
    assert.equal(render.diagrams, 8);
    assert.equal(render.formulas, 5);
    assert.equal(render.font, true);
    assert.ok(render.fontFaces > 0);
    assert.ok(render.diagramFonts.every(font => font.includes('Noto Sans SC')));
    assert.ok(render.images.length >= 2);
    assert.ok(render.images.every(image => image.complete && image.width === 640));
    assert.deepEqual(render.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(remoteRequests, []);
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
