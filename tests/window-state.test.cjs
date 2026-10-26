'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WindowStateStore, validateWindowState, restoreWindowState, MAX_STATE_BYTES } = require('../electron/window-state.cjs');
const primary = { id: 1, workArea: { x: 0, y: 24, width: 1920, height: 1056 } };
const left = { id: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1080 } };
const state = (bounds = { x: 120, y: 100, width: 1280, height: 860 }, maximized = false, displayId = 1) => ({ bounds, maximized, displayId });
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-window-state-')); t.after(() => fs.rm(root, { recursive: true, force: true })); const filePath = path.join(root, 'profile', 'window.json'); return { root, filePath, store: new WindowStateStore(filePath) }; }

test('window defaults are centered in the primary work area and never restore fullscreen', () => {
  const restored = restoreWindowState(null, [left, primary], primary);
  assert.deepEqual(restored, { bounds: { x: 320, y: 122, width: 1280, height: 860 }, maximized: false, displayId: '1' });
  assert.equal(Object.hasOwn(restored, 'fullscreen'), false);
});
test('negative-coordinate multi-monitor normal bounds and maximized state survive restoration', () => {
  const before = state({ x: -1750, y: -120, width: 1000, height: 700 }, true, 2);
  assert.deepEqual(restoreWindowState(before, [primary, left], primary), { ...before, displayId: '2' });
});
test('a removed display falls back by overlap and clamps a fully offscreen window onto the primary', () => {
  const restored = restoreWindowState(state({ x: -1800, y: -100, width: 1200, height: 800 }, true, 2), [primary], primary);
  assert.deepEqual(restored, { bounds: { x: 0, y: 24, width: 1200, height: 800 }, maximized: true, displayId: '1' });
});
test('resolution reduction clamps the complete window within its retained display work area', () => {
  const smaller = { id: 2, workArea: { x: -1280, y: 30, width: 1280, height: 690 } };
  const restored = restoreWindowState(state({ x: -1900, y: -100, width: 1800, height: 1000 }, false, 2), [primary, smaller], primary);
  assert.deepEqual(restored.bounds, smaller.workArea);
});
test('screens smaller than the UI minimum receive the whole available area instead of an oversized window', () => {
  const tiny = { id: 8, workArea: { x: 80, y: 40, width: 600, height: 400 } };
  const restored = restoreWindowState(state({ x: -100, y: -100, width: 100, height: 100 }), [tiny], tiny);
  assert.deepEqual(restored.bounds, tiny.workArea);
});
test('valid large screens enlarge undersized saved windows to the 740 by 520 UI minimum', () => {
  const restored = restoreWindowState(state({ x: 500, y: 200, width: 100, height: 120 }), [primary], primary);
  assert.deepEqual(restored.bounds, { x: 500, y: 200, width: 740, height: 520 });
});
test('without a retained display ID the greatest visible intersection chooses the correct monitor', () => {
  const right = { id: 3, workArea: { x: 1920, y: 24, width: 1920, height: 1056 } };
  const restored = restoreWindowState(state({ x: 1800, y: 100, width: 1200, height: 800 }, false, null), [primary, right], primary);
  assert.equal(restored.displayId, '3'); assert.deepEqual(restored.bounds, { x: 1920, y: 100, width: 1200, height: 800 });
});
test('display repositioning preserves the retained display association but removes all offscreen coordinates', () => {
  const moved = { id: 2, workArea: { x: 1920, y: -1080, width: 1920, height: 1080 } };
  const restored = restoreWindowState(state({ x: -1800, y: -100, width: 1280, height: 860 }, false, 2), [primary, moved], primary);
  assert.deepEqual(restored, { bounds: { x: 1920, y: -860, width: 1280, height: 860 }, maximized: false, displayId: '2' });
});
test('malformed rectangles, unbounded numbers, accessor fields and fullscreen payloads are not accepted', () => {
  for (const value of [NaN, Infinity, 1000001, -1000001, '10', 0.5]) assert.equal(validateWindowState(state({ x: value, y: 10, width: 1000, height: 800 })), null);
  for (const value of [0, -1, 100001, Infinity, '1000']) assert.equal(validateWindowState(state({ x: 10, y: 10, width: value, height: 800 })), null);
  assert.equal(validateWindowState({ ...state(), fullscreen: true }), null);
  assert.equal(validateWindowState({ ...state(), maximized: 'true' }), null);
  assert.equal(validateWindowState({ ...state(), displayId: 'x'.repeat(129) }), null);
  let touched = false; const getter = Object.defineProperty({}, 'bounds', { enumerable: true, get() { touched = true; return state().bounds; } });
  assert.equal(validateWindowState(getter), null); assert.equal(touched, false);
  const restored = restoreWindowState({ ...state(), fullscreen: true }, [primary], primary); assert.equal(restored.maximized, false); assert.equal(Object.hasOwn(restored, 'fullscreen'), false);
});
test('unavailable or malformed display descriptions still produce finite fallback bounds', () => {
  const restored = restoreWindowState(null, [{ id: 1, workArea: { x: NaN, y: 0, width: 0, height: 0 } }], null);
  assert.deepEqual(restored.bounds, { x: 320, y: 110, width: 1280, height: 860 });
  assert.ok(Object.values(restored.bounds).every(Number.isSafeInteger));
});
test('normal bounds and maximized state persist by value, without document or fullscreen data', async t => {
  const { store, filePath } = await fixture(t), saved = state({ x: -1750, y: -120, width: 1000, height: 700 }, true, 2);
  const write = store.save(saved); saved.bounds.x = 500; await write; await store.flush();
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8')); assert.deepEqual(Object.keys(raw).sort(), ['bounds', 'displayId', 'maximized', 'version']);
  assert.equal(raw.bounds.x, -1750); assert.equal(raw.maximized, true); assert.equal(raw.displayId, '2');
  const reopened = await new WindowStateStore(filePath).load([primary, left], primary); assert.equal(reopened.bounds.x, -1750); assert.equal(reopened.maximized, true);
});
test('queued move and resize snapshots preserve call order and load waits for the final atomic write', async t => {
  const { store, filePath } = await fixture(t);
  const writes = Array.from({ length: 12 }, (_, index) => store.save(state({ x: index * 5, y: 100, width: 1000 + index, height: 700 }, index % 2 === 0)));
  const read = store.load([primary], primary); await Promise.all(writes); const result = await read; await store.flush();
  assert.deepEqual(result.bounds, { x: 55, y: 100, width: 1011, height: 700 }); assert.equal(result.maximized, false);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, 'utf8')).bounds, result.bounds);
});
test('bad JSON, wrong versions and the 16 KiB cap recover safely without rewriting saved bytes', async t => {
  const { store, filePath } = await fixture(t); await fs.mkdir(path.dirname(filePath));
  for (const bytes of ['{broken', ' '.repeat(MAX_STATE_BYTES + 1), JSON.stringify({ version: 9, ...state() }), JSON.stringify({ version: 1, ...state(), fullscreen: true })]) {
    await fs.writeFile(filePath, bytes); const result = await store.load([primary], primary);
    assert.equal(result.maximized, false); assert.equal(result.bounds.width, 1280); assert.ok(store.warning); assert.equal(await fs.readFile(filePath, 'utf8'), bytes);
  }
});
test('symlinked config is not followed and failed writes do not poison the later save queue', async t => {
  const { root, store, filePath } = await fixture(t); await fs.mkdir(path.dirname(filePath));
  const target = path.join(root, 'private.txt'); await fs.writeFile(target, 'not window settings'); await fs.symlink(target, filePath);
  await store.load([primary], primary); assert.ok(store.warning); await store.save(state()); assert.equal(await fs.readFile(target, 'utf8'), 'not window settings'); assert.equal((await fs.lstat(filePath)).isSymbolicLink(), false);
  await fs.unlink(filePath); await fs.mkdir(filePath); await assert.rejects(store.save(state())); await assert.rejects(store.flush());
  await fs.rmdir(filePath); await store.save(state({ x: 30, y: 40, width: 900, height: 650 }, true)); await store.flush();
  assert.equal((await store.load([primary], primary)).maximized, true); assert.equal(store.warning, '');
});
