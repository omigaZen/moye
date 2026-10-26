'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const preview = require('../electron/system-preview.cjs');
const registry = require('../electron/system-preview-registration.cjs');
const { DocumentStore } = require('../electron/file-store.cjs');
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-system-preview-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
function chunks(bytes) { const items = []; for (let i = 8; i < bytes.length;) { const n = bytes.readUInt32BE(i), type = bytes.toString('ascii', i + 4, i + 8), data = bytes.subarray(i + 8, i + 8 + n); assert.equal(zlib.crc32(bytes.subarray(i + 4, i + 8 + n)), bytes.readUInt32BE(i + n + 8)); items.push({ type, data }); i += n + 12; } return items; }

test('thumbnail command is opt-in and accepts Unicode local URIs without shell parsing', () => {
  assert.equal(preview.parsePreviewArgs(['Moye', '/tmp/note.md']), null);
  const name = path.join(os.tmpdir(), '中文 文件.md'), output = path.join(os.tmpdir(), 'thumb.png');
  const value = preview.parsePreviewArgs(['Moye', '--system-preview', '--input', pathToFileURL(name).href, '--output', output, '--size', '512']);
  assert.deepEqual(value, { input: name, output, size: 512 }); assert.equal(Object.isFrozen(value), true);
});
test('thumbnail command rejects remote URLs, unknown flags, ambiguous values and excessive dimensions', () => {
  const base = ['--system-preview', '--input', path.join(os.tmpdir(), 'a.md'), '--output', path.join(os.tmpdir(), 'o.png')];
  for (const args of [[...base, '--input', '/tmp/b.md'], [...base, '--unknown', 'x'], [...base, '--size', '0'], [...base, '--size', '1025'], [...base, '--size', '256.1']]) assert.throws(() => preview.parsePreviewArgs(args));
  for (const value of ['https://example.test/a.md', 'file://server/a.md', 'file:///tmp/a.md?x=1', 'file:///tmp/a.md#x', 'relative.md', '/tmp/a.exe']) assert.throws(() => preview.sourcePath(value));
  assert.throws(() => preview.parsePreviewArgs(['--system-preview', '--input', '/tmp/a.md', '--output', 'relative.png']));
});
test('bounded descriptor reads preserve source bytes, recognize UTF16 and avoid splitting supplementary characters', async t => {
  const dir = await fixture(t), input = path.join(dir, '原文.txt'), bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文😀\r\n', 'utf16le')]);
  await fs.writeFile(input, bytes); const result = await preview.readPreviewSource({ input });
  assert.equal(result.text, '中文😀\r\n'); assert.equal(result.encoding, 'utf-16le'); assert.equal(result.plain, true); assert.deepEqual(await fs.readFile(input), bytes);
  await fs.writeFile(input, '😀'.repeat(preview.MAX_RENDER_CODEPOINTS + 2));
  const long = await preview.readPreviewSource({ input }); assert.equal([...long.text].length, preview.MAX_RENDER_CODEPOINTS); assert.equal(long.text.isWellFormed(), true); assert.equal(long.truncated, true);
});
test('directories, binary files and oversized input fail without producing a destination', async t => {
  const dir = await fixture(t), input = path.join(dir, 'note.md'); await fs.writeFile(input, Buffer.from([0, 0, 0, 0]));
  await assert.rejects(preview.readPreviewSource({ input }), /二进制|编码/);
  await fs.writeFile(input, Buffer.alloc(preview.MAX_SOURCE_BYTES + 1, 65)); await assert.rejects(preview.readPreviewSource({ input }), /8 MiB/);
  const folder = path.join(dir, 'folder.md'); await fs.mkdir(folder); await assert.rejects(preview.readPreviewSource({ input: folder }), /regular text/);
  if (process.platform === 'linux') {
    const pipe = path.join(dir, 'pipe.md'); const made = spawnSync('mkfifo', [pipe]); assert.equal(made.status, 0);
    await assert.rejects(preview.readPreviewSource({ input: pipe }), /regular text/);
  }
});
test('system preview reuses explicit per-file encoding without rewriting encoding memory', async t => {
  const dir = await fixture(t), input = path.join(dir, 'legacy.md'), memory = path.join(dir, 'document-encodings.json');
  const bytes = Buffer.from('a4a4a4e5', 'hex'); await fs.writeFile(input, bytes); const store = new DocumentStore({ encodingMemoryPath: memory }); await store.open(input, { encoding: 'big5' });
  const remembered = await fs.readFile(memory), result = await preview.readPreviewSource({ input }, { encodingMemoryPath: memory });
  assert.equal(result.text, '中文'); assert.equal(result.encoding, 'big5'); assert.equal(result.encodingRemembered, true); assert.equal(result.encodingGuessed, false); assert.deepEqual(await fs.readFile(memory), remembered); assert.deepEqual(await fs.readFile(input), bytes);
});
test('offline Markdown keeps formatting and static formulas while stripping active HTML and links', () => {
  const html = preview.renderMarkdown('# 标题\n\n**粗体** $x^2$\n\n| A | B |\n|---|---|\n|1|2|\n\n<script>alert(1)</script>\n<img src="x" onerror="alert(1)">\n[a](javascript:alert)\n\n```mermaid\ngraph TD; A-->B\n```');
  assert.match(html, /<h1[^>]*>标题/); assert.match(html, /<strong>粗体/); assert.match(html, /<table>/); assert.match(html, /class="katex"/); assert.match(html, /language-mermaid/);
  assert.doesNotMatch(html, /<script|\sonerror|href=|<iframe/i);
  assert.doesNotThrow(() => preview.renderMarkdown('$\\def\\x{\\x}\\x$'));
});
test('static preview CSP forbids JavaScript and network, escapes plain TXT and sanitizes display preferences', async () => {
  const source = { title: '<script>title</script>.txt', canonical: path.join(os.tmpdir(), 'name.txt'), text: '<script>fetch("https://bad.test")</script>', plain: true, truncated: true, encodingGuessed: true };
  const html = await preview.buildPreviewHTML(source, { preferences: { 'appearance.fontFamily': 'x; background:url(https://bad.test)', 'appearance.fontSize': 1e9, 'appearance.lineHeight': 10, 'appearance.theme': 'dark', 'typography.colorTheme': 'nord' } });
  assert.match(html, /script-src 'none'/); assert.match(html, /connect-src 'none'/); assert.match(html, /&lt;script&gt;fetch/); assert.match(html, /--preview-font-size:48px/); assert.match(html, /--preview-line-height:3.5/); assert.match(html, /Opening excerpt/); assert.match(html, /Guessed encoding/);
  assert.doesNotMatch(html, /background:url\(https/); assert.doesNotMatch(html, /<script\b/i);
});
test('system math respects independent parser toggles and supported local macros', () => {
  const source = '$x$\n\n$$\ny\n$$\n\n```math\nz\n```\n';
  const disabled = preview.renderMarkdown(source, { 'markdown.inlineMath': false, 'markdown.mathBlock': false, 'markdown.codeBlockMath': false });
  assert.doesNotMatch(disabled, /class="katex"/); assert.match(disabled, /\$x\$/); assert.match(disabled, /\$\$\ny\n\$\$/);
  assert.match(disabled, /<pre><code class="language-math">z/);
  const codeOnly = preview.renderMarkdown(source, { 'markdown.inlineMath': false, 'markdown.mathBlock': false, 'markdown.codeBlockMath': true }); assert.equal((codeOnly.match(/class="katex"/g) || []).length, 1);
  const macro = preview.renderMarkdown('$\\RR$', { 'math.macros': JSON.stringify({ RR: '\\mathbb{R}' }) }); assert.match(macro, /class="katex"/); assert.match(macro, /mathbb/);
  assert.doesNotMatch(preview.renderMarkdown('a[^ref]\n\n[^ref]: note\n', { 'markdown.footnotes': false }), /footnotes/);
});
test('custom preview themes are read-only, inherit local colors and reject symlinked theme content', async t => {
  const dir = await fixture(t), filename = path.join(dir, 'sample.toml');
  const text = '[meta]\nname="Sample"\nappearance="light"\nbased_on="nord"\n[colors]\npaper="#fffaf0"\nbody="#123456"\n';
  await fs.writeFile(filename, text);
  const result = await preview.loadPreviewThemeVariables({ 'typography.colorTheme': 'custom:sample', 'appearance.theme': 'light' }, { themesDirectory: dir });
  assert.equal(result['--paper'], '#fffaf0'); assert.equal(result['--ink'], '#123456'); assert.deepEqual(await fs.readdir(dir), ['sample.toml']);
  await fs.rename(filename, path.join(dir, 'original.toml')); await fs.symlink(path.join(dir, 'original.toml'), filename);
  const fallback = await preview.loadPreviewThemeVariables({ 'typography.colorTheme': 'custom:sample' }, { themesDirectory: dir }); assert.notEqual(fallback['--ink'], '#123456');
});
test('PNG metadata preserves raster data and has independently verified CRCs and cache identity', () => {
  const makeChunk = (type, data) => { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4, 'ascii'); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, -4)), b.length - 4); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), makeChunk('IHDR', ihdr), makeChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 255, 255, 255]))), makeChunk('IEND', Buffer.alloc(0))]);
  const source = { input: path.join(os.tmpdir(), '中文.md'), modifiedSeconds: 1234, sizeBytes: 70, plain: false };
  const output = preview.addThumbnailMetadata(png, source); assert.deepEqual(output.subarray(0, png.length - 12), png.subarray(0, -12));
  const texts = []; for (let i = png.length - 12; i < output.length - 12;) { const n = output.readUInt32BE(i); assert.equal(output.toString('ascii', i + 4, i + 8), 'tEXt'); assert.equal(zlib.crc32(output.subarray(i + 4, i + 8 + n)), output.readUInt32BE(i + 8 + n)); texts.push(output.toString('latin1', i + 8, i + 8 + n)); i += n + 12; }
  assert.ok(texts.includes('Thumb::URI\0' + pathToFileURL(source.input).href)); assert.ok(texts.includes('Thumb::MTime\0' + '1234')); assert.ok(texts.includes('Thumb::Mimetype\0text/markdown')); assert.equal(chunks(output).at(-1).type, 'IEND');
  assert.throws(() => preview.addThumbnailMetadata(Buffer.from('wrong'), source));
});
test('thumbnail writes are atomic and private, and cannot follow an output symlink', async t => {
  const dir = await fixture(t), output = path.join(dir, 'result.png'), original = path.join(dir, 'original.md'); await fs.writeFile(original, 'original');
  await preview.writeThumbnail(output, Buffer.from('png')); assert.equal((await fs.stat(output)).mode & 0o777, 0o600); assert.equal(await fs.readFile(output, 'utf8'), 'png');
  await fs.unlink(output); await fs.symlink(original, output); await assert.rejects(preview.writeThumbnail(output, Buffer.from('replacement')), /regular file/); assert.equal(await fs.readFile(original, 'utf8'), 'original');
  assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.tmp')), false);
});
test('Linux Exec generation quotes Unicode paths and escapes literal field-code percent signs', () => {
  const binary = path.join(os.tmpdir(), '墨页 $quote"%name', 'Moye'); const text = registry.thumbnailerContent(binary);
  assert.match(text, /\[Thumbnailer Entry\]/); assert.match(text, /--input %u --output %o --size %s/); assert.match(text, /%%name/); assert.match(text, /\\\$quote\\"/);
  assert.throws(() => registry.thumbnailerContent('/tmp/invalid\nExec=evil')); assert.throws(() => registry.thumbnailerContent('relative/Moye'));
});
test('isolated XDG install is repeatable and removal preserves unrelated thumbnailers', async t => {
  const dir = await fixture(t), binary = path.join(dir, 'Moye app'), home = path.join(dir, 'xdg'); await fs.writeFile(binary, 'binary', { mode: 0o755 });
  const first = await registry.install({ executable: binary, dataHome: home }); assert.equal(first.installed, true); assert.equal(await fs.readFile(first.path, 'utf8'), registry.thumbnailerContent(binary));
  await fs.writeFile(path.join(home, 'thumbnailers/other.thumbnailer'), 'other'); await registry.install({ executable: binary, dataHome: home });
  assert.equal((await registry.uninstall({ dataHome: home })).removed, true); assert.equal(await fs.readFile(path.join(home, 'thumbnailers/other.thumbnailer'), 'utf8'), 'other'); assert.equal((await registry.uninstall({ dataHome: home })).removed, false);
});
test('Linux registration refuses existing unrelated data and symlink targets', async t => {
  const dir = await fixture(t), binary = path.join(dir, 'Moye'), home = path.join(dir, 'xdg'); await fs.writeFile(binary, 'binary'); await fs.mkdir(path.join(home, 'thumbnailers'), { recursive: true });
  const target = path.join(home, 'thumbnailers/moye.thumbnailer'); await fs.writeFile(target, 'unrelated'); await assert.rejects(registry.install({ executable: binary, dataHome: home }), /unrelated/); await assert.rejects(registry.uninstall({ dataHome: home }), /not owned/); assert.equal(await fs.readFile(target, 'utf8'), 'unrelated');
  await fs.unlink(target); await fs.symlink(binary, target); await assert.rejects(registry.install({ executable: binary, dataHome: home }), /unexpected/); assert.equal(await fs.readFile(binary, 'utf8'), 'binary');
});
test('macOS shared presentation writes only to a provisioned group and excludes documents and paths', async t => {
  const dir = await fixture(t), group = path.join(dir, 'group');
  assert.equal((await preview.syncMacPreviewPreferences({}, { platform: 'darwin', containerDirectory: group })).shared, false); await assert.rejects(fs.stat(group));
  await fs.mkdir(group); const result = await preview.syncMacPreviewPreferences({ 'appearance.fontSize': 22, 'appearance.fontFamily': 'Local Font', 'appearance.lineHeight': 2, 'typography.paragraphStyle': 'indented', document: 'private content', file: '/private/path' }, { platform: 'darwin', containerDirectory: group });
  assert.equal(result.shared, true); const text = await fs.readFile(result.path, 'utf8'), values = JSON.parse(text); assert.equal(values.presentation.fontSize, 22); assert.equal(values.presentation.indented, true); assert.doesNotMatch(text, /private/); assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});
