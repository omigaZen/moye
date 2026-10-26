'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DocumentStore } = require('../electron/file-store.cjs');
const { validateFolder, normalizePolicy, shouldCopyImage, imageReference, readLocalImage } = require('../electron/image-store.cjs');
const { applyParser } = require('../src/image-policy.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-image-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DocumentStore(), document = path.join(root, '中文 文档.md');
  await store.save('', document);
  return { root, store, document };
}
const png = (name = '图片 (1).png', bytes = 'complete-image-data') => ({ name, bytes: Buffer.from(bytes) });
const destination = markdown => /^!\[.*?\]\((?:<(.*)>|(.*))\)$/.exec(markdown).slice(1).find(value => value !== undefined);

test('folder settings accept document-relative templates and reject traversal, absolute and reserved paths', () => {
  for (const folder of ['${filename}.assets', './images', '图片/${filename}', 'images\\nested', '.']) assert.equal(validateFolder(folder), true, folder);
  for (const folder of ['', ' ', '..', '../images', 'safe/../../outside', 'safe\\..\\outside', '/tmp/images', '\\server\\share', 'C:\\images', 'C:images', 'images//nested', 'images/', 'images/CON', 'nul.png', 'images.', '${unknown}/images', 'images\0private', 'images\nprivate']) assert.equal(validateFolder(folder), false, folder);
  assert.throws(() => normalizePolicy({ 'images.assetFolder': '../outside' }), /设置无效/);
});

test('readable image parser capability is explicitly enabled or fails visibly', () => {
  let enabled = false; applyParser({ SetImgPathAllowSpace: value => { enabled = value; } });
  assert.equal(enabled, true); assert.throws(() => applyParser({}), /readable image paths/);
});

test('auto preserves legacy copy-relative/reference-absolute defaults and source scope only changes local rules', () => {
  assert.deepEqual(normalizePolicy(), { insertAction: 'copy', assetFolder: '${filename}.assets', pathStyle: 'auto', relativePrefix: true, escapePath: true, applyToLocal: true });
  assert.equal(shouldCopyImage('local', {}), true);
  assert.equal(shouldCopyImage('local', { applyToLocal: false }), false);
  assert.equal(shouldCopyImage('local', { insertAction: 'reference' }), false);
  assert.equal(shouldCopyImage('bitmap', { insertAction: 'reference', applyToLocal: false }), true);
  const reference = imageReference('/tmp/image (1).png', '/tmp/note.md');
  assert.equal(destination(reference.markdown), 'file:///tmp/image%20%281%29.png');
});

test('custom nested filename folder copies complete data and emits escaped, prefixed relative paths', async t => {
  const f = await fixture(t);
  const result = await f.store.addImage(png(), { 'images.assetFolder': '图片/${filename}.assets' });
  assert.equal(result.path, path.join(f.root, '图片/中文 文档.assets/图片 (1).png'));
  assert.equal(await fs.readFile(result.path, 'utf8'), 'complete-image-data');
  assert.match(result.markdown, /\.\/%E5%9B%BE%E7%89%87\/%E4%B8%AD%E6%96%87%20%E6%96%87%E6%A1%A3\.assets\/%E5%9B%BE%E7%89%87%20%281%29\.png/);
});

