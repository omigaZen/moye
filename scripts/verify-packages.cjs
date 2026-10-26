#!/usr/bin/env node
'use strict';

// Audit the actual portable distributions against one frozen application tree.
// Cross-building a package does not verify its native operating-system behavior.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const targets = [
  { platform: 'Windows', target: 'win32', arch: 'x64', extension: 'zip' },
  { platform: 'Linux', target: 'linux', arch: 'x64', extension: 'tar.gz' },
  { platform: 'macOS', target: 'darwin', arch: 'x64', extension: 'zip' },
  { platform: 'macOS', target: 'darwin', arch: 'arm64', extension: 'zip' },
];
// Versioned requirements keep a 0.3 audit independent of 0.4-only modules and
// evidence, while newer releases must ship and run every accumulated feature.
const featureGroups = [
  { name: 'core', since: '0.3.0', requiredFiles: ['src/index.html', 'src/renderer.js', 'src/styles.css', 'src/document-state.js', 'electron/main.cjs', 'electron/preload.cjs', 'electron/file-store.cjs', 'electron/recovery-store.cjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md'] },
  { name: 'viewport', since: '0.3.0', requiredFiles: [], evidence: 'packaged-viewport-report.json', report: 'packagedViewport', cases: 2, identity: 'binary' },
  { name: 'mathLayout', since: '0.3.0', requiredFiles: ['src/math-config.js'], evidence: 'packaged-math-layout-report.json', report: 'packagedMathLayout', cases: 3, identity: 'executable' },
  { name: 'mathSettings', since: '0.3.0', requiredFiles: ['src/math-config.js', 'src/markdown-config.js'], evidence: 'packaged-math-settings-report.json', report: 'packagedMathSettings', cases: 4 },
  { name: 'settings', since: '0.3.0', requiredFiles: ['src/settings-schema.js', 'src/settings-panel.js', 'src/settings-panel.css', 'src/preferences.css', 'electron/settings-store.cjs'], evidence: 'packaged-settings-report.json', report: 'packagedSettings', cases: 39 },
  { name: 'focus', since: '0.3.0', requiredFiles: ['src/editor-focus.js', 'src/editor-focus.css'], evidence: 'packaged-focus-report.json', report: 'packagedFocus', cases: 12 },
  { name: 'shortcuts', since: '0.3.0', requiredFiles: ['src/shortcut-config.js', 'src/editor-shortcuts.js'], evidence: 'packaged-shortcuts-report.json', report: 'packagedShortcuts', cases: 16 },
  { name: 'punctuation', since: '0.3.0', requiredFiles: ['src/editor-punctuation.js', 'src/editor-pairing.js'], evidence: 'packaged-punctuation-report.json', report: 'packagedPunctuation', cases: 21 },
  { name: 'markdownSettings', since: '0.3.0', requiredFiles: ['src/markdown-config.js'], evidence: 'packaged-markdown-settings-report.json', report: 'packagedMarkdownSettings', cases: 6 },
  { name: 'imageSettings', since: '0.3.0', requiredFiles: ['src/image-policy.js', 'electron/image-store.cjs', 'electron/relative-assets.cjs'], evidence: 'packaged-image-settings-report.json', report: 'packagedImageSettings', cases: 8 },
  { name: 'outlineCache', since: '0.3.0', requiredFiles: ['src/editor-outline-cache.js'], evidence: 'packaged-outline-cache-report.json', report: 'packagedOutlineCache', cases: 13 },
  { name: 'readingAnchor', since: '0.4.0', requiredFiles: ['src/reading-anchor.js'], evidence: 'packaged-reading-anchor-report.json', report: 'packagedReadingAnchor', cases: 11 },
  { name: 'typography', since: '0.4.0', requiredFiles: ['src/typography-config.js', 'src/typography-view.js', 'src/typography.css', 'src/paragraph-typesetter.js'], evidence: 'packaged-typography-report.json', report: 'packagedTypography', cases: 9 },
  { name: 'readingExperience', since: '0.4.0', requiredFiles: ['src/reading-experience.js', 'src/reading-experience.css'], evidence: 'packaged-reading-experience-report.json', report: 'packagedReadingExperience', cases: 24 },
  { name: 'settingsExperience', since: '0.4.0', requiredFiles: ['src/settings-panel.js', 'src/settings-panel.css', 'src/typography-config.js'], evidence: 'packaged-settings-experience-report.json', report: 'packagedSettingsExperience', cases: 10 },
  { name: 'settingsLive', since: '0.4.0', requiredFiles: ['electron/settings-store.cjs'], evidence: 'packaged-settings-live-report.json', report: 'packagedSettingsLive', cases: 5 },
  { name: 'tableExperience', since: '0.4.0', requiredFiles: ['src/table-presentation.js', 'src/table-presentation.css', 'src/table-tools.js', 'src/table-tools.css'], evidence: 'packaged-table-experience-report.json', report: 'packagedTableExperience', cases: 14 },
  { name: 'colorThemes', since: '0.4.0', requiredFiles: ['src/color-theme-config.js', 'src/color-theme-editor.js', 'src/color-themes.css', 'electron/theme-store.cjs'], evidence: 'packaged-color-themes-report.json', report: 'packagedColorThemes', cases: 10 },
  { name: 'contentExperience', since: '0.4.0', requiredFiles: ['src/content-experience.js', 'src/content-experience.css', 'src/highlight-worker.js', 'src/vendor/vditor/dist/js/highlight.js/highlight.min.js', 'src/vendor/vditor/dist/js/highlight.js/third-languages.js'], evidence: 'packaged-content-experience-report.json', report: 'packagedContentExperience', cases: 14 },
  { name: 'sourcePresentation', since: '0.4.0', requiredFiles: ['src/source-presentation.js', 'src/source-presentation.css'], evidence: 'packaged-source-presentation-report.json', report: 'packagedSourcePresentation', cases: 11 },
  { name: 'workspaceExperience', since: '0.4.0', requiredFiles: ['src/workspace-browser.js', 'src/workspace-browser.css', 'electron/workspace-store.cjs', 'electron/text-codec.cjs', 'electron/vendor/encoding-provenance.json', 'electron/vendor/iconv-lite/lib/index.js', 'electron/vendor/safer-buffer/safer.js'], evidence: 'packaged-workspace-experience-report.json', report: 'packagedWorkspaceExperience', cases: 11 },
  { name: 'exportExperience', since: '0.4.0', requiredFiles: ['src/export-snapshot.js', 'electron/export-service.cjs'], evidence: 'packaged-export-experience-report.json', report: 'packagedExportExperience', cases: 7 },
  { name: 'mathReading', since: '0.4.0', requiredFiles: ['src/math-reading-syntax.js'], evidence: 'packaged-math-reading-report.json', report: 'packagedMathReading', cases: 7 },
  { name: 'recentFiles', since: '0.5.0', requiredFiles: ['electron/recent-files.cjs', 'src/recent-files.js', 'src/recent-files.css'], evidence: 'packaged-recent-files-report.json', report: 'packagedRecentFiles', cases: 8 },
  { name: 'readingLongform', since: '0.5.0', requiredFiles: ['src/txt-chapters.js'], evidence: 'packaged-reading-longform-report.json', report: 'packagedReadingLongform', cases: 10 },
  { name: 'typographyRich', since: '0.5.0', requiredFiles: ['src/paragraph-typesetter.js'], evidence: 'packaged-typography-rich-report.json', report: 'packagedTypographyRich', cases: 8 },
  { name: 'exportPagination', since: '0.5.0', requiredFiles: ['src/export-snapshot.js'], evidence: 'packaged-export-pagination-report.json', report: 'packagedExportPagination', cases: 8 },
  { name: 'i18n', since: '0.5.0', requiredFiles: ['src/i18n.js', 'src/i18n.css', 'src/locales/en-US.js', 'electron/localization.cjs'], evidence: 'packaged-i18n-report.json', report: 'packagedI18n', cases: 7 },
  { name: 'systemPreview', since: '0.5.0', requiredFiles: ['electron/system-preview.cjs', 'electron/system-preview-registration.cjs', 'src/system-preview.html', 'src/system-preview.css'], evidence: 'packaged-system-preview-report.json', report: 'packagedSystemPreview', cases: 6 },
  { name: 'fileRefresh', since: '0.5.0', requiredFiles: ['electron/window-state.cjs'], evidence: 'packaged-file-refresh-report.json', report: 'packagedFileRefresh', cases: 10 },
  { name: 'tabClose', since: '0.5.0', requiredFiles: [], evidence: 'packaged-tab-close-report.json', report: 'packagedTabClose', cases: 4 },
];
function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Invalid application version: ${version}`);
  return match.slice(1).map(Number);
}
function atLeast(version, minimum) {
  const current = versionParts(version), required = versionParts(minimum);
  for (let index = 0; index < 3; index++) { if (current[index] !== required[index]) return current[index] > required[index]; }
  return true;
}
function applicableFeatureGroups(version) { return featureGroups.filter(group => atLeast(version, group.since)); }
function requiredFilesFor(version) { return [...new Set(applicableFeatureGroups(version).flatMap(group => group.requiredFiles))].sort(); }
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function fileSha(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic application resource: ${name}`);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

