'use strict';

// Regression evidence for cached outline generation, not Typora equivalence
// or a replacement for the packaged long-document performance measurement.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const project = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-outline-cache-'));
  const results = [], errors = [], remoteRequests = [];
  const executable = process.env.MOYE_OUTLINE_CACHE_EXECUTABLE ? path.resolve(process.env.MOYE_OUTLINE_CACHE_EXECUTABLE) : require('electron');
  let app, page, application, documentNumber = 0;
  const initial = '# Outline test\n\n[toc]\n\n## First\n\nBody one.\n\n## Second\n\nBody two.\n';
  async function probe(name, run) {
    try { results.push({ name, status: 'pass', details: await run() }); }
    catch (error) { results.push({ name, status: 'fail', error: error.stack }); }
  }
  async function open(content = initial) {
    const file = path.join(work, `document-${++documentNumber}.md`);
    await fs.writeFile(file, content);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, file);
    await page.evaluate(async () => { await moye.performAction('open'); moye.setMode('ir'); });
    await page.waitForTimeout(160);
    await page.evaluate(() => moye.editor.vditor.outline.render(moye.editor.vditor));
  }
  const stats = () => page.evaluate(() => __outlineProbe.controller.stats());
  async function place(selector, selectNode = false) {
    await page.evaluate(({ selector, selectNode }) => {
      const v = moye.editor.vditor, node = v.ir.element.querySelector(selector);
      v.ir.element.focus();
      const range = document.createRange();
      if (selectNode) range.selectNode(node);
      else { range.selectNodeContents(node); range.collapse(false); }
      getSelection().removeAllRanges(); getSelection().addRange(range);
    }, { selector, selectNode });
  }
  async function verifyGenerated() {
    return page.evaluate(() => {
      const v = moye.editor.vditor, outline = v.outline;
      const actual = outline.render(v), expected = __outlineProbe.original.call(outline, v);
      const targets = [...v.ir.element.querySelectorAll('.vditor-toc [data-target-id]')];
      return { sameAsUpstream: actual === expected, actual, unresolved: targets.filter(node => !document.getElementById(node.dataset.targetId)).map(node => node.dataset.targetId) };
    });
  }
  async function changed(run) {
    const before = await stats();
    await run();
    const generated = await verifyGenerated(), after = await stats();
    assert.ok(after.misses > before.misses, 'changed heading input must regenerate the outline');
    assert.equal(generated.sameAsUpstream, true);
    return { misses: after.misses - before.misses, sameAsUpstream: generated.sameAsUpstream };
  }
  try {
    app = await electron.launch({
      executablePath: executable,
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_OUTLINE_CACHE_EXECUTABLE ? [] : [path.join(project, 'electron/main.cjs')])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
    });
    page = await app.firstWindow();
    application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, path: app.getAppPath(), executable: app.getPath('exe') }));
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.route(/^https?:/, route => route.abort());
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready);
    // Also allow running this helper's test before its renderer hook lands.
    if (!await page.evaluate(() => !!window.MoyeOutlineCache)) {
      assert.equal(application.isPackaged, false, 'Packaged application must include the outline cache; source injection is forbidden');
      await page.addScriptTag({ path: path.join(project, 'src', 'editor-outline-cache.js') });
    }
    await page.evaluate(() => {
      const outline = moye.editor.vditor.outline;
      MoyeOutlineCache.install(moye.editor).destroy();
      const original = outline.render;
      window.__outlineProbe = { original, originalCalls: 0 };
      outline.render = function () { __outlineProbe.originalCalls++; return original.apply(this, arguments); };
      __outlineProbe.controller = MoyeOutlineCache.install(moye.editor);
    });
    await open();
    await probe('ordinary trusted editor input reuses unchanged outline while preserving text and undo', async () => {
      const before = await stats();
      await place('p:not(.vditor-toc)');
      await page.keyboard.insertText('汉');
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const after = await stats();
      assert.ok(after.hits > before.hits); assert.equal(after.misses, before.misses);
      const text = await page.evaluate(() => moye.editor.getValue()); assert.ok(text.includes('汉'));
      await page.waitForTimeout(450);
      await page.evaluate(() => moye.performAction('undo'));
      assert.equal(await page.evaluate(() => moye.editor.getValue().includes('汉')), false);
      return { cacheHits: after.hits - before.hits, extraGenerations: after.misses - before.misses, undoPreserved: true };
    });
    await open();
    await probe('trusted heading rename regenerates TOC labels and retains navigable IDs', async () => {
      const result = await changed(async () => { await place('h2'); await page.keyboard.insertText(' renamed'); });
      const generated = await verifyGenerated();
      assert.ok(generated.actual.includes('First renamed')); assert.deepEqual(generated.unresolved, []);
      return { ...result, navigationTargetsResolved: true };
    });
    await probe('heading inline Markdown formatting invalidates cached generation', async () => {
      const result = await changed(async () => { await place('h2'); await page.keyboard.insertText(' **bold**'); });
      assert.ok((await verifyGenerated()).actual.includes('<strong>bold</strong>')); return result;
    });
    await probe('trusted deletion removes a heading from generated navigation', async () => {
      const count = await page.locator('.vditor-ir h2').count();
      const result = await changed(async () => { await place('h2', true); await page.keyboard.press('Backspace'); });
      assert.ok(await page.locator('.vditor-ir h2').count() < count); return result;
    });
    await open();
    await probe('inserting a body block before headings regenerates their index-derived IDs', async () => changed(async () => {
      await page.evaluate(() => { const root = moye.editor.vditor.ir.element, p = document.createElement('p'); p.dataset.block = '0'; p.textContent = 'Inserted body'; root.insertBefore(p, root.firstElementChild); });
    }));
    await probe('reordering headings regenerates outline order and index-derived IDs', async () => changed(async () => {
      await page.evaluate(() => { const root = moye.editor.vditor.ir.element, headings = root.querySelectorAll('h2'); root.insertBefore(headings[1], headings[0]); });
    }));
    await probe('heading level, ID and style changes are cache inputs', async () => {
      const changes = [];
      changes.push(await changed(async () => page.evaluate(() => { const old = moye.editor.vditor.ir.element.querySelector('h2'), next = document.createElement('h3'); for (const attribute of old.attributes) next.setAttribute(attribute.name, attribute.value); next.innerHTML = old.innerHTML; old.replaceWith(next); })));
      changes.push(await changed(async () => page.evaluate(() => { moye.editor.vditor.ir.element.querySelector('h3').id = 'renamed_heading_id'; })));
      changes.push(await changed(async () => page.evaluate(() => { moye.editor.vditor.ir.element.querySelector('h3').style.fontStyle = 'italic'; })));
      return changes;
    });
    await probe('transient heading selection bookmarks reuse identical generated outline', async () => {
      const before = await stats();
      const result = await page.evaluate(() => {
        const v = moye.editor.vditor, heading = v.ir.element.querySelector('h3'), bookmark = document.createElement('wbr');
        heading.append(bookmark); const actual = v.outline.render(v); bookmark.remove(); return actual;
      });
      const after = await stats(); assert.equal(after.misses, before.misses); assert.ok(after.hits > before.hits);
      assert.equal(result, (await verifyGenerated()).actual); return { extraGenerations: after.misses - before.misses };
    });
    await probe('Markdown and math option changes invalidate generation', async () => {
      const results = [];
      results.push(await changed(async () => page.evaluate(() => { const options = moye.editor.vditor.options.preview.markdown; options.toc = !options.toc; })));
      results.push(await changed(async () => page.evaluate(() => { moye.editor.vditor.options.preview.math.macros.__cacheDiagnostic = 'x'; })));
      await page.evaluate(() => { const options = moye.editor.vditor.options.preview; options.markdown.toc = !options.markdown.toc; delete options.math.macros.__cacheDiagnostic; });
      return results;
    });
    await probe('source/live mode changes retain equivalent generated outline', async () => {
      const before = await stats();
      await page.evaluate(() => { moye.setMode('sv'); moye.editor.vditor.outline.render(moye.editor.vditor); moye.setMode('ir'); });
      const generated = await verifyGenerated(), after = await stats();
      assert.equal(generated.sameAsUpstream, true); assert.ok(after.misses > before.misses); return { sameAsUpstream: true };
    });
    await probe('reloading identical Markdown with fresh heading nodes regenerates', async () => {
      const before = await stats();
      await open();
      const first = await page.evaluate(() => { window.__priorHeading = moye.editor.vditor.ir.element.querySelector('h1'); return true; });
      await open();
      const replaced = await page.evaluate(() => __priorHeading !== moye.editor.vditor.ir.element.querySelector('h1'));
      assert.equal(first && replaced, true); assert.ok((await stats()).misses > before.misses);
      assert.equal((await verifyGenerated()).sameAsUpstream, true); return { freshHeadingNodes: replaced };
    });
    await probe('replacing content root or outline target invalidates even identical HTML', async () => {
      const before = await stats();
      const same = await page.evaluate(() => {
        const v = moye.editor.vditor, old = v.ir.element, clone = old.cloneNode(true);
        old.replaceWith(clone); v.ir.element = clone;
        const actual = v.outline.render(v), expected = __outlineProbe.original.call(v.outline, v);
        clone.replaceWith(old); v.ir.element = old; v.outline.render(v);
        const target = v.outline.element.lastElementChild; target.replaceWith(target.cloneNode(true)); v.outline.render(v);
        return actual === expected;
      });
      assert.equal(same, true); assert.ok((await stats()).misses >= before.misses + 3); return { sameAsUpstream: same };
    });
    await probe('uncacheable configuration falls back to upstream and destroy restores it', async () => {
      const before = await stats();
      const result = await page.evaluate(() => {
        const v = moye.editor.vditor;
        v.options.preview.markdown.__cacheDiagnostic = () => true;
        const actual = v.outline.render(v), expected = __outlineProbe.original.call(v.outline, v);
        delete v.options.preview.markdown.__cacheDiagnostic;
        const controller = __outlineProbe.controller, stats = controller.stats();
        controller.destroy(); controller.destroy();
        const restored = v.outline.render(v) === __outlineProbe.original.call(v.outline, v);
        __outlineProbe.controller = MoyeOutlineCache.install(moye.editor);
        const idempotent = __outlineProbe.controller === MoyeOutlineCache.install(moye.editor);
        return { same: actual === expected, stats, restored, idempotent };
      });
      assert.equal(result.same && result.restored && result.idempotent, true); assert.ok(result.stats.fallbacks > before.fallbacks);
      return { sameAsUpstream: true, fallback: true, destroyRestoresUpstream: true, installIdempotent: true };
    });
  } finally {
    if (app) {
      const process = app.process(), exit = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exit;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const report = { generatedAt: new Date().toISOString(), platform: process.platform, executable, application, evidence: 'Moye regression checks; no original Typora comparison or performance certification', results, pageErrors: errors, remoteRequests };
    await fs.writeFile(path.resolve(process.env.MOYE_OUTLINE_CACHE_OUTPUT || path.join(project, 'tests', 'outline-cache-report.json')), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (errors.length || remoteRequests.length || results.some(result => result.status === 'fail')) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
