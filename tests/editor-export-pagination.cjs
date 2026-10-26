'use strict';
// Actual Electron snapshots and native PDF/PNG, not a CSS-string-only check.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const run = promisify(execFile);
async function main() {
  const project = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-pagination-'));
  const executable = process.env.MOYE_PAGINATION_EXECUTABLE;
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, purpose: 'Real PDF pagination, complete detached export, local links, images and formula fit; not Telari print-engine equivalence', results: [], pageErrors: [], remoteRequests: [] };
  let app, page, outsideDirectory;
  async function check(name, action) { try { const details = await action(); report.results.push({ name, status: 'pass', details }); } catch (error) { report.results.push({ name, status: 'fail', error: error.stack || error.message }); throw error; } }
  try {
    app = await electron.launch({ executablePath: executable || require('electron'), args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(executable ? [] : [project])], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    page.on('pageerror', e => report.pageErrors.push(e.message)); page.on('request', r => { if (/^https?:/.test(r.url())) report.remoteRequests.push(r.url()); });
    await page.waitForFunction(() => window.moye?.ready);
    report.application = await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (executable) assert.equal(report.application.isPackaged, true);
    const baseFile = path.join(work, 'pagination-base.md'); await fs.writeFile(baseFile, '# Export diagnostic\n\nDocument remains unchanged.\n');
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); dialog.showMessageBox = async () => ({ response: 1 }); }, baseFile);
    await page.evaluate(() => moye.performAction('open'));
    await page.evaluate(async () => { moye.setReading(true); await moye.reading.whenReady(); });
    const baseline = await page.evaluate(() => ({ content: moye.getState().content, dirty: moye.getState().dirty, undo: JSON.stringify(moye.editor.vditor.undo) }));
    await check('detached complete TXT export includes every block and keeps the live document unchanged', async () => {
      await page.evaluate(async () => { await moye.settings.apply({ 'reading.txtMode': 'plain', 'reading.txtPreset': 'book' }); await moye.reading.whenReady(); });
      const value = await page.evaluate(async () => {
        const style = moye.reading.getRoot(), full = document.createElement('article'); full.className = style.className; full.dataset.readingComplete = 'true';
        for (let index = 0; index < 240; index++) { const p = document.createElement('p'); p.className = 'moye-reading-plain-paragraph'; p.textContent = `FULL_CHAPTER_${String(index).padStart(3, '0')} 文本🙂 ${'完整内容。'.repeat(25)}`; full.append(p); }
        const before = full.textContent, snapshot = await MoyeExportSnapshot.capture({ element: full, styleElement: style, title: '完整章节' });
        const parsed = new DOMParser().parseFromString(snapshot.html, 'text/html');
        return { text: parsed.querySelector('.moye-export-content').textContent, before, paragraphs: parsed.querySelectorAll('p').length, connected: full.isConnected, width: snapshot.width, css: snapshot.css, bookContext: !!parsed.querySelector('.moye-export-reading-context[data-txt-preset="book"]') };
      });
      assert.equal(value.connected, false); assert.equal(value.text, value.before); assert.equal(value.paragraphs, 240); assert.ok(value.width > 300); assert.match(value.css, /content-visibility:visible!important/); assert.ok(value.bookContext);
      return { completeParagraphs: value.paragraphs, exactText: true, connected: false, txtBookContextPreserved: true };
    });
    await check('a virtual reading window is rejected rather than silently exporting a partial book', async () => {
      const result = await page.evaluate(async () => { const partial = document.createElement('article'); partial.dataset.readingVirtual = 'true'; partial.textContent = 'Only current chapter'; try { await MoyeExportSnapshot.capture({ element: partial, styleElement: moye.reading.getRoot() }); return { rejected: false }; } catch (error) { return { rejected: true, name: error.name, message: error.message }; } });
      assert.ok(result.rejected); assert.equal(result.name, 'TypeError'); assert.ok(result.message.length); return result;
    });
    await check('encoded Chinese and literal-percent footnote links resolve to namespaced exported targets', async () => {
      const result = await page.evaluate(async () => {
        const fixture = document.createElement('article'); fixture.className = moye.reading.getRoot().className;
        for (const [source, id] of [['脚注:中文', 'reader-脚注:中文'], ['literal%20id', 'reader-literal%20id'], ['literal id', 'reader-literal id']]) {
          const ref = document.createElement('a'); ref.href = '#' + encodeURIComponent(source); ref.textContent = 'reference'; const target = document.createElement('p'); target.id = id; target.dataset.readingSourceId = source; target.textContent = 'footnote text'; fixture.append(ref, target);
        }
        const snapshot = await MoyeExportSnapshot.capture({ element: fixture, styleElement: moye.reading.getRoot() }); const doc = new DOMParser().parseFromString(snapshot.html, 'text/html');
        return [...doc.querySelectorAll('a')].map(a => ({ href: a.getAttribute('href'), target: decodeURIComponent(a.getAttribute('href').slice(1)), found: !!doc.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))) }));
      });
      assert.equal(result.length, 3); assert.ok(result.every(x => x.found)); assert.deepEqual(result.map(x => x.target), ['reader-脚注:中文', 'reader-literal%20id', 'reader-literal id']); return { resolvedInternalLinks: result.length, ambiguousEscapesUseDecodedTarget: true };
    });
    await check('reading line boxes and stale formula scales do not freeze exported page geometry', async () => {
      const result = await page.evaluate(async () => {
        const fixture = document.createElement('article'); fixture.className = moye.reading.getRoot().className;
        fixture.style.cssText = 'width:420px;font-size:17px'; fixture.innerHTML = '<p style="text-indent:2em;color:rgb(20,40,60)"><strong>Inline text</strong> '+ '中文与English mixed typography保持正文和格式。'.repeat(12) + '</p><div class="moye-block-math" data-math-scale="0.2" style="font-size:20%"><svg viewBox="0 0 1200 40" width="1200" height="40"><text x="0" y="30">Full formula</text></svg></div>';
        const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-100000px;top:0;width:420px;visibility:hidden'; holder.append(fixture); document.body.append(holder);
        const original = fixture.textContent, optimized = MoyeParagraphTypesetter.apply(fixture, { ...moye.settings.getValues(), 'typography.textAlign': 'optimal' });
        const beforeBoxes = fixture.querySelectorAll('[data-moye-typeset-line]').length, snapshot = await MoyeExportSnapshot.capture({ element: fixture, styleElement: moye.reading.getRoot() }); holder.remove(); const parsed = new DOMParser().parseFromString(snapshot.html, 'text/html');
        return { exactText: parsed.querySelector('.moye-export-content').textContent === original, beforeBoxes, optimized, lineBoxes: parsed.querySelectorAll('[data-moye-typeset-line],[data-moye-typeset-box]').length, strong: parsed.querySelector('strong').textContent, mathScale: parsed.querySelector('.moye-block-math').style.fontSize, authorIndent: parsed.querySelector('p').style.textIndent };
      });
      assert.ok(result.exactText); assert.ok(result.beforeBoxes > 1, JSON.stringify(result.optimized)); assert.equal(result.lineBoxes, 0); assert.equal(result.strong, 'Inline text'); assert.equal(result.mathScale, ''); assert.equal(result.authorIndent, '2em'); return result;
    });
    const imageFile = path.join(work, '中文 图片.svg'); await fs.writeFile(imageFile, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#234567"/></svg>');
    const responsiveImage = path.join(work, '当前 图.svg'); await fs.writeFile(responsiveImage, '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90" fill="#876543"/></svg>');
    outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-export-external-')); const outsideImage = path.join(outsideDirectory, 'referenced.svg'); await fs.writeFile(outsideImage, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#cd3456"/></svg>');
    await check('ignored and responsive images do not corrupt retained images and failed images have readable fallbacks', async () => {
      const result = await page.evaluate(async urls => {
        const fixture = document.createElement('article'); fixture.className = moye.reading.getRoot().className;
        fixture.innerHTML = '<ul><li><p>Image in list</p></li></ul><p></p>'; const list = fixture.querySelector('li'), row = fixture.lastElementChild;
        const ignored = document.createElement('div'); ignored.dataset.exportIgnore = ''; const ignoredImage = document.createElement('img'); ignoredImage.src = urls.bad; ignored.append(ignoredImage); fixture.prepend(ignored);
        for (const parent of [list, row, row]) { const image = document.createElement('img'); image.src = urls.good; image.alt = 'ratio preserved'; parent.append(image); }
        const picture = document.createElement('picture'), source = document.createElement('source'), chosen = document.createElement('img'); source.media = '(min-width:1px)'; source.srcset = urls.chosen; chosen.src = urls.good; chosen.alt = 'selected picture'; picture.append(source, chosen); row.append(picture);
        const responsive = document.createElement('img'); responsive.src = urls.good; responsive.srcset = urls.chosen + ' 1x'; responsive.alt = 'selected srcset'; row.append(responsive);
        const external = document.createElement('img'); external.src = urls.external; external.alt = 'OUTSIDE_REFERENCE_IMAGE'; row.append(external);
        const bad = document.createElement('img'); bad.src = urls.bad; bad.alt = '缺失的图片'; bad.width = 5000; bad.height = 5000; row.append(bad); document.body.append(fixture);
        await Promise.all([...fixture.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
        const snapshot = await MoyeExportSnapshot.capture({ element: fixture }); fixture.remove(); const parsed = new DOMParser().parseFromString(snapshot.html, 'text/html');
        return { images: [...parsed.querySelectorAll('img')].map(image => image.src), fallbacks: [...parsed.querySelectorAll('.moye-export-image-fallback')].map(x => x.textContent), externalPixels: parsed.querySelector('img[alt="OUTSIDE_REFERENCE_IMAGE"]')?.src || null, warnings: snapshot.warnings, hasHugeDimensions: /(?:width|height)="5000"/.test(snapshot.html), currentPicture: chosen.currentSrc, currentSrcset: responsive.currentSrc, nativeScope: await desktop.checkExportResources({ urls: [urls.good, urls.external] }) };
      }, { good: pathToFileURL(imageFile).href, chosen: pathToFileURL(responsiveImage).href, external: pathToFileURL(outsideImage).href, bad: pathToFileURL(path.join(work, 'missing.svg')).href });
      assert.equal(result.images.length, result.externalPixels ? 6 : 5); assert.equal(result.images.filter(url => url === pathToFileURL(imageFile).href).length, 3); assert.equal(result.currentPicture, pathToFileURL(responsiveImage).href); assert.equal(result.currentSrcset, pathToFileURL(responsiveImage).href); assert.equal(result.images.filter(url => url === pathToFileURL(responsiveImage).href).length, 2); assert.ok(result.fallbacks.some(x => x.includes('缺失的图片'))); assert.ok(!result.hasHugeDimensions); assert.ok(result.warnings.length); assert.deepEqual(result.nativeScope, [true, false]);
      if (result.externalPixels) assert.match(result.externalPixels, /^data:image\/png;base64,/); else assert.ok(result.fallbacks.some(x => x.includes('OUTSIDE_REFERENCE_IMAGE')) && result.warnings.length);
      return { retainedImages: result.images.length, responsiveCurrentSourcesPreserved: 2, ignoredImageDidNotShiftSources: true, failedImageFallback: true, noReserved5000pxBox: true, externalFileStillDenied: true, externalReference: result.externalPixels ? 'loaded pixels reused' : 'explicit fallback and warning' };
    });
    await check('actual wide KaTeX HTML is captured as a scalable passive vector viewport', async () => {
      const result = await page.evaluate(async imageUrl => {
        const fixture = document.createElement('article'); fixture.className = moye.reading.getRoot().className; fixture.style.fontSize = getComputedStyle(moye.reading.getRoot()).fontSize; fixture.innerHTML = '<p>WIDE_FORMULA_PROOF</p>' + moye.editor.vditor.lute.Md2HTML('Inline $\\sqrt{x^2+y^2}+\\overbrace{a+b}$.\n\n$$' + Array.from({ length: 45 }, (_, i) => `\\sqrt{x_{${i}}^2+y_{${i}}^2}`).join('+') + '$$'); document.body.append(fixture);
        const math = await MoyeMathReadingSyntax.render(fixture, { 'math.engine': 'KaTeX', 'markdown.math': true, 'markdown.inlineMath': true }, { cdn: moye.editor.vditor.options.cdn, math: moye.editor.vditor.options.preview.math });
        const spacer = document.createElement('div'); spacer.style.height = '1600px'; fixture.append(spacer); const lazy = document.createElement('img'); lazy.src = imageUrl; lazy.alt = 'LAZY_IMAGE_AFTER_VIEWPORT'; fixture.append(lazy); await lazy.decode(); lazy.loading = 'lazy';
        await document.fonts.ready;
        const inlineSvgRatios = [...fixture.querySelectorAll('.katex svg')].filter(svg => !svg.closest('.katex-display')).map(svg => svg.getBoundingClientRect().height / parseFloat(getComputedStyle(svg.closest('.katex')).fontSize));
        const snapshot = await MoyeExportSnapshot.capture({ element: fixture, styleElement: moye.reading.getRoot(), title: 'Wide formula' }); fixture.remove();
        const parsed = new DOMParser().parseFromString(snapshot.html, 'text/html'), svg = parsed.querySelector('svg.moye-export-formula');
        window.__paginationWideSnapshot = snapshot;
        window.__paginationInlineSvgRatios = inlineSvgRatios;
        return { rendered: math.rendered, errors: math.errors, svg: !!svg, viewBox: svg?.getAttribute('viewBox'), formulaText: svg?.querySelector('.katex-html')?.textContent, foreign: svg?.querySelectorAll('foreignObject').length, active: parsed.querySelectorAll('script,iframe,button').length, inlineSvgRatios, originalLazy: lazy.loading, exportedLoading: parsed.querySelector('img').getAttribute('loading') };
      }, pathToFileURL(imageFile).href);
      assert.equal(result.rendered, 2); assert.deepEqual(result.errors, []); assert.ok(result.svg); assert.equal(result.foreign, 1); assert.equal(result.active, 0); assert.ok(Number(result.viewBox.split(' ')[2]) > 2000); assert.match(result.formulaText, /x/); assert.ok(result.inlineSvgRatios.length >= 2 && result.inlineSvgRatios.every(r => r > 0.1)); assert.equal(result.originalLazy, 'lazy'); assert.equal(result.exportedLoading, 'eager'); return { rendered: 2, vectorWidth: Number(result.viewBox.split(' ')[2]), passiveForeignObject: true, inlineSvgRatios: result.inlineSvgRatios, lazyExportIsEagerWithoutSourceMutation: true };
    });
    await app.evaluate(({ app }) => {
      global.__paginationWindows = [];
      app.on('browser-window-created', (_event, win) => {
        if (win.webContents.getLastWebPreferences().javascript !== false) return;
        win.webContents.once('did-finish-load', () => {
          win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: `JSON.stringify({mainWidth:document.querySelector('main').getBoundingClientRect().width,formulas:Array.from(document.querySelectorAll('svg.moye-export-formula')).map(s=>{const b=s.getBoundingClientRect();return {width:b.width,height:b.height,viewBox:s.getAttribute('viewBox')}}),inlineSvgRatios:Array.from(document.querySelectorAll('.katex svg')).filter(s=>!s.closest('svg.moye-export-formula')).map(s=>s.getBoundingClientRect().height/parseFloat(getComputedStyle(s.closest('.katex')).fontSize))})`, returnByValue: true }).then(r => global.__paginationWindows.push(JSON.parse(r.result.value))).catch(() => {});
        });
      });
    });
    await check('native PDF keeps heading with body and fully paginates a long footnote with working internal links', async () => {
      const snapshot = await page.evaluate(async imageUrls => {
        const fixture = document.createElement('article'); fixture.className = moye.reading.getRoot().className;
        const spacer = document.createElement('div'); spacer.style.height = '940px'; spacer.textContent = 'PAGE_ONE_FILLER'; fixture.append(spacer);
        const h = document.createElement('h2'); h.textContent = 'KEEP_WITH_BODY_HEADING'; const p = document.createElement('p'); p.textContent = 'BODY_HEAD_GUARD First body line must travel with its heading. Readable print text.'; fixture.append(h, p);
        const bookParagraph = document.createElement('p'); bookParagraph.className = 'moye-reading-plain-paragraph'; bookParagraph.textContent = 'TXT_BOOK_INDENT_MARKER '+ 'Book paragraph keeps its first-line indent. '.repeat(4); fixture.append(bookParagraph);
        const list = document.createElement('ul'), li = document.createElement('li'), imageRow = document.createElement('p'); li.textContent = 'LOCAL_IMAGE_LIST'; list.append(li); fixture.append(list, imageRow);
        for (const parent of [li, imageRow, imageRow]) { const image = document.createElement('img'); image.src = imageUrls.good; image.alt = 'Local ratio 2 to 1'; parent.append(image); }
        const badImage = document.createElement('img'); badImage.src = imageUrls.bad; badImage.alt = 'MISSING_PDF_IMAGE'; badImage.width = 5000; badImage.height = 5000; imageRow.append(badImage);
        const external = document.createElement('img'); external.src = imageUrls.external; external.alt = 'OUTSIDE_REFERENCE_IMAGE'; imageRow.append(external);
        for (let n = 0; n < 2; n++) { const ref = document.createElement('a'); ref.href = '#'+encodeURIComponent('脚注:中文'); ref.textContent = n ? 'ADJACENT_REF_TWO' : 'ADJACENT_REF_ONE'; fixture.append(ref); }
        const notes = document.createElement('section'); notes.className = 'footnotes-defs-div'; notes.style.cssText = 'max-height:40px;overflow:hidden';
        const target = document.createElement('div'); target.id = 'reader-脚注:中文'; target.dataset.readingSourceId = '脚注:中文';
        for (let index = 0; index < 100; index++) { const item = document.createElement('p'); item.textContent = `LONG_FOOTNOTE_${String(index).padStart(3,'0')} ${'A long footnote remains selectable across pages. '.repeat(3)}`; target.append(item); }
        notes.append(target); fixture.append(notes);
        const table = document.createElement('table'), head = document.createElement('thead'), header = document.createElement('tr'), body = document.createElement('tbody');
        for (let column = 1; column <= 12; column++) { const cell = document.createElement('th'); cell.textContent = 'H'+column; header.append(cell); } head.append(header);
        for (let row = 0; row < 3; row++) { const line = document.createElement('tr'); for (let column = 1; column <= 12; column++) { const cell = document.createElement('td'); cell.textContent = column === 12 ? 'Z12' : 'C'+column; line.append(cell); } body.append(line); }
        table.append(head, body); fixture.append(table); const end = document.createElement('p'); end.textContent = 'COMPLETE_PDF_FINAL_MARKER'; fixture.append(end);
        const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden'; holder.append(fixture); document.body.append(holder);
        await Promise.all([...fixture.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
        try { return await MoyeExportSnapshot.capture({ element: fixture, styleElement: moye.reading.getRoot(), title: 'Pagination proof', theme: 'paper' }); } finally { holder.remove(); }
      }, { good: pathToFileURL(imageFile).href, bad: pathToFileURL(path.join(work, 'missing.svg')).href, external: pathToFileURL(outsideImage).href });
      const destination = path.join(work, 'pagination.pdf'); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination);
      const expectedBodyFontPt = await page.evaluate(() => parseFloat(getComputedStyle(moye.reading.getRoot()).fontSize) * 0.75);
      const native = await page.evaluate(payload => desktop.exportDocument(payload), { ...snapshot, options: { format: 'pdf', paperSize: 'A4', theme: 'paper', width: 780 } }); assert.ok(native.saved);
      const text = (await run('pdftotext', ['-layout', destination, '-'])).stdout, pages = text.split('\f');
      const heading = pages.findIndex(p => p.includes('KEEP_WITH_BODY_HEADING')), body = pages.findIndex(p => p.includes('BODY_HEAD_GUARD'));
      assert.ok(heading >= 0); assert.equal(heading, body); assert.ok(pages.length > 4); for (let i = 0; i < 100; i++) assert.ok(text.includes(`LONG_FOOTNOTE_${String(i).padStart(3, '0')}`), `Footnote ${i}`); assert.ok(text.includes('COMPLETE_PDF_FINAL_MARKER'));
      const links = JSON.parse((await run('python3', ['-c', 'import json,sys,urllib.parse\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1]); named=r.named_destinations; output=[]\nfor i,p in enumerate(r.pages):\n for ref in p.get("/Annots",[]):\n  a=ref.get_object(); action=a.get("/A",{}); dest=a.get("/Dest")\n  if action.get("/S")=="/GoTo": dest=action.get("/D")\n  if dest is None: continue\n  target=None; name=None\n  if isinstance(dest,str):\n   name=urllib.parse.unquote(str(dest)).lstrip("/#"); resolved=named.get(str(dest))\n   if resolved is not None: target=r.get_destination_page_number(resolved)\n  elif isinstance(dest,list) and dest:\n   first=dest[0]; target=next((j for j,q in enumerate(r.pages) if getattr(first,"idnum",None)==getattr(q.indirect_reference,"idnum",None)),None)\n  output.append({"page":i,"target":target,"name":name,"resolved":target is not None and 0<=target<len(r.pages)})\nprint(json.dumps(output,ensure_ascii=False))', destination])).stdout);
      const footnotePage = pages.findIndex(p => p.includes('LONG_FOOTNOTE_000'));
      assert.ok(links.length >= 2 && links.every(link => link.resolved && link.target === footnotePage && (link.name === null || link.name === 'reader-脚注:中文')), JSON.stringify(links));
      assert.ok(text.includes('MISSING_PDF_IMAGE'));
      const drawnImagePixels = Number((await run('python3', ['-c', 'import fitz,sys; d=fitz.open(sys.argv[1]); total=0\nfor p in d:\n im=p.get_pixmap(alpha=False); b=im.samples; total+=sum(abs(b[i]-35)<5 and abs(b[i+1]-69)<5 and abs(b[i+2]-103)<5 for i in range(0,len(b),im.n))\nprint(total)', destination])).stdout.trim());
      assert.ok(drawnImagePixels > 6000, `Expected several complete local images, got ${drawnImagePixels} matching pixels`);
      const externalPixels = Number((await run('python3', ['-c', 'import fitz,sys; d=fitz.open(sys.argv[1]); total=0\nfor p in d:\n im=p.get_pixmap(alpha=False); b=im.samples; total+=sum(abs(b[i]-205)<5 and abs(b[i+1]-52)<5 and abs(b[i+2]-86)<5 for i in range(0,len(b),im.n))\nprint(total)', destination])).stdout.trim());
      assert.ok(externalPixels > 1500 || text.includes('OUTSIDE_REFERENCE_IMAGE') && native.warnings.length, 'An out-of-scope image must reuse loaded pixels or have a visible fallback and warning');
      const tableCells = JSON.parse((await run('python3', ['-c', 'import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps([{"page":i,"text":w[4],"x0":w[0],"x1":w[2],"width":p.rect.width} for i,p in enumerate(d) for w in p.get_text("words") if w[4]=="Z12"]))', destination])).stdout);
      assert.equal(tableCells.length, 3, 'All rightmost cells in the 12-column table stay visible'); assert.ok(tableCells.every(w => w.x0 >= 40 && w.x1 <= w.width - 40), JSON.stringify(tableCells));
      const bodyFonts = JSON.parse((await run('python3', ['-c', 'import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps([s["size"] for p in d for b in p.get_text("dict")["blocks"] if "lines" in b for l in b["lines"] for s in l["spans"] if "BODY_HEAD_GUARD" in s["text"]]))', destination])).stdout);
      assert.ok(bodyFonts.length && bodyFonts.every(size => Math.abs(size - expectedBodyFontPt) < 0.3), `Wide table must not shrink the whole document: ${JSON.stringify({ bodyFonts, expectedBodyFontPt })}`);
      const indents = JSON.parse((await run('python3', ['-c', 'import fitz,json,sys; d=fitz.open(sys.argv[1]); print(json.dumps({w[4]:w[0] for p in d for w in p.get_text("words") if w[4] in ["TXT_BOOK_INDENT_MARKER","BODY_HEAD_GUARD"]}))', destination])).stdout);
      const bookIndentPt = indents.TXT_BOOK_INDENT_MARKER - indents.BODY_HEAD_GUARD; assert.ok(Math.abs(bookIndentPt - expectedBodyFontPt * 2) < 1, JSON.stringify(indents));
      await app.evaluate(({ dialog }) => { global.__paginationSaveCalls = 0; dialog.showSaveDialog = async () => { global.__paginationSaveCalls++; return { canceled: false, filePath: global.__paginationUiDestination }; }; });
      const uiLayouts = [];
      for (const [direction, marginMm] of [['landscape', 30], ['portrait', 8]]) {
        await page.evaluate(() => moye.performAction('export-pdf'));
        const modal = page.locator('dialog[open]:has([data-export-option="orientation"])'), orientation = modal.locator('[data-export-option="orientation"]'), margin = modal.locator('[data-export-option="margin-mm"]');
        assert.ok(await orientation.isVisible() && await margin.isVisible()); assert.equal(await margin.getAttribute('min'), '8'); assert.equal(await margin.getAttribute('max'), '30');
        await orientation.selectOption(direction); await orientation.focus(); await page.keyboard.press('Tab'); assert.equal(await margin.evaluate(node => document.activeElement === node), true);
        const runButton = modal.locator('.dialog-actions button').first();
        if (direction === 'landscape') {
          for (const invalid of ['7', '31', '8.5', '']) { await margin.fill(invalid); await runButton.click(); assert.match(await modal.locator('[role="status"]').textContent(), /8.*30/); assert.equal(await app.evaluate(() => global.__paginationSaveCalls), 0); assert.equal(await runButton.isEnabled(), true); }
        }
        const file = path.join(work, `ui-${direction}-${marginMm}.pdf`); await app.evaluate((_electron, destination) => { global.__paginationUiDestination = destination; }, file); await margin.fill(String(marginMm)); await runButton.click();
        await page.waitForFunction(() => { const d = document.querySelector('dialog[open]:has([data-export-option="orientation"])'); return d && !d.querySelector('.dialog-actions button').disabled; }, null, { timeout: 30000 });
        assert.ok((await fs.stat(file)).size > 1000);
        const layout = JSON.parse((await run('python3', ['-c', 'import fitz,json,sys; d=fitz.open(sys.argv[1]); p=d[0]; words=p.get_text("words"); print(json.dumps({"width":p.rect.width,"height":p.rect.height,"left":min(w[0] for w in words)}))', file])).stdout); uiLayouts.push({ direction, marginMm, ...layout });
        if (direction === 'landscape') assert.ok(Math.abs(layout.width - 297 / 25.4 * 72) < 2 && Math.abs(layout.height - 210 / 25.4 * 72) < 2); else assert.ok(layout.width < layout.height);
        await modal.locator('.dialog-actions button').last().click(); await modal.waitFor({ state: 'detached' });
      }
      assert.equal(await app.evaluate(() => global.__paginationSaveCalls), 2); assert.ok(Math.abs(uiLayouts[0].left - uiLayouts[1].left - 22 / 25.4 * 72) < 1, JSON.stringify(uiLayouts));
      return { pdfPages: pages.filter(p => p.trim()).length, headingAndBodyPage: heading + 1, completeFootnoteParagraphs: 100, workingInternalLinks: links.length, localImagePixels: drawnImagePixels, externalReferencePixels: externalPixels, externalReferenceNotSilentlyDropped: true, failedImageTextVisible: true, wideTableColumns: 12, rightmostCellsWithinPage: tableCells.length, unshrunkBodyFontPt: bodyFonts[0], preservedTxtBookIndentPt: bookIndentPt, nativeOrientationAndMarginUI: uiLayouts, invalidMarginsRejectedBeforeSave: true, sizeBytes: native.sizeBytes };
    });
    await check('native narrow PNG and PDF scale the entire formula instead of cropping its right side', async () => {
      const snapshot = await page.evaluate(() => window.__paginationWideSnapshot), destination = path.join(work, 'wide.png');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, destination);
      const native = await page.evaluate(payload => desktop.exportDocument(payload), { ...snapshot, options: { format: 'png', width: 400, scale: 2, theme: 'paper' } }); assert.ok(native.saved);
      const png = await fs.readFile(destination); assert.equal(png.readUInt32BE(16), 800); assert.ok(png.readUInt32BE(20) > 80);
      const lazyImagePixels = Number((await run('python3', ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); print(sum(abs(r-35)<5 and abs(g-69)<5 and abs(b-103)<5 for r,g,b in im.getdata()))', destination])).stdout.trim()); assert.ok(lazyImagePixels > 20000, `Image below the first viewport must draw completely: ${lazyImagePixels}`);
      const audit = await app.evaluate(() => global.__paginationWindows), measured = audit.flatMap(w => w.formulas.map(f => ({ ...f, mainWidth: w.mainWidth }))).at(-1); assert.ok(measured);
      const expectedInline = await page.evaluate(() => window.__paginationInlineSvgRatios), actualInline = audit.at(-1).inlineSvgRatios;
      assert.equal(actualInline.length, expectedInline.length); for (let i = 0; i < expectedInline.length; i++) assert.ok(Math.abs(actualInline[i] - expectedInline[i]) < 0.03, JSON.stringify({ expectedInline, actualInline }));
      const view = measured.viewBox.split(' ').map(Number), expectedRatio = view[2] / view[3]; assert.ok(measured.width <= measured.mainWidth + 1); assert.ok(Math.abs(measured.width / measured.height - expectedRatio) / expectedRatio < 0.03, JSON.stringify(measured));
      const pdf = path.join(work, 'wide-formula.pdf'); await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, pdf);
      const pdfResult = await page.evaluate(payload => desktop.exportDocument(payload), { ...snapshot, options: { format: 'pdf', paperSize: 'A5', theme: 'paper', width: 400 } }); assert.ok(pdfResult.saved);
      const terms = JSON.parse((await run('python3', ['-c', 'import fitz,json,sys,unicodedata; d=fitz.open(sys.argv[1]); t=unicodedata.normalize("NFKC","".join(p.get_text() for p in d)); print(json.dumps({"x":t.count("x"),"y":t.count("y"),"pages":len(d)}))', pdf])).stdout);
      assert.ok(terms.x >= 46 && terms.y >= 46, `All formula terms must survive PDF export: ${JSON.stringify(terms)}`);
      return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), naturalFormulaWidth: view[2], drawnFormulaWidth: measured.width, mainWidth: measured.mainWidth, preservedAspectRatio: true, inlineSqrtAndBraceHeightRatios: actualInline, lowerLazyImagePixels: lazyImagePixels, nativePdfFormulaTerms: terms };
    });
    const after = await page.evaluate(() => ({ content: moye.getState().content, dirty: moye.getState().dirty, undo: JSON.stringify(moye.editor.vditor.undo) })); assert.deepEqual(after, baseline);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.remoteRequests, []); report.pass = true;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; process.exitCode = 1; }
  finally {
    if (app) { const child = app.process(), exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
    await fs.writeFile(process.env.MOYE_PAGINATION_OUTPUT || path.join(project, 'tests/export-pagination-report.json'), JSON.stringify(report, null, 2) + '\n'); await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
    if (outsideDirectory) await fs.rm(outsideDirectory, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(JSON.stringify({ pass: report.pass, cases: report.results.length, results: report.results, fatalError: report.fatalError }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
