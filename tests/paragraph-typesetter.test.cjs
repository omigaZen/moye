'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const typesetter = require('../src/paragraph-typesetter.js');

test('whole-paragraph optimisation can choose a compressed line instead of a greedy extra line', () => {
  const boxes = Array.from({ length: 5 }, () => ({ width: 30, stretch: 15, shrink: 5, breakAfter: true }));
  const result = typesetter.breakLines(boxes, { width: 80 });
  assert.deepEqual(result.lines.map(line => line.end), [3, 5]);
  assert.equal(result.lines[0].ratio, -1);
  assert.equal(result.lines[1].last, true);
  assert.ok(result.cost > 0);
});

test('first-line indent changes the paragraph solution and later lines retain full measure', () => {
  const boxes = Array.from({ length: 5 }, () => ({ width: 30, stretch: 15, shrink: 5, breakAfter: true }));
  const result = typesetter.breakLines(boxes, { width: 100, firstLineWidth: 60 });
  assert.deepEqual(result.lines.map(line => line.end), [2, 5]);
  assert.deepEqual(result.lines.map(line => line.available), [60, 100]);
});

test('forbidden line boundaries and unbreakable overfull runs are respected', () => {
  const boxes = Array.from({ length: 4 }, () => ({ width: 20, stretch: 10, shrink: 4, breakAfter: true }));
  boxes[1].breakAfter = false;
  const result = typesetter.breakLines(boxes, { width: 60 });
  assert.ok(result.lines.every(line => line.end !== 2));
  assert.equal(typesetter.breakLines([{ width: 80, breakAfter: true }], { width: 70 }), null);
});

test('CJK closing marks never start a line and opening marks never end one', () => {
  const tokens = typesetter.tokenize('「中文，测试」。');
  const open = new Set(['「']), close = new Set(['，', '」', '。']);
  tokens.forEach((token, index) => {
    if (open.has(token.text) || close.has(tokens[index + 1]?.text)) assert.equal(token.breakAfter, false);
  });
  assert.equal(tokens.map(token => token.text).join(''), '「中文，测试」。');
});

test('tokens preserve graphemes, combining text, original spaces and UTF-16 offsets', () => {
  const raw = '中文Unity  e\u0301👨‍👩‍👧‍👦测试';
  const tokens = typesetter.tokenize(raw);
  assert.equal(tokens.map(token => token.text).join(''), raw);
  assert.ok(tokens.some(token => token.text === '👨‍👩‍👧‍👦'));
  assert.ok(tokens.some(token => token.text === 'e\u0301'));
  for (const token of tokens) assert.equal(raw.slice(token.start, token.end), token.text);
});

test('invalid geometry and excessive token counts fall back without unbounded optimisation', () => {
  assert.equal(typesetter.breakLines([{ width: NaN }], { width: 100 }), null);
  assert.equal(typesetter.breakLines([{ width: 10 }], { width: 0 }), null);
  assert.equal(typesetter.breakLines(Array.from({ length: typesetter.maximumTokens + 1 }, () => ({ width: 10 })), { width: 100 }), null);
  assert.equal(typesetter.breakLines([], { width: 100 }), null);
});


test('full-width punctuation geometry narrows advance while preserving the measured glyph ink', () => {
  const result = typesetter.punctuationGeometry('「', 20, { left: 9, right: 15, fontSize: 20 });
  assert.equal(result.width, 10);
  assert.equal(result.offset, -7);
  assert.ok(9 + result.offset >= 0);
  assert.ok(15 + result.offset <= result.width);
  assert.equal(typesetter.punctuationGeometry('。', 20, { left: 0, right: 20, fontSize: 20 }), null);
  assert.equal(typesetter.punctuationGeometry('。', 20, {}), null);
});

test('punctuation compression excludes Latin decimals, path characters and Japanese/Korean letters', () => {
  for (const text of ['.', ',', ':', '/', '1.2', 'A', 'あ', '글', '한', 'e\u0301', '“', '”']) {
    assert.equal(typesetter.punctuationGeometry(text, 20, { left: 2, right: 7, fontSize: 20 }), null, text);
  }
  assert.ok(typesetter.punctuationGeometry('，', 20, { left: 2, right: 7, fontSize: 20 }));
});

test('URL and Windows/UNC/Unix file-path ranges protect embedded full-width marks without changing text', () => {
  const paths = ['https://example.test/目录（旧）/a.md', 'C:\\目录（旧）\\file.md', '\\\\server\\共享\\【文件】.txt', '/tmp/目录【1】/file.txt'];
  const text = paths.join(' '), ranges = typesetter.protectedRanges(text);
  assert.deepEqual(ranges.map(range => text.slice(range.start, range.end)), paths);
  for (const token of typesetter.tokenize(text).filter(token => /[（）【】]/u.test(token.text))) {
    assert.ok(ranges.some(range => token.start >= range.start && token.end <= range.end));
  }
});

test('paragraph dynamic programming observes its deadline before expanding the full search', () => {
  let checks = 0;
  const boxes = Array.from({ length: 600 }, () => ({ width: 20, stretch: 3, shrink: 1, breakAfter: true }));
  const result = typesetter.breakLines(boxes, { width: 480, deadline: 5, clock() { checks++; return 6; } });
  assert.equal(result, null);
  assert.equal(checks, 1);
});


test('relative and quoted paths with spaces also exclude their CJK punctuation from display compression', () => {
  const paths = ['assets\\目录（旧）\\file.md', 'assets/目录【旧】/file.md', '"C:\\目录 （旧）\\file.md"', "'../目录 【旧】/file.md'"];
  const text = paths.join(' '), ranges = typesetter.protectedRanges(text);
  assert.deepEqual(ranges.map(range => text.slice(range.start, range.end)), paths);
});