test('relative prefix, readable syntax and mandatory URL delimiter escaping remain independent', async t => {
  const f = await fixture(t);
  const result = await f.store.addImage(png('图 # %20 (1).png'), { assetFolder: '图片', relativePrefix: false, escapePath: false });
  assert.equal(result.markdown, '![图 # %20 (1)](<图片/图 %23 %2520 (1).png>)');
  const prefixed = imageReference(result.path, f.document, { pathStyle: 'relative', relativePrefix: true, escapePath: false });
  assert.match(prefixed.markdown, /\(<\.\/图片\//);
  const noPrefix = imageReference(path.join(f.root, 'simple.png'), f.document, { pathStyle: 'relative', relativePrefix: false });
  assert.equal(noPrefix.markdown, '![simple](simple.png)');
  const parent = imageReference(path.join(path.dirname(f.root), 'sibling.png'), f.document, { pathStyle: 'relative' });
  assert.equal(parent.markdown, '![sibling](../sibling.png)');
  const delimiter = await f.store.addImage(png('未闭合 (和 `code`.png'), { assetFolder: '图片', escapePath: false });
  assert.equal(delimiter.markdown, '![未闭合 (和 \\`code\\`](<./图片/未闭合 %28和 %60code%60.png>)');
});

test('absolute paths use valid file URLs for spaces, Unicode, percent and Windows volumes', async t => {
  const f = await fixture(t);
  const result = await f.store.addImage(png('图 # %20 (1).png'), { pathStyle: 'absolute' });
  assert.equal(fileURLToPath(destination(result.markdown)), result.path);
  const windows = imageReference('C:\\User Name\\中文\\图 (1)#%.png', 'C:\\User Name\\note.md', { pathStyle: 'absolute' });
  assert.equal(destination(windows.markdown), 'file:///C:/User%20Name/%E4%B8%AD%E6%96%87/%E5%9B%BE%20%281%29%23%25.png');
  const relative = imageReference('C:\\User Name\\中文\\图.png', 'C:\\User Name\\note.md', { pathStyle: 'relative', relativePrefix: false });
  assert.equal(relative.markdown, '![图](%E4%B8%AD%E6%96%87/%E5%9B%BE.png)');
  const otherDrive = imageReference('D:\\图片\\图.png', 'C:\\note.md', { pathStyle: 'relative' });
  assert.match(otherDrive.markdown, /file:\/\/\/D:/);
  const unc = imageReference('\\\\server\\share\\图 空格.png', 'C:\\note.md', { pathStyle: 'absolute' });
  assert.equal(destination(unc.markdown), 'file://server/share/%E5%9B%BE%20%E7%A9%BA%E6%A0%BC.png');
});

test('concurrent copies resolve collisions without overwriting files or leaving temporary files', async t => {
  const f = await fixture(t);
  const images = await Promise.all(Array.from({ length: 8 }, (_, index) => f.store.addImage(png('same.png', `image-${index}`), { assetFolder: 'images' })));
  assert.equal(new Set(images.map(image => image.path)).size, images.length);
  await Promise.all(images.map(async (image, index) => assert.equal(await fs.readFile(image.path, 'utf8'), `image-${index}`)));
  assert.equal((await fs.readdir(path.join(f.root, 'images'))).some(name => name.endsWith('.tmp')), false);
});

test('long supplementary Unicode filenames remain valid complete filesystem names', async t => {
  const f = await fixture(t);
  const image = await f.store.addImage(png('😀'.repeat(100) + '.png'));
  assert.ok(Buffer.byteLength(path.basename(image.path), 'utf8') <= 255);
  assert.equal(await fs.readFile(image.path, 'utf8'), 'complete-image-data');
  assert.doesNotMatch(path.basename(image.path), /\uFFFD/);
});

test('invalid images and unreadable inputs never publish an asset', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.addImage(png('bad.exe')), /格式/);
  await assert.rejects(f.store.addImage(png('empty.png', '')), /不能为空/);
  await assert.rejects(readLocalImage(path.join(f.root, 'missing.png')), { code: 'ENOENT' });
  await fs.mkdir(path.join(f.root, 'directory.png'));
  await assert.rejects(readLocalImage(path.join(f.root, 'directory.png')), /不能为空/);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['directory.png', '中文 文档.md'].sort());
});

test('a failed filesystem write removes its partial temporary data without publishing an image', async t => {
  const f = await fixture(t), originalOpen = fs.open;
  t.mock.method(fs, 'open', async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.moye-image-')) {
      handle.writeFile = async () => { await handle.write(Buffer.from('partial')); const error = new Error('Disk full'); error.code = 'ENOSPC'; throw error; };
    }
    return handle;
  });
  await assert.rejects(f.store.addImage(png(), { assetFolder: 'images' }), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readdir(path.join(f.root, 'images')), []);
  assert.equal(await fs.readFile(f.document, 'utf8'), '');
});

