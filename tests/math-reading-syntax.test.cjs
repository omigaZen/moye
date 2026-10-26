'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const syntax = require('../src/math-reading-syntax.js');

function originals(prepared) {
  let result = prepared.markdown;
  for (const alias of prepared.aliases) result = result.split(alias.token).join(alias.source);
  return result;
}
test('explicit inline and display TeX delimiters become aliases with exact original offsets and source', () => {
  const raw = '中文\\(x^2+1\\)与English。\r\n\r\n\\[\r\n\\frac{a}{b}\r\n\\]\r\n';
  const prepared = syntax.prepare(raw);
  assert.equal(prepared.aliases.length, 2);
  assert.deepEqual(prepared.aliases.map(alias => alias.display), [false, true]);
  assert.deepEqual(prepared.aliases.map(alias => alias.tex), ['x^2+1', '\r\n\\frac{a}{b}\r\n']);
  for (const alias of prepared.aliases) assert.equal(raw.slice(alias.start, alias.end), alias.source);
  assert.equal(originals(prepared), raw);
  assert.equal(prepared.metadata.sourceUnchanged, true);
});
test('ordinary parentheses, brackets, currency and escaped literal delimiters remain unchanged', () => {
  for (const raw of ['(x+1) [a,b] （中文）', '价格 $4.99/月 和 $89.99。', String.raw`\\(x+1\\) 与 \\[y\\]`, String.raw`没有结束的 \(x+1`, String.raw`空的 \( \)`, String.raw`跨行 \(x
y\)`]) {
    const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 0, raw); assert.equal(prepared.markdown, raw);
  }
  const betweenPrices = syntax.prepare(String.raw`价格 $5，公式 \(x+1\)，另一个 $6。`);
  assert.equal(betweenPrices.aliases.length, 1); assert.equal(betweenPrices.aliases[0].tex, 'x+1');
});
test('fenced, quoted fenced, indented and inline code protect every formula delimiter', () => {
  const raw = '```markdown\n\\(x\\)\n\\[y\\]\n```\n\n> ~~~text\n> \\(quoted\\)\n> ~~~\n\n    \\(indent\\)\n\n`\\(inline\\)` and ``a`\\[code\\]``.\n\n正常 \\(z\\)。';
  const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 1); assert.equal(prepared.aliases[0].tex, 'z'); assert.equal(originals(prepared), raw);
});
test('HTML tags and their raw nested content, comments, URLs and Markdown destinations stay literal', () => {
  const raw = String.raw`<div data-x="\(attr\)"><span>\(html\)</span></div>
<!-- \[comment\] -->
<!DOCTYPE html SYSTEM "\(declaration\)">
<?xml data="\(processing-instruction\)"?>
<![CDATA[\[literal-cdata\]]]>
https://example.test/\(url\)
<https://example.test/\[autolink\]>
[label](assets/\(local\).png "title \(text\)")
![\(alt\)](img/\(path\).png)
![\(reference-alt\)][image-id]
[ref]: assets/\(reference-path\).png
Outside \(x\).`;
  const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 1); assert.equal(prepared.aliases[0].tex, 'x'); assert.equal(originals(prepared), raw);
});
test('an HTML-looking literal in inline code does not mask real math later in the paragraph', () => {
  const raw = '`<span>` followed by \\(x\\).';
  const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 1); assert.equal(prepared.aliases[0].tex, 'x');
});
test('URL literals are protected while an explicitly delimited TeX href remains an isolated math expression', () => {
  const raw = String.raw`https://example.test/\(literal\) and \(\href{https://example.test}{x}\)`;
  const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 1); assert.equal(prepared.aliases[0].tex, String.raw`\href{https://example.test}{x}`); assert.equal(originals(prepared), raw);
});
test('existing dollar math and math fences are recorded without rewriting or recursively interpreting TeX', () => {
  const raw = '$a$ and $\\text{\\(literal\\)}$.\n\n$$\ny=2\n$$\n\n~~~math\nz=3\n~~~\n\n\\(new\\)';
  const prepared = syntax.prepare(raw); assert.equal(prepared.aliases.length, 1); assert.equal(prepared.aliases[0].tex, 'new');
  assert.equal(prepared.nativeMath.length, 4); assert.ok(prepared.nativeMath.some(math => math.kind === 'fence' && math.source.startsWith('~~~math')));
  assert.equal(originals(prepared), raw);
});
test('YAML metadata and individually disabled inline/display settings preserve source', () => {
  const raw = '---\ntitle: "\\(metadata\\)"\n---\n\n\\(x\\)\n\n\\[y\\]\n';
  const inlineOnly = syntax.prepare(raw, { 'markdown.inlineMath': true, 'markdown.mathBlock': false });
  assert.equal(inlineOnly.aliases.length, 1); assert.equal(inlineOnly.aliases[0].display, false);
  const blockOnly = syntax.prepare(raw, { inline: false, display: true }); assert.equal(blockOnly.aliases.length, 1); assert.equal(blockOnly.aliases[0].display, true);
  const neither = syntax.prepare(raw, { inline: false, display: false }); assert.equal(neither.markdown, raw);
});
test('processing budgets have explicit copy-safe fallback and tokens cannot collide with original document text', () => {
  const raw = String.raw`MOYEMATHREADING0X0Q0END text \(x\)`;
  const prepared = syntax.prepare(raw); assert.ok(!raw.includes(prepared.aliases[0].token)); assert.equal(originals(prepared), raw);
  const huge = 'x'.repeat(syntax.maximumSourceCharacters + 1); const skipped = syntax.prepare(huge); assert.equal(skipped.markdown, huge); assert.equal(skipped.metadata.skipped.sourceBudget, 1);
  const repeated = String.raw`\(x\) `.repeat(syntax.maximumAliases + 2); const bounded = syntax.prepare(repeated); assert.equal(bounded.aliases.length, syntax.maximumAliases); assert.equal(originals(bounded), repeated);
  const longDollar = '$' + 'x'.repeat(syntax.maximumFormulaCharacters + 1) + '$';
  const native = syntax.prepare(longDollar); assert.equal(native.nativeMath[0].source, longDollar); assert.equal(native.markdown, longDollar);
});

