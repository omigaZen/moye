'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escaped, quoteCharacter, literalURL } = require('../src/editor-punctuation.js');
test('smart quote context includes combining marks and opening punctuation', () => {
  for (const prefix of ['', ' ', '(', '“', '—']) { assert.equal(quoteCharacter('"', prefix), '“'); assert.equal(quoteCharacter("'", prefix), '‘'); }
  for (const prefix of ['word', 'e\u0301', '42', '中文']) { assert.equal(quoteCharacter('"', prefix), '”'); assert.equal(quoteCharacter("'", prefix), '’'); }
});
test('punctuation escapes honor odd backslash counts', () => { assert.equal(escaped('a\\'), true); assert.equal(escaped('a\\\\'), false); assert.equal(escaped('a\\\\\\'), true); assert.equal(escaped('abc'), false); });
test('URL context covers schemes, www and email without swallowing ordinary prose', () => {
  for (const text of ['https://a.test/a', 'See https://a.test/a', 'www.example.test', 'mailto:a@test.test', 'a@test.test']) assert.equal(literalURL(text), true);
  for (const text of ['', 'prose words', 'https://a.test/a then prose', 'e.g. ']) assert.equal(literalURL(text), false);
});
