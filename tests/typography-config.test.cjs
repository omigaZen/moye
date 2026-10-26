'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const typography = require('../src/typography-config.js');

test('daily profile preserves existing Moye defaults and includes view-only table defaults', () => {
  const profile = typography.getProfile('daily');
  assert.equal(profile.values['appearance.fontSize'], 17);
  assert.equal(profile.values['appearance.contentWidth'], 780);
  assert.equal(profile.values['appearance.lineHeight'], 1.85);
  assert.equal(profile.values['table.layout'], 'body');
  assert.equal(profile.values['table.style'], 'grid');
  assert.equal(profile.values['table.alignment'], 'start');
  assert.equal(typography.modified(profile.values), false);
});

test('profiles switch atomically and modified state compares against the selected baseline', () => {
  let values = { ...typography.defaults, ...typography.applyProfile('technical') };
  assert.equal(values['appearance.contentWidth'], 900);
  assert.equal(typography.modified(values), false);
  values = { ...values, 'appearance.fontSize': 18 };
  assert.equal(typography.modified(values), true);
  assert.equal(typography.baseline(values)['appearance.fontSize'], 17);
  assert.throws(() => typography.applyProfile('missing'), /不存在/);
});

test('saving and cloning profiles preserves only supported visual fields, never document content', () => {
  let values = { ...typography.defaults, ...typography.applyProfile('book'), 'document.content': 'private', 'appearance.fontSize': 21 };
  values = { ...values, ...typography.saveProfile(values, '我的长文') };
  assert.equal(values['typography.activeProfile'], 'user-1');
  const saved = typography.getProfile('user-1', values);
  assert.equal(saved.builtin, false);
  assert.equal(saved.values['appearance.fontSize'], 21);
  assert.equal(saved.values['typography.textAlign'], 'optimal');
  assert.ok(!values['typography.savedProfiles'].includes('private'));
  assert.equal(typography.modified(values), false);
  const clone = typography.saveProfile(values, '我的长文副本');
  assert.equal(clone['typography.activeProfile'], 'user-2');
  assert.deepEqual(typography.getProfile('user-2', { ...values, ...clone }).values, saved.values);
});

test('deleting a selected custom profile retains current visual values and returns a modified daily baseline', () => {
  let values = { ...typography.defaults, ...typography.applyProfile('compact') };
  values = { ...values, ...typography.saveProfile(values, '临时方案') };
  const patch = typography.removeProfile('user-1', values);
  assert.deepEqual(Object.keys(patch).sort(), ['typography.activeProfile', 'typography.savedProfiles']);
  values = { ...values, ...patch };
  assert.equal(values['appearance.fontSize'], 15);
  assert.equal(values['typography.activeProfile'], 'daily');
  assert.equal(typography.modified(values), true);
  assert.throws(() => typography.removeProfile('daily', values), /内置/);
});

test('imported profiles reject arbitrary settings, duplicate identities and malformed data', () => {
  const one = { id: 'user-1', name: '合法', values: { 'appearance.fontSize': 20 } };
  assert.equal(typography.parseProfiles(JSON.stringify([one]))[0].values['table.layout'], 'body');
  for (const bad of [null, '{}', '[', JSON.stringify([{ ...one, id: '__proto__' }]), JSON.stringify([{ ...one, name: '日常书写' }]), JSON.stringify([one, one]), JSON.stringify([{ ...one, values: { 'general.autoSave': true } }]), '[{"id":"user-1","name":"恶意","values":{"__proto__":{}}}]']) {
    assert.throws(() => typography.parseProfiles(bad));
  }
  assert.throws(() => typography.parseProfiles(' '.repeat(65537)), /过长/);
});

test('profile limits and names are bounded for UI and durable preferences', () => {
  assert.throws(() => typography.saveProfile({}, ''), /名称/);
  assert.throws(() => typography.saveProfile({}, 'a'.repeat(41)), /名称/);
  assert.throws(() => typography.saveProfile({}, '日常书写'), /同名/);
  let values = { ...typography.defaults };
  for (let index = 1; index <= typography.maximumProfiles; index++) values = { ...values, ...typography.saveProfile(values, `方案${index}`) };
  assert.equal(typography.profiles(values).length, 36);
  assert.throws(() => typography.saveProfile(values, '超限'), /最多/);
});

test('typography validators reject unsafe font CSS and invalid legal values', () => {
  for (const value of ['Arial; color:red', '<style>', 'a\nb', '', 'x'.repeat(201)]) assert.throws(() => typography.validateSetting('typography.latinFontFamily', value));
  assert.equal(typography.validateSetting('typography.latinFontFamily', 'inherit'), 'inherit');
  for (const [key, value] of [['typography.cjkSpacing', 1], ['typography.paragraphStyle', 'other'], ['typography.colorTheme', 'bad'], ['typography.activeProfile', 'x'], ['appearance.lineHeight', 1.83], ['appearance.contentWidth', 781], ['appearance.fontSize', Infinity]]) assert.throws(() => typography.validateSetting(key, value));
  assert.equal(typography.validateSetting('typography.textAlign', 'optimal'), 'optimal');
  assert.equal(typography.validateSetting('typography.colorTheme', 'custom:My_Theme-1'), 'custom:My_Theme-1');
  assert.throws(() => typography.validateSetting('typography.colorTheme', 'custom:../theme'));
});

test('returned profile copies cannot mutate builtins or subsequent baseline results', () => {
  const profile = typography.getProfile('daily'); profile.values['appearance.fontSize'] = 99;
  assert.equal(typography.getProfile('daily').values['appearance.fontSize'], 17);
  const baseline = typography.baseline(); baseline['appearance.fontSize'] = 99;
  assert.equal(typography.baseline()['appearance.fontSize'], 17);
});


test('punctuation compression is a validated profile field and old profiles acquire the safe default', () => {
  assert.equal(typography.defaults['typography.punctuationCompression'], false);
  assert.equal(typography.getProfile('book').values['typography.punctuationCompression'], true);
  const old = typography.parseProfiles('[{"id":"user-1","name":"旧方案","values":{"appearance.fontSize":18}}]')[0];
  assert.equal(old.values['typography.punctuationCompression'], false);
  const values = { ...typography.defaults, 'typography.punctuationCompression': true };
  const patch = typography.saveProfile(values, '标点方案');
  assert.equal(typography.getProfile(patch['typography.activeProfile'], patch).values['typography.punctuationCompression'], true);
  assert.throws(() => typography.validateSetting('typography.punctuationCompression', 'true'));
});
