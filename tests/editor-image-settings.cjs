'use strict';

// Real application bridge, filesystem and editor checks; this is Moye regression
// evidence, not a comparison against an independently running Typora instance.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fileURLToPath, pathToFileURL } = require('node:url');

async function main() {
  const root = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-image-settings-'));
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Moye real-application image preferences regression; not Typora differential acceptance', results: [], pageErrors: [], remoteRequests: [] };
  let app, page, number = 0;
  const defaults = { 'images.insertAction': 'copy', 'images.assetFolder': '${filename}.assets', 'images.pathStyle': 'auto', 'images.relativePrefix': true, 'images.escapePath': true, 'images.applyToLocal': true };
  const bytes = await fs.readFile(path.join(root, 'samples/assets/书写 测试.svg'));
  const original = path.join(work, '原图 空格 (1)#%20.svg'); await fs.writeFile(original, bytes);
  const probe = async (name, operation) => {
    const started = Date.now();
    try { const details = await operation(); report.results.push({ name, status: 'pass', elapsedMs: Date.now() - started, details }); }
    catch (error) { report.results.push({ name, status: 'fail', elapsedMs: Date.now() - started, error: error.stack || error.message }); }
  };
  try {
    app = await electron.launch({
      executablePath: process.env.MOYE_IMAGE_SETTINGS_EXECUTABLE || require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_IMAGE_SETTINGS_EXECUTABLE ? [] : [root])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
    });
    await app.evaluate(({ app, session }) => {
      app.moyeImageSettingsRequests = [];
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/^https?:/.test(details.url)) app.moyeImageSettingsRequests.push(details.url);
        callback({ cancel: /^https?:/.test(details.url) });
      });
    });
    page = await app.firstWindow();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready && window.moye.settings, null, { timeout: 30000 });
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }));
    async function apply(patch = {}) { return page.evaluate(async patch => { await moye.settings.apply(patch); return moye.settings.getValues(); }, { ...defaults, ...patch }); }
    async function open() {
      const filename = path.join(work, `图片 文档 ${++number}.md`); await fs.writeFile(filename, '# 图片\n\n');
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); dialog.showMessageBox = async () => ({ response: 1 }); }, filename);
      await page.evaluate(async () => { await moye.performAction('open'); moye.setMode('ir'); });
      return filename;
    }
    async function choose(filename = original) {
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename);
      const images = await page.evaluate(() => desktop.chooseImages()); assert.equal(images.length, 1); return images[0];
    }
    async function render(image) {
      await page.evaluate(image => {
        const editor = moye.editor, root = editor.vditor.ir.element;
        root.focus(); const range = document.createRange(); range.selectNodeContents(root); range.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(range); editor.insertMD(`\n${image.markdown}\n`);
      }, image);
      const expected = decodeURIComponent(pathToFileURL(image.path).href);
      await page.waitForFunction(expected => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 640 && decodeURIComponent(image.src) === expected), expected, { timeout: 10000 });
      return page.evaluate(expected => ({ markdown: moye.editor.getValue(), image: [...moye.editor.vditor.ir.element.querySelectorAll('img')].filter(image => image.naturalWidth === 640 && decodeURIComponent(image.src) === expected).map(image => ({ src: image.src, width: image.naturalWidth }))[0] }), expected);
    }

    await probe('default copy keeps document asset folder, escaped relative syntax and real image preview', async () => {
      await apply(); const doc = await open(), image = await choose();
      assert.equal(path.dirname(image.path), path.join(work, `${path.basename(doc, '.md')}.assets`));
      assert.match(image.markdown, /\(\.\//); assert.match(image.markdown, /%20/); assert.match(image.markdown, /%28/); assert.match(image.markdown, /%23%2520/);
      assert.deepEqual(await fs.readFile(image.path), bytes);
      return { markdown: image.markdown, rendered: await render(image) };
    });
    await probe('nested filename folder template produces actual assets and survives Save As and reopening', async () => {
      await apply({ 'images.assetFolder': '图片/${filename}.assets' }); const doc = await open(), image = await choose();
      const relative = path.join('图片', `${path.basename(doc, '.md')}.assets`, path.basename(original));
      assert.equal(image.path, path.join(work, relative)); await render(image);
      const destination = path.join(work, '另存 目录'); await fs.mkdir(destination); const filename = path.join(destination, '另存.md');
      await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
      await page.evaluate(() => moye.performAction('save-as'));
      assert.deepEqual(await fs.readFile(path.join(destination, relative)), bytes);
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename);
      await page.evaluate(() => moye.performAction('open'));
      await page.waitForFunction(() => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 640));
      return { folder: relative, migrated: true, reopenedPreview: true };
    });
    await probe('reference action honors explicit relative syntax and relative prefix changes', async () => {
      await apply({ 'images.insertAction': 'reference', 'images.pathStyle': 'relative', 'images.relativePrefix': false }); await open();
      const image = await choose(); assert.equal(image.path, original); assert.doesNotMatch(image.markdown, /file:\/\/|\(\.\//); assert.match(image.markdown, /%20/);
      await render(image);
      await page.evaluate(() => moye.settings.apply({ 'images.relativePrefix': true }));
      const prefixed = await choose(); assert.match(prefixed.markdown, /\(\.\//);
      return { withoutPrefix: image.markdown, withPrefix: prefixed.markdown };
    });
    await probe('absolute syntax for copies creates a separate file and a round-trippable file URI', async () => {
      await apply({ 'images.pathStyle': 'absolute' }); await open(); const image = await choose();
      assert.notEqual(image.path, original); const uri = /\]\((.*)\)$/.exec(image.markdown)[1]; assert.equal(fileURLToPath(uri), image.path);
      assert.deepEqual(await fs.readFile(image.path), bytes); return { markdown: image.markdown, rendered: await render(image) };
    });
    await probe('disabled optional escaping keeps readable Unicode and spaces with valid image rendering', async () => {
      await apply({ 'images.assetFolder': '图片', 'images.escapePath': false, 'images.relativePrefix': false }); await open(); const image = await choose();
      assert.match(image.markdown, /\(<图片\/原图 空格 \(1\)%23%2520\.svg>\)$/);
      return { markdown: image.markdown, rendered: await render(image) };
    });
    await probe('local source scope bypasses file copy while bitmap bytes are materialized using selected folder', async () => {
      await apply({ 'images.applyToLocal': false, 'images.assetFolder': '剪贴板/${filename}' }); const doc = await open();
      const referenced = await choose(); assert.equal(referenced.path, original); assert.match(referenced.markdown, /file:\/\//); await render(referenced);
      await page.evaluate(() => moye.settings.apply({ 'images.insertAction': 'reference' }));
      const bitmap = await page.evaluate(bytes => desktop.importImage({ name: '粘贴.svg', bytes }), [...bytes]);
      assert.equal(path.dirname(bitmap.path), path.join(work, '剪贴板', path.basename(doc, '.md')));
      assert.deepEqual(await fs.readFile(bitmap.path), bytes);
      return { localReferenced: true, bitmapCopied: true, markdown: bitmap.markdown, rendered: await render(bitmap) };
    });
    await probe('invalid copy folder preferences fail validation without replacing existing setting', async () => {
      await apply({ 'images.assetFolder': '安全目录' });
      const rejected = [];
      for (const folder of ['../outside', '/tmp/outside', 'C:\\outside', 'safe/../../outside', '${unknown}']) {
        const result = await page.evaluate(async folder => { try { await moye.settings.apply({ 'images.assetFolder': folder }); return false; } catch { return true; } }, folder);
        assert.equal(result, true, folder); rejected.push(folder);
      }
      assert.equal(await page.evaluate(() => moye.settings.getValues()['images.assetFolder']), '安全目录');
      return { rejected, preservedValue: '安全目录' };
    });
    await probe('readable paths survive settings reload, Save As, reopening and source/live mode round trips', async () => {
      await apply({ 'images.assetFolder': '可读 图片/${filename}', 'images.escapePath': false, 'images.relativePrefix': false }); const doc = await open(), image = await choose();
      await render(image);
      const specialSource = path.join(work, '未闭合 (和 `code`.svg'); await fs.writeFile(specialSource, bytes);
      const special = await choose(specialSource); assert.match(special.markdown, /%28和 %60code%60/); await render(special);
      await page.evaluate(async () => { await moye.settings.apply({ 'markdown.mark': !moye.settings.getValues()['markdown.mark'] }); await moye.settings.reload(); });
      const destination = path.join(work, '可读路径另存'); await fs.mkdir(destination); const filename = path.join(destination, 'saved.md');
      await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename);
      await page.evaluate(() => moye.performAction('save-as'));
      const migrated = path.join(destination, '可读 图片', path.basename(doc, '.md'), path.basename(image.path));
      assert.deepEqual(await fs.readFile(migrated), bytes);
      const migratedSpecial = path.join(path.dirname(migrated), path.basename(special.path)); assert.deepEqual(await fs.readFile(migratedSpecial), bytes);
      await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename);
      await page.evaluate(() => moye.performAction('open'));
      const expected = decodeURIComponent(pathToFileURL(migrated).href);
      const expectedSpecial = decodeURIComponent(pathToFileURL(migratedSpecial).href);
      const allImages = [expected, expectedSpecial];
      await page.waitForFunction(expected => expected.every(source => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 640 && decodeURIComponent(image.src) === source)), allImages);
      const before = await page.evaluate(() => moye.getState().content);
      for (const mode of ['sv', 'ir', 'sv', 'ir']) await page.evaluate(mode => moye.setMode(mode), mode);
      await page.waitForFunction(expected => expected.every(source => [...moye.editor.vditor.ir.element.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 640 && decodeURIComponent(image.src) === source)), allImages);
      const after = await page.evaluate(() => moye.getState().content);
      assert.equal(after, before); assert.equal(after, await fs.readFile(filename, 'utf8'));
      return { migratedReadablePath: true, reopenedPreview: true, sourceLiveRoundTrips: 2, sourceUnchanged: true, unmatchedParenthesisAndCodeDelimiter: true };
    });
    report.remoteRequests = await app.evaluate(({ app }) => app.moyeImageSettingsRequests);
    report.pass = report.results.every(item => item.status === 'pass') && report.pageErrors.length === 0 && report.remoteRequests.length === 0;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; }
  finally {
    if (app) { const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.writeFile(path.resolve(process.env.MOYE_IMAGE_SETTINGS_OUTPUT || path.join(root, 'tests/image-settings-report.json')), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
