'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = path.resolve(__dirname, '../src');
function workerHarness() {
  const messages = [], context = vm.createContext({ performance, console });
  context.self = context;
  context.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(sourceRoot, filename), 'utf8'), context, { filename, timeout: 1500 });
  context.postMessage = value => messages.push(value);
  vm.runInContext(fs.readFileSync(path.join(sourceRoot, 'highlight-worker.js'), 'utf8'), context, { filename: 'highlight-worker.js' });
  return (source, language, id = 1) => { context.onmessage({ data: { id, source, language } }); return messages.at(-1); };
}
test('worker loads the local grammars and produces real C# keyword highlighting', () => {
  const run = workerHarness(), result = run('public int Count = 3;\n', 'csharp');
  assert.equal(result.worker, true); assert.equal(result.resolvedLanguage, 'csharp'); assert.match(result.html, /hljs-keyword/); assert.ok(Number.isFinite(result.durationMs));
});
test('worker escapes document markup instead of returning executable HTML', () => {
  const run = workerHarness(), result = run('<script>throw 1</script> & "text"', 'plaintext');
  assert.equal(result.worker, true); assert.ok(!result.html.includes('<script>')); assert.match(result.html, /&lt;script&gt;/); assert.match(result.html, /&amp;/);
});
test('unknown language uses plain text without expensive automatic detection', () => {
  const run = workerHarness(), result = run('你好 <> public const x = 3;\n', 'not-a-real-language');
  assert.equal(result.resolvedLanguage, 'plaintext'); assert.equal(result.html, '你好 &lt;&gt; public const x = 3;\n');
});
test('worker accepts language aliases and preserves Unicode text inside escaped output', () => {
  const run = workerHarness(), result = run('const 名称 = "中文"; // 说明\n', 'js');
  assert.equal(result.resolvedLanguage, 'js'); assert.match(result.html, /hljs-keyword/); assert.match(result.html, /中文/); assert.match(result.html, /说明/);
});
test('worker ignores malformed messages without producing a response', () => {
  const run = workerHarness(); assert.equal(run(123, 'js'), undefined); assert.equal(run('const x=1', 7), undefined); assert.equal(run('const x=1', 'js', NaN), undefined);
});
