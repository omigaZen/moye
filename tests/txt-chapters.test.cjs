'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, boundary } = require('../src/txt-chapters.js');
test('TXT window index preserves complete original bytes of text and chapter source offsets', () => {
  const raw = '第一章 开始\r\n' + 'A😀中\r\n'.repeat(10000) + 'Chapter IV: Last\r\n尾文';
  const model = build(raw); assert.equal(model.windows.map(w => raw.slice(w.start, w.end)).join(''), raw);
  assert.equal(model.codePoints, [...raw].length);
  assert.deepEqual(model.chapters.map(c => c.text), ['第一章 开始', 'Chapter IV: Last']);
  assert.equal(raw.slice(model.chapters[1].offset).startsWith('Chapter IV'), true);
  assert.equal(model.windowForOffset(raw.length), model.windows.length - 1);
});
test('pathological single-line and many-short-line inputs have bounded mounted windows', () => {
  for (const raw of ['😀a'.repeat(400000), 'x\n'.repeat(200000), '\n'.repeat(200000)]) {
    const m = build(raw); assert.ok(m.windows.length > 1);
    for (const w of m.windows) { const text = raw.slice(w.start, w.end); assert.ok(text.length <= 65600); assert.ok((text.match(/\n/g) || []).length <= 256); assert.ok(!/^[\uDC00-\uDFFF]/.test(text)); assert.ok(!/[\uD800-\uDBFF]$/.test(text)); }
  }
});
test('chapter disabling and arbitrary offsets are deterministic without changing literal markup', () => {
  const raw = '**literal** <b>HTML</b> $x$\n第一章 开始\n正文', m = build(raw, { chapterDetection: false });
  assert.equal(m.raw, raw); assert.equal(m.chapters.length, 0); assert.equal(m.windowForOffset(-1), 0); assert.equal(m.windowForOffset(Infinity), 0);
});
test('window boundaries keep common grapheme clusters and ZWJ emoji whole', () => {
  const raw = 'a'.repeat(4095) + '👩‍💻' + 'e\u0301' + 'z'.repeat(5000), m = build(raw, { maxWindowCharacters: 4096 });
  assert.equal(m.windows.map(w => raw.slice(w.start,w.end)).join(''), raw); assert.ok(m.windows.some(w => raw.slice(w.start,w.end).includes('👩‍💻')));
  assert.equal(boundary('a😀b', 2), 1);
  for (const oddWidth of [1, 3, 61, 63]) {
    const at = 4096, astralMarks = 'a'.repeat(at) + '\u0301'.repeat(oddWidth) + '\u{1D185}'.repeat(40) + 'z';
    const end = boundary(astralMarks, at);
    assert.ok(end <= at + 64); assert.equal(end, at + 63);
    assert.ok(!/[\uD800-\uDBFF]$/.test(astralMarks.slice(0, end))); assert.ok(!/^[\uDC00-\uDFFF]/.test(astralMarks.slice(end)));
  }
});
