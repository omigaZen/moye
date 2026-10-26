'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const {
  DocumentStore, ExternalChangeError, atomicWrite, decodeMarkdown, encodeMarkdown,
} = require('../electron/file-store.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('no-op save preserves BOM and mixed line endings byte-for-byte', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, '中文 文件.md');
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n正文\n末行\r\n')]);
  await fs.writeFile(filename, original);
  const store = new DocumentStore();
  const opened = await store.open(filename);
  assert.equal(opened.content, '# 标题\n正文\n末行\n');
  assert.equal(opened.encoding, 'UTF-8 BOM');
  assert.equal(fileURLToPath(opened.baseUrl), directory + path.sep);
  await store.save(opened.content);
  assert.deepEqual(await fs.readFile(filename), original);
});

test('editing a CRLF document preserves its encoding and newline style', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'crlf.md');
  await fs.writeFile(filename, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
  const store = new DocumentStore();
  await store.open(filename);
  const result = await store.save('one\ntwo edited\n');
  assert.equal(result.eol, 'CRLF');
  assert.deepEqual(await fs.readFile(filename), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo edited\r\n')]));
});

test('external modifications are detected and never silently overwritten', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'shared.md');
  await fs.writeFile(filename, 'original');
  const store = new DocumentStore();
  await store.open(filename);
  await fs.writeFile(filename, 'external');
  await assert.rejects(store.save('my edit'), error => error instanceof ExternalChangeError && error.code === 'EXTERNAL_CHANGE');
  assert.equal(await fs.readFile(filename, 'utf8'), 'external');
  await store.save('my edit', filename, { overwriteConflict: true });
  assert.equal(await fs.readFile(filename, 'utf8'), 'my edit');
});

test('external deletion requires an explicit overwrite decision', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'deleted.md');
  await fs.writeFile(filename, 'old');
  const store = new DocumentStore();
  await store.open(filename);
  await fs.unlink(filename);
  await assert.rejects(store.save('new'), ExternalChangeError);
  await assert.rejects(fs.access(filename), { code: 'ENOENT' });
});

test('Save As preserves the old file and writes to the selected new path', async t => {
  const directory = await fixture(t);
  const original = path.join(directory, 'old.md');
  const destination = path.join(directory, '新文档.md');
  await fs.writeFile(original, 'original');
  const store = new DocumentStore();
  await store.open(original);
  const result = await store.save('new content', destination);
  assert.equal(result.path, destination);
  assert.equal(await fs.readFile(original, 'utf8'), 'original');
  assert.equal(await fs.readFile(destination, 'utf8'), 'new content');
});

test('reset forgets the old file and its BOM and EOL settings', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'old.md');
  await fs.writeFile(filename, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('old\r\n')]));
  const store = new DocumentStore();
  await store.open(filename);
  const result = store.reset();
  assert.equal(result.path, null);
  assert.equal(result.content, '');
  assert.equal(result.encoding, 'UTF-8');
  assert.equal(result.eol, 'LF');
});

test('invalid UTF-8 and binary content are rejected without changing open document', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'valid.md');
  const invalid = path.join(directory, 'invalid.md');
  await fs.writeFile(filename, 'valid');
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0x00]));
  const store = new DocumentStore();
  await store.open(filename);
  await assert.rejects(store.open(invalid), /UTF-8/);
  assert.equal(store.filePath, filename);
  assert.equal(store.originalContent, 'valid');
  assert.throws(() => decodeMarkdown(Buffer.from('a\0b')), /二进制/);
});

test('atomic write leaves no temporary files and preserves existing permissions', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'document.md');
  await fs.writeFile(filename, 'old', { mode: 0o640 });
  await atomicWrite(filename, Buffer.from('replacement'));
  assert.equal(await fs.readFile(filename, 'utf8'), 'replacement');
  if (process.platform !== 'win32') assert.equal((await fs.stat(filename)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readdir(directory), ['document.md']);
});

test('failed atomic write does not change the document or leave temporary files', async t => {
  const directory = await fixture(t);
  const destination = path.join(directory, 'directory.md');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep'), 'safe');
  await assert.rejects(atomicWrite(destination, Buffer.from('replacement')));
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'safe');
  assert.deepEqual(await fs.readdir(directory), ['directory.md']);
});

test('image import uses adjacent assets, escapes paths and never overwrites collisions', async t => {
  const directory = await fixture(t);
  const store = new DocumentStore();
  await assert.rejects(store.addImage({ name: 'a.png', bytes: Buffer.from('png') }), /先保存/);
  await store.save('# 图片', path.join(directory, '中文 文档.md'));
  const first = await store.addImage({ name: '../../图 [1].png', bytes: Buffer.from('first') });
  const second = await store.addImage({ name: '../../图 [1].png', bytes: Buffer.from('second') });
  assert.equal(path.dirname(first.path), path.join(directory, '中文 文档.assets'));
  assert.match(first.markdown, /%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3\.assets/);
  assert.match(first.markdown, /图 \\\[1\\\]/);
  assert.notEqual(first.path, second.path);
  assert.equal(await fs.readFile(first.path, 'utf8'), 'first');
  assert.equal(await fs.readFile(second.path, 'utf8'), 'second');
  await assert.rejects(store.addImage({ name: 'bad.exe', bytes: Buffer.from('data') }), /格式/);
});

