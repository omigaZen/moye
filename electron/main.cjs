'use strict';

const { app, BrowserWindow, Menu, dialog: electronDialog, ipcMain, shell, session, clipboard, ClipboardItem, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  DocumentStore, ExternalChangeError, MAX_DOCUMENT_BYTES, IMAGE_EXTENSIONS,
  baseUrlFor, atomicWrite,
} = require('./file-store.cjs');
const { RecoveryStore } = require('./recovery-store.cjs');
const { SettingsStore, MAX_SETTINGS_BYTES, parseSettings } = require('./settings-store.cjs');
const shortcuts = require('../src/shortcut-config.js');
const imagePolicy = require('./image-store.cjs');
const { WorkspaceStore } = require('./workspace-store.cjs');
const workspace = new WorkspaceStore();
const exportService = require('./export-service.cjs');
const { ThemeStore } = require('./theme-store.cjs');
const { RecentFilesStore } = require('./recent-files.cjs');
const { WindowStateStore } = require('./window-state.cjs');
const localeText = require('../src/i18n.js');
const localization = require('./localization.cjs');

function nativeLocale() { return localeText.resolveLocale(settings?.snapshot().values['ui.language'] || 'zh-CN', app.getLocale()); }
const translate = text => localeText.t(text, nativeLocale());
// Translate only application-owned options at the call boundary. Electron's
// original dialog object stays available to the OS and deterministic tests.
const dialog = new Proxy(electronDialog, { get(target, key) {
  if (['showOpenDialog', 'showSaveDialog', 'showMessageBox'].includes(key)) return (...args) => {
    args[args.length - 1] = localization.localizeDialogOptions(args.at(-1), nativeLocale(), app.getLocale(), key === 'showOpenDialog' ? 'open' : key === 'showSaveDialog' ? 'save' : 'message');
    return target[key](...args);
  };
  if (key === 'showErrorBox') return (title, message) => target.showErrorBox(translate(title), translate(message));
  return target[key];
} });

app.setName('墨页');
const automatedTest = process.env.MOYE_TEST === '1';
if (automatedTest && process.env.MOYE_TEST_USER_DATA && path.isAbsolute(process.env.MOYE_TEST_USER_DATA)) {
  app.setPath('userData', process.env.MOYE_TEST_USER_DATA);
}

let documents = new DocumentStore({ encodingMemoryPath: path.join(app.getPath('userData'), 'document-encodings.json') });
const recentFiles = new RecentFilesStore({ filePath: path.join(app.getPath('userData'), 'recent-files.json') });
const windowState = new WindowStateStore(path.join(app.getPath('userData'), 'window-state.json'));
const documentNavigation = new WorkspaceStore();
let recovery;
let settings;
let themes;
let mainWindow = null;
let dirty = false;
let closingApproved = false;
let closeRequested = false;
let quitRequested = false;
let pendingOpenPath = null;
let rendererReady = false;
let pendingActions = [];
let operationQueue = Promise.resolve();
let shortcutBindings = shortcuts.resolve('{}', process.platform);
let externalWatchTimer, externalWatchBusy = false, externalWatchState = { path: null, stamp: '', notified: '' };
let windowStateTimer;
let macPreviewQueue = Promise.resolve();

async function persistWindowState() {
  clearTimeout(windowStateTimer);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds(), display = screen.getDisplayMatching(bounds);
    await windowState.save({ bounds, maximized: mainWindow.isMaximized() && !mainWindow.isFullScreen(), displayId: display.id });
  } catch { /* A state-write error must never discard a document or block close. */ }
}
function scheduleWindowState() {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(persistWindowState, 200); windowStateTimer.unref();
}
async function currentDocumentNeighbor(direction) {
  if (![-1, 1].includes(direction)) throw new TypeError('文件导航方向无效。');
  const filename = documents.filePath, documentId = documents.documentId;
  if (!filename) return null;
  const directory = await fs.realpath(path.dirname(filename));
  if (documents.documentId !== documentId) return null;
  if (documentNavigation.rootPath !== directory) await documentNavigation.chooseRoot(directory);
  const current = await documentNavigation.entryForPath(filename);
  const entry = current ? await documentNavigation.neighbor(current.id, direction) : null;
  return documents.documentId === documentId && entry ? { ...entry, navigation: 'document', ownerDocumentId: documentId } : null;
}

