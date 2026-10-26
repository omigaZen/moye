'use strict';
// One-shot, read-only thumbnail service. It is deliberately separate from the
// normal editor, its IPC bridge, file history and crash-recovery session.
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { decodeText, bomInfo } = require('./text-codec.cjs');
const { DocumentStore } = require('./file-store.cjs');
const { resourceAllowed } = require('./export-service.cjs');
const colorThemes = require('../src/color-theme-config.js');
const markdownConfig = require('../src/markdown-config.js');
const { ThemeStore } = require('./theme-store.cjs');
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_RENDER_CODEPOINTS = 65536;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 15000;
const extensions = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0')) throw new TypeError('Invalid preview input.');
  let result = value;
  if (!path.isAbsolute(value) && /^[a-z][a-z\d+.-]*:/i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash || url.hostname && url.hostname !== 'localhost') throw new TypeError('System previews accept local files only.');
    result = fileURLToPath(url);
  }
  if (!path.isAbsolute(result) || !extensions.has(path.extname(result).toLowerCase())) throw new TypeError('Preview input must be an absolute Markdown or TXT filename.');
  return path.resolve(result);
}
function parsePreviewArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('Invalid command line.');
  const index = argv.indexOf('--system-preview');
  if (index < 0) return null;
  const values = new Map(), args = argv.slice(index + 1);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--output', '--size'].includes(args[i]) || values.has(args[i]) || typeof args[i + 1] !== 'string' || args[i + 1].startsWith('--')) throw new TypeError('Invalid system-preview option.');
    values.set(args[i], args[i + 1]);
  }
  const input = sourcePath(values.get('--input'));
  const output = values.get('--output'), sizeText = values.get('--size') || '256';
  if (typeof output !== 'string' || output.includes('\0') || !path.isAbsolute(output) || !/\.png$/i.test(output) || output.length > 16384) throw new TypeError('Preview output must be an absolute PNG filename.');
  if (!/^\d+$/.test(sizeText) || Number(sizeText) < 64 || Number(sizeText) > 1024) throw new TypeError('Preview size must be 64–1024 pixels.');
  if (path.resolve(output) === input) throw new TypeError('Preview output cannot replace its source.');
  return Object.freeze({ input, output: path.resolve(output), size: Number(sizeText) });
}
async function readPreviewSource(request, { encodingMemoryPath } = {}) {
  const input = sourcePath(request.input), canonical = await fs.realpath(input);
  const before = await fs.lstat(canonical);
  if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new Error('System preview requires a regular text file no larger than 8 MiB.');
  const handle = await fs.open(canonical, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0) | (nativeFs.constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES || info.ino !== before.ino || info.dev !== before.dev) throw new Error('System preview requires an unchanged regular text file no larger than 8 MiB.');
    // Reading one bounded descriptor prevents a renamed path or a growing file
    // from turning this operation into an unbounded read.
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_SOURCE_BYTES + 1));
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length > MAX_SOURCE_BYTES || length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('The source changed while its preview was being read.');
    let remembered = null;
    if (encodingMemoryPath && !bomInfo(bytes.subarray(0, length))) {
      const memory = new DocumentStore({ encodingMemoryPath });
      await memory.loadEncodingMemory();
      remembered = memory.encodingMemoryEntries.get(await memory.encodingMemoryKey(canonical))?.encoding || null;
    }
    const decoded = decodeText(bytes.subarray(0, length), { encoding: remembered || 'auto' });
    let text = decoded.text, count = 0;
    for (const c of text) { if (++count > MAX_RENDER_CODEPOINTS) break; }
    // Avoid Array.from for multi-megabyte input; find the UTF-16 boundary once.
    if (count > MAX_RENDER_CODEPOINTS) { let units = 0, n = 0; for (const c of text) { if (++n > MAX_RENDER_CODEPOINTS) break; units += c.length; } text = text.slice(0, units); }
    return { input, canonical, text, truncated: count > MAX_RENDER_CODEPOINTS, sizeBytes: info.size, modifiedSeconds: Math.floor(info.mtimeMs / 1000), encoding: decoded.encoding, encodingGuessed: decoded.encodingGuessed, encodingRemembered: !!remembered, title: path.basename(input), plain: path.extname(input).toLowerCase() === '.txt' };
  } finally { await handle.close(); }
}
function decodeEntities(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#\d+|#x[a-f\d]+);/gi, token => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const number = token[2]?.toLowerCase() === 'x' ? parseInt(token.slice(3, -1), 16) : Number(token.slice(2, -1));
    return number >= 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : token;
  });
}
function renderMarkdown(text, preferences = {}) {
  if (!global.Lute) require('../src/vendor/vditor/dist/js/lute/lute.min.js');
  const lute = global.Lute.New();
  markdownConfig.apply(lute, {}, preferences);
  lute.SetSanitize(true); lute.SetCodeSyntaxHighlight(false); lute.SetDataImage(false);
  lute.SetGFMTable(true); lute.SetGFMTaskListItem(true); lute.SetHeadingID(true);
  let html = lute.Md2HTML(text).replace(/<a\b[^>]*>/gi, '<a>');
  const katex = require('../src/vendor/vditor/dist/js/katex/katex.min.js');
  const macros = {};
  try {
    const raw = JSON.parse(preferences['math.macros'] || '{}');
    for (const [name, definition] of Object.entries(raw).slice(0, 64)) {
      const value = Array.isArray(definition) && definition.length < 3 ? definition[0] : definition;
      if (/^[A-Za-z]+$/.test(name) && typeof value === 'string' && value.length <= 2048) macros['\\' + name] = value;
    }
  } catch { /* Invalid optional macro input leaves normal formulas available. */ }
  let formulas = 0, remaining = 16384;
  function formula(original, tag, body, enabled) {
    const tex = decodeEntities(body);
    if (!enabled) return tag === 'div' ? `<pre class="preview-math-source">${escapeHtml('$$\n' + tex + '\n$$')}</pre>` : original;
    if (++formulas > 64 || tex.length > 2048 || tex.length > remaining) return original;
    remaining -= tex.length;
    try { return `<${tag} class="preview-math">${katex.renderToString(tex, { displayMode: tag === 'div', throwOnError: true, trust: false, strict: 'ignore', maxExpand: 256, maxSize: 20, macros: { ...macros } })}</${tag}>`; }
    catch { return original; }
  }
  html = html.replace(/<(span|div) class="language-math">([\s\S]*?)<\/\1>/g, (original, tag, body) => formula(original, tag, body, preferences[tag === 'div' ? 'markdown.mathBlock' : 'markdown.inlineMath'] !== false));
  html = html.replace(/<pre><code class="language-math">([\s\S]*?)<\/code><\/pre>/g, (original, body) => preferences['markdown.codeBlockMath'] === false ? original : formula(original, 'div', body, true));
  return html;
}
function safeFont(value, fallback) { return typeof value === 'string' && value.length <= 200 && !/[;{}<>\r\n\0]/.test(value) && !/url\s*\(/i.test(value) ? value : fallback; }
function presentation(preferences = {}, appearance = 'light', themeVariables = {}) {
  const dark = preferences['appearance.theme'] === 'dark' || preferences['appearance.theme'] === 'system' && appearance === 'dark';
  const colors = colorThemes.palette(preferences['typography.colorTheme'], dark ? 'dark' : 'light');
  for (const [key, value] of Object.entries(themeVariables || {})) if (colorThemes.variableKeys.includes(key) && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) colors[key] = value;
  const number = (key, fallback, min, max) => Number.isFinite(preferences[key]) ? Math.max(min, Math.min(max, preferences[key])) : fallback;
  return { colors, font: safeFont(preferences['appearance.fontFamily'], '"Noto Sans SC",sans-serif'), mono: safeFont(preferences['appearance.monospaceFontFamily'], 'monospace'), fontSize: number('appearance.fontSize', 17, 9, 48), lineHeight: number('appearance.lineHeight', 1.85, 1, 3.5), indented: preferences['typography.paragraphStyle'] === 'indented', justify: ['justify', 'optimal'].includes(preferences['typography.textAlign']) };
}
async function loadPreviewThemeVariables(preferences, { themesDirectory, appearance = 'light' } = {}) {
  if (!themesDirectory || !path.isAbsolute(themesDirectory) || !colorThemes.customPattern.test(preferences['typography.colorTheme'] || '')) return {};
  const directory = await fs.lstat(themesDirectory).catch(() => null);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) return {};
  const store = new ThemeStore({ directory: themesDirectory }), themes = [], visited = new Set();
  let selected = preferences['typography.colorTheme'];
  while (colorThemes.customPattern.test(selected) && !visited.has(selected) && themes.length < 32) {
    visited.add(selected);
    const fileName = selected.slice(7) + '.toml';
    try { const loaded = await store.readFile(fileName), theme = colorThemes.parse(loaded.content, fileName); themes.push(theme); selected = theme.basedOn; }
    catch { break; }
  }
  const dark = preferences['appearance.theme'] === 'dark' || preferences['appearance.theme'] === 'system' && appearance === 'dark';
  return colorThemes.resolve(themes, preferences['typography.colorTheme'], dark ? 'dark' : 'light').variables;
}
async function buildPreviewHTML(source, { appRoot = path.resolve(__dirname, '..'), preferences = {}, appearance = 'light', themesDirectory, themeVariables } = {}) {
  const [template, css] = await Promise.all([fs.readFile(path.join(appRoot, 'src/system-preview.html'), 'utf8'), fs.readFile(path.join(appRoot, 'src/system-preview.css'), 'utf8')]);
  const style = presentation(preferences, appearance, themeVariables || await loadPreviewThemeVariables(preferences, { themesDirectory, appearance }));
  const vars = Object.entries(style.colors).map(([k, v]) => `${k}:${v}`).join(';');
  const custom = `:root{${vars};--preview-body-font:${style.font};--preview-mono-font:${style.mono};--preview-font-size:${style.fontSize}px;--preview-line-height:${style.lineHeight}}.preview-content>p{text-indent:${style.indented ? '2em' : '0'};text-align:${style.justify ? 'justify' : 'start'}}`;
  const body = source.plain ? `<pre class="plain-text">${escapeHtml(source.text)}</pre>` : renderMarkdown(source.text, preferences);
  const note = [source.truncated ? '仅显示文档开头 / Opening excerpt' : '', source.encodingGuessed ? '文本编码为推测结果 / Guessed encoding' : ''].filter(Boolean).join(' · ');
  const replacements = { TITLE: escapeHtml(source.title), BASE: escapeHtml(pathToFileURL(path.dirname(source.canonical) + path.sep).href), FONT_CSS: escapeHtml(pathToFileURL(path.join(appRoot, 'src/vendor/fonts/noto-sans-sc/400.css')).href), EDITOR_CSS: escapeHtml(pathToFileURL(path.join(appRoot, 'src/vendor/vditor/dist/index.css')).href), MATH_CSS: escapeHtml(pathToFileURL(path.join(appRoot, 'src/vendor/vditor/dist/js/katex/katex.min.css')).href), STYLE: css + '\n' + custom, BODY: body, NOTE: escapeHtml(note) };
  return template.replace(/__([A-Z_]+)__/g, (m, key) => replacements[key] ?? m);
}
async function syncMacPreviewPreferences(preferences, options = {}) {
  if ((options.platform || process.platform) !== 'darwin') return { shared: false, reason: 'platform' };
  const container = options.containerDirectory || path.join(os.homedir(), 'Library', 'Group Containers', 'group.com.moye.editor');
  const info = await fs.lstat(container).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { shared: false, reason: 'app-group-not-provisioned' };
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Quick Look settings require a provisioned, real App Group container.');
  const filename = path.join(container, 'moye-preview-settings.json'), existing = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new Error('Quick Look settings target is not a regular private file.');
  const style = presentation(preferences, options.appearance, options.themeVariables || await loadPreviewThemeVariables(preferences, options));
  const payload = { version: 1, presentation: { font: style.font, fontSize: style.fontSize, lineHeight: style.lineHeight, indented: style.indented, justify: style.justify, paper: style.colors['--paper'], ink: style.colors['--ink'] } };
  const temporary = path.join(container, `.moye-preview-settings-${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(payload), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
  return { shared: true, path: filename };
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const head = Buffer.from(type), chunk = Buffer.alloc(data.length + 12); chunk.writeUInt32BE(data.length); head.copy(chunk, 4); data.copy(chunk, 8); chunk.writeUInt32BE(crc32(Buffer.concat([head, data])), data.length + 8); return chunk; }
function addThumbnailMetadata(png, source) {
  if (!Buffer.isBuffer(png) || png.length < 20 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') throw new Error('Invalid PNG result.');
  const fields = { 'Thumb::URI': pathToFileURL(source.input).href, 'Thumb::MTime': String(source.modifiedSeconds), 'Thumb::Size': String(source.sizeBytes), 'Thumb::Mimetype': source.plain ? 'text/plain' : 'text/markdown', Software: 'Moye system preview' };
  return Buffer.concat([png.subarray(0, -12), ...Object.entries(fields).map(([k, v]) => pngChunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'))), png.subarray(-12)]);
}
async function writeThumbnail(output, bytes) {
  const previous = await fs.lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous?.isSymbolicLink() || previous && !previous.isFile()) throw new Error('Preview output must be a regular file.');
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, output); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function runPreview(electron, request, options = {}) {
  const { app, BrowserWindow, session, nativeImage } = electron;
  const validated = parsePreviewArgs(['--system-preview', '--input', request.input, '--output', request.output, '--size', String(request.size)]);
  const source = await readPreviewSource(validated, options), appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
  const temporary = await fs.mkdtemp(path.join(app.getPath('temp') || os.tmpdir(), 'moye-system-preview-'));
  const filename = path.join(temporary, 'preview.html'), allowedHtml = pathToFileURL(filename).href;
  const partition = `moye-system-preview-${crypto.randomUUID()}`, isolated = session.fromPartition(partition, { cache: false });
  const roots = { appRoot, documentRoot: path.dirname(source.canonical) };
  isolated.setPermissionRequestHandler((_webContents, _permission, done) => done(false));
  isolated.webRequest.onBeforeRequest((details, done) => {
    if (details.url.split('#')[0] === allowedHtml) { done({ cancel: false }); return; }
    resourceAllowed(details.url, roots).then(async allowed => {
      if (allowed && /^file:/.test(details.url)) { try { allowed = (await fs.stat(fileURLToPath(details.url))).size <= MAX_IMAGE_BYTES; } catch { allowed = false; } }
      done({ cancel: !allowed });
    }, () => done({ cancel: true }));
  });
  let window, deadline;
  try {
    await fs.writeFile(filename, await buildPreviewHTML(source, { ...options, appRoot }), { mode: 0o600 });
    window = new BrowserWindow({ show: false, width: 800, height: 1060, frame: false, webPreferences: { partition, javascript: false, contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    deadline = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, PREVIEW_TIMEOUT_MS);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== allowedHtml) event.preventDefault(); });
    window.webContents.debugger.attach('1.3');
    await window.loadFile(filename);
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 800, height: 1060, deviceScaleFactor: 1, mobile: false });
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const result = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.fonts.status === "loaded" && Array.from(document.images).every(image => image.complete)', returnByValue: true, awaitPromise: false });
      if (result.result?.value === true) break;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    const shot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true, clip: { x: 0, y: 0, width: 800, height: 1060, scale: 1 } });
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).resize({ height: validated.size, quality: 'good' });
    if (image.isEmpty()) throw new Error('System preview produced an empty image.');
    const bytes = addThumbnailMetadata(image.toPNG(), source);
    await writeThumbnail(validated.output, bytes);
    const webPreferences = window.webContents.getLastWebPreferences();
    return { path: validated.output, sizeBytes: bytes.length, dimensions: image.getSize(), truncated: source.truncated, encodingGuessed: source.encodingGuessed, readOnly: true,
      application: { version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath },
      security: { javascript: webPreferences.javascript, nodeIntegration: webPreferences.nodeIntegration, sandbox: webPreferences.sandbox, contextIsolation: webPreferences.contextIsolation } };
  } finally {
    clearTimeout(deadline);
    if (window && !window.isDestroyed()) { if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach(); window.destroy(); }
    isolated.webRequest.onBeforeRequest(null); await isolated.clearStorageData().catch(() => {}); await fs.rm(temporary, { recursive: true, force: true });
  }
}
module.exports = { parsePreviewArgs, sourcePath, readPreviewSource, renderMarkdown, buildPreviewHTML, presentation, loadPreviewThemeVariables, syncMacPreviewPreferences, addThumbnailMetadata, writeThumbnail, runPreview, MAX_SOURCE_BYTES, MAX_RENDER_CODEPOINTS, PREVIEW_TIMEOUT_MS };
