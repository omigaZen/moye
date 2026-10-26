'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DocumentStore } = require('../electron/file-store.cjs');
const { imageReferences } = require('../electron/relative-assets.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-relative-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(source); await fs.mkdir(target);
  const store = new DocumentStore();
  async function open(content) { const file = path.join(source, 'original.md'); await fs.writeFile(file, content); return store.open(file); }
  async function image(relative, text = 'image-data') { const file = path.join(source, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; }
  return { root, source, target, store, open, image, destination: path.join(target, 'saved.md') };
}

test('Save As copies ordinary nested relative images without rewriting the Markdown', async t => {
  const f = await fixture(t); await f.image('assets/nested/photo.png');
  const content = '# 图片\n\n![描述](assets/nested/photo.png "原图")\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(f.target, 'assets/nested/photo.png'), 'utf8'), 'image-data');
  assert.equal(await fs.readFile(f.destination, 'utf8'), content);
});

test('angle destinations, percent encoding and HTML img support Chinese paths with spaces', async t => {
  const f = await fixture(t); await f.image('图片/测试 图片.svg', '<svg/>');
  const content = '![甲](<图片/测试 图片.svg>)\n\n![乙](%E5%9B%BE%E7%89%87/%E6%B5%8B%E8%AF%95%20%E5%9B%BE%E7%89%87.svg)\n\n<img width="42" src="图片/测试 图片.svg">\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(f.target, '图片/测试 图片.svg'), 'utf8'), '<svg/>');
});

test('balanced and escaped parentheses are recognized as image paths', async t => {
  const f = await fixture(t); await f.image('assets/test(1).png');
  const content = '![a](assets/test(1).png)\n\n![b](assets/test\\(1\\).png)\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(f.target, 'assets/test(1).png'), 'utf8'), 'image-data');
});

test('only definitions referenced by Markdown images are migrated', async t => {
  const f = await fixture(t); await f.image('assets/photo.png'); await f.image('assets/link.png', 'not-image-reference');
  const content = '![one][Shared Image]\n\n![Shared Image][]\n\n![shortcut]\n\n[Shared Image]: assets/photo.png "title"\n[shortcut]: <assets/photo.png>\n[ordinary link][link]\n[link]: assets/link.png\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(f.target, 'assets/photo.png'), 'utf8'), 'image-data');
  await assert.rejects(fs.access(path.join(f.target, 'assets/link.png')), { code: 'ENOENT' });
});

test('fenced and inline code, HTML comments, escaped image syntax and data-src are not treated as images', async t => {
  const f = await fixture(t); await f.image('assets/unused.png');
  const content = '```md\n![a](assets/unused.png)\n```\n\n~~~html\n<img src="assets/unused.png">\n~~~\n\n`![code](assets/unused.png)`\n\n<!-- <img src="assets/unused.png"> -->\n\n\\![escaped](assets/unused.png)\n\n<img data-src="assets/unused.png">\n';
  assert.deepEqual(imageReferences(content), []);
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  await assert.rejects(fs.access(path.join(f.target, 'assets')), { code: 'ENOENT' });
});

test('remote, data, file and absolute image references remain byte-for-byte unchanged', async t => {
  const f = await fixture(t);
  const content = '![a](https://example.com/photo.png)\n![b](//example.com/photo.png)\n![c](data:image/png;base64,AAAA)\n![d](file:///tmp/photo.png)\n![e](/tmp/photo.png)\n![f](C:\\images\\photo.png)\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.deepEqual(await fs.readdir(f.target), ['saved.md']);
});

test('directory-external relative images are rebased without being read or copied', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'outside (1).png');
  // Deliberately missing: rebasing is path-only and must not read this file.
  const content = 'before ![x](../outside%20%281%29.png#preview) after\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, `before ![x](${pathToFileURL(external).href.replace(/[()]/g, char => char === '(' ? '%28' : '%29')}#preview) after\n`);
  assert.deepEqual(await fs.readdir(f.target), ['saved.md']);
});

