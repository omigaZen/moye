'use strict';

// Exercise the real browser renderer with the packaged scripts and the same CSP.
// This resource test is separate from full-app editing and Typora equivalence.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const project = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-mathjax-offline-'));
  const resource = filename => pathToFileURL(path.join(project, 'src', filename)).href;
  const cdn = resource('vendor/vditor');
  const csp = "default-src 'self' file: data: blob:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' file:; img-src 'self' file: data: blob:; font-src 'self' file: data:; connect-src 'self' file: data:; object-src 'none'; frame-src 'none'; base-uri 'none'";
  await fs.writeFile(path.join(work, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${resource('vendor/vditor/dist/index.css')}"></head><body><div id="samples" class="vditor-reset"></div><script src="${resource('vendor/vditor/dist/index.min.js')}"></script><script src="${resource('math-config.js')}"></script></body></html>`);
  await fs.writeFile(path.join(work, 'main.cjs'), `'use strict';
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(work, 'profile'))});
app.whenReady().then(() => {
  app.mathProbeRequests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    app.mathProbeRequests.push(details.url);
    callback({ cancel: /^https?:/.test(details.url) });
  });
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.loadFile(${JSON.stringify(path.join(work, 'index.html'))});
});
`);
  const report = { method: 'Standalone Electron resource/helper integration with strict app CSP, isolated profile, all HTTP(S) aborted at session level including worker requests.', results: [], errors: [], consoleErrors: [], remoteRequests: [] };
  let app;
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : []), path.join(work, 'main.cjs')],
    });
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.waitForFunction(() => window.MoyeMath && window.Vditor);

    async function render(formulae, settings = {}) {
      await page.evaluate(async ({ cdn, formulae, settings }) => {
        const options = { cdn, engine: 'MathJax', macros: {}, autoNumber: false, ...settings };
        await MoyeMath.configure(options);
        MoyeMath.resetDocument();
        const container = document.getElementById('samples');
        container.innerHTML = '';
        for (const text of formulae) {
          const element = document.createElement('div');
          element.className = 'language-math'; element.textContent = text;
          container.appendChild(element);
        }
        Vditor.mathRender(container, { cdn, math: MoyeMath.previewOptions(options) });
      }, { cdn, formulae, settings });
      await page.waitForFunction(count => document.querySelectorAll('#samples .language-math[data-math], #samples .vditor-reset--error').length === count, formulae.length, { timeout: 20000 });
      return page.evaluate(() => ({
        count: document.querySelectorAll('#samples .language-math > mjx-container[jax="SVG"]').length,
        errors: [...document.querySelectorAll('#samples .vditor-reset--error')].map(element => element.textContent),
        html: document.getElementById('samples').innerHTML,
      }));
    }
    async function probe(name, callback) {
      try { const details = await callback(); report.results.push({ name, status: 'pass', details }); }
      catch (error) { report.results.push({ name, status: 'fail', error: error.message }); }
    }

    await probe('five formulae render through MathJax 4 offline under strict CSP', async () => {
      const rendered = await render([
        String.raw`\int_0^1 x^2\,dx`, String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`,
        String.raw`\ce{H2O}`, String.raw`\mathbb{\alpha}+\mathscr{ABC}+𝛼`,
        String.raw`\begingroup\def\foo{x}\foo\endgroup`,
      ]);
      assert.equal(rendered.count, 5); assert.deepEqual(rendered.errors, []);
      const version = await page.evaluate(() => MathJax.version);
      assert.equal(version, '4.1.3'); return { version, formulae: rendered.count };
    });
    await probe('runtime custom macro added and removed without stale expansion', async () => {
      let rendered = await render([String.raw`\RR^2`], { macros: { RR: String.raw`\mathbb{R}` } });
      assert.equal(rendered.count, 1); assert.deepEqual(rendered.errors, []);
      assert.ok(!rendered.html.includes('-5C"'));
      rendered = await render([String.raw`\RR^2`]);
      // MathJax's noundefined package draws the literal backslash as SVG paths.
      assert.ok(rendered.html.includes('-5C"') || rendered.errors.length);
      return { removed: true };
    });
    await probe('macro argument arrays are applied', async () => {
      const rendered = await render([String.raw`\bold{x+y}`], { macros: { bold: [String.raw`\mathbf{#1}`, 1] } });
      assert.equal(rendered.count, 1); assert.deepEqual(rendered.errors, []);
      assert.ok(!rendered.html.includes('-5C"')); return { count: rendered.count };
    });
    await probe('numbering can be enabled, reset for a new document and disabled', async () => {
      let rendered = await render(['x=1', 'y=2'], { autoNumber: true });
      assert.equal(rendered.count, 2); assert.match(rendered.html, /data-labels|mjx-eqn|data-mml-node="mtable"/);
      const first = rendered.html;
      rendered = await render(['x=1', 'y=2'], { autoNumber: true });
      // Reset should start labels from the first equation rather than 3/4.
      const labels = html => [...html.matchAll(/data-labels="([^"]*)"/g)].map(match => match[1]);
      assert.deepEqual(labels(rendered.html), labels(first));
      rendered = await render(['x=1', 'y=2']);
      assert.equal(rendered.count, 2); assert.doesNotMatch(rendered.html, /data-labels|mjx-eqn/);
      return { enabledThenDisabled: true };
    });
    await probe('invalid formula can be corrected without renderer errors', async () => {
      let rendered = await render([String.raw`\frac{`]);
      assert.equal(rendered.errors.length, 1);
      rendered = await render([String.raw`\frac{1}{2}`]);
      assert.equal(rendered.count, 1); assert.deepEqual(rendered.errors, []);
      return { corrected: true };
    });
    await probe('all NewCM dynamic SVG data loads from local files', async () => {
      await page.evaluate(() => MathJax.startup.document.outputJax.font.loadDynamicFiles());
      const requests = await app.evaluate(({ app }) => app.mathProbeRequests);
      const dynamic = requests.filter(url => /mathjax-newcm-font\/svg\/dynamic\//.test(url));
      assert.ok(dynamic.length > 20, `Expected dynamic font chunks, saw ${dynamic.length}`);
      assert.ok(dynamic.every(url => url.startsWith(cdn + '/dist/js/mathjax/fonts/')));
      return { dynamicChunks: dynamic.length };
    });
    const nativeRequests = await app.evaluate(({ app }) => app.mathProbeRequests);
    report.remoteRequests = nativeRequests.filter(url => /^https?:/.test(url));
    report.localDynamicRequests = nativeRequests.filter(url => /\/dynamic\//.test(url)).map(url => url.slice(cdn.length));
    report.version = await page.evaluate(() => MathJax.version);
    report.pass = report.results.every(result => result.status === 'pass') && report.errors.length === 0 && report.consoleErrors.length === 0 && report.remoteRequests.length === 0;
  } catch (error) { report.pass = false; report.fatalError = error.stack || error.message; }
  finally {
    if (app) {
      const process = app.process();
      const exited = process.exitCode === null ? new Promise(resolve => process.once('exit', resolve)) : Promise.resolve();
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited;
    }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.writeFile(path.join(project, 'tests', 'mathjax-offline-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
