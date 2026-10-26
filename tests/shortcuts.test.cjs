'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const shortcuts = require('../src/shortcut-config.js');

test('platform primary aliases resolve semantically, with independent Ctrl and Meta modifiers', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const primary = platform === 'darwin' ? 'Command+Shift+P' : 'Ctrl+Shift+P';
    assert.equal(shortcuts.normalizeAccelerator('CommandOrControl + SHIFT + p', platform).signature, shortcuts.normalizeAccelerator(primary, platform).signature);
    assert.equal(shortcuts.normalizeAccelerator('Control+Option+p', platform).signature, 'Ctrl+Alt+P');
    assert.equal(shortcuts.normalizeAccelerator('Meta+P', platform).signature, 'Meta+P');
    assert.notEqual(shortcuts.normalizeAccelerator('Ctrl+P', platform).signature, shortcuts.normalizeAccelerator('Command+P', platform).signature);
    const defaults = shortcuts.resolve('{}', platform);
    assert.equal(defaults.focus, 'F8'); assert.equal(defaults.typewriter, 'F9');
    assert.equal(Object.keys(defaults).length, shortcuts.commands.length);
  }
});

test('shifted punctuation and names collide with the same physical accelerator', () => {
  const equivalent = [['Ctrl+?', 'Ctrl+Shift+/'], ['Ctrl+Plus', 'Ctrl+Shift+='], ['Ctrl+{', 'Ctrl+Shift+['], ['Cmd+Esc', 'Meta+Escape']];
  for (const [left, right] of equivalent) assert.equal(shortcuts.normalizeAccelerator(left, 'linux').signature, shortcuts.normalizeAccelerator(right, 'linux').signature);
  assert.throws(() => shortcuts.resolve(JSON.stringify({ bold: 'Control+?', italic: 'Ctrl+Shift+/' }), 'linux'), /同时分配/);
});

test('overrides replace defaults, disable with an empty string, and may atomically swap commands', () => {
  const result = shortcuts.resolve(JSON.stringify({ bold: 'Ctrl+I', italic: 'Ctrl+B', save: '' }), 'linux');
  assert.equal(result.bold, 'Ctrl+I'); assert.equal(result.italic, 'Ctrl+B'); assert.equal(result.save, '');
  assert.equal(shortcuts.resolve('{}', 'linux').save, 'Ctrl+S');
  assert.throws(() => shortcuts.resolve('{"bold":"Control+S"}', 'linux'), /同时分配/);
  assert.throws(() => shortcuts.resolve('{"bold":"CmdOrCtrl+S"}', 'darwin'), /同时分配/);
});

test('fixed edit and native menu accelerators cannot be stolen', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const primary = platform === 'darwin' ? 'Command' : 'Ctrl';
    for (const chord of [`${primary}+C`, `${primary}+X`, `${primary}+V`, `${primary}+Shift+V`, `${primary}+A`, `${primary}+Enter`, `${primary}+Plus`, `${primary}+-`, `${primary}+0`, `${primary}+Backspace`, `${primary}+Shift+Left`, 'Ctrl+Space', 'Alt+Tab', 'F11', 'Alt+F4']) {
      assert.throws(() => shortcuts.resolve(JSON.stringify({ bold: chord }), platform), /固定的系统或编辑快捷键冲突/, `${platform}: ${chord}`);
    }
  }
});

test('malformed, unsafe, and unknown shortcut settings are rejected before use', () => {
  for (const raw of ['null', '[]', 'true', '42', '{', '{"__proto__":"Ctrl+P"}', '{"missing":"Ctrl+P"}', '{"bold":3}', '{"bold":null}', '{"bold":"B"}', '{"bold":"Shift+B"}', '{"bold":"Ctrl+Ctrl+P"}', '{"bold":"Ctrl+P+K"}', '{"bold":"Ctrl+"}', '{"bold":"Ctrl+F25"}', '{"bold":"Ctrl+\u0000B"}']) {
    assert.throws(() => shortcuts.validateKeyBindings(raw, 'linux'), TypeError, raw);
  }
  assert.throws(() => shortcuts.validateKeyBindings(' '.repeat(16385), 'linux'), TypeError);
  assert.doesNotThrow(() => shortcuts.validateKeyBindings('{"bold":""}', 'linux'));
});

test('DOM and Electron input descriptions match one command and preserve IME/AltGraph', () => {
  const bindings = shortcuts.resolve('{"bold":"Ctrl+Alt+P"}', 'linux');
  assert.equal(shortcuts.matchEvent({ key: 'p', ctrlKey: true, altKey: true }, bindings, 'linux'), 'bold');
  assert.equal(shortcuts.matchEvent({ key: 'p', control: true, alt: true }, bindings, 'linux'), 'bold');
  assert.equal(shortcuts.matchEvent({ key: 'b', ctrlKey: true }, bindings, 'linux'), null);
  assert.equal(shortcuts.matchEvent({ key: 'p', ctrlKey: true, altKey: true, isComposing: true }, bindings, 'linux'), null);
  assert.equal(shortcuts.matchEvent({ key: 'p', ctrlKey: true, altKey: true, keyCode: 229 }, bindings, 'linux'), null);
  assert.equal(shortcuts.matchEvent({ key: 'p', ctrlKey: true, altKey: true, getModifierState: key => key === 'AltGraph' }, bindings, 'linux'), null);
  assert.equal(shortcuts.matchEvent({ key: '`', ctrlKey: true, shiftKey: true }, bindings, 'linux'), 'inline-code');
});

test('invalid shortcut multi-setting updates leave the current revision and file unchanged', async t => {
  const { SettingsStore } = require('../electron/settings-store.cjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-shortcut-validation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.initialize();
  await store.update({ 'editor.keyBindings': '{"bold":"Ctrl+Alt+P"}' });
  const before = store.snapshot(), saved = await fs.readFile(store.filePath, 'utf8');
  assert.throws(() => store.update({ 'appearance.fontSize': 22, 'editor.keyBindings': '{"bold":"Ctrl+C"}' }), /快捷键/);
  assert.deepEqual(store.snapshot(), before); assert.equal(await fs.readFile(store.filePath, 'utf8'), saved);
  const restarted = new SettingsStore(directory);
  assert.equal((await restarted.get()).values['editor.keyBindings'], '{"bold":"Ctrl+Alt+P"}');
  assert.equal(JSON.parse(await store.export()).values['editor.keyBindings'], '{"bold":"Ctrl+Alt+P"}');
});

test('new reading commands do not invalidate an existing custom redo binding on upgrade', () => {
  const bindings = shortcuts.resolve('{"redo":"Ctrl+Alt+R"}', 'linux');
  assert.equal(shortcuts.matchEvent({key:'r',ctrlKey:true,altKey:true}, bindings, 'linux'), 'redo');
  assert.throws(() => shortcuts.validateKeyBindings('{"redo":"Ctrl+Alt+R","reading":"Ctrl+Alt+R"}'), /同时分配/);
});
