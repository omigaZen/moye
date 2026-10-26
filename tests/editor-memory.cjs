'use strict';
// Separate Linux memory diagnostic. It never repeats or replaces latency gates.
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

async function main() {
  if (process.platform !== 'linux') throw new Error('This diagnostic reads Linux /proc.');
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-memory-'));
  const executable = path.resolve(process.env.MOYE_MEMORY_EXECUTABLE || path.join(root, 'release/Moye-linux-x64/Moye'));
  const report = { generatedAt: new Date().toISOString(), unit: 'KiB', method: 'Separate settled long-document snapshot from /proc status and smaps_rollup, resolving PID namespace IDs; not a peak or input-latency measurement.', processes: [], pass: false };
  let app;
  try {
    app = await electron.launch({ executablePath: executable, args: ['--no-sandbox', '--ozone-platform=headless'], env: { ...process.env, MOYE_TEST: '1', MOYE_TEST_USER_DATA: path.join(work, 'profile') } });
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });
    await page.waitForFunction(() => window.moye?.ready);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(root, 'samples/长文性能验收.md'));
    await page.evaluate(() => moye.performAction('open'));
    await page.waitForFunction(() => { const r = moye.editor.vditor.ir.element, images = [...r.querySelectorAll('img')]; return images.length === 20 && images.every(i => i.complete && i.naturalWidth > 0) && r.querySelectorAll('.hljs').length >= 100; }, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    report.document = await page.evaluate(() => ({ mode: moye.editor.getCurrentMode(), sourceLength: moye.getState().content.length, dirty: moye.getState().dirty }));
    const identity = await app.evaluate(({ app }) => { const f = process.getBuiltinModule('fs'); return { version: app.getVersion(), isPackaged: app.isPackaged, appPath: app.getAppPath(), mainNamespace: f.readlinkSync('/proc/self/ns/pid'), mainProc: f.readlinkSync('/proc/self'), metrics: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory })) }; });
    assert.equal(identity.isPackaged, true); assert.equal(identity.version, require('../package.json').version);
    report.application = { version: identity.version, isPackaged: identity.isPackaged, appPath: identity.appPath, executable, asarSha256: crypto.createHash('sha256').update(await fs.readFile(identity.appPath)).digest('hex') };
    const matches = new Map();
    for (const id of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        if (await fs.readlink(`/proc/${id}/ns/pid`) !== identity.mainNamespace) continue;
        const status = await fs.readFile(`/proc/${id}/status`, 'utf8');
        const namespacePid = Number(/^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).at(-1));
        if (identity.metrics.some(m => m.pid === namespacePid)) matches.set(namespacePid, { id, status });
      } catch { /* Processes outside this application can disappear while enumerating. */ }
    }
    for (const metric of identity.metrics) {
      const found = matches.get(metric.pid); assert.ok(found, `Resolve ${metric.type} PID`);
      const value = (text, field) => Number(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)?.[1] ?? NaN);
      const smaps = await fs.readFile(`/proc/${found.id}/smaps_rollup`, 'utf8');
      const rssKiB = value(found.status, 'VmRSS'), peakRssKiB = value(found.status, 'VmHWM'), pssKiB = value(smaps, 'Pss');
      assert.ok(rssKiB > 0 && pssKiB > 0 && peakRssKiB >= rssKiB);
      report.processes.push({ type: metric.type, rssKiB, peakRssKiB, pssKiB });
    }
    report.totalRssKiB = report.processes.reduce((s, p) => s + p.rssKiB, 0);
    report.totalPssKiB = report.processes.reduce((s, p) => s + p.pssKiB, 0);
    report.note = 'RSS can double-count shared pages; PSS apportions them. This is one settled Linux snapshot, not a cross-platform bound or a peak-total measurement. Electron getAppMetrics returned zero working-set values on this host.';
    report.pass = !report.document.dirty && report.document.sourceLength > 100000;
  } catch (error) { report.fatalError = error.stack || error.message; }
  finally {
    if (app) { const p = app.process(), exited = p.exitCode === null ? new Promise(resolve => p.once('exit', resolve)) : Promise.resolve(); await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await exited; }
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5 });
    await fs.writeFile(path.join(root, 'artifacts/memory-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
