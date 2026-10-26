'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/markdown-config.js');
require('../node_modules/vditor/dist/js/lute/lute.min.js');

test('shared configuration changes actual IR inline and block math independently without disabling normal code previews', () => {
  const lute = Lute.New(), markdown = {};
  lute.SetVditorIR(true);
  const source = 'Inline $x$.\n\n$$\ny=2\n$$\n\n```javascript\nconst n = 1;\n```\n';
  for (const [inline, block] of [[true, true], [false, true], [true, false], [false, false]]) {
    config.apply(lute, markdown, { 'markdown.inlineMath': inline, 'markdown.mathBlock': block, 'markdown.codeBlockMath': false });
    const dom = lute.Md2VditorIRDOM(source);
    assert.equal(/data-type="math-inline"/.test(dom), inline);
    assert.equal(lute.Md2VditorIRDOM('$$\ny=2\n$$\n').includes('class="vditor-ir__preview"'), block);
    assert.match(dom, /<pre class="vditor-ir__preview"[^>]*><code class="language-javascript"/);
    assert.equal(markdown.moyeCodeBlockMath, false);
  }
});

test('whitespace view policy switches presentation without changing Markdown or inserting nodes', () => {
  const element = { style: {} };
  config.applyView(element, { 'markdown.preserveWhitespace': true });
  assert.equal(element.style.whiteSpace, 'pre-wrap');
  config.applyView(element, { 'markdown.preserveWhitespace': false });
  assert.equal(element.style.whiteSpace, 'normal');
});

test('all required parser capabilities are checked before mutating the active parser', () => {
  let mutations = 0;
  const parser = Object.fromEntries(config.bindings.map(({ setter }) => [setter, () => mutations++]));
  parser.SetVditorCodeBlockPreview = () => mutations++;
  delete parser.SetInlineMath;
  const markdown = { retained: true };
  assert.throws(() => config.apply(parser, markdown, {}), /SetInlineMath/);
  assert.equal(mutations, 0);
  assert.deepEqual(markdown, { retained: true });
});
