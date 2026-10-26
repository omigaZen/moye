'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron: electron } = require('playwright');

async function main() {
  const project = path.resolve(__dirname, '..');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-math-layout-'));
  const executable = process.env.MOYE_LAYOUT_EXECUTABLE ? path.resolve(process.env.MOYE_LAYOUT_EXECUTABLE) : require('electron');
  const app = await electron.launch({
    executablePath: executable,
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'] : []), ...(process.env.MOYE_LAYOUT_EXECUTABLE ? [] : [path.join(project, 'electron/main.cjs')])],
    env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') },
  });
  const results = [], errors = [];
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  async function probe(name, run) {
    try { results.push({ name, status: 'pass', details: await run() }); }
    catch (error) {
      const details = await page.evaluate(() => window.moyeMathClickDiagnostics ? { clickDiagnostics: window.moyeMathClickDiagnostics.events, finalState: window.moyeMathClickDiagnostics.snapshot() } : undefined).catch(() => undefined);
      results.push({ name, status: 'fail', error: error.message, details });
    }
  }
  const fixture = '# 公式排版回归\n\n前文。\n\n$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$\n\n后文。\n\n```javascript\nconst n = 1;\n```\n\n尾部。\n';
  try {
    await page.waitForFunction(() => window.moye?.ready);
    await page.setViewportSize({ width: 1280, height: 860 });
    const file = path.join(work, 'formula-layout.md');
    await fs.writeFile(file, fixture);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.evaluate(() => moye.performAction('open'));
    await page.evaluate(() => moye.settings.apply({ 'appearance.theme': 'dark' }));
    await page.waitForFunction(() => document.querySelectorAll('.vditor-ir mjx-container,.vditor-ir .katex').length >= 1);
    await page.waitForTimeout(220); // IR marker transitions last 150 ms.

    await probe('collapsed math and code source markers have zero area and no padding box', async () => {
      const markers = await page.evaluate(() => [...document.querySelectorAll('.vditor-ir__node:not(.vditor-ir__node--expand) pre.vditor-ir__marker')].map(node => {
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { type: node.parentElement.dataset.type, width: rect.width, height: rect.height, padding: style.padding, background: style.backgroundColor };
      }));
      assert.ok(markers.some(marker => marker.type === 'math-block'));
      assert.ok(markers.some(marker => marker.type === 'code-block'));
      for (const marker of markers) {
        assert.equal(marker.width, 0, JSON.stringify(marker));
        assert.equal(marker.height, 0, JSON.stringify(marker));
        assert.equal(marker.padding, '0px', JSON.stringify(marker));
        assert.equal(marker.background, 'rgba(0, 0, 0, 0)', JSON.stringify(marker));
      }
      return markers;
    });
    await fs.mkdir(path.join(project, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'artifacts/math-marker-after-020.png') });

    await probe('expanding a formula keeps its original editable source visible', async () => {
      const before = await page.evaluate(() => moye.getState().content);
      await page.evaluate(() => {
        const ir = moye.editor.vditor.ir.element, block = ir.querySelector('[data-type="math-block"]'), events = [];
        // Exercise a real click after scrolling. A blur-induced return to the
        // first caret must not move the preview between mouse down and up.
        ir.scrollTop = Math.min(78, Math.max(0, ir.scrollHeight - ir.clientHeight));
        const describe = node => {
          if (!node) return null;
          if (node.nodeType === Node.TEXT_NODE) return '#text<' + describe(node.parentElement) + '>';
          return [node.tagName || node.nodeName, node.id ? '#' + node.id : '', typeof node.className === 'string' && node.className ? '.' + node.className.trim().replace(/\s+/g, '.') : ''].join('');
        };
        const snapshot = () => {
          const selection = getSelection(), range = selection.rangeCount ? selection.getRangeAt(0) : null, preview = block.querySelector('.vditor-ir__preview'), math = preview?.querySelector('.language-math'), rendered = preview?.querySelector('mjx-container');
          return { active: describe(document.activeElement), irScrollTop: ir.scrollTop, blockClass: block.className,
            sourcePoint: range ? { node: describe(range.startContainer), offset: range.startOffset, collapsed: range.collapsed } : null,
            preview: preview ? { rect: preview.getBoundingClientRect().toJSON(), tabindex: preview.getAttribute('tabindex'), overflowX: getComputedStyle(preview).overflowX } : null,
            math: math ? { rect: math.getBoundingClientRect().toJSON(), tabindex: math.getAttribute('tabindex'), overflowX: getComputedStyle(math).overflowX, clientWidth: math.clientWidth, scrollWidth: math.scrollWidth } : null,
            rendered: rendered ? { tabindex: rendered.getAttribute('tabindex'), overflowX: getComputedStyle(rendered).overflowX, clientWidth: rendered.clientWidth, scrollWidth: rendered.scrollWidth, role: rendered.getAttribute('role') } : null };
        };
        const record = (phase, event) => {
          if (events.length >= 80) return;
          events.push({ at: Math.round(performance.now() * 10) / 10, phase, type: event.type, target: describe(event.target), relatedTarget: describe(event.relatedTarget), ...snapshot() });
        };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'focusout', 'blur']) document.addEventListener(type, event => record('capture', event), true);
        ir.addEventListener('click', event => record('ir-bubble', event));
        const observer = new MutationObserver(records => { for (const change of records) record('class-mutation', { type: 'class', target: change.target }); });
        observer.observe(block, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
        window.moyeMathClickDiagnostics = { events, snapshot };
        record('before-click', { type: 'state', target: block });
      });
      await page.locator('.vditor-ir__node[data-type="math-block"] .vditor-ir__preview').click();
      await page.waitForFunction(() => document.querySelector('.vditor-ir__node--expand[data-type="math-block"]'));
      await page.waitForTimeout(220);
      const result = await page.evaluate(() => {
        const block = document.querySelector('.vditor-ir__node--expand[data-type="math-block"]');
        const source = block.querySelector('pre.vditor-ir__marker');
        const rect = source.getBoundingClientRect();
        const style = getComputedStyle(source);
        return { width: rect.width, height: rect.height, padding: style.padding, source: source.textContent, editable: source.isContentEditable, content: moye.getState().content,
          editorFocused: document.activeElement === moye.editor.vditor.ir.element, clickDiagnostics: window.moyeMathClickDiagnostics.events };
      });
      assert.ok(result.width > 44 && result.height > 36, JSON.stringify(result));
      assert.equal(result.padding, '18px 22px');
      assert.equal(result.source, '\\int_0^1 x^2 dx = \\frac{1}{3}');
      assert.equal(result.editable, true);
      assert.equal(result.content, before);
      assert.equal(result.editorFocused, true);
      return { width: result.width, height: result.height, padding: result.padding, editable: result.editable, editorFocused: result.editorFocused, clickDiagnostics: result.clickDiagnostics };
    });

    await probe('leaving formula source collapses it again and preserves the original Markdown', async () => {
      await page.locator('.vditor-ir p').last().click();
      await page.waitForFunction(() => !document.querySelector('.vditor-ir__node--expand[data-type="math-block"]'));
      await page.waitForTimeout(220);
      const result = await page.evaluate(() => {
        const source = document.querySelector('.vditor-ir__node[data-type="math-block"] pre.vditor-ir__marker');
        const rect = source.getBoundingClientRect();
        return { width: rect.width, height: rect.height, content: moye.getState().content, dirty: moye.getState().dirty };
      });
      assert.equal(result.width, 0); assert.equal(result.height, 0);
      assert.equal(result.content, fixture); assert.equal(result.dirty, false);
      return { width: result.width, height: result.height, dirty: result.dirty, originalBytesPreserved: true };
    });
  } finally {
    const proc = app.process(), exit = proc.exitCode === null ? new Promise(resolve => proc.once('exit', resolve)) : Promise.resolve();
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await exit;
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const report = { platform: process.platform, executable, results, pageErrors: errors };
    await fs.writeFile(process.env.MOYE_LAYOUT_OUTPUT || path.join(project, 'tests/math-layout-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (results.some(result => result.status === 'fail') || errors.length) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