test('source symlinks are rebased without copying files outside the document directory', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation can require developer mode.');
  const f = await fixture(t); const outside = path.join(f.root, 'private'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.png'), 'do-not-copy');
  await fs.symlink(outside, path.join(f.source, 'assets'));
  const content = '![x](assets/private.png)\n';
  await f.open(content); const result = await f.store.save(content, f.destination);
  assert.equal(result.content, `![x](${pathToFileURL(path.join(f.source, 'assets/private.png')).href})\n`);
  await assert.rejects(fs.access(path.join(f.target, 'assets')), { code: 'ENOENT' });
});

test('destination directory symlinks are rejected without writing through them', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation can require developer mode.');
  const f = await fixture(t); await f.image('assets/photo.png');
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(f.target, 'assets'));
  const content = '![x](assets/photo.png)'; await f.open(content);
  await assert.rejects(f.store.save(content, f.destination), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.access(f.destination), { code: 'ENOENT' });
});

test('different existing destination images abort Save As without overwriting either document or image', async t => {
  const f = await fixture(t); await f.image('assets/photo.png', 'original-image');
  await fs.mkdir(path.join(f.target, 'assets')); await fs.writeFile(path.join(f.target, 'assets/photo.png'), 'other-image');
  await fs.writeFile(f.destination, 'existing-document');
  const content = '![x](assets/photo.png)'; await f.open(content);
  await assert.rejects(f.store.save(content, f.destination), /内容不同/);
  assert.equal(await fs.readFile(path.join(f.target, 'assets/photo.png'), 'utf8'), 'other-image');
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'existing-document');
  assert.equal(f.store.filePath, path.join(f.source, 'original.md'));
});

test('identical existing destination images are reused', async t => {
  const f = await fixture(t); await f.image('assets/photo.png', 'same');
  await fs.mkdir(path.join(f.target, 'assets')); await fs.writeFile(path.join(f.target, 'assets/photo.png'), 'same');
  const content = '![x](assets/photo.png)'; await f.open(content);
  const result = await f.store.save(content, f.destination); assert.equal(result.content, content);
});

test('oversize images are rebased instead of copied', async t => {
  const f = await fixture(t); const source = await f.image('large.png'); await fs.truncate(source, 25 * 1024 * 1024 + 1);
  const content = '![x](large.png)'; await f.open(content);
  const result = await f.store.save(content, f.destination);
  assert.equal(result.content, `![x](${pathToFileURL(source).href})`);
  await assert.rejects(fs.access(path.join(f.target, 'large.png')), { code: 'ENOENT' });
});

test('saving again in the same directory does not rebase external references', async t => {
  const f = await fixture(t); const content = '![x](../shared.png)\n'; await f.open(content);
  const result = await f.store.save(content); assert.equal(result.content, content);
});

test('HTML src entities and single-quoted attributes retain their original spelling', async t => {
  const f = await fixture(t); await f.image('assets/a&b.png');
  const content = "<img alt='a' src='assets/a&amp;b.png' width='20'>"; await f.open(content);
  const result = await f.store.save(content, f.destination);
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(f.target, 'assets/a&b.png'), 'utf8'), 'image-data');
});

test('unreferenced managed assets never follow an existing destination file symlink', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation can require developer mode.');
  const f = await fixture(t); await f.image('original.assets/extra.png', 'original-image');
  const outside = path.join(f.root, 'outside.png'); await fs.writeFile(outside, 'private-image');
  await fs.mkdir(path.join(f.target, 'original.assets')); await fs.symlink(outside, path.join(f.target, 'original.assets/extra.png'));
  await f.open('no image references');
  await assert.rejects(f.store.save('no image references', f.destination), /内容不同/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'private-image');
  await assert.rejects(fs.access(f.destination), { code: 'ENOENT' });
});
