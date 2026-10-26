'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n.js');
const native = require('../electron/localization.cjs');
const schema = require('../src/settings-schema.js');

test('locale selection preserves the Chinese default and resolves explicit system choice', () => {
  assert.equal(i18n.resolveLocale(), 'zh-CN');
  assert.equal(i18n.resolveLocale('zh-CN', 'en-US'), 'zh-CN');
  assert.equal(i18n.resolveLocale('en-US', 'zh-CN'), 'en-US');
  assert.equal(i18n.resolveLocale('system', 'zh-TW'), 'zh-CN');
  assert.equal(i18n.resolveLocale('system', 'en-GB'), 'en-US');
  assert.equal(i18n.resolveLocale('system', 'ja-JP'), 'en-US');
  assert.equal(i18n.resolveLocale('unknown'), 'zh-CN');
});
test('every implemented setting and command has complete English presentation vocabulary', () => {
  const missing = [];
  for (const definition of schema.definitions) {
    for (const value of [definition.label, definition.category, definition.description, ...(definition.options || []).map(option => option.label)]) {
      if (typeof value === 'string' && /\p{Script=Han}/u.test(value) && value !== '简体中文' && /\p{Script=Han}/u.test(i18n.t(value, 'en-US'))) missing.push({ key: definition.key, value });
    }
  }
  for (const command of require('../src/shortcut-config.js').commands) if (/\p{Script=Han}/u.test(i18n.t(command.label, 'en-US'))) missing.push({ command: command.id, value: command.label });
  assert.deepEqual(missing, []);
});
test('dynamic UI messages preserve file names and replacement metacharacters literally', () => {
  const file = '保存：取消 $& <script> [x].md';
  assert.equal(i18n.t(`文件 ${file} 已存在。`, 'en-US'), `File ${file} already exists.`);
  assert.equal(i18n.t(`下一篇：${file}`, 'en-US'), `Next document: ${file}`);
  assert.equal(i18n.t(`移除记录 ${file}`, 'en-US'), `Remove record ${file}`);
  assert.equal(i18n.t('已选 18 字符', 'en-US'), '18 characters selected');
  assert.equal(i18n.t('第 4 行：引号未闭合。', 'en-US'), 'Line 4: Unterminated quote.');
  assert.equal(i18n.t('外部设置文件暂未载入，继续使用上次有效设置。设置文件不是有效 JSON。', 'en-US'), 'External settings could not be loaded yet. The last valid settings remain in use. The settings file is not valid JSON.');
});
test('Chinese, unknown input, form values and oversized strings are never rewritten by the pure translator', () => {
  for (const value of ['保存', '未命名.md', '我的私人段落', 'const 保存 = 1;', 'x'.repeat(5000), null, undefined, 42]) assert.equal(i18n.t(value, 'zh-CN'), value);
  assert.equal(i18n.t('我的私人段落', 'en-US'), '我的私人段落');
  assert.equal(i18n.t('x'.repeat(5000), 'en-US'), 'x'.repeat(5000));
  assert.equal(i18n.t('  保存  ', 'en-US'), '  Save  ');
  const osError = "ENOENT: no such file or directory, open '/tmp/保存：取消.md'";
  assert.equal(i18n.t(osError, 'en-US'), osError);
  assert.equal(i18n.t('保存：取消', 'en-US'), '保存：取消');
  assert.equal(i18n.t('/tmp/保存：取消.md', 'en-US'), '/tmp/保存：取消.md');
  assert.equal(i18n.t('：', 'en-US'), ': '); // Only a standalone application separator.
  assert.equal(i18n.t('：', 'zh-CN'), '：');
});
test('native menus retain callbacks, accelerators, roles and user labels without mutating source', () => {
  const callback = () => {}, source = [{ label: '文件', submenu: [{ label: '保存', accelerator: 'Ctrl+S', click: callback }, { label: '保存', i18nUserContent: true }, { role: 'hideOthers' }] }];
  const result = native.localizeMenuTemplate(source, 'en-US');
  assert.equal(result[0].label, 'File'); assert.equal(result[0].submenu[0].label, 'Save');
  assert.equal(result[0].submenu[0].click, callback); assert.equal(result[0].submenu[0].accelerator, 'Ctrl+S');
  assert.equal(result[0].submenu[1].label, '保存'); assert.equal(Object.hasOwn(result[0].submenu[1], 'i18nUserContent'), false);
  assert.equal(result[0].submenu[2].label, 'Hide others'); assert.equal(result[0].submenu[2].role, 'hideOthers');
  assert.equal(source[0].label, '文件'); assert.equal(source[0].submenu[0].label, '保存');
});
test('native dialogs translate only UI fields while preserving chosen paths and options', () => {
  const source = { title: '保存 Markdown 文档', message: '文件 保存.md 已存在。', detail: '未保存的更改将在放弃后丢失。', buttons: ['保存', '取消'], filters: [{ name: 'Markdown 文档', extensions: ['md', 'txt'] }], defaultPath: '/私人/保存.md', properties: ['createDirectory'], defaultId: 1 };
  const result = native.localizeDialogOptions(source, 'en-US', 'zh-CN', 'save');
  assert.equal(result.title, 'Save Markdown document'); assert.equal(result.message, 'File 保存.md already exists.');
  assert.deepEqual(result.buttons, ['Save', 'Cancel']); assert.equal(result.buttonLabel, 'Save');
  assert.equal(result.defaultPath, source.defaultPath); assert.equal(result.defaultId, 1); assert.deepEqual(result.properties, ['createDirectory']);
  assert.equal(result.filters[0].name, 'Markdown documents'); assert.deepEqual(result.filters[0].extensions, ['md', 'txt']);
  assert.equal(source.title, '保存 Markdown 文档'); assert.equal(source.filters[0].name, 'Markdown 文档');
});
test('localized definitions remain independent presentation copies with stable configuration values', () => {
  const translated = i18n.localizeDefinitions(schema.definitions, 'en-US');
  assert.equal(translated.length, schema.definitions.length);
  for (let index = 0; index < translated.length; index++) {
    assert.equal(translated[index].key, schema.definitions[index].key);
    assert.equal(translated[index].default, schema.definitions[index].default);
    if (translated[index].options) assert.deepEqual(translated[index].options.map(option => option.value), schema.definitions[index].options.map(option => option.value));
  }
  assert.equal(schema.definitions.find(item => item.key === 'appearance.fontSize').label, '正文字号');
  assert.equal(translated.find(item => item.key === 'appearance.fontSize').label, 'Body font size');
});