async function checkExternalDocument() {
  if (externalWatchBusy || !mainWindow || mainWindow.isDestroyed() || !documents.filePath) return;
  externalWatchBusy = true;
  const filename = documents.filePath;
  try {
    const info = await fs.stat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const stamp = info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` : 'missing';
    if (externalWatchState.path !== filename) externalWatchState = { path: filename, stamp: '', notified: '' };
    if (stamp === externalWatchState.stamp) return;
    externalWatchState.stamp = stamp;
    if (await documents.hasExternalChange() && documents.filePath === filename && stamp !== externalWatchState.notified) {
      externalWatchState.notified = stamp;
      mainWindow.webContents.send('document:external-change', { path: filename, missing: !info });
    }
  } catch { /* Transient file access never replaces the in-memory document. */ }
  finally { externalWatchBusy = false; }
}

const FILTERS = [{ name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }, { name: '所有文件', extensions: ['*'] }];

function trustedSender(event) {
  return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
}
function requireTrusted(event) { if (!trustedSender(event)) throw new Error('不允许的调用来源。'); }
function serial(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => {});
  return next;
}
function textValue(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('文档内容无效或超过 32 MB。');
  return value;
}
function markEdited(value) {
  dirty = value;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (process.platform === 'darwin') mainWindow.setDocumentEdited(value);
    mainWindow.setTitle(`${value ? '● ' : ''}${documents.filePath ? path.basename(documents.filePath) : translate('未命名.md')} — ${translate('墨页')}`);
  }
}
async function recordRecent(filename, options = {}) {
  if (options.preview) return '';
  app.addRecentDocument(filename);
  try { await recentFiles.remember(filename); return ''; }
  catch { return '文档操作已完成，但最近文件记录未能保存。'; }
}
function recentId(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'id') || typeof options.id !== 'string') throw new TypeError('最近文件参数无效。');
  return options.id;
}
function action(name) {
  if (!rendererReady) {
    if (!pendingActions.includes(name)) pendingActions.push(name);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:action', name);
    mainWindow.focus();
  }
}
async function clearDraft() {
  return recovery.clearCurrent();
}
async function readDraft() {
  const draft = await recovery.getPending();
  if (!draft) return null;
  const originalPath = typeof draft.path === 'string' && path.isAbsolute(draft.path) ? draft.path : null;
  return {
    path: null, originalPath,
    name: originalPath ? `${path.basename(originalPath)}（恢复副本）` : '恢复的草稿.md',
    content: draft.content, baseUrl: baseUrlFor(originalPath), updatedAt: draft.updatedAt, recoveryId: draft.recoveryId,
  };
}
async function chooseSavePath() {
  const response = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Markdown 文档',
    defaultPath: documents.filePath || '未命名.md',
    filters: FILTERS,
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (response.canceled || !response.filePath) return null;
  if (path.extname(response.filePath)) return response.filePath;
  const destination = `${response.filePath}.md`;
  let exists = false;
  try { await fs.access(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    // A dialog that checked "report" did not authorize replacing "report.md".
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '确认覆盖', message: `文件 ${path.basename(destination)} 已存在。`,
      detail: '自动添加 .md 扩展名后的实际目标已存在。是否替换这个文件？',
      buttons: ['覆盖', '取消'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (confirmation.response !== 0) return null;
  }
  return destination;
}
async function saveDocument(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('保存参数无效。');
  const content = textValue(options.content);
  if (options.saveAs !== undefined && typeof options.saveAs !== 'boolean') throw new Error('保存参数无效。');
  let destination = options.saveAs || !documents.filePath ? await chooseSavePath() : documents.filePath;
  if (!destination) return null;
  let result;
  try { result = await documents.save(content, destination); }
  catch (error) {
    if (!(error instanceof ExternalChangeError)) throw error;
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '文件已在外部更改',
      message: '这个文件已被其他程序修改或删除。',
      detail: '选择另存为可以保留磁盘上的版本。选择覆盖将使用当前编辑内容替换它。',
      buttons: ['另存为', '覆盖磁盘文件', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response.response === 2) return null;
    if (response.response === 0) {
      destination = await chooseSavePath();
      if (!destination) return null;
      // The user explicitly chose a path and confirmed overwrite in the native
      // save dialog, including the original path if selected again.
    }
    result = await documents.save(content, destination, { overwriteConflict: true });
  }
  markEdited(false);
  const recentWarning = await recordRecent(destination);
  let workspaceEntry = null;
  try { workspaceEntry = await workspace.entryForPath(destination); } catch { /* Saving is already successful even when a folder disappeared. */ }
  if (process.platform === 'darwin') mainWindow.setRepresentedFilename(destination);
  await clearDraft();
  return { ...result, recentWarning, workspaceEntry };
}

async function exportDocument(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('导出参数无效。');
  if (payload.documentId !== undefined && payload.documentId !== documents.documentId) throw new Error('文档已切换，请重新导出。');
  const options = exportService.validateExportOptions(payload.options);
  const html = exportService.buildExportHtml({ html: payload.html, css: payload.css, title: payload.title,
    baseUrl: documents.payload(documents.originalContent).baseUrl, options });
  const extension = options.format === 'pdf' ? 'pdf' : 'png';
  const response = await dialog.showSaveDialog(mainWindow, { title: `导出 ${extension.toUpperCase()}`,
    defaultPath: `${path.basename(documents.filePath || '未命名.md', path.extname(documents.filePath || '未命名.md'))}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }], properties: ['showOverwriteConfirmation', 'createDirectory'] });
  if (response.canceled || !response.filePath) return null;
  let destination = response.filePath;
  if (!path.extname(destination)) {
    destination += `.${extension}`;
    try {
      await fs.access(destination);
      const confirmation = await dialog.showMessageBox(mainWindow, { type: 'question', title: '确认覆盖', message: `${path.basename(destination)} 已存在。`, buttons: ['覆盖', '取消'], defaultId: 1, cancelId: 1 });
      if (confirmation.response !== 0) return null;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = await fs.mkdtemp(path.join(app.getPath('temp'), 'moye-export-'));
  const filename = path.join(temporary, 'document.html');
  const partition = `moye-export-${require('node:crypto').randomUUID()}`;
  const exportSession = session.fromPartition(partition, { cache: false });
  const allowedHtml = pathToFileURL(filename).href;
  const roots = { appRoot: path.resolve(__dirname, '..'), documentRoot: documents.filePath ? path.dirname(documents.filePath) : null };
  exportSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  exportSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.split('#')[0] === allowedHtml) { callback({ cancel: false }); return; }
    exportService.resourceAllowed(details.url, roots).then(allowed => callback({ cancel: !allowed }), () => callback({ cancel: true }));
  });
  let window, deadline;
  try {
    await atomicWrite(filename, Buffer.from(html));
    window = new BrowserWindow({ show: false, width: options.width, height: 900, frame: false,
      webPreferences: { partition, javascript: false, contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    deadline = setTimeout(() => { if (window && !window.isDestroyed()) window.destroy(); }, 30000);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== allowedHtml) event.preventDefault(); });
    window.webContents.debugger.attach('1.3');
    await window.loadFile(filename);
    const evaluate = async expression => {
      const result = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: false, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`导出页面处理失败：${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      return result.result?.value;
    };
    // The export page has JavaScript disabled. Poll its layout from Node rather
    // than depending on page callbacks or animation frames in a hidden window.
    const readyDeadline = Date.now() + 8000;
    while (Date.now() < readyDeadline) {
      const ready = await evaluate('({fonts:document.fonts.status,images:Array.from(document.images).every(image=>image.complete)})');
      if (ready.fonts === 'loaded' && ready.images) break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const failedImages = await evaluate(`(() => { let count = 0; for (const image of Array.from(document.images)) { if (!image.complete || !image.naturalWidth) { const note = document.createElement('span'); note.className = 'moye-export-missing-image'; note.style.cssText = 'display:inline-block;max-width:100%;padding:8px;border:1px solid currentColor;overflow-wrap:anywhere'; note.textContent = ${JSON.stringify(translate('图片无法显示'))} + (image.alt ? ': ' + image.alt : ''); image.replaceWith(note); count++; } } return count; })()`);
    if (failedImages) {
      const fontDeadline = Date.now() + 2000;
      while (Date.now() < fontDeadline && await evaluate('document.fonts.status') !== 'loaded') await new Promise(resolve => setTimeout(resolve, 60));
    }
    let bytes, dimensions;
    if (options.format === 'pdf') {
      bytes = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: options.paperSize, landscape: options.landscape, generateTaggedPDF: true });
    } else {
      await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: options.width, height: 900, deviceScaleFactor: options.scale, mobile: false });
      await new Promise(resolve => setTimeout(resolve, 80));
      const measured = await evaluate('({width:Math.ceil(document.querySelector("main").getBoundingClientRect().width),height:Math.max(1,Math.ceil(document.querySelector("main").getBoundingClientRect().height+parseFloat(getComputedStyle(document.body).paddingTop)+parseFloat(getComputedStyle(document.body).paddingBottom)))})');
      dimensions = exportService.validateImageDimensions(options.width, measured.height, options.scale);
      const shot = await window.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width: options.width, height: measured.height, scale: 1 } });
      bytes = Buffer.from(shot.data, 'base64');
    }
    await atomicWrite(destination, bytes);
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(value => typeof value === 'string').slice(0, 19) : [];
    if (failedImages) warnings.push(translate('有图片未能载入，已在导出中标记。'));
    return { saved: true, path: destination, format: options.format, sizeBytes: bytes.length, dimensions, warnings };
  } finally {
    clearTimeout(deadline);
    if (window && !window.isDestroyed()) { if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach(); window.destroy(); }
    exportSession.webRequest.onBeforeRequest(null);
    await exportSession.clearStorageData().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function settingsPayload(snapshot = settings.snapshot()) {
  return { ...snapshot, systemTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', systemLocale: app.getLocale() };
}
function applyNativeSettings(snapshot) {
  session.defaultSession.setSpellCheckerEnabled(snapshot.values['general.spellcheck']);
  // Replacing the complete menu unregisters the previous accelerator too.
  // Validation has already completed atomically in SettingsStore.
  buildMenu(snapshot);
  markEdited(dirty);
  app.setAboutPanelOptions({ applicationName: translate('墨页 Moye'), applicationVersion: app.getVersion(), copyright: translate('本地 Markdown 编辑器') });
  if (process.platform === 'darwin') {
    const values = snapshot.values, options = { appearance: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', themesDirectory: path.join(app.getPath('userData'), 'document-themes') };
    macPreviewQueue = macPreviewQueue.catch(() => {}).then(() => require('./system-preview.cjs').syncMacPreviewPreferences(values, options));
    macPreviewQueue.catch(() => {});
  }
  const payload = settingsPayload(snapshot);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', payload);
  return payload;
}
function settingsOptions(options, { patch = false } = {}) {
  if (options === undefined && !patch) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('设置参数无效。');
  const keys = patch ? new Set(['patch', 'expectedRevision']) : new Set(['expectedRevision']);
  if (Object.keys(options).some(key => !keys.has(key))) throw new TypeError('设置参数包含未知字段。');
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) throw new TypeError('设置版本号无效。');
  return options;
}

function registerIpc() {
  const handle = (channel, callback, { queue = false } = {}) => ipcMain.handle(channel, (event, ...args) => {
    requireTrusted(event);
    return queue ? serial(() => callback(...args)) : callback(...args);
  });

  handle('settings:get', async () => settingsPayload(await settings.get()));
  handle('export:resources', async options => {
    if (!options || Object.keys(options).some(key => key !== 'urls') || !Array.isArray(options.urls) || options.urls.length > 512 || options.urls.some(url => typeof url !== 'string' || url.length > 16384)) throw new TypeError('导出资源参数无效。');
    const roots = { appRoot: path.resolve(__dirname, '..'), documentRoot: documents.filePath ? path.dirname(documents.filePath) : null };
    return Promise.all(options.urls.map(url => exportService.resourceAllowed(url, roots).catch(() => false)));
  });
  handle('system-preview:configure', async () => {
    if (process.platform !== 'linux') throw new Error('此平台的系统预览暂未提供。');
    if (!app.isPackaged) throw new Error('请在桌面发布包中启用系统缩略图。');
    const response = await dialog.showMessageBox(mainWindow, { type: 'question', title: '系统缩略图', message: '在文件管理器中预览 Markdown 和 TXT 文档。', detail: '启用后由文件管理器生成缩略图，不修改文档内容。', buttons: ['启用', '移除', '取消'], defaultId: 2, cancelId: 2 });
    const registration = require('./system-preview-registration.cjs');
    if (response.response === 0) return registration.install({ executable: process.execPath });
    if (response.response === 1) return registration.uninstall();
    return { canceled: true };
  }, { queue: true });
  handle('recent:list', () => recentFiles.list());
  handle('recent:remove', options => recentFiles.remove(recentId(options)), { queue: true });
  handle('recent:clear', async () => { const snapshot = await recentFiles.clear(); app.clearRecentDocuments(); return snapshot; }, { queue: true });
  handle('recent:remember-current', async options => {
    if (!options || Object.keys(options).some(key => key !== 'documentId') || options.documentId !== documents.documentId) throw new Error('文档已切换，请重试。');
    return documents.filePath ? recentFiles.remember(documents.filePath) : { recorded: false };
  }, { queue: true });
  handle('recent:open', async options => {
    const filename = await recentFiles.resolve(recentId(options));
    const result = await documents.open(filename);
    markEdited(false);
    const recentWarning = await recordRecent(filename);
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename(filename);
    await clearDraft();
    return { ...result, recentWarning };
  }, { queue: true });
  handle('document:neighbor', options => currentDocumentNeighbor(options?.direction), { queue: true });
  handle('document:neighbor-open', async options => {
    if (!options || typeof options.id !== 'string' || options.ownerDocumentId !== documents.documentId) throw new Error('文档已切换，请重新选择下一篇。');
    const filename = await documentNavigation.resolveFile(options.id), result = await documents.open(filename);
    markEdited(false); const recentWarning = await recordRecent(filename);
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename(filename);
    await clearDraft(); return { ...result, recentWarning };
  }, { queue: true });
  handle('settings:reload', async () => applyNativeSettings(await settings.reload({ throwOnInvalid: true })));
  handle('settings:open-file', async () => {
    await settings.ensureFile();
    const error = await shell.openPath(settings.filePath);
    if (error) throw new Error(error); return { opened: true, path: settings.filePath };
  });
  handle('themes:get', () => themes.get());
  handle('themes:save', options => themes.save(options), { queue: true });
  handle('themes:remove', options => themes.remove(options), { queue: true });
  handle('themes:open-folder', async () => {
    const snapshot = await themes.get(); const error = await shell.openPath(snapshot.directory);
    if (error) throw new Error(error); return { opened: true };
  });
  handle('settings:update', async raw => {
    const options = settingsOptions(raw, { patch: true });
    return applyNativeSettings(await settings.update(options.patch, options));
  });
  handle('settings:reset', async raw => {
    const options = settingsOptions(raw);
    return applyNativeSettings(await settings.reset(options));
  });
  handle('settings:import', async raw => {
    const options = settingsOptions(raw);
    const response = await dialog.showOpenDialog(mainWindow, {
      title: '导入墨页设置', filters: [{ name: '墨页设置 JSON', extensions: ['json'] }], properties: ['openFile'],
    });
    if (response.canceled || !response.filePaths[0]) return null;
    const filePath = response.filePaths[0], info = await fs.stat(filePath);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) throw new Error('请选择不超过 64 KB 的设置 JSON 文件。');
    return applyNativeSettings(await settings.import(await fs.readFile(filePath, 'utf8'), options));
  }, { queue: true });
  handle('settings:export', async () => {
    const response = await dialog.showSaveDialog(mainWindow, {
      title: '导出墨页设置', defaultPath: 'Moye-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (response.canceled || !response.filePath) return { saved: false };
    // Keep the exact chosen path: adding an extension after the OS overwrite
    // confirmation would authorize a different target.
    await atomicWrite(response.filePath, Buffer.from(await settings.export()));
    return { saved: true, path: response.filePath };
  }, { queue: true });

  handle('document:open', async () => {
    let selectedPath = pendingOpenPath;
    pendingOpenPath = null;
    if (!selectedPath) {
      const response = await dialog.showOpenDialog(mainWindow, { title: '打开 Markdown 文档', filters: FILTERS, properties: ['openFile'] });
      if (response.canceled || !response.filePaths[0]) return null;
      selectedPath = response.filePaths[0];
    }
    const result = await documents.open(selectedPath);
    markEdited(false);
    const recentWarning = await recordRecent(selectedPath);
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename(selectedPath);
    await clearDraft();
    return { ...result, recentWarning };
  }, { queue: true });

  handle('document:save', saveDocument, { queue: true });
  handle('document:export', exportDocument, { queue: true });
  handle('document:reload', async options => {
    if (!documents.filePath) throw new Error('当前文档还没有磁盘文件。');
    if (dirty && options?.discard !== true) throw new Error('请先保存或放弃当前更改，再重新载入。');
    const filename = documents.filePath, encoding = documents.originalEncodingGuessed ? 'auto' : documents.originalEncoding;
    const result = await documents.open(filename, { encoding, rememberEncoding: false });
    externalWatchState = { path: null, stamp: '', notified: '' }; markEdited(false); return result;
  }, { queue: true });
  handle('document:encoding', async options => {
    if (!options || !['confirm', 'reinterpret', 'convert'].includes(options.mode)) throw new TypeError('编码操作无效。');
    if (options.mode === 'confirm') return documents.confirmEncoding();
    if (typeof options.encoding !== 'string') throw new TypeError('编码选项无效。');
    if (options.mode === 'convert') return documents.setEncoding(options.encoding);
    if (dirty && options.discard !== true || !documents.filePath) throw new Error('请先保存或放弃当前更改，再按其他编码重新读取。');
    const result = await documents.open(documents.filePath, { encoding: options.encoding });
    markEdited(false); return result;
  }, { queue: true });
  handle('workspace:choose', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, { title: '打开文档文件夹', properties: ['openDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const snapshot = await workspace.chooseRoot(selection.filePaths[0]);
    workspace.watch(update => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('workspace:changed', update); });
    return snapshot;
  }, { queue: true });
  handle('workspace:list', async options => {
    if (!options || typeof options.id !== 'string') throw new TypeError('工作区参数无效。');
    return options.query === undefined ? workspace.list(options.id) : workspace.search(options.query);
  });
  handle('workspace:neighbor', async options => {
    if (!options || typeof options.id !== 'string' || ![-1, 1].includes(options.direction)) throw new TypeError('文件导航参数无效。');
    return workspace.neighbor(options.id, options.direction);
  });
  handle('workspace:open', async options => {
    if (!options || typeof options.id !== 'string' || typeof options.preview !== 'boolean') throw new TypeError('文档预览参数无效。');
    const filename = await workspace.resolveFile(options.id);
    const result = await documents.open(filename);
    markEdited(false);
    const recentWarning = await recordRecent(filename, { preview: options.preview });
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename(filename);
    await clearDraft();
    return { ...result, workspaceId: options.id, preview: options.preview, recentWarning };
  }, { queue: true });
  handle('document:session', () => documents.payload(documents.originalContent));
  handle('document:sample', async options => {
    const names = new Set(['欢迎.md', '完整语法验收.md']);
    if (!options || !names.has(options.name)) throw new Error('示例文档不存在。');
    const samplePath = path.join(__dirname, '..', 'src', 'samples', options.name);
    const content = await fs.readFile(samplePath, 'utf8');
    const result = documents.recover(content, samplePath);
    markEdited(false);
    await clearDraft();
    return { ...result, name: options.name };
  }, { queue: true });
  handle('document:new', async () => {
    const result = documents.reset();
    markEdited(false);
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename('');
    await clearDraft();
    return result;
  }, { queue: true });
  handle('document:confirm-discard', async () => {
    const response = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: '保存更改', message: '要保存对当前文档的更改吗？',
      detail: '未保存的更改将在放弃后丢失。',
      buttons: ['保存', '放弃更改', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    return ['save', 'discard', 'cancel'][response.response];
  });
  ipcMain.on('document:edited', (event, state) => {
    if (!trustedSender(event) || !state || typeof state.edited !== 'boolean') return;
    markEdited(state.edited);
  });

  handle('image:choose', async () => {
    const policy = imagePolicy.normalizePolicy(settings.snapshot().values);
    const reference = !imagePolicy.shouldCopyImage('local', policy);
    if (!documents.filePath && (!reference || policy.pathStyle === 'relative')) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: '先保存文档', message: '请先保存 Markdown 文档，再插入图片。', detail: '图片会复制到文档旁的资源文件夹，使用相对路径引用。' });
      return [];
    }
    const response = await dialog.showOpenDialog(mainWindow, {
      title: '插入图片', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: [...IMAGE_EXTENSIONS].map(ext => ext.slice(1)) }],
    });
    if (response.canceled) return [];
    const images = [];
    for (const imagePath of response.filePaths) {
      const image = await imagePolicy.readLocalImage(imagePath);
      if (reference) images.push(imagePolicy.imageReference(imagePath, documents.filePath, policy));
      else images.push(await documents.addImage(image, policy));
    }
    return images;
  }, { queue: true });
  handle('image:import', async image => {
    if (!image || typeof image !== 'object' || typeof image.name !== 'string') throw new Error('图片参数无效。');
    const bytes = image.bytes;
    if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes) && !(bytes instanceof ArrayBuffer)) throw new Error('图片数据无效。');
    if (bytes.byteLength > 25 * 1024 * 1024 || bytes.length > 25 * 1024 * 1024) throw new Error('图片不能超过 25 MB。');
    return documents.addImage({ name: image.name, bytes: Buffer.from(bytes) }, imagePolicy.normalizePolicy(settings.snapshot().values));
  }, { queue: true });

  handle('draft:stash', draft => {
    if (!draft || typeof draft !== 'object') throw new Error('草稿参数无效。');
    const content = textValue(draft.content);
    if (draft.documentId !== undefined && draft.documentId !== documents.documentId) return { stashed: false, reason: 'stale-document' };
    if (draft.path !== undefined && (draft.path || null) !== documents.filePath) return { stashed: false, reason: 'stale-document' };
    // The renderer's path is not trusted; only the native current file is used.
    const snapshot = { version: 1, path: documents.filePath || documents.assetSourcePath, content, updatedAt: new Date().toISOString() };
    const documentId = documents.documentId;
    const filePath = documents.filePath;
    return recovery.stash(snapshot, () => documentId === documents.documentId && filePath === documents.filePath);
  });
  handle('draft:get', readDraft);
  handle('draft:restore', async () => {
    const draft = await readDraft();
    if (!draft) return null;
    // Recovery is an unsaved copy. A crash must never authorize overwriting a
    // file that may have changed while the editor was not running.
    const previousDocuments = documents;
    const restoredDocuments = new DocumentStore({ encodingMemoryPath: path.join(app.getPath('userData'), 'document-encodings.json') });
    const result = restoredDocuments.recover(draft.content, draft.originalPath);
    documents = restoredDocuments;
    try {
      await recovery.consumePending(draft.recoveryId, { version: 1, path: draft.originalPath, content: draft.content, updatedAt: new Date().toISOString() });
    } catch (error) { documents = previousDocuments; throw error; }
    markEdited(true);
    if (process.platform === 'darwin') mainWindow.setRepresentedFilename('');
    return result;
  }, { queue: true });
  handle('draft:clear', () => recovery.discardPending());
  handle('app:platform', () => ({ platform: process.platform, version: app.getVersion() }));
  handle('clipboard:write-text', async payload => {
    if (!payload || typeof payload !== 'object') throw new Error('剪贴板参数无效。');
    const text = textValue(payload.text);
    if (payload.html !== undefined) {
      if (typeof payload.html !== 'string' || payload.html.length > 4 * 1024 * 1024) throw new Error('剪贴板 HTML 参数无效。');
      await clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': payload.html })]);
    } else await clipboard.writeText(text);
    return { written: true };
  });
  handle('app:renderer-ready', () => {
    rendererReady = true;
    const queued = pendingActions;
    pendingActions = [];
    if (pendingOpenPath && !queued.includes('open')) queued.push('open');
    for (const name of queued) action(name);
    return { ready: true };
  });
  handle('app:cancel-close', () => {
    closeRequested = false;
    quitRequested = false;
    return { canceled: true };
  });
  handle('app:close', async () => {
    // Only this session is cleared. Unresolved recoveries are stored separately.
    await clearDraft();
    await persistWindowState(); await windowState.flush().catch(() => {});
    await macPreviewQueue.catch(() => {});
    closingApproved = true;
    if (quitRequested) app.quit(); else mainWindow.close();
    return { closed: true };
  }, { queue: true });
}

function buildMenu(snapshot = settings.snapshot()) {
  const mac = process.platform === 'darwin';
  shortcutBindings = shortcuts.resolve(snapshot.values['editor.keyBindings'] || '{}', process.platform);
  const item = (label, command) => ({ id: `command:${command}`, label, ...(shortcutBindings[command] ? { accelerator: shortcutBindings[command] } : {}), click: () => action(command) });
  const template = [
    ...(mac ? [{ label: '墨页', submenu: [{ role: 'about', label: '关于墨页' }, { type: 'separator' }, item('设置…', 'preferences'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide', label: '隐藏墨页' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: '退出墨页' }] }] : []),
    { label: '文件', submenu: [
      item('新建', 'new'), item('打开…', 'open'), item('最近文件…', 'recent'), ...(process.platform === 'linux' ? [item('系统缩略图…', 'system-preview')] : []),
      item('打开文件夹…', 'workspace'), item('同目录上一个文件', 'previous-file'), item('同目录下一个文件', 'next-file'),
      { type: 'separator' }, item('保存', 'save'), item('另存为…', 'save-as'),
      { type: 'separator' }, item('导出 PDF…', 'export-pdf'), item('导出图片…', 'export-image'),
      { type: 'separator' }, item('关闭当前文档', 'close'), item('关闭窗口', 'close-window'), ...(!mac ? [{ role: 'quit', label: '退出' }] : []),
    ] },
    { label: '编辑', submenu: [
      item('撤销', 'undo'), item('重做', 'redo'), { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴为纯文本' }, { role: 'selectAll', label: '全选' },
      { type: 'separator' }, item('查找与替换', 'find'), item('复制为 Markdown', 'copy-markdown'),
      ...(!mac ? [{ type: 'separator' }, item('设置…', 'preferences')] : []),
    ] },
    { label: '格式', submenu: [
      ...['bold', 'italic', 'strike', 'inline-code', 'link'].map(id => item(shortcuts.commands.find(command => command.id === id).label, id)),
      { type: 'separator' },
      ...['code', 'quote', 'list', 'ordered-list', 'table', 'image'].map(id => item(shortcuts.commands.find(command => command.id === id).label, id)),
    ] },
    { label: '视图', submenu: [
      item('切换源码模式', 'source'), item('显示／隐藏大纲', 'outline'),
      item('切换阅读模式', 'reading'),
      item('切换明暗主题', 'theme'), item('专注模式', 'focus'), item('打字机模式', 'typewriter'), item('显示／隐藏格式栏', 'toolbar'),
      { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
    ] },
    { label: '帮助', submenu: [item('编辑器使用说明', 'help'), { role: 'about', label: '关于墨页' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(localization.localizeMenuTemplate(template, nativeLocale())));
}

async function createWindow() {
  closingApproved = false;
  closeRequested = false;
  rendererReady = false;
  pendingActions = [];
  const restoredWindow = await windowState.load(screen.getAllDisplays(), screen.getPrimaryDisplay());
  mainWindow = new BrowserWindow({
    ...restoredWindow.bounds, minWidth: Math.min(740, restoredWindow.bounds.width), minHeight: Math.min(520, restoredWindow.bounds.height),
    title: '墨页', backgroundColor: '#f7f6f2', show: false,
    ...(process.platform !== 'darwin' ? { icon: path.join(__dirname, '..', 'assets', 'icon.png') } : {}),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      // The session flag below toggles checking without rebuilding webContents.
      spellcheck: true,
    },
  });
  mainWindow.once('ready-to-show', () => { if (restoredWindow.maximized) mainWindow.maximize(); mainWindow.show(); });
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'leave-full-screen']) mainWindow.on(event, scheduleWindowState);
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    // A managed key has one owner: the renderer capture listener. Do not cancel
    // the DOM event: it needs the focused control and actual composition state.
    // Other platform menu roles retain Electron's native accelerator handling.
    const managed = shortcuts.matchEvent({ ...input, isComposing: false }, shortcutBindings, process.platform);
    mainWindow.webContents.setIgnoreMenuShortcuts(Boolean(managed));
  });
  mainWindow.on('close', event => {
    // Once ready, renderer checks its current DOM before deciding whether the
    // document is dirty. This closes the input-callback debounce window.
    if (!closingApproved && (rendererReady || dirty)) {
      event.preventDefault();
      if (!closeRequested) { closeRequested = true; action('close-window'); }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  const indexPath = path.join(__dirname, '..', 'src', 'index.html');
  const indexUrl = pathToFileURL(indexPath).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== indexUrl) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.webContents.on('context-menu', (_event, parameters) => {
    const spellcheck = settings.snapshot().values['general.spellcheck'];
    const spellingItems = spellcheck && parameters.misspelledWord ? [
      ...(parameters.dictionarySuggestions?.length ? parameters.dictionarySuggestions.slice(0, 8).map(suggestion => ({ label: suggestion, i18nUserContent: true, click: () => mainWindow?.webContents.replaceMisspelling(suggestion) })) : [{ label: '无拼写建议', enabled: false }]),
      { label: '添加到拼写字典', click: () => session.defaultSession.addWordToSpellCheckerDictionary(parameters.misspelledWord) },
      { type: 'separator' },
    ] : [];
    const menu = Menu.buildFromTemplate(localization.localizeMenuTemplate([
      ...spellingItems,
      { label: '撤销', click: () => action('undo'), enabled: parameters.isEditable },
      { label: '重做', click: () => action('redo'), enabled: parameters.isEditable },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: parameters.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: parameters.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: parameters.editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: '粘贴为纯文本', enabled: parameters.editFlags.canPaste },
      { type: 'separator' }, { role: 'selectAll', label: '全选' },
    ], nativeLocale()));
    menu.popup({ window: mainWindow });
  });
  await mainWindow.loadFile(indexPath);
  clearInterval(externalWatchTimer);
  externalWatchTimer = setInterval(checkExternalDocument, 900); externalWatchTimer.unref();
  if (pendingOpenPath) action('open');
}

function pathFromArguments(argv) {
  return argv.slice(1).find(value => !value.startsWith('-') && /\.(?:md|markdown|mdown|mkd|txt)$/i.test(value) && path.isAbsolute(value));
}

let previewRequest = null, registrationAction = null, startupError = null;
try {
  previewRequest = require('./system-preview.cjs').parsePreviewArgs(process.argv);
  const register = process.argv.includes('--register-system-preview'), unregister = process.argv.includes('--unregister-system-preview');
  if (register && unregister || previewRequest && (register || unregister)) throw new Error('系统预览启动参数冲突。');
  registrationAction = register ? 'install' : unregister ? 'uninstall' : null;
} catch (error) { startupError = error; }

if (startupError) { console.error(startupError.message); app.exit(1); }
else if (previewRequest) {
  // Thumbnail generation is independent of the editing instance and never
  // initializes its recovery/settings stores or takes its single-instance lock.
  // Destroying the capture window must not trigger Electron's default quit
  // before asynchronous cleanup and the CLI result have completed.
  app.on('window-all-closed', () => {});
  const originalUserData = app.getPath('userData');
  const temporaryUserData = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'moye-preview-profile-'));
  app.setPath('userData', temporaryUserData);
  app.whenReady().then(async () => {
    let values = require('../src/settings-schema.js').defaults;
    try {
      const filename = path.join(originalUserData, 'settings.json'), info = await fs.stat(filename);
      if (info.isFile() && info.size <= MAX_SETTINGS_BYTES) values = parseSettings(await fs.readFile(filename, 'utf8')).values;
    } catch { /* A read-only preview uses defaults for inaccessible preferences. */ }
    return require('./system-preview.cjs').runPreview(require('electron'), previewRequest, { preferences: values,
      appearance: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', themesDirectory: path.join(originalUserData, 'document-themes'), encodingMemoryPath: path.join(originalUserData, 'document-encodings.json') });
  }).then(async result => {
    await fs.rm(temporaryUserData, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n', error => error ? reject(error) : resolve()));
    app.exit(0);
  }).catch(async error => {
    console.error(error.message);
    await fs.rm(temporaryUserData, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    app.exit(1);
  });
} else if (registrationAction) {
  app.whenReady().then(async () => {
    if (process.platform !== 'linux' || !app.isPackaged) throw new Error('请在 Linux 桌面发布包中配置系统缩略图。');
    const registration = require('./system-preview-registration.cjs');
    return registrationAction === 'install' ? registration.install({ executable: process.execPath }) : registration.uninstall();
  }).then(async result => { await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result) + '\n', error => error ? reject(error) : resolve())); app.exit(0); }).catch(error => { console.error(error.message); app.exit(1); });
} else if (!(automatedTest || app.requestSingleInstanceLock())) app.quit();
else {
  pendingOpenPath = pathFromArguments(process.argv) || null;
  app.on('second-instance', (_event, argv) => {
    const selectedPath = pathFromArguments(argv);
    if (selectedPath) { pendingOpenPath = selectedPath; action('open'); }
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.on('open-file', (event, selectedPath) => {
    event.preventDefault();
    pendingOpenPath = selectedPath;
    if (mainWindow && !mainWindow.webContents.isLoading()) action('open');
  });
  app.on('before-quit', () => { quitRequested = true; });
  app.whenReady().then(async () => {
    await recentFiles.initialize();
    recovery = new RecoveryStore(app.getPath('userData'));
    await recovery.initialize();
    settings = new SettingsStore(app.getPath('userData'));
    await settings.initialize();
    settings.watch(snapshot => applyNativeSettings(snapshot));
    themes = new ThemeStore({ directory: path.join(app.getPath('userData'), 'document-themes') });
    await themes.get();
    themes.watch(snapshot => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('themes:changed', snapshot); });
    applyNativeSettings(settings.snapshot());
    nativeTheme.on('updated', () => {
      if (settings) applyNativeSettings(settings.snapshot());
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    app.setAboutPanelOptions({ applicationName: translate('墨页 Moye'), applicationVersion: app.getVersion(), copyright: translate('本地 Markdown 编辑器') });
    registerIpc();
    buildMenu();
    await createWindow();
    app.on('activate', () => { if (!mainWindow) { documents.reset(); markEdited(false); createWindow(); } });
  }).catch(error => { dialog.showErrorBox('墨页无法启动', error.message); app.quit(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { clearInterval(externalWatchTimer); clearTimeout(windowStateTimer); workspace.close(); documentNavigation.close(); themes?.dispose(); settings?.dispose(); });
}