test('nested folder symlinks are rejected before writing or following a source symlink', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation can require developer mode.');
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.mkdir(path.join(f.root, 'images')); await fs.symlink(outside, path.join(f.root, 'images', 'nested'));
  await assert.rejects(f.store.addImage(png(), { assetFolder: 'images/nested' }), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(path.join(outside, 'private.png'), 'private');
  await fs.symlink(path.join(outside, 'private.png'), path.join(f.root, 'linked.png'));
  await assert.rejects(readLocalImage(path.join(f.root, 'linked.png')));
});

test('Save As migrates custom nested relative assets and preserves old filename folders across repeated saves', async t => {
  const f = await fixture(t);
  const image = await f.store.addImage(png(), { assetFolder: '图片/${filename}.assets', escapePath: false });
  await f.store.save(image.markdown);
  await f.store.save(image.markdown, path.join(f.root, 'renamed.md'));
  const target = path.join(f.root, '目标 目录'); await fs.mkdir(target);
  const saved = await f.store.save(image.markdown, path.join(target, 'saved.md'));
  assert.equal(saved.content, image.markdown);
  assert.equal(await fs.readFile(path.join(target, '图片/中文 文档.assets/图片 (1).png'), 'utf8'), 'complete-image-data');
  assert.equal(await fs.readFile(image.path, 'utf8'), 'complete-image-data');
});

test('Save As migrates editor-serialized readable paths with spaces, parentheses and optional titles', async t => {
  const f = await fixture(t);
  const image = await f.store.addImage(png(), { assetFolder: '图片/${filename}.assets', escapePath: false });
  const raw = image.markdown.replace('(<', '(').replace('>)', ')');
  const withTitle = raw.slice(0, -1) + ' "图片标题")';
  const content = `${raw}\n\n${withTitle}\n\n![ref][photo]\n[photo]: 图片/中文 文档.assets/图片 (1).png '引用标题'\n`;
  const target = path.join(f.root, '目标'); await fs.mkdir(target);
  const result = await f.store.save(content, path.join(target, 'saved.md'));
  assert.equal(result.content, content);
  assert.equal(await fs.readFile(path.join(target, '图片/中文 文档.assets/图片 (1).png'), 'utf8'), 'complete-image-data');
});

test('Save As custom asset collision aborts before replacing target document or store state', async t => {
  const f = await fixture(t);
  const image = await f.store.addImage(png('image.png'), { assetFolder: 'images/nested' });
  const target = path.join(f.root, 'target'); await fs.mkdir(path.join(target, 'images/nested'), { recursive: true });
  await fs.writeFile(path.join(target, 'images/nested/image.png'), 'other');
  const targetDocument = path.join(target, 'saved.md'); await fs.writeFile(targetDocument, 'existing');
  await assert.rejects(f.store.save(image.markdown, targetDocument), /内容不同/);
  assert.equal(await fs.readFile(targetDocument, 'utf8'), 'existing');
  assert.equal(await fs.readFile(path.join(target, 'images/nested/image.png'), 'utf8'), 'other');
  assert.equal(f.store.filePath, f.document);
});

test('Save As filesystem failure leaves no partial migrated image and preserves both documents', async t => {
  const f = await fixture(t);
  const image = await f.store.addImage(png('image.png'), { assetFolder: 'images/nested' }); await f.store.save(image.markdown);
  const target = path.join(f.root, 'target'); await fs.mkdir(target);
  const targetDocument = path.join(target, 'saved.md'); await fs.writeFile(targetDocument, 'existing');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async function (filename, ...args) {
    const handle = await originalOpen.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.moye-image-') && filename.startsWith(target + path.sep)) {
      handle.writeFile = async () => { await handle.write(Buffer.from('partial')); const error = new Error('Disk full'); error.code = 'ENOSPC'; throw error; };
    }
    return handle;
  });
  await assert.rejects(f.store.save(image.markdown, targetDocument), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readdir(path.join(target, 'images/nested')), []);
  assert.equal(await fs.readFile(targetDocument, 'utf8'), 'existing');
  assert.equal(await fs.readFile(f.document, 'utf8'), image.markdown);
  assert.equal(f.store.filePath, f.document);
});
