'use strict';
const { _electron: electron } = require('playwright');
const { PNG } = require('playwright-core/lib/utilsBundle');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-rich-typography-'));
  const images = path.join(root, 'artifacts/typography-rich'); await fs.mkdir(images, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, purpose: 'Actual Chromium glyph advance/ink, shaped rich-inline paragraphs and source/copy integrity; not an original Telari differential.', results: [], pageErrors: [], remoteRequests: [] };
  let app, page, sequence = 0;
  async function probe(name, operation) {
    if (process.env.MOYE_RICH_TYPOGRAPHY_FILTER && !name.includes(process.env.MOYE_RICH_TYPOGRAPHY_FILTER)) return;
    try { await page.evaluate(() => { if (window.__moyeRichFixture) { MoyeParagraphTypesetter.restore(window.__moyeRichFixture); window.__moyeRichFixture.remove(); delete window.__moyeRichFixture; } }); const details = await operation(); report.results.push({ name, status: 'pass', details }); }
    catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); }
  }
  async function open(raw) {
    const file = path.join(work, `rich-${++sequence}.md`); await fs.writeFile(file, raw);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1 }); }, file);
    await page.evaluate(async () => { moye.setReading(false); await moye.performAction('open'); });
  }
  async function fixture(html, width = 420) {
    return page.evaluate(async ({ html, width }) => {
      const el = document.createElement('div'); el.className = 'moye-typography vditor-reset'; el.dataset.settingsPreview = 'rich-regression';
      el.style.cssText = `position:fixed;left:40px;top:75px;width:${width}px;max-height:720px;overflow:auto;z-index:1800;background:white;color:#111;line-height:1.6;padding:0;border:0`;
      el.innerHTML = html; document.body.append(el); window.__moyeRichFixture = el;
      MoyeTypographyView.applyTo(el, { ...MoyeTypography.defaults, 'appearance.fontSize': 20, 'appearance.fontFamily': '"Noto Sans SC", sans-serif', 'appearance.lineHeight': 1.6 });
      await document.fonts.load('20px "Noto Sans SC"', '「中文，标点。？！【测试】」'); await document.fonts.ready;
      return { text: el.textContent, html: el.innerHTML };
    }, { html, width });
  }
  try {
    app = await electron.launch({ executablePath: process.env.MOYE_RICH_TYPOGRAPHY_EXECUTABLE || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(process.env.MOYE_RICH_TYPOGRAPHY_EXECUTABLE ? [] : [root])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    await app.evaluate(({ app, session }) => { app.moyeRichRequests = []; session.defaultSession.webRequest.onBeforeRequest((details, callback) => { if (/^https?:/.test(details.url)) app.moyeRichRequests.push(details.url); callback({ cancel: /^https?:/.test(details.url) }); }); });
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(error.message)); await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => window.moye?.ready && window.MoyeParagraphTypesetter && window.MoyeTypographyView);
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (process.env.MOYE_RICH_TYPOGRAPHY_EXECUTABLE) assert.equal(report.application.isPackaged, true);

    await probe('full-width punctuation uses smaller actual advances and real raster ink remains inside its allocated box', async () => {
      const glyphs = ['「', '」', '，', '。', '（', '）']; const results = [];
      for (const glyph of glyphs) {
        await page.evaluate(() => { if (window.__moyeRichFixture) { MoyeParagraphTypesetter.restore(window.__moyeRichFixture); window.__moyeRichFixture.remove(); } });
        await fixture(`<p style="margin:0;width:80px;height:44px;text-spacing-trim:space-all">${glyph}\u200b</p>`, 100);
        const result = await page.evaluate(() => {
          const el = window.__moyeRichFixture, p = el.firstElementChild, original = p.textContent, r = document.createRange(); r.selectNodeContents(p); const before = r.getBoundingClientRect().width;
          const result = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'start', 'typography.punctuationCompression': true });
          const box = p.querySelector('[data-moye-typeset-box]'), rect = p.getBoundingClientRect(), b = box?.getBoundingClientRect(); r.selectNodeContents(p);
          return { result, exactText: original === p.textContent, before, after: r.getBoundingClientRect().width, box: b ? { left: b.left - rect.left, width: b.width } : null, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        });
        assert.equal(result.result.compressedMarks, 1, glyph); assert.equal(result.exactText, true); assert.ok(result.box && result.box.width < result.before - 1, JSON.stringify({ glyph, result }));
        const screenshot = await page.screenshot({ clip: result.clip, path: path.join(images, `glyph-${glyph.codePointAt(0).toString(16)}.png`) });
        const png = PNG.sync.read(screenshot); let first = Infinity, last = -1, ink = 0;
        for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const at = (y * png.width + x) * 4; if (png.data[at] < 160 && png.data[at + 1] < 160 && png.data[at + 2] < 160 && png.data[at + 3] > 200) { first = Math.min(first, x); last = Math.max(last, x); ink++; } }
        const scale = png.width / result.clip.width; assert.ok(ink > 2, glyph); assert.ok(first >= Math.floor(result.box.left * scale) - 1); assert.ok(last <= Math.ceil((result.box.left + result.box.width) * scale) + 1, JSON.stringify({ glyph, first, last, box: result.box, scale }));
        results.push({ glyph, naturalAdvance: result.before, allocatedAdvance: result.box.width, rasterInk: { first, last, pixels: ink } });
      }
      return { glyphs: results };
    });

    await probe('Latin decimals, Windows and URL paths, and Japanese/Korean letters keep exact text and display advance', async () => {
      const text = 'v1.2.3, A/B: C:\\目录（旧）\\file.md https://example.test/资源（旧）/a.md 日本語かな 한글';
      await fixture('<p style="white-space:pre;width:max-content;text-spacing-trim:space-all"></p>', 1050);
      const result = await page.evaluate(text => {
        const el = window.__moyeRichFixture, p = el.firstElementChild; p.textContent = text;
        const range = document.createRange(); range.selectNodeContents(p); const before = range.getBoundingClientRect().width;
        const result = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'start', 'typography.punctuationCompression': true }); range.selectNodeContents(p);
        return { result, before, after: range.getBoundingClientRect().width, text: p.textContent, glyphBoxes: p.querySelectorAll('[data-moye-typeset-glyph]').length };
      }, text);
      assert.equal(result.text, text); assert.equal(result.glyphBoxes, 0); assert.equal(result.after, result.before); return result;
    });

    await probe('DOM-shaped nested emphasis, deletion, marks and super/subscripts optimise in prose, quotes and list paragraphs', async () => {
      const rich = ('中文<em>嵌套<strong>重点内容</strong></em>与<del>删除</del>、<mark>高亮</mark>，H<sub>2</sub>O和E=mc<sup>2</sup>。').repeat(5);
      const before = await fixture(`<p>${rich}<a id="rich-target" href="https://example.test/ref">链接文本跨行仍然保留唯一链接和锚点文字</a></p><blockquote><p>${'引用中的普通正文，保留结构。'.repeat(8)}</p></blockquote><ul><li><p>${'列表段落保留编号之外的正文结构。'.repeat(7)}</p></li></ul>`, 420);
      const result = await page.evaluate(() => {
        const el = window.__moyeRichFixture, report = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'optimal', 'typography.punctuationCompression': true });
        const paragraphs = [...el.querySelectorAll('[data-moye-typeset="optimal"]')]; const copied = el.cloneNode(true); MoyeParagraphTypesetter.unwrapCopy(copied);
        return { report, text: el.textContent, copiedText: copied.textContent, paragraphs: paragraphs.length, uniqueIds: [...el.querySelectorAll('[id]')].map(n => n.id), formats: Object.fromEntries(['em strong', 'del', 'mark', 'sup', 'sub'].map(selector => [selector, el.querySelectorAll(selector).length])), liveTargetText: el.querySelector('#rich-target')?.textContent, copiedLinks: copied.querySelectorAll('a[href="https://example.test/ref"]').length, copiedTarget: copied.querySelector('#rich-target')?.textContent, privateNodesAfterCopy: copied.querySelectorAll('[data-moye-typeset-line],[data-moye-typeset-box],[data-moye-typeset-glyph],[data-moye-typeset-copy-key],[data-moye-typeset-origin]').length, finalHTML: copied.innerHTML };
      });
      assert.ok(result.paragraphs >= 3, JSON.stringify(result.report)); assert.equal(result.text, before.text); assert.equal(result.copiedText, before.text); assert.equal(new Set(result.uniqueIds).size, result.uniqueIds.length);
      for (const count of Object.values(result.formats)) assert.ok(count > 0); assert.ok(result.liveTargetText?.length > 0, 'live target must not migrate to an empty partial Range clone'); assert.equal(result.copiedLinks, 1); assert.equal(result.copiedTarget, '链接文本跨行仍然保留唯一链接和锚点文字'); assert.equal(result.privateNodesAfterCopy, 0);
      return { paragraphs: result.paragraphs, report: result.report, formats: result.formats, copyKeepsOneOriginalLink: true, exactText: true };
    });

    await probe('copy merges only fragments of one original inline and preserves adjacent independent footnotes and same-URL links', async () => {
      await fixture(`<p style="text-indent:3px">${'中文正文，适合整段断行。'.repeat(12)}<a href="https://example.test/same">独立甲</a><a href="https://example.test/same">独立乙</a><sup><a href="#note">1</a></sup><sup><a href="#note">2</a></sup></p>`);
      const result = await page.evaluate(() => {
        const el = window.__moyeRichFixture, original = el.innerHTML, report = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'optimal', 'typography.punctuationCompression': true });
        const copy = el.cloneNode(true); MoyeParagraphTypesetter.unwrapCopy(copy);
        const result = { report, links: [...copy.querySelectorAll('a[href="https://example.test/same"]')].map(a => a.textContent), footnotes: [...copy.querySelectorAll('sup>a[href="#note"]')].map(a => a.textContent), style: copy.firstElementChild.getAttribute('style') };
        MoyeParagraphTypesetter.restore(el); result.exactRestoration = original === el.innerHTML;
        const raw = document.createElement('div'); raw.innerHTML = '<p data-moye-typeset="optimal" data-moye-typeset-copy-key="invented" data-moye-typeset-original-style="background:url(https://example.test/secret)"><sup><a href="#note">1</a></sup><sup><a href="#note">2</a></sup></p>'; const unchanged = raw.innerHTML; MoyeParagraphTypesetter.unwrapCopy(raw); result.forgedStateIgnored = raw.innerHTML === unchanged;
        return result;
      });
      assert.ok(result.report.optimizedParagraphs > 0); assert.deepEqual(result.links, ['独立甲', '独立乙']); assert.deepEqual(result.footnotes, ['1', '2']); assert.equal(result.style, 'text-indent:3px'); assert.equal(result.exactRestoration, true); assert.equal(result.forgedStateIgnored, true); return result;
    });

    await probe('punctuation hanging has actual overflow beyond the chosen line end without changing source characters', async () => {
      const before = await fixture(`<p style="width:205px;margin:0">${'中文中文中文中文中文。'.repeat(12)}</p>`, 420);
      const result = await page.evaluate(() => {
        const el = window.__moyeRichFixture, report = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'optimal', 'typography.punctuationCompression': true, 'typography.hangingPunctuation': true });
        const p = el.firstElementChild, bounds = p.getBoundingClientRect(), lines = [...p.querySelectorAll('[data-moye-typeset-line]')];
        const hanging = lines.filter(line => line.lastElementChild?.textContent === '。'); const first = hanging[0]?.getBoundingClientRect();
        return { report, text: p.textContent, width: bounds.width, hangs: hanging.map(line => line.lastElementChild.getBoundingClientRect().right - bounds.right), clip: first ? { x: bounds.x, y: first.y, width: bounds.width + 16, height: first.height } : null };
      });
      assert.equal(result.text, before.text); assert.ok(result.report.optimizedParagraphs > 0, JSON.stringify(result)); assert.ok(result.hangs.some(value => value > 1), JSON.stringify(result)); assert.ok(result.hangs.every(value => value < 12));
      const png = PNG.sync.read(await page.screenshot({ clip: result.clip, path: path.join(images, 'hanging-native-ink.png') })); let rightMost = -1;
      for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const i = (y * png.width + x) * 4; if (png.data[i] < 160 && png.data[i + 1] < 160 && png.data[i + 2] < 160) rightMost = Math.max(rightMost, x); }
      const scale = png.width / result.clip.width; assert.ok(rightMost >= Math.ceil(result.width * scale), JSON.stringify({ rightMost, scale, result })); result.rasterOverflowPixels = rightMost + 1 - Math.ceil(result.width * scale); return result;
    });

    await probe('native editing trim is capability-detected and view changes never mutate editable text or nodes', async () => {
      await fixture('<div class="vditor-ir"><div class="vditor-reset" contenteditable="true" lang="zh-CN" style="font:20px/32px &quot;Noto Sans SC&quot;,sans-serif"><p style="text-spacing-trim:space-all">「中文」</p><p>「中文」</p></div></div>', 420);
      const result = await page.evaluate(() => {
        const host = window.__moyeRichFixture, ir = host.querySelector('[contenteditable]'), original = ir.innerHTML, observer = new MutationObserver(() => {}); observer.observe(ir, { childList: true, subtree: true, characterData: true, attributes: true });
        const capabilities = MoyeTypographyView.applyTo(host, { ...MoyeTypography.defaults, 'appearance.fontSize': 20, 'typography.punctuationCompression': true });
        const paragraphs = [...ir.querySelectorAll('p')], measure = p => { const r = document.createRange(); r.selectNodeContents(p); return r.getBoundingClientRect().width; };
        const changes = observer.takeRecords().length; observer.disconnect(); const skipped = MoyeParagraphTypesetter.apply(ir, { 'typography.textAlign': 'optimal', 'typography.punctuationCompression': true });
        return { capabilities, changes, exactDOM: ir.innerHTML === original, font: getComputedStyle(paragraphs[1]).font, lang: ir.lang, fullAdvance: measure(paragraphs[0]), nativeAdvance: measure(paragraphs[1]), nativeValue: getComputedStyle(paragraphs[1]).textSpacingTrim, skippedEditable: skipped.skippedEditable };
      });
      assert.equal(result.changes, 0); assert.equal(result.exactDOM, true); assert.equal(result.skippedEditable, true);
      if (result.capabilities.punctuationCompressionEditing) { assert.equal(result.nativeValue, result.capabilities.textSpacingTrim); assert.ok(result.nativeAdvance < result.fullAdvance - 1, JSON.stringify(result)); }
      return result;
    });

    await probe('unsupported inline geometry, generated quotes, math/code and excessive paragraphs fall back intact', async () => {
      const before = await fixture('<p>含<code>code</code>的段落。</p><p>含<span class="moye-reading-math-source" data-reading-markdown="$x$">$x$</span>的段落。</p><p>含<span style="padding-inline:3px">额外留白</span>的段落。</p><p>含<q>自动引号</q>的段落。</p><p dir="rtl">方向需要浏览器处理。</p><style>.moye-rich-generated::before{content:"前缀"}</style><p class="moye-rich-generated">段落生成内容。</p><p>' + '超长'.repeat(2500) + '</p>');
      const result = await page.evaluate(() => { const el = window.__moyeRichFixture, report = MoyeParagraphTypesetter.apply(el, { 'typography.textAlign': 'optimal', 'typography.punctuationCompression': true }); return { report, html: el.innerHTML, text: el.textContent, leakedMeasurementNodes: document.querySelectorAll('[data-moye-typeset-measure]').length }; });
      assert.equal(result.html, before.html); assert.equal(result.text, before.text); assert.equal(result.leakedMeasurementNodes, 0); assert.equal(result.report.fallbackParagraphs, 7); assert.ok(result.report.reasons.generatedInlineContent); assert.ok(result.report.reasons.complexInlineGeometry); assert.ok(result.report.reasons.boundedDocumentBudget); return result.report;
    });

    await probe('actual settings toggle preserves backward source selection, pending input and a meaningful undo step', async () => {
      const raw = 'before\n'; await open(raw);
      await page.evaluate(() => { moye.setMode('sv'); const s = moye.editor.vditor.sv.element; s.focus(); s.setSelectionRange(1, 5, 'backward'); });
      await page.evaluate(async () => { await moye.settings.apply({ 'typography.punctuationCompression': true }); });
      const selected = await page.evaluate(() => { const s = moye.editor.vditor.sv.element; return [s.selectionStart, s.selectionEnd, s.selectionDirection, s.value]; }); assert.deepEqual(selected, [1, 5, 'backward', raw]);
      await page.evaluate(() => { const s = moye.editor.vditor.sv.element; s.focus(); s.setSelectionRange(6, 6); }); await page.keyboard.insertText(' after'); await page.waitForTimeout(450);
      assert.equal(await page.evaluate(() => moye.getState().content), 'before after\n');
      await page.evaluate(async () => { await moye.settings.apply({ 'typography.punctuationCompression': false }); }); await page.locator('.vditor-sv').focus(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => moye.getState().content), raw); return { backwardSelection: selected.slice(0, 3), inputPreserved: true, undoExact: true };
    });
    report.remoteRequests.push(...await app.evaluate(({ app }) => app.moyeRichRequests));
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally { if (app) { const p = app.process(), exit = p.exitCode === null ? new Promise(resolve => p.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exit; } await fs.rm(work, { recursive: true, force: true, maxRetries: 5 }); }
  report.pass = !report.fatalError && report.results.length > 0 && report.results.every(result => result.status === 'pass') && !report.pageErrors.length && !report.remoteRequests.length;
  await fs.writeFile(process.env.MOYE_RICH_TYPOGRAPHY_OUTPUT || path.join(root, 'tests/typography-rich-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, failed: report.results.filter(result => result.status !== 'pass'), errors: report.pageErrors, remoteRequests: report.remoteRequests, fatalError: report.fatalError }, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
