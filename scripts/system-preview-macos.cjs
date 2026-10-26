#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function build({ arch, outputDirectory, embedApp, team } = {}) {
  if (process.platform !== 'darwin') throw new Error('Quick Look compilation requires macOS and the Xcode macOS SDK. No extension binary was produced.');
  if (!['arm64', 'x86_64'].includes(arch) || typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) throw new TypeError('Specify arch arm64|x86_64 and an absolute output directory.');
  if (team !== undefined && !/^[A-Z0-9]{10}$/.test(team)) throw new TypeError('Invalid Apple development team identifier.');
  const project = path.join(root, 'native/system-preview/macos/MoyeQuickLook.xcodeproj');
  await fs.mkdir(outputDirectory, { recursive: true });
  const args = ['-project', project, '-scheme', 'MoyeQuickLook', '-configuration', 'Release', '-sdk', 'macosx', '-arch', arch, '-derivedDataPath', path.join(outputDirectory, 'derived-data'), 'build', ...(team ? ['CODE_SIGNING_ALLOWED=YES', `DEVELOPMENT_TEAM=${team}`] : ['CODE_SIGNING_ALLOWED=NO'])];
  await new Promise((resolve, reject) => { const child = spawn('/usr/bin/xcodebuild', args, { stdio: 'inherit', shell: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Quick Look xcodebuild failed (${code}).`))); });
  const product = path.join(outputDirectory, 'derived-data/Build/Products/Release/MoyeQuickLook.appex');
  if (!(await fs.stat(path.join(product, 'Contents/MacOS/MoyeQuickLook'))).isFile()) throw new Error('Xcode did not produce the expected extension executable.');
  let embedded = null;
  if (embedApp) {
    const app = await fs.realpath(embedApp);
    if (!app.endsWith('.app') || !(await fs.stat(path.join(app, 'Contents/Info.plist'))).isFile()) throw new Error('Embedding requires an existing macOS application bundle.');
    const plugins = path.join(app, 'Contents/PlugIns'); await fs.mkdir(plugins, { recursive: true });
    embedded = path.join(plugins, 'MoyeQuickLook.appex');
    if (await fs.lstat(embedded).catch(() => null)) throw new Error('The target extension already exists; remove the old generated extension explicitly before replacing it.');
    await fs.cp(product, embedded, { recursive: true, dereference: false });
  }
  return { product, arch, embedded, signingRequested: !!team, nativeRuntimeTested: false, note: 'Compilation does not certify Finder activation, entitlements, shared settings, signing or notarization.' };
}
async function main(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--arch': 'arch', '--output': 'outputDirectory', '--embed-app': 'embedApp', '--team': 'team' }[args[i]];
    if (!key || !args[i + 1] || values[key]) throw new Error('Usage: system-preview-macos.cjs --arch arm64|x86_64 --output /absolute/build-dir [--embed-app /path/Moye.app] [--team APPLETEAM1]');
    values[key] = args[i + 1];
  }
  console.log(JSON.stringify(await build(values)));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { build };