test('Save As into another directory relocates adjacent managed assets', async t => {
  const directory = await fixture(t);
  const sourceDirectory = path.join(directory, 'source');
  const destinationDirectory = path.join(directory, 'destination');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  const store = new DocumentStore();
  await store.save('# 图片', path.join(sourceDirectory, 'note.md'));
  const image = await store.addImage({ name: 'photo.png', bytes: Buffer.from('image-data') });
  await store.save(image.markdown);
  await store.save(image.markdown, path.join(destinationDirectory, 'copy.md'));
  assert.equal(await fs.readFile(path.join(destinationDirectory, 'note.assets', 'photo.png'), 'utf8'), 'image-data');
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'note.assets', 'photo.png'), 'utf8'), 'image-data');
});

test('Save As asset collisions abort without overwriting target images', async t => {
  const directory = await fixture(t);
  const sourceDirectory = path.join(directory, 'source');
  const destinationDirectory = path.join(directory, 'destination');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(path.join(destinationDirectory, 'note.assets'), { recursive: true });
  await fs.writeFile(path.join(destinationDirectory, 'note.assets', 'photo.png'), 'existing-image');
  const store = new DocumentStore();
  await store.save('original', path.join(sourceDirectory, 'note.md'));
  const image = await store.addImage({ name: 'photo.png', bytes: Buffer.from('new-image') });
  await assert.rejects(store.save(image.markdown, path.join(destinationDirectory, 'copy.md')), /内容不同/);
  assert.equal(await fs.readFile(path.join(destinationDirectory, 'note.assets', 'photo.png'), 'utf8'), 'existing-image');
  await assert.rejects(fs.access(path.join(destinationDirectory, 'copy.md')), { code: 'ENOENT' });
  assert.equal(store.filePath, path.join(sourceDirectory, 'note.md'));
});

test('repeated Save As preserves images belonging to older document names', async t => {
  const directory = await fixture(t);
  const sourceDirectory = path.join(directory, 'source');
  const destinationDirectory = path.join(directory, 'destination');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  const store = new DocumentStore();
  await store.save('', path.join(sourceDirectory, '最初文档.md'));
  const image = await store.addImage({ name: '图片.png', bytes: Buffer.from('image-data') });
  await store.save(image.markdown, path.join(sourceDirectory, 'renamed.md'));
  await store.save(image.markdown, path.join(destinationDirectory, 'copy.md'));
  assert.equal(await fs.readFile(path.join(destinationDirectory, '最初文档.assets', '图片.png'), 'utf8'), 'image-data');
});

test('image filenames containing parentheses are safe Markdown destinations', async t => {
  const directory = await fixture(t);
  const store = new DocumentStore();
  await store.save('', path.join(directory, 'note.md'));
  const image = await store.addImage({ name: '图).png', bytes: Buffer.from('image-data') });
  assert.match(image.markdown, /%29\.png\)$/);
  assert.equal(path.basename(image.path), '图).png');
});

test('recovering a draft cannot overwrite its original file and preserves image resources on save', async t => {
  const directory = await fixture(t);
  const sourceDirectory = path.join(directory, 'source');
  const destinationDirectory = path.join(directory, 'destination');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  const originalPath = path.join(sourceDirectory, 'note.md');
  const original = new DocumentStore();
  await original.save('original', originalPath);
  const image = await original.addImage({ name: 'photo.png', bytes: Buffer.from('image-data') });
  const recovered = new DocumentStore();
  const payload = recovered.recover(`unsaved\n${image.markdown}`, originalPath);
  assert.equal(payload.path, null);
  assert.equal(fileURLToPath(payload.baseUrl), sourceDirectory + path.sep);
  await assert.rejects(recovered.save(payload.content), /绝对保存路径/);
  await recovered.save(payload.content, path.join(destinationDirectory, 'recovered.md'));
  assert.equal(await fs.readFile(originalPath, 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(destinationDirectory, 'note.assets', 'photo.png'), 'utf8'), 'image-data');
});

test('document identity changes on new and open but remains stable across saves', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'note.md');
  const store = new DocumentStore();
  const initial = store.payload('');
  const saved = await store.save('text', filename);
  assert.equal(initial.documentId, saved.documentId);
  const opened = await store.open(filename);
  assert.notEqual(saved.documentId, opened.documentId);
  const fresh = store.reset();
  assert.notEqual(opened.documentId, fresh.documentId);
});

test('Save As never follows managed asset symlinks outside the document directory', async t => {
  if (process.platform === 'win32') return t.skip('Creating symlinks can require Windows developer mode.');
  const directory = await fixture(t);
  const sourceDirectory = path.join(directory, 'source');
  const destinationDirectory = path.join(directory, 'destination');
  const privateDirectory = path.join(directory, 'outside');
  await fs.mkdir(sourceDirectory);
  await fs.mkdir(destinationDirectory);
  await fs.mkdir(privateDirectory);
  await fs.writeFile(path.join(privateDirectory, 'private.png'), 'private');
  await fs.symlink(privateDirectory, path.join(sourceDirectory, 'note.assets'));
  const store = new DocumentStore();
  await store.save('![x](./note.assets/private.png)', path.join(sourceDirectory, 'note.md'));
  await store.save(store.originalContent, path.join(destinationDirectory, 'copy.md'));
  await assert.rejects(fs.access(path.join(destinationDirectory, 'note.assets')), { code: 'ENOENT' });
});

test('encoding roundtrip handles CR-only files and supplementary Unicode', () => {
  const bytes = Buffer.from('# 中文😀\r第二行\r', 'utf8');
  const decoded = decodeMarkdown(bytes);
  assert.equal(decoded.eol, '\r');
  assert.deepEqual(encodeMarkdown(decoded.content, decoded), bytes);
});
