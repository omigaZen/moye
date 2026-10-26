'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Each bridge method maps to one fixed capability. Arbitrary IPC and filesystem
// paths are deliberately not exposed to document content.
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  openDocument: () => ipcRenderer.invoke('document:open'),
  saveDocument: (options) => ipcRenderer.invoke('document:save', options),
  exportDocument: payload => ipcRenderer.invoke('document:export', payload),
  checkExportResources: options => ipcRenderer.invoke('export:resources', options),
  newDocument: () => ipcRenderer.invoke('document:new'),
  listRecentFiles: () => ipcRenderer.invoke('recent:list'),
  openRecentFile: options => ipcRenderer.invoke('recent:open', options),
  removeRecentFile: options => ipcRenderer.invoke('recent:remove', options),
  clearRecentFiles: () => ipcRenderer.invoke('recent:clear'),
  rememberCurrentRecent: options => ipcRenderer.invoke('recent:remember-current', options),
  configureSystemPreview: () => ipcRenderer.invoke('system-preview:configure'),
  documentNeighbor: options => ipcRenderer.invoke('document:neighbor', options),
  openDocumentNeighbor: options => ipcRenderer.invoke('document:neighbor-open', options),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  listWorkspace: options => ipcRenderer.invoke('workspace:list', options),
  openWorkspaceEntry: options => ipcRenderer.invoke('workspace:open', options),
  changeEncoding: options => ipcRenderer.invoke('document:encoding', options),
  reloadDocument: options => ipcRenderer.invoke('document:reload', options),
  onExternalChange: callback => {
    if (typeof callback !== 'function') throw new TypeError('Document callback must be a function.');
    const handler = (_event, update) => callback(update);
    ipcRenderer.on('document:external-change', handler);
    return () => ipcRenderer.removeListener('document:external-change', handler);
  },
  workspaceNeighbor: options => ipcRenderer.invoke('workspace:neighbor', options),
  onWorkspaceChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Workspace callback must be a function.');
    const handler = (_event, update) => callback(update);
    ipcRenderer.on('workspace:changed', handler);
    return () => ipcRenderer.removeListener('workspace:changed', handler);
  },
  chooseImages: () => ipcRenderer.invoke('image:choose'),
  importImage: (image) => ipcRenderer.invoke('image:import', image),
  setEdited: (state) => ipcRenderer.send('document:edited', state),
  stashDraft: (draft) => ipcRenderer.invoke('draft:stash', draft),
  getDraft: () => ipcRenderer.invoke('draft:get'),
  restoreDraft: () => ipcRenderer.invoke('draft:restore'),
  clearDraft: () => ipcRenderer.invoke('draft:clear'),
  getPlatform: () => ipcRenderer.invoke('app:platform'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  reloadSettings: () => ipcRenderer.invoke('settings:reload'),
  openSettingsFile: () => ipcRenderer.invoke('settings:open-file'),
  getThemes: () => ipcRenderer.invoke('themes:get'),
  saveTheme: options => ipcRenderer.invoke('themes:save', options),
  removeTheme: options => ipcRenderer.invoke('themes:remove', options),
  openThemesFolder: () => ipcRenderer.invoke('themes:open-folder'),
  onThemesChanged: callback => {
    if (typeof callback !== 'function') throw new TypeError('Theme callback must be a function.');
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('themes:changed', handler);
    return () => ipcRenderer.removeListener('themes:changed', handler);
  },
  updateSettings: (options) => ipcRenderer.invoke('settings:update', options),
  resetSettings: (options) => ipcRenderer.invoke('settings:reset', options),
  importSettings: (options) => ipcRenderer.invoke('settings:import', options),
  exportSettings: () => ipcRenderer.invoke('settings:export'),
  onSettingsChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Settings callback must be a function.');
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
  writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write-text', payload),
  getSessionDocument: () => ipcRenderer.invoke('document:session'),
  openSample: (options) => ipcRenderer.invoke('document:sample', options),
  ready: () => ipcRenderer.invoke('app:renderer-ready'),
  confirmDiscard: () => ipcRenderer.invoke('document:confirm-discard'),
  cancelClose: () => ipcRenderer.invoke('app:cancel-close'),
  closeWindow: () => ipcRenderer.invoke('app:close'),
  onAction: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Action callback must be a function.');
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('app:action', handler);
    return () => ipcRenderer.removeListener('app:action', handler);
  },
}));
