'use strict';
// Actual one-shot Electron/native-package CLI, never an in-editor substitute.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { PNG } = require('playwright-core/lib/utilsBundle');
const { _electron: electron } = require('playwright');
async function main() {
  const project = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-preview-ui-'));
  const executable = process.env.MOYE_SYSTEM_PREVIEW_EXECUTABLE ? path.resolve(process.env.MOYE_SYSTEM_PREVIEW_EXECUTABLE) : require('electron');
  const packaged = !!process.env.MOYE_SYSTEM_PREVIEW_EXECUTABLE;
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, purpose: 'Actual system-thumbnail CLI and isolated Linux registration, not Finder activation or original-application differential acceptance', results: [], remoteRequests: [], pageErrors: [] };
  let count = 0;
  const server = http.createServer((_req, response) => { report.remoteRequests.push('loopback-image-request'); response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  async function command(args, { settings, expectedSuccess = true, dataHome } = {}) {
    const profile = path.join(work, `profile-${++count}`); await fs.mkdir(profile);
    if (settings) await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 1, values: settings }));
    const run = await new Promise((resolve, reject) => {
      const child = spawn(executable, [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packaged ? [] : [project]), ...args], { env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: profile, ...(dataHome ? { XDG_DATA_HOME: dataHome } : {}) }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('System preview CLI exceeded 35 seconds.')); }, 35000);
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, profile }); });
    });
    if (expectedSuccess) assert.equal(run.code, 0, run.stderr + run.stdout); else assert.notEqual(run.code, 0, 'Invalid request unexpectedly succeeded.');
    let payload = null;
    for (const line of run.stdout.split(/\r?\n/).reverse()) { try { const parsed = JSON.parse(line); if (parsed && typeof parsed === 'object') { payload = parsed; break; } } catch {} }
    return { ...run, payload };
  }
  function pngText(bytes) { const fields = {}; for (let i = 8; i < bytes.length;) { const n = bytes.readUInt32BE(i); if (bytes.toString('ascii', i + 4, i + 8) === 'tEXt') { const raw = bytes.toString('latin1', i + 8, i + 8 + n), split = raw.indexOf('\0'); fields[raw.slice(0, split)] = raw.slice(split + 1); } i += n + 12; } return fields; }
  async function probe(name, operation) { try { report.results.push({ name, status: 'pass', details: await operation() }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); } }
  const source = path.join(work, '中文 文件.md'), original = Buffer.from(`# 本地系统缩略图\n\n**粗体** 和 $x^2+\\alpha$。\n\n![网络图](${address}/image.png)\n<script>fetch('${address}/script')</script>\n\n| A | B |\n|---|---|\n|1|2|\n`);
  await fs.writeFile(source, original);
  try {
    await probe('actual one-shot thumbnail renders Markdown and math offline with valid cache metadata and unchanged source', async () => {
      const output = path.join(work, 'markdown.png'), run = await command(['--system-preview', '--input', pathToFileURL(source).href, '--output', output, '--size', '256']);
      const bytes = await fs.readFile(output), png = PNG.sync.read(bytes), text = pngText(bytes);
      assert.equal(png.height, 256); assert.ok(png.width > 180 && png.width <= 256); assert.ok(bytes.length > 1800);
      const paper = [...png.data.subarray(0, 3)]; let ink = 0; for (let i = 0; i < png.data.length; i += 4) if (paper.some((p, c) => Math.abs(p - png.data[i + c]) > 24)) ink++; assert.ok(ink > 300);
      assert.equal(text['Thumb::URI'], pathToFileURL(source).href); assert.equal(text['Thumb::MTime'], String(Math.floor((await fs.stat(source)).mtimeMs / 1000))); assert.equal(text['Thumb::Mimetype'], 'text/markdown'); assert.equal(digest(await fs.readFile(source)), digest(original)); assert.equal(report.remoteRequests.length, 0);
      assert.ok(run.payload?.readOnly); assert.deepEqual(run.payload.security, { javascript: false, nodeIntegration: false, sandbox: true, contextIsolation: true }); report.application = run.payload.application;
      return { width: png.width, height: png.height, sizeBytes: bytes.length, inkPixels: ink, cacheMetadata: true, sourceUnchanged: true, requests: report.remoteRequests.length, security: run.payload.security };
    });
    await probe('UTF16 TXT is previewed read-only and original BOM and CRLF bytes survive exactly', async () => {
      const input = path.join(work, '原文.txt'), bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一章\r\n<h1>字面标签</h1>\r\n😀 纯文本\r\n', 'utf16le')]), output = path.join(work, 'plain.png'); await fs.writeFile(input, bytes);
      await command(['--system-preview', '--input', input, '--output', output, '--size', '512']); const image = PNG.sync.read(await fs.readFile(output)); assert.equal(image.height, 512); assert.equal(pngText(await fs.readFile(output))['Thumb::Mimetype'], 'text/plain'); assert.deepEqual(await fs.readFile(input), bytes);
      return { height: image.height, exactBytes: true, bom: true };
    });
    await probe('system preview follows saved local palette and does not rewrite its settings file', async () => {
      const output = path.join(work, 'theme.png'), values = { 'appearance.theme': 'light', 'typography.colorTheme': 'nord', 'appearance.fontSize': 24 };
      const run = await command(['--system-preview', '--input', source, '--output', output, '--size', '256'], { settings: values });
      const image = PNG.sync.read(await fs.readFile(output)); assert.deepEqual([...image.data.subarray(0, 3)], [236, 239, 244]); const settings = JSON.parse(await fs.readFile(path.join(run.profile, 'settings.json'), 'utf8')); assert.deepEqual(settings, { schemaVersion: 1, values });
      return { palettePixel: [...image.data.subarray(0, 3)], settingsPreserved: true };
    });
    await probe('large Unicode source is explicitly excerpted while the original remains complete', async () => {
      const input = path.join(work, 'large.txt'), output = path.join(work, 'large.png'), text = '😀中文\n'.repeat(20000); await fs.writeFile(input, text);
      const run = await command(['--system-preview', '--input', input, '--output', output, '--size', '128']); assert.equal(run.payload?.truncated, true); assert.equal(await fs.readFile(input, 'utf8'), text); assert.equal(PNG.sync.read(await fs.readFile(output)).height, 128);
      return { truncated: true, sourceCodePoints: [...text].length, sourceUnchanged: true };
    });
    await probe('remote and over-budget files are rejected without creating a thumbnail or modifying input', async () => {
      const output = path.join(work, 'invalid.png'); await command(['--system-preview', '--input', `${address}/remote.md`, '--output', output, '--size', '256'], { expectedSuccess: false }); await assert.rejects(fs.stat(output));
      const input = path.join(work, 'too-large.md'); await fs.writeFile(input, Buffer.alloc(8 * 1024 * 1024 + 1, 65)); await command(['--system-preview', '--input', input, '--output', output, '--size', '256'], { expectedSuccess: false }); await assert.rejects(fs.stat(output)); assert.equal((await fs.stat(input)).size, 8 * 1024 * 1024 + 1);
      return { remoteRejected: true, byteBudgetRejected: true, noOutput: true };
    });
    if (packaged && process.platform === 'linux') await probe('packaged CLI installs and removes only its isolated XDG thumbnailer registration', async () => {
      const dataHome = path.join(work, 'xdg'); await command(['--register-system-preview'], { dataHome }); const filename = path.join(dataHome, 'thumbnailers/moye.thumbnailer'), text = await fs.readFile(filename, 'utf8'); assert.match(text, /--system-preview --input %u --output %o --size %s/); assert.ok(text.includes(executable));
      await fs.writeFile(path.join(dataHome, 'thumbnailers/other.thumbnailer'), 'keep'); await command(['--unregister-system-preview'], { dataHome }); await assert.rejects(fs.stat(filename)); assert.equal(await fs.readFile(path.join(dataHome, 'thumbnailers/other.thumbnailer'), 'utf8'), 'keep');
      const application = await electron.launch({ executablePath: executable, args: ['--no-sandbox', '--ozone-platform=headless'], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'ui-profile'), XDG_DATA_HOME: dataHome } });
      try {
        const page = await application.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 }); await page.waitForFunction(() => window.moye?.ready);
        page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('request', request => { if (/^https?:/.test(request.url())) report.remoteRequests.push(request.url()); });
        const before = await page.evaluate(() => moye.getState());
        await application.evaluate(({ dialog }) => { global.__previewResponses = [0, 1]; global.__previewPrompts = []; dialog.showMessageBox = async (_window, options) => { global.__previewPrompts.push(options); return { response: global.__previewResponses.shift() }; }; });
        await page.locator('#more-button').click(); await page.locator('#more-menu [data-action="system-preview"]').click();
        for (let i = 0; i < 100; i++) { if (await fs.stat(filename).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.equal(await fs.readFile(filename, 'utf8'), text);
        await page.evaluate(() => moye.performAction('system-preview')); await assert.rejects(fs.stat(filename));
        assert.deepEqual(await page.evaluate(() => moye.getState()), before); assert.equal(await fs.readFile(path.join(dataHome, 'thumbnailers/other.thumbnailer'), 'utf8'), 'keep');
        const prompts = await application.evaluate(() => global.__previewPrompts); assert.equal(prompts.length, 2); assert.deepEqual(prompts[0].buttons, ['启用', '移除', '取消']);
      } finally {
        const child = application.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await application.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
      }
      return { isolatedRegistration: true, removedOnlyOwnedFile: true, actualMoreMenuAndNativeConfirmation: true, documentUnchanged: true };
    });
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(work, { recursive: true, force: true, maxRetries: 5 }); }
  report.pass = report.results.every(result => result.status === 'pass') && !report.remoteRequests.length && !report.pageErrors.length;
  const output = process.env.MOYE_SYSTEM_PREVIEW_OUTPUT || path.join(project, 'tests/system-preview-report.json'); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
