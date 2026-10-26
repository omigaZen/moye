'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wordStats } = require('../src/document-state.js');
test('large counts preserve code points, isolated surrogates and word boundaries', () => {
  const text = '中🦊A word \ud800'.repeat(100000);
  assert.deepEqual(wordStats(text), { characters: 1000000, words: 300000, minutes: 858 });
  assert.deepEqual(wordStats('```\n中文 hidden\n```\n中文 alpha'), { characters: 26, words: 3, minutes: 1 });
});
