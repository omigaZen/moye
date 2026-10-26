'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {} }; vm.runInNewContext(fs.readFileSync(require.resolve('../src/table-tools.js'), 'utf8'), context);
const { encodeTsv } = context.window.MoyeTableTools;
test('table TSV preserves empty cells, whitespace, quotes and multiline cells', () => {
 assert.equal(encodeTsv([['  中文  ', '', 'a\tb'], ['a"b', 'line1\nline2', '=SUM(A1)']]), '  中文  \t\t"a\tb"\r\n"a""b"\t"line1\nline2"\t=SUM(A1)');
});
test('table TSV keeps zero and false values without changing content', () => { assert.equal(encodeTsv([[0, false, null, undefined]]), '0\tfalse\t\t'); });