async function optionalJson(name) {
  try {
    const file = path.join(root, 'tests', name), data = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ...data, evidenceFile: name, evidenceFileModifiedAt: (await fs.stat(file)).mtime.toISOString() };
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function binaryArchitecture(directory, target) {
  const executable = path.join(directory, ...(target.target === 'darwin' ? ['Moye.app', 'Contents', 'MacOS', 'Moye'] : [target.target === 'win32' ? 'Moye.exe' : 'Moye']));
  const handle = await fs.open(executable, 'r'), bytes = Buffer.alloc(4096);
  try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
  if (target.target === 'win32') {
    const offset = bytes.readUInt32LE(0x3c);
    if (bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid Windows executable header.');
    return bytes.readUInt16LE(offset + 4) === 0x8664 ? 'x64' : 'unknown';
  }
  if (target.target === 'linux') {
    if (bytes.toString('ascii', 1, 4) !== 'ELF') throw new Error('Invalid Linux executable header.');
    return bytes[4] === 2 && bytes.readUInt16LE(18) === 62 ? 'x64' : 'unknown';
  }
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Invalid macOS executable header.');
  const cpu = bytes.readUInt32LE(4);
  return cpu === 0x01000007 ? 'x64' : cpu === 0x0100000c ? 'arm64' : 'unknown';
}

function inspectArchive(file, executableEntry) {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const script = String.raw`
import gzip, hashlib, json, pathlib, re, sys, tarfile, zipfile
p = pathlib.Path(sys.argv[1])
executable_entry = sys.argv[2]
temporary = re.compile(r'^(?:\.rsync-tmp|\.(?:app\.asar|Electron Framework|Moye(?:\.exe)?)(?:\.[A-Za-z0-9_-]+)+)$')
def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()
if p.name.endswith('.zip'):
    with zipfile.ZipFile(p) as archive:
        bad = archive.testzip()
        if bad is not None: raise ValueError('ZIP CRC failure: ' + bad)
        names = archive.namelist()
        targets = [name for name in names if name.lower().endswith('/resources/app.asar')]
        if len(targets) != 1: raise ValueError('Expected exactly one archived app.asar')
        with archive.open(targets[0]) as stream: archived_hash = digest(stream)
        if names.count(executable_entry) != 1: raise ValueError('Expected exactly one archived executable: ' + executable_entry)
        with archive.open(executable_entry) as stream: executable_hash = digest(stream)
else:
    # Read through the trailer to verify the complete gzip CRC, including bytes
    # after tar end markers, then read the actual ASAR member independently.
    with gzip.open(p, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): pass
    with tarfile.open(p, 'r:gz') as archive:
        names = archive.getnames()
        targets = [item for item in archive.getmembers() if item.isfile() and item.name.lower().endswith('/resources/app.asar')]
        if len(targets) != 1: raise ValueError('Expected exactly one archived app.asar')
        with archive.extractfile(targets[0]) as stream: archived_hash = digest(stream)
        executables = [item for item in archive.getmembers() if item.isfile() and item.name == executable_entry]
        if len(executables) != 1: raise ValueError('Expected exactly one archived executable: ' + executable_entry)
        with archive.extractfile(executables[0]) as stream: executable_hash = digest(stream)
        targets = [targets[0].name]
unexpected = [name for name in names if temporary.match(pathlib.PurePosixPath(name).name)]
print(json.dumps({'archiveIntegrityPassed': True, 'archivedAsarSha256': archived_hash, 'asarEntry': targets[0], 'archivedExecutableSha256': executable_hash, 'executableEntry': executable_entry, 'unexpectedAtomicEntries': unexpected}))
`;
  const result = spawnSync(python, ['-c', script, file, executableEntry], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Archive verification failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const names = [];
  for (const directory of ['src', 'electron', 'assets']) {
    names.push(...(await walk(path.join(root, directory))).map(name => `${directory}/${name}`));
  }
  names.push('LICENSE', 'THIRD-PARTY-NOTICES.md'); names.sort();
  const sourceHashes = new Map();
  for (const name of names) sourceHashes.set(name, sha(await fs.readFile(path.join(root, name))));
  const frozenTreeSha256 = sha(names.map(name => `${sourceHashes.get(name)}  ${name}\n`).join(''));
  const activeGroups = applicableFeatureGroups(manifest.version), requiredFiles = requiredFilesFor(manifest.version);
  const missingRequiredSourceFiles = requiredFiles.filter(name => !sourceHashes.has(name));
  const report = {
    generatedAt: new Date().toISOString(), buildHost: `${process.platform}-${process.arch}`,
    version: manifest.version, frozenTreeSha256,
    sourceComparison: 'Every packaged src/, electron/, assets/, LICENSE and THIRD-PARTY-NOTICES file byte-matches frozen source; no unexpected application files.',
    sameAsarAcrossPlatforms: false,
    requiredFiles, missingRequiredSourceFiles,
    featureGroups: activeGroups.map(group => ({ name: group.name, since: group.since, requiredFiles: group.requiredFiles, evidenceFile: group.evidence || null, minimumCases: group.cases || 0 })),
    limitations: [
      'Windows and macOS archives were cross-constructed on Linux; native execution has not been tested.',
      'Portable distributions are not signed/notarized.',
      'Real operating-system IME testing remains separate from headless automation.',
      'This verifies packaged resources and Moye feature tests, not complete Typora settings or behavior parity.',
    ],
    packages: [],
  };
  for (const target of targets) {
    const directory = path.join(root, 'release', `Moye-${target.target}-${target.arch}`);
    const archivePath = path.join(root, 'release', `Moye-${manifest.version}-${target.platform}-${target.arch}.${target.extension}`);
    const applicationPath = path.join(directory, ...(target.target === 'darwin' ? ['Moye.app', 'Contents'] : []), 'Resources');
    const asarPath = target.target === 'darwin' ? path.join(applicationPath, 'app.asar') : path.join(directory, 'resources', 'app.asar');
    const archiveHash = await fileSha(archivePath), asarHash = await fileSha(asarPath);
    const executableEntry = `Moye-${target.target}-${target.arch}/${target.target === 'darwin' ? 'Moye.app/Contents/MacOS/Moye' : target.target === 'win32' ? 'Moye.exe' : 'Moye'}`;
    const executableHash = await fileSha(path.join(root, 'release', executableEntry));
    const mismatches = [];
    const archived = inspectArchive(archivePath, executableEntry);
    if (archived.archivedAsarSha256 !== asarHash) mismatches.push('Archived app.asar differs from audited application');
    if (archived.unexpectedAtomicEntries.length) mismatches.push('Archive contains packager atomic temporary artifacts');
    if (archived.archivedExecutableSha256 !== executableHash) mismatches.push('Archived executable differs from audited executable');
    const executableArchitecture = await binaryArchitecture(directory, target);
    if (executableArchitecture !== target.arch) mismatches.push('Executable architecture');
    const packagedManifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    const packagedEntries = asar.listPackage(asarPath).map(entry => entry.replace(/^\//, ''));
    const packagedNames = new Set(packagedEntries);
    for (const name of requiredFiles) if (!packagedNames.has(name)) mismatches.push(`Required application file missing: ${name}`);
    const expectedManifest = Object.fromEntries(['name', 'productName', 'version', 'description', 'main', 'license'].map(key => [key, manifest[key]]));
    if (JSON.stringify(packagedManifest) !== JSON.stringify(expectedManifest)) mismatches.push('package.json metadata');
    for (const name of names) {
      try { if (sha(asar.extractFile(asarPath, name)) !== sourceHashes.get(name)) mismatches.push(name); }
      catch (error) { mismatches.push(`${name}: ${error.message}`); }
    }
    const allowed = new Set([...names, 'package.json']);
    for (const name of packagedEntries) {
      const info = asar.statFile(asarPath, name);
      if (!info.files && !allowed.has(name)) mismatches.push(`Unexpected packaged entry: ${name}`);
    }
    const sidecar = await fs.readFile(`${archivePath}.sha256`, 'utf8');
    if (sidecar.trim() !== `${archiveHash}  ${path.basename(archivePath)}`) mismatches.push('Archive SHA256 sidecar');
    report.packages.push({ platform: target.platform, arch: target.arch, file: archivePath,
      sizeBytes: (await fs.stat(archivePath)).size, sha256: archiveHash, appAsarSha256: asarHash,
      version: packagedManifest.version, sourceFilesChecked: names.length, sourceMismatches: mismatches,
      executableArchitecture, ...archived, codeSigned: false, nativeRuntimeTested: false });
  }
  report.sameAsarAcrossPlatforms = new Set(report.packages.map(item => item.appAsarSha256)).size === 1;
  report.packagedLinuxSmoke = await optionalJson('packaged-linux-report.json');
  for (const group of activeGroups) if (group.evidence) report[group.report] = await optionalJson(group.evidence);
  report.packagingBuild = await optionalJson('package-build-report.json');
  const build = report.packagingBuild;
  report.frozenBuildMatches = !!(build?.version === manifest.version && build.frozenTreeSha256 === frozenTreeSha256
    && build.sourceManifestSha256 === await fileSha(path.join(root, 'package.json'))
    && build.packages?.length === targets.length
    && report.packages.every(item => build.packages.some(built => built.archive === path.basename(item.file)
      && built.archiveSha256 === item.sha256 && built.appAsarSha256 === item.appAsarSha256)));
  const linux = report.packages.find(item => item.platform === 'Linux');
  const linuxExecutable = path.join(root, 'release', 'Moye-linux-x64', 'Moye');
  const linuxAsar = path.join(root, 'release', 'Moye-linux-x64', 'resources', 'app.asar');
  const samePath = (value, expected) => typeof value === 'string' && path.resolve(value) === expected;
  const fresh = data => data?.evidenceFileModifiedAt && build?.completedAt && Date.parse(data.evidenceFileModifiedAt) >= Date.parse(build.completedAt);
  const packagedApplication = data => fresh(data) && data?.application?.isPackaged && data.application.version === manifest.version
    && samePath(data.application.path || data.application.appPath, linuxAsar)
    && (!data.application.executable || samePath(data.application.executable, linuxExecutable));
  const smoke = report.packagedLinuxSmoke;
  if (fresh(smoke) && smoke?.binary?.version === manifest.version && smoke.binary.packaged && samePath(smoke.binary.path, linuxAsar) && !smoke.errors?.length && !smoke.remote?.length && !smoke.render?.errors?.length) {
    linux.nativeRuntimeTested = true;
  }
  report.resourceAuditPass = missingRequiredSourceFiles.length === 0 && report.frozenBuildMatches && report.sameAsarAcrossPlatforms && report.packages.every(item => item.sourceMismatches.length === 0);
  const casesPass = (data, minimumCases) => data?.results?.length >= minimumCases && data.results.every(item => item.status === 'pass') && !data.pageErrors?.length && !data.remoteRequests?.length && !data.fatalError;
  const suites = activeGroups.filter(group => group.evidence).map(group => {
    const data = report[group.report];
    const identity = group.identity ? fresh(data) && samePath(data?.[group.identity], linuxExecutable) : packagedApplication(data);
    return [group.name, data, group.cases, identity];
  });
  report.packagedFeatureSuites = suites.map(([name, data, expectedCases, actualPackagedApplication]) => ({ name, expectedCases, actualCases: data?.results?.length || 0, actualPackagedApplication: !!actualPackagedApplication, pass: !!(actualPackagedApplication && casesPass(data, expectedCases)) }));
  report.packagedFeatureTestsPass = !!(linux.nativeRuntimeTested && smoke?.binary?.version === manifest.version && smoke.binary.packaged
    && smoke.render?.diagrams === 8 && smoke.render?.formulas === 5 && smoke.render?.font
    && !smoke.errors?.length && !smoke.remote?.length && !smoke.render?.errors?.length
    && report.packagedFeatureSuites.every(item => item.pass));
  report.pass = report.resourceAuditPass && report.packagedFeatureTestsPass;
  await fs.writeFile(path.join(root, 'tests', 'package-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ version: report.version, pass: report.pass, resourceAuditPass: report.resourceAuditPass, packagedFeatureTestsPass: report.packagedFeatureTestsPass, filesCheckedPerPackage: names.length,
    frozenBuildMatches: report.frozenBuildMatches, sameAsarAcrossPlatforms: report.sameAsarAcrossPlatforms, packagedFeatureSuites: report.packagedFeatureSuites, packages: report.packages }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { featureGroups, applicableFeatureGroups, requiredFilesFor };
