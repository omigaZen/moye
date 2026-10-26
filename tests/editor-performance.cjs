'use strict';

// Reproducible Linux Electron/Chromium performance probe. Committed insertText
// events are not a substitute for a real OS input-method composition test.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), minMs: sorted[0], maxMs: sorted.at(-1) };
}

async function main() {
  const project = path.resolve(__dirname, '..');
  const fixture = path.join(project, 'samples', '长文性能验收.md');
  const source = await fs.readFile(fixture, 'utf8');
  const packagedExecutable = process.env.MOYE_PERF_EXECUTABLE ? path.resolve(process.env.MOYE_PERF_EXECUTABLE) : null;
  const executable = packagedExecutable || require('electron');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-performance-'));
  const output = path.join(project, 'artifacts');
  await fs.mkdir(output, { recursive: true });
  const fonts = path.resolve(project, '..', 'system-deps', 'fonts.conf');
  const fontExists = await fs.access(fonts).then(() => true, () => false);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length,
      reportedMemoryBytes: os.totalmem(),
      cgroupCpuMax: await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(value => value.trim(), () => null),
      cgroupMemoryMax: await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8').then(value => value.trim(), () => null),
      fontconfigFile: fontExists ? fonts : null,
      runtime: null,
      executable,
      mode: 'Electron headless with explicit 1280×860 renderer viewport, isolated userData; native open/save dialogs stubbed only for deterministic file selection',
    },
    fixture: { path: 'samples/长文性能验收.md', bytes: Buffer.byteLength(source), codePoints: [...source].length, hanCharacters: (source.match(/\p{Script=Han}/gu) || []).length, codeBlocks: (source.match(/^```csharp/gm) || []).length, localImageReferences: (source.match(/^!\[/gm) || []).length },
    sourceHashes: {
      rendererSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(project, 'src', 'renderer.js'))).digest('hex'),
      mainSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(project, 'electron', 'main.cjs'))).digest('hex'),
    },
    thresholds: { openToEditableMs: 2000, inputP95Ms: 50 },
    limitations: [
      'Measured on one Linux host only. Windows and macOS are unmeasured.',
      'Headless requestAnimationFrame is a rendering scheduling proxy, not physical monitor presentation latency.',
      'Playwright keyboard.insertText dispatches committed Unicode text; it does not exercise a real Chinese IME.',
      'The native file picker is replaced with an immediate selection. Human picker time is excluded.',
      'Initial editor launch is warmed before opening the long document. Open timing is document-open-to-editable, not application cold launch.',
    ],
    errors: [],
  };
  let app;
  try {
    const launchStarted = performance.now();
    app = await electron.launch({
      executablePath: executable,
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), ...(packagedExecutable ? [] : [path.join(project, 'electron', 'main.cjs')])],
      env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile'), ...(fontExists ? { FONTCONFIG_FILE: fonts } : {}) },
    });
    report.environment.runtime = await app.evaluate(() => ({ ...process.versions }));
    const loadedApplication = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, sourcePath: app.getAppPath() }));
    const loadedBytes = async filename => loadedApplication.sourcePath.endsWith('.asar')
      ? require('@electron/asar').extractFile(loadedApplication.sourcePath, filename)
      : fs.readFile(path.join(loadedApplication.sourcePath, filename));
    loadedApplication.rendererSha256 = crypto.createHash('sha256').update(await loadedBytes('src/renderer.js')).digest('hex');
    loadedApplication.mainSha256 = crypto.createHash('sha256').update(await loadedBytes('electron/main.cjs')).digest('hex');
    report.isPackaged = loadedApplication.isPackaged;
    report.loadedApplication = loadedApplication;
    const page = await app.firstWindow();
    const fontRequests = new Map();
    const network = await page.context().newCDPSession(page);
    await network.send('Network.enable');
    network.on('Network.requestWillBeSent', event => {
      if (/\.woff2(?:[?#]|$)/i.test(event.request.url)) fontRequests.set(event.requestId, { name: event.request.url, startWallMs: event.wallTime * 1000, startProtocolSeconds: event.timestamp });
    });
    network.on('Network.loadingFinished', event => {
      const request = fontRequests.get(event.requestId);
      if (request) { request.endWallMs = request.startWallMs + (event.timestamp - request.startProtocolSeconds) * 1000; request.encodedDataLength = event.encodedDataLength; }
    });
    network.on('Network.loadingFailed', event => {
      const request = fontRequests.get(event.requestId);
      if (request) request.failed = event.errorText;
    });
    // Ozone headless can clamp the OS window to the virtual screen minimum;
    // explicitly fix the renderer viewport rather than assuming constructor size.
    await page.setViewportSize({ width: 1280, height: 860 });
    report.environment.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
    report.environment.rendererTimeOriginMs = await page.evaluate(() => performance.timeOrigin);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => window.moye?.ready, { timeout: 30000 });
    report.coldStartup = {
      startupToReadyMs: performance.now() - launchStarted,
      method: 'Node monotonic time immediately before Playwright Electron launch → first renderer reports moye.ready; includes automation process/debugger/viewport setup and font preload, excludes human interaction.',
      fonts: await page.evaluate(() => ({ declared: [...document.fonts].length, loaded: [...document.fonts].filter(face => face.status === 'loaded').length, notoSansScDeclared: [...document.fonts].filter(face => /Noto Sans SC/i.test(face.family)).length, notoSansScLoaded: [...document.fonts].filter(face => /Noto Sans SC/i.test(face.family) && face.status === 'loaded').length })),
    };
    report.coldStartup.meets2000Ms = report.coldStartup.startupToReadyMs <= 2000;
    await app.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, fixture);

    report.open = await page.evaluate(async () => {
      const started = performance.now();
      await moye.performAction('open');
      const root = moye.editor.vditor.ir.element;
      root.focus();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { openToEditableMs: performance.now() - started, editable: root.isContentEditable, mode: moye.editor.getCurrentMode(), sourceLength: moye.getState().content.length };
    });
    report.open.meets2000Ms = report.open.editable && report.open.openToEditableMs <= 2000;

    const stableStarted = performance.now();
    await page.waitForFunction(() => {
      const root = moye.editor.vditor.ir.element;
      const images = [...root.querySelectorAll('img')];
      return images.length === 20 && images.every(image => image.complete && image.naturalWidth > 0)
        && root.querySelectorAll('.hljs').length >= 100;
    }, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const resourcesReadyAfterEditableMs = performance.now() - stableStarted;
    // Give debounced stats, syntax preview and layout work time to settle. This
    // wait is outside all input latency measurements.
    await page.waitForTimeout(900);
    report.resources = await page.evaluate(() => {
      const root = moye.editor.vditor.ir.element;
      return { imageCount: root.querySelectorAll('img').length, loadedImageCount: [...root.querySelectorAll('img')].filter(image => image.complete && image.naturalWidth > 0).length, imageNaturalWidths: [...root.querySelectorAll('img')].map(image => image.naturalWidth), highlightedCodeBlocks: root.querySelectorAll('.hljs').length, fontsStatus: document.fonts.status };
    });
    report.resources.settleAfterEditableMs = performance.now() - stableStarted;
    report.resources.resourcesReadyAfterEditableMs = resourcesReadyAfterEditableMs;
    report.resources.additionalStabilizationWaitMs = 900;
    report.resources.unmodifiedContentExact = await page.evaluate(expected => moye.getState().content === expected, source);

    report.viewport = await page.evaluate(() => {
      const root = moye.editor.vditor.ir.element;
      const paragraphs = [...root.querySelectorAll('p')].filter(p => !p.closest('.vditor-ir__preview') && p.textContent.length > 700);
      const index = Math.floor(paragraphs.length / 2);
      const paragraph = paragraphs[index];
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      root.focus({ preventScroll: true });
      const selection = getSelection(), range = document.createRange();
      range.setStart(node, Math.floor(node.textContent.length / 2)); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
      let scroller = root;
      while (scroller.parentElement && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
      const caret = range.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
      scroller.scrollTop += caret.top - bounds.top - scroller.clientHeight / 2;
      window.__moyePerf = { baselineMarkdown: moye.editor.getValue(), scroller, paragraphIndex: index, inputEventCount: 0, eventToFrame: [], fontEvents: [], fontsAtStart: [...document.fonts].map(face => ({ family: face.family, status: face.status, unicodeRange: face.unicodeRange })), phase: 'keyboard', originalStateLength: moye.getState().content.length };
      document.fonts.addEventListener('loading', () => window.__moyePerf.fontEvents.push({ event: 'loading', atMs: performance.now() }));
      document.fonts.addEventListener('loadingdone', event => window.__moyePerf.fontEvents.push({ event: 'loadingdone', atMs: performance.now(), faces: [...event.fontfaces].map(face => ({ family: face.family, status: face.status, unicodeRange: face.unicodeRange })) }));
      root.addEventListener('beforeinput', event => {
        window.__moyePerf.lastBeforeInput = { started: performance.now(), data: event.data, inputType: event.inputType };
      }, true);
      root.addEventListener('input', event => {
        const probe = window.__moyePerf;
        probe.inputEventCount++;
        const before = probe.lastBeforeInput;
        probe.lastBeforeInput = null;
        const started = before?.started ?? performance.now();
        const sample = { phase: probe.phase, character: event.data, trusted: event.isTrusted, startedAtMs: started, startEvent: before ? 'beforeinput' : 'input', inputCaptureAtMs: performance.now() };
        sample.beforeInputToInputCaptureMs = sample.inputCaptureAtMs - started;
        probe.activeInput = sample;
        requestAnimationFrame(() => {
          const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
          const rect = range?.getBoundingClientRect(); // Include caret layout readiness.
          sample.frameAtMs = performance.now(); sample.latencyMs = sample.frameAtMs - started; sample.caretTop = rect?.top;
          probe.eventToFrame.push(sample);
        });
      }, true);
      root.addEventListener('input', () => {
        const sample = window.__moyePerf.activeInput;
        if (sample) sample.inputTargetHandlersMs = performance.now() - sample.inputCaptureAtMs;
      });
      const after = range.getBoundingClientRect();
      return { longParagraphCount: paragraphs.length, selectedParagraphIndex: index, initialScrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, viewportHeight: scroller.clientHeight, caretInitialTop: after.top, scrollerClass: scroller.className };
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, 'performance-middle-before.png') });

    const keyboardText = '【端到端测量】甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
    const keyboardSamples = [];
    for (const character of keyboardText) {
      const started = performance.now();
      await page.keyboard.insertText(character);
      const viewport = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
        const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
        const caret = range?.getBoundingClientRect();
        resolve({ scrollTop: window.__moyePerf.scroller.scrollTop, caretTop: caret?.top, caretBottom: caret?.bottom });
      })));
      keyboardSamples.push({ character, latencyMs: performance.now() - started, ...viewport });
    }
    report.keyboardEndToEnd = {
      method: 'Node performance.now → await Playwright keyboard.insertText(one committed Unicode character) → renderer next requestAnimationFrame callback and IPC response',
      interpretation: 'Conservative automation command roundtrip diagnostic, including IPC and potentially an additional frame; this is not physical input-to-display latency.',
      text: keyboardText, ...distribution(keyboardSamples.map(sample => sample.latencyMs)), samples: keyboardSamples,
    };
    report.keyboardEndToEnd.meets50Ms = report.keyboardEndToEnd.p95Ms <= 50;
    const keyboardEventSamples = await page.evaluate(() => {
      window.__moyePerf.phase = 'page';
      return window.__moyePerf.eventToFrame.filter(sample => sample.phase === 'keyboard');
    });
    report.keyboardEventToFrame = {
      method: 'Renderer capture of real Playwright-dispatched beforeinput (fallback input) → next requestAnimationFrame; excludes command/response IPC outside the renderer',
      ...distribution(keyboardEventSamples.map(sample => sample.latencyMs)), samples: keyboardEventSamples,
    };
    report.keyboardEventToFrame.meets50Ms = report.keyboardEventToFrame.p95Ms <= 50;

    const pageText = '【页面帧测量】天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏';
    const browserSamples = await page.evaluate(async text => {
      const samples = [];
      for (const character of text) {
        const started = performance.now();
        const accepted = document.execCommand('insertText', false, character);
        const synchronousMs = performance.now() - started;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null;
        samples.push({ character, accepted, latencyMs: performance.now() - started, synchronousMs, scrollTop: window.__moyePerf.scroller.scrollTop, caretTop: range?.getBoundingClientRect().top });
      }
      return samples;
    }, pageText);
    report.pageInsertToFrame = {
      method: 'Renderer performance.now → document.execCommand(insertText, one character) → next requestAnimationFrame; excludes Playwright input IPC',
      text: pageText, ...distribution(browserSamples.map(sample => sample.latencyMs)), synchronousWork: distribution(browserSamples.map(sample => sample.synchronousMs)), samples: browserSamples,
    };
    report.pageInsertToFrame.meets50Ms = report.pageInsertToFrame.p95Ms <= 50;
    report.editorInteractionPass = report.keyboardEventToFrame.meets50Ms && report.pageInsertToFrame.meets50Ms;
    await page.waitForTimeout(600);
    report.integrity = await page.evaluate(({ keyboardText, pageText }) => {
      const actual = moye.editor.getValue(), baseline = window.__moyePerf.baselineMarkdown;
      const withoutInserted = actual.replace(keyboardText, '').replace(pageText, '');
      return {
        keyboardTextPresentExactlyOnce: actual.split(keyboardText).length - 1 === 1,
        pageTextPresentExactlyOnce: actual.split(pageText).length - 1 === 1,
        originalRenderedMarkdownIntact: withoutInserted === baseline,
        inputEventCount: window.__moyePerf.inputEventCount,
        expectedInputEventCount: [...keyboardText].length + [...pageText].length,
        stateMatchesCurrentEditor: moye.getState().content === actual,
        originalDocumentCodePoints: [...baseline].length, finalDocumentCodePoints: [...actual].length,
        finalScrollTop: window.__moyePerf.scroller.scrollTop,
      };
    }, { keyboardText, pageText });
    const scrolls = [...keyboardSamples, ...browserSamples].map(sample => sample.scrollTop);
    report.viewport.maximumObservedScrollDeltaPx = Math.max(...scrolls) - Math.min(...scrolls);
    report.viewport.neverJumpedToTop = Math.min(...scrolls) > report.viewport.initialScrollTop / 2;
    report.viewport.allKeyboardCaretPositionsVisible = keyboardSamples.every(sample => sample.caretTop >= 0 && sample.caretBottom <= 860);
    report.viewport.note = 'Per-input scroll/caret samples detect large resets. This is not proof that no intermediate display frame ever flickered.';
    await page.screenshot({ path: path.join(output, 'performance-middle-after.png') });
    const serializationTimes = await page.evaluate(async () => {
      const values = [];
      for (let i = 0; i < 8; i++) {
        const start = performance.now();
        moye.editor.getValue();
        values.push(performance.now() - start);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return values;
    });
    report.profile = { fullDocumentGetValue: { ...distribution(serializationTimes), samplesMs: serializationTimes, note: 'Eight isolated calls after the input test; useful attribution, not an independent input latency measurement.' } };
    // Diagnostic only: repeat the same characters after their first use. The
    // cold-character measurements and their failed gates remain unchanged.
    await page.evaluate(() => { window.__moyePerf.phase = 'warm-keyboard'; });
    const warmRoundtrip = [];
    for (const character of keyboardText) {
      const started = performance.now();
      await page.keyboard.insertText(character);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      warmRoundtrip.push(performance.now() - started);
    }
    const fontDiagnostics = await page.evaluate(({ keyboardText, pageText }) => {
      const probe = window.__moyePerf;
      const resources = performance.getEntriesByType('resource').filter(entry => /\.woff2(?:[?#]|$)/i.test(entry.name)).map(entry => ({ name: entry.name, startTimeMs: entry.startTime, responseEndMs: entry.responseEnd, durationMs: entry.duration, initiatorType: entry.initiatorType }));
      const warmSamples = probe.eventToFrame.filter(sample => sample.phase === 'warm-keyboard');
      const coldSamples = probe.eventToFrame.filter(sample => sample.phase === 'keyboard');
      const coldSpikes = coldSamples.filter(sample => sample.latencyMs > 50).map(sample => ({ ...sample, overlappingFontRequests: resources.filter(entry => entry.startTimeMs <= sample.frameAtMs && entry.responseEndMs >= sample.startedAtMs) }));
      const actual = moye.editor.getValue();
      return {
        warmSamples, coldSpikes, resources, fontEvents: probe.fontEvents,
        initialDeclaredFontFaces: probe.fontsAtStart.length,
        initialLoadedFontFaces: probe.fontsAtStart.filter(face => face.status === 'loaded').length,
        initialNotoSansScDeclaredFaces: probe.fontsAtStart.filter(face => /Noto Sans SC/i.test(face.family)).length,
        initialNotoSansScLoadedFaces: probe.fontsAtStart.filter(face => /Noto Sans SC/i.test(face.family) && face.status === 'loaded').length,
        finalLoadedFontFaces: [...document.fonts].filter(face => face.status === 'loaded').length,
        fullDocumentIntactAfterWarmDiagnostic: actual.replace(keyboardText, '').replace(pageText, '').replace(keyboardText, '') === probe.baselineMarkdown,
      };
    }, { keyboardText, pageText });
    report.warmKeyboardDiagnostic = {
      note: 'Same characters entered a second time, after initial glyph/font use. This diagnostic does not replace or relax the first-use input acceptance gates.',
      eventToFrame: { ...distribution(fontDiagnostics.warmSamples.map(sample => sample.latencyMs)), samples: fontDiagnostics.warmSamples },
      externalRoundtrip: distribution(warmRoundtrip),
      fullDocumentIntactAfterWarmDiagnostic: fontDiagnostics.fullDocumentIntactAfterWarmDiagnostic,
    };
    report.fontLoadingDiagnostics = { ...fontDiagnostics, warmSamples: undefined };
    const origin = report.environment.rendererTimeOriginMs;
    report.fontLoadingDiagnostics.protocolFontRequests = [...fontRequests.values()].map(request => ({ ...request, startTimeMs: request.startWallMs - origin, responseEndMs: request.endWallMs === undefined ? null : request.endWallMs - origin }));
    report.fontLoadingDiagnostics.coldSpikes = report.fontLoadingDiagnostics.coldSpikes.map(sample => ({
      ...sample,
      overlappingProtocolFontRequests: report.fontLoadingDiagnostics.protocolFontRequests.filter(request => request.startTimeMs <= sample.frameAtMs && (request.responseEndMs ?? sample.frameAtMs) >= sample.startedAtMs),
      overlappingFontSetEvents: fontDiagnostics.fontEvents.filter(event => event.atMs >= sample.startedAtMs && event.atMs <= sample.frameAtMs + 20),
    }));
    report.memory = await app.evaluate(({ app }) => ({ unit: 'KiB', note: 'Electron process working-set snapshots after the long-document interaction sample; shared pages can be counted in multiple processes.', processes: app.getAppMetrics().map(({ type, memory }) => ({ type, memory })) }));
    report.pass = report.open.meets2000Ms && report.keyboardEndToEnd.meets50Ms && report.pageInsertToFrame.meets50Ms
      && report.resources.loadedImageCount === 20 && report.resources.unmodifiedContentExact
      && report.integrity.originalRenderedMarkdownIntact && report.integrity.keyboardTextPresentExactlyOnce
      && report.integrity.pageTextPresentExactlyOnce && report.viewport.neverJumpedToTop && report.errors.length === 0;
    if (!report.pass) report.recommendations = [
      'Profile the input handler on the same fixture. Avoid serializing and reparsing the complete document synchronously for every input event.',
      'Keep immediate DOM editing responsive while batching noncritical word count, outline and recovery serialization work.',
      'Remeasure on Windows/macOS and target user hardware before claiming cross-platform performance acceptance.',
    ];
  } catch (error) {
    report.pass = false;
    report.fatalError = error.stack || error.message;
  } finally {
    if (app) {
      const process = app.process();
      const exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await exited;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(error => { report.cleanupError = error.message; });
    await fs.writeFile(path.join(output, 'performance-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ isPackaged: report.isPackaged, pass: report.pass, editorInteractionPass: report.editorInteractionPass, coldStartup: report.coldStartup, open: report.open, resources: report.resources, keyboardEndToEnd: report.keyboardEndToEnd && { p50Ms: report.keyboardEndToEnd.p50Ms, p95Ms: report.keyboardEndToEnd.p95Ms }, keyboardEventToFrame: report.keyboardEventToFrame && { p50Ms: report.keyboardEventToFrame.p50Ms, p95Ms: report.keyboardEventToFrame.p95Ms }, pageInsertToFrame: report.pageInsertToFrame && { p50Ms: report.pageInsertToFrame.p50Ms, p95Ms: report.pageInsertToFrame.p95Ms }, integrity: report.integrity, viewport: report.viewport, fatalError: report.fatalError }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