function readingRenderer() {
  const calls = []; let initialisations = 0;
  class TeX {} class SVG {}
  const module = { exports: {} };
  const mathjax = { config: { tex: { packages: ['base'] }, svg: {}, options: {} }, startup: { promise: Promise.resolve(), constructors: { tex: TeX, svg: SVG }, mathjax: { document: () => {
    initialisations++;
    return { convertPromise: async tex => { calls.push(tex); if (tex === '\\bad') throw new Error('invalid TeX'); return { querySelector: () => null, querySelectorAll: () => [] }; } };
  } } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/math-reading-syntax.js'), 'utf8'), { module, MathJax: mathjax, document: {} });
  const node = (tex, source = '$' + tex + '$', kind = 'inline') => {
    const classes = new Set();
    return { dataset: { readingTex: tex, readingMarkdown: source, readingDisplay: String(kind === 'block') }, textContent: tex,
      tagName: kind === 'fence' ? 'CODE' : kind === 'block' ? 'DIV' : 'SPAN', parentElement: { tagName: kind === 'fence' ? 'PRE' : 'P' }, style: {},
      classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value) },
      setAttribute() {}, replaceChildren(...children) { this.children = children; } };
  };
  return { api: module.exports, calls, node, initialisations: () => initialisations };
}
test('reading render budgets cover native inline, display and math fences while preserving sources and valid siblings', async () => {
  const { api, calls, node } = readingRenderer(), long = 'x'.repeat(api.maximumFormulaCharacters + 1);
  const blocked = [node(long, '$' + long + '$'), node(long, '$$\r\n ' + long + ' \r\n$$', 'block'), node(long, '~~~math\r\n' + long + '\r\n~~~', 'fence')];
  const broken = node('\\bad'), valid = [node('x'.repeat(api.maximumFormulaCharacters)), node('y+1')];
  const report = await api.render([...blocked, broken, ...valid]);
  assert.equal(report.rendered, 2); assert.equal(report.budget.rejected, 3); assert.equal(report.budget.attempted, 3); assert.equal(calls.length, 3);
  for (const element of [...blocked, broken]) { assert.equal(element.textContent, element.dataset.readingMarkdown); assert.equal(element.classList.contains('moye-reading-math-source'), true); }
  assert.equal(report.errors.filter(error => error.stage === 'budget' && error.code === 'formula-characters').length, 3);
  assert.ok(valid.every(element => element.classList.contains('moye-reading-rendered')));
  const allBlocked = readingRenderer(), only = allBlocked.node(long), fallback = await allBlocked.api.render([only]);
  assert.equal(allBlocked.initialisations(), 0); assert.equal(fallback.errors.length, 1); assert.equal(fallback.errors[0].stage, 'budget'); assert.equal(only.textContent, only.dataset.readingMarkdown);
});
test('reading formula count is bounded across syntaxes without sending the excess formula to the engine', async () => {
  const { api, calls, node } = readingRenderer(), nodes = Array.from({ length: api.maximumRenderFormulas + 1 }, (_, index) => node(String(index)));
  const report = await api.render(nodes);
  assert.equal(calls.length, api.maximumRenderFormulas); assert.equal(report.rendered, api.maximumRenderFormulas); assert.equal(report.budget.rejected, 1);
  assert.equal(report.errors[0].code, 'formula-count'); assert.equal(nodes.at(-1).textContent, nodes.at(-1).dataset.readingMarkdown);
});
test('reading total TeX budget rejects a formula that does not fit but continues with a shorter valid sibling', async () => {
  const { api, calls, node } = readingRenderer(), nodes = Array.from({ length: 15 }, () => node('x'.repeat(api.maximumFormulaCharacters)));
  nodes.push(node('y'.repeat(4090)), node('z'.repeat(7)), node('a'.repeat(6)));
  const report = await api.render(nodes);
  assert.equal(report.budget.characters, api.maximumRenderCharacters); assert.equal(report.rendered, 17); assert.equal(calls.length, 17);
  assert.equal(report.errors.length, 1); assert.equal(report.errors[0].code, 'document-characters'); assert.equal(nodes.at(-2).textContent, nodes.at(-2).dataset.readingMarkdown);
  assert.equal(nodes.at(-1).classList.contains('moye-reading-rendered'), true);
});
