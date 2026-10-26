#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareAssets } = require('./prepare-assets.cjs');
const root = path.resolve(__dirname, '..');
const manifest = require(path.join(root, 'package.json'));
const officialTargets = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];

function applicationSnapshot(directory) {
  const hashes = {};
  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic application resource: ${name}`);
      if (entry.isDirectory()) walk(path.join(current, entry.name), name);
      else if (entry.isFile()) hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(current, entry.name))).digest('hex');
    }
  }
  for (const name of ['src', 'electron', 'assets']) walk(path.join(directory, name), name);
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
  const names = Object.keys(hashes).sort();
  return { sha256: crypto.createHash('sha256').update(names.map(name => `${hashes[name]}  ${name}\n`).join('')).digest('hex'), files: hashes };
}

function cleanPackagerArtifacts(directory) {
  const release = path.join(root, 'release');
  if (path.dirname(directory) !== release || !/^Moye-(?:win32|linux|darwin)-(?:x64|arm64)$/.test(path.basename(directory))) throw new Error('Refusing to clean artifacts outside a generated distribution.');
  const temporaryName = /^\.(?:app\.asar|Electron Framework|Moye(?:\.exe)?)(?:\.[A-Za-z0-9_-]+)+$/;
  const removed = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && temporaryName.test(entry.name)) { fs.unlinkSync(file); removed.push(path.relative(directory, file)); }
    }
  }
  walk(directory);
  if (removed.length) console.log(`Removed ${removed.length} packager atomic temporary artifact(s)`);
  return removed;
}

function recoverCompletedBundle(temporaryPath, destination, python, platform = 'darwin') {
  const release = path.join(root, 'release');
  if (path.dirname(destination) !== release || !/^Moye-(?:win32|linux|darwin)-(?:x64|arm64)$/.test(path.basename(destination)) || !path.basename(destination).startsWith(`Moye-${platform}-`)) throw new Error('Refusing to recover a non-generated output.');
  const temporaryRoot = path.join(os.tmpdir(), 'electron-packager');
  if (path.dirname(temporaryPath) !== temporaryRoot || !/^tmp-[A-Za-z0-9]+$/.test(path.basename(temporaryPath))) throw new Error('Refusing an unexpected packager staging directory.');
  const bundle = platform === 'darwin' ? path.join(temporaryPath, 'Moye.app', 'Contents') : temporaryPath;
  const asar = require('@electron/asar');
  const resources = platform === 'darwin' ? 'Resources' : 'resources';
  const executable = platform === 'darwin' ? path.join('MacOS', 'Moye') : platform === 'win32' ? 'Moye.exe' : 'Moye';
  const staged = JSON.parse(asar.extractFile(path.join(bundle, resources, 'app.asar'), 'package.json').toString('utf8'));
  if (staged.version !== manifest.version || staged.main !== manifest.main || !fs.statSync(path.join(bundle, executable)).isFile()) throw new Error('Completed staging bundle failed metadata validation.');
  // A final-path collision can occur even after the initial cleanup on a
  // managed filesystem. Recover only the completed, validated generated bundle,
  // once, after packager has finished all application processing.
  const result = spawnSync(python, ['-c', 'import os, pathlib, shutil, sys; source, dest = map(pathlib.Path, sys.argv[1:]); shutil.rmtree(dest) if dest.exists() else None; os.rename(source, dest)', temporaryPath, destination], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(path.join(destination, ...(platform === 'darwin' ? ['Moye.app', 'Contents'] : []), resources, 'app.asar'))) throw new Error('Completed output recovery failed.');
  console.log(`Recovered completed bundle: ${path.basename(destination)}`);
  return destination;
}

async function createArchive(directory, archivePath, python) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'moye-archive-'));
  const stagedArchive = path.join(temporary, path.basename(archivePath));
  try {
    const archive = spawnSync(python, [path.join(root, 'scripts', 'archive.py'), directory, stagedArchive], { stdio: 'inherit' });
    if (archive.error) throw archive.error;
    if (archive.status !== 0) throw new Error(`Archive process failed: ${archive.status}`);
    const stagedHash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(stagedArchive)) stagedHash.update(chunk);
    const stagedDigest = stagedHash.digest('hex');
    // Never overwrite a compressed release in place: managed filesystems can
    // retain older partially written extents. Verify the complete temporary
    // stream first, then publish it with one atomic replacement.
    const publish = spawnSync(python, ['-c', 'import gzip, os, pathlib, sys, zipfile\np, dest = map(pathlib.Path, sys.argv[1:])\nif p.name.endswith(".zip"):\n with zipfile.ZipFile(p) as archive:\n  bad = archive.testzip()\n  if bad is not None: raise ValueError("ZIP CRC failure: " + bad)\nelse:\n with gzip.open(p, "rb") as stream:\n  for chunk in iter(lambda: stream.read(1024 * 1024), b""): pass\nos.replace(p, dest)', stagedArchive, archivePath], { stdio: 'inherit' });
    if (publish.error) throw publish.error;
    if (publish.status !== 0) throw new Error(`Archive validation/publication failed: ${publish.status}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk);
    const digest = hash.digest('hex');
    if (digest !== stagedDigest) throw new Error('Published archive differs from the validated temporary archive.');
    fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`);
    console.log(`Created ${path.basename(archivePath)}`);
    return digest;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const targets = requested.includes('all') ? officialTargets : requested.length ? requested : [`${process.platform}-${process.arch}`];
  for (const target of targets) {
    if (!officialTargets.includes(target)) throw new Error(`Unsupported target ${target}. Choose: ${officialTargets.join(', ')}`);
  }
  prepareAssets();
  const frozen = applicationSnapshot(root);
  const sourceManifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex');
  const startedAt = new Date().toISOString();
  const packages = [];
  for (const entry of ['electron/main.cjs', 'electron/preload.cjs', 'src/index.html', 'src/renderer.js', 'src/samples/欢迎.md']) {
    if (!fs.existsSync(path.join(root, entry))) throw new Error(`Application entry is missing: ${entry}`);
  }
  const { packager } = await import('@electron/packager');
  const release = path.join(root, 'release');
  fs.mkdirSync(release, { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'moye-package-'));
  try {
    for (const entry of ['src', 'electron', 'assets', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
      const src = path.join(root, entry);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(staging, entry), { recursive: true });
    }
    // All runtime JavaScript/resources are vendored; developer dependencies stay out.
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({
      name: manifest.name, productName: manifest.productName,
      version: manifest.version, description: manifest.description,
      main: manifest.main, license: manifest.license,
    }, null, 2));
    for (const target of targets) {
      const [platform, arch] = target.split('-');
      console.log(`Packaging Moye ${manifest.version}: ${platform}/${arch}`);
      const packageOptions = {
        dir: staging, out: release, name: 'Moye',
        platform, arch, appVersion: manifest.version,
        electronVersion: manifest.devDependencies.electron,
        appBundleId: 'com.moye.editor', appCategoryType: 'public.app-category.productivity',
        executableName: 'Moye', asar: true, prune: false, overwrite: true,
        appCopyright: 'Copyright © 2026 Moye contributors',
        extendInfo: {
          CFBundleDisplayName: '墨页 Moye',
          CFBundleDocumentTypes: [{
            CFBundleTypeName: 'Markdown document', CFBundleTypeRole: 'Editor',
            CFBundleTypeExtensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'],
          }],
          NSHighResolutionCapable: true,
        },
        win32metadata: { CompanyName: 'Moye', FileDescription: manifest.description, ProductName: '墨页 Moye', OriginalFilename: 'Moye.exe' },
      };
      const icon = path.join(root, 'assets', platform === 'win32' ? 'icon.ico' : platform === 'darwin' ? 'icon.icns' : 'icon.png');
      if (fs.existsSync(icon)) packageOptions.icon = icon;
      if (process.env.MOYE_ELECTRON_ZIP_DIR) packageOptions.electronZipDir = path.resolve(process.env.MOYE_ELECTRON_ZIP_DIR);
      // A repeated build in managed filesystems can retain an incomplete
      // legacy tree and make packager's final rename fail ENOTEMPTY.
      // Use the same Python runtime as archiving for a complete generated-tree
      // removal, and verify the required nonexistent-destination postcondition.
      // Existing compressed releases remain available until archive replacement.
      const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
      const generatedOutput = path.join(release, `Moye-${platform}-${arch}`);
      if (path.dirname(generatedOutput) !== release || !/^Moye-(?:win32|linux|darwin)-(?:x64|arm64)$/.test(path.basename(generatedOutput))) throw new Error('Refusing to clean a non-generated output path.');
      const cleanup = spawnSync(python, ['-c', 'import pathlib, shutil, sys; p = pathlib.Path(sys.argv[1]); shutil.rmtree(p) if p.exists() else None', generatedOutput], { stdio: 'inherit' });
      if (cleanup.error) throw cleanup.error;
      if (cleanup.status !== 0 || fs.existsSync(generatedOutput)) throw new Error(`Generated output cleanup failed: ${generatedOutput}`);
      let directories;
      try { directories = await packager(packageOptions); }
      catch (error) {
        if (error.code !== 'ENOTEMPTY' || error.dest !== generatedOutput || typeof error.path !== 'string') throw error;
        directories = [recoverCompletedBundle(error.path, generatedOutput, python, platform)];
      }
      for (const directory of directories) {
        cleanPackagerArtifacts(directory);
        if (platform === 'linux') {
          fs.writeFileSync(path.join(directory, 'start-moye.sh'), '#!/bin/sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec ./Moye "$@"\n', { mode: 0o755 });
        }
        const label = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';
        const archivePath = path.join(release, `Moye-${manifest.version}-${label}-${arch}.${platform === 'linux' ? 'tar.gz' : 'zip'}`);
        const digest = await createArchive(directory, archivePath, python);
        const asarPath = path.join(directory, ...(platform === 'darwin' ? ['Moye.app', 'Contents', 'Resources'] : ['resources']), 'app.asar');
        const asarHash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(asarPath)) asarHash.update(chunk);
        packages.push({ target, archive: path.basename(archivePath), archiveSha256: digest, appAsarSha256: asarHash.digest('hex') });
      }
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (applicationSnapshot(root).sha256 !== frozen.sha256 || crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex') !== sourceManifestSha256) throw new Error('Application source changed during packaging. Freeze the application tree and rebuild all targets.');
  fs.writeFileSync(path.join(root, 'tests', 'package-build-report.json'), JSON.stringify({ startedAt, completedAt: new Date().toISOString(), version: manifest.version, buildHost: `${process.platform}-${process.arch}`, frozenTreeSha256: frozen.sha256, sourceManifestSha256, sourceFiles: frozen.files, packages }, null, 2) + '\n');
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { recoverCompletedMacBundle: recoverCompletedBundle, recoverCompletedBundle, cleanPackagerArtifacts, applicationSnapshot, createArchive };
