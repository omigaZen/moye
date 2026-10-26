'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./file-store.cjs');

const MAX_STATE_BYTES = 16 * 1024, MAX_COORDINATE = 1000000, MAX_DIMENSION = 100000;
const MIN_WIDTH = 740, MIN_HEIGHT = 520;
const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 860 });
const FALLBACK_DISPLAY = Object.freeze({ id: 'fallback', workArea: Object.freeze({ x: 0, y: 0, width: 1920, height: 1080 }) });

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function dataProperties(value, allowed) {
  if (!plain(value)) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function rectangle(value) {
  if (!dataProperties(value, ['x', 'y', 'width', 'height']) || !['x', 'y', 'width', 'height'].every(key => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]))) return null;
  const { x, y, width, height } = value;
  if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || x + width > MAX_COORDINATE || y + height > MAX_COORDINATE) return null;
  return { x, y, width, height };
}
function displayId(value) {
  if (value === null || value === undefined) return null;
  if (Number.isSafeInteger(value) && value >= -1 && value <= 0xffffffff) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return undefined;
}
function validateWindowState(value) {
  if (!dataProperties(value, ['version', 'bounds', 'maximized', 'displayId']) || value.version !== undefined && value.version !== 1 || typeof value.maximized !== 'boolean') return null;
  const bounds = rectangle(value.bounds), id = displayId(value.displayId);
  return bounds && id !== undefined ? { bounds, maximized: value.maximized, displayId: id } : null;
}
function areaIntersection(a, b) { return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); }
function validDisplay(value) {
  if (!value || typeof value !== 'object') return null;
  const id = displayId(value.id), area = rectangle(value.workArea);
  return id !== undefined && id !== null && area ? { id, workArea: area } : null;
}

// getAllDisplays()/getPrimaryDisplay() use DIP work areas. Never assume that a
// usable display begins at (0,0), or that the saved display still exists.
function restoreWindowState(saved, displays, primaryDisplay) {
  const state = validateWindowState(saved), primary = validDisplay(primaryDisplay);
  const available = (Array.isArray(displays) ? displays.slice(0, 256) : []).map(validDisplay).filter(Boolean);
  if (primary && !available.some(display => display.id === primary.id)) available.push(primary);
  if (!available.length) available.push(FALLBACK_DISPLAY);
  const fallback = available.find(display => display.id === primary?.id) || available[0];
  let target = state && available.find(display => display.id === state.displayId);
  if (!target && state) {
    let largest = 0;
    for (const display of available) { const intersection = areaIntersection(state.bounds, display.workArea); if (intersection > largest) { largest = intersection; target = display; } }
  }
  target ||= fallback;
  const area = target.workArea, desired = state?.bounds || DEFAULT_SIZE;
  const width = Math.min(area.width, Math.max(MIN_WIDTH, desired.width)), height = Math.min(area.height, Math.max(MIN_HEIGHT, desired.height));
  const x = state ? Math.min(Math.max(state.bounds.x, area.x), area.x + area.width - width) : area.x + Math.floor((area.width - width) / 2);
  const y = state ? Math.min(Math.max(state.bounds.y, area.y), area.y + area.height - height) : area.y + Math.floor((area.height - height) / 2);
  return { bounds: { x, y, width, height }, maximized: state?.maximized === true, displayId: target.id };
}

class WindowStateStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.length > 32768 || filePath.includes('\0')) throw new TypeError('窗口状态需要绝对存储路径。');
    this.filePath = filePath; this.queue = Promise.resolve(); this.pending = this.queue; this.warning = '';
  }
  serialize(operation) { const next = this.queue.then(operation); this.queue = next.catch(() => {}); this.pending = next; return next; }
  load(displays, primaryDisplay) {
    return this.serialize(async () => {
      let saved = null; this.warning = '';
      try {
        const info = await fs.lstat(this.filePath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('Invalid window state file');
        const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (data?.version !== 1 || !(saved = validateWindowState(data))) throw new Error('Invalid window state');
      } catch (error) { if (error.code !== 'ENOENT') this.warning = '窗口状态无法读取，已放入当前可用屏幕。'; }
      return restoreWindowState(saved, displays, primaryDisplay);
    });
  }
  save(value) {
    const state = validateWindowState(value);
    if (!state) return Promise.reject(new TypeError('窗口状态无效。'));
    // Capture by value before enqueueing. Later move/resize events or caller
    // mutations cannot alter this write or overtake a newer queued snapshot.
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...state }) + '\n');
    if (bytes.length > MAX_STATE_BYTES) return Promise.reject(new Error('窗口状态超过 16 KiB。'));
    return this.serialize(async () => { await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 }); await atomicWrite(this.filePath, bytes); this.warning = ''; return state; });
  }
  flush() { return this.pending; }
}

module.exports = { WindowStateStore, validateWindowState, restoreWindowState, MIN_WIDTH, MIN_HEIGHT, DEFAULT_SIZE, MAX_STATE_BYTES, MAX_COORDINATE, MAX_DIMENSION };
