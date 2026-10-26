'use strict';
// Run every packaged feature suite serially against one actual executable.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'release', `Moye-${process.platform}-${process.arch}`, process.platform === 'darwin' ? 'Moye.app/Contents/MacOS/Moye' : process.platform === 'win32' ? 'Moye.exe' : 'Moye'));
if (!fs.statSync(executable).isFile()) throw new Error('Packaged executable is missing.');
const suites = [
  ['packaged-smoke.cjs', null, 'linux'], ['packaged-viewport.cjs', null, 'viewport'],
  ['editor-settings.cjs', 'SETTINGS', 'settings'], ['editor-math-settings.cjs', 'MATH_SETTINGS', 'math-settings'],
  ['editor-math-layout.cjs', 'LAYOUT', 'math-layout'], ['editor-focus.cjs', 'FOCUS', 'focus'],
  ['editor-shortcuts.cjs', 'SHORTCUT', 'shortcuts'], ['editor-punctuation.cjs', 'PUNCTUATION', 'punctuation'],
  ['editor-markdown-settings.cjs', 'MARKDOWN_SETTINGS', 'markdown-settings'], ['editor-image-settings.cjs', 'IMAGE_SETTINGS', 'image-settings'],
  ['editor-outline-cache.cjs', 'OUTLINE_CACHE', 'outline-cache'],
  ['editor-reading-anchor.cjs', 'READING_ANCHOR', 'reading-anchor'],
  ['editor-settings-experience.cjs', 'SETTINGS_EXPERIENCE', 'settings-experience'],
  ['editor-table-experience.cjs', 'TABLE_EXPERIENCE', 'table-experience'],
  ['editor-typography.cjs', 'TYPOGRAPHY', 'typography'],
  ['editor-reading-experience.cjs', 'READING', 'reading-experience'],
  ['editor-content-experience.cjs', 'CONTENT', 'content-experience'],
  ['editor-source-presentation.cjs', 'SOURCE_PRESENTATION', 'source-presentation'],
  ['editor-workspace-experience.cjs', 'WORKSPACE', 'workspace-experience'],
  ['editor-export-experience.cjs', 'EXPORT', 'export-experience'],
  ['editor-color-themes.cjs', 'COLOR_THEMES', 'color-themes'],
  ['editor-settings-live.cjs', 'SETTINGS_LIVE', 'settings-live'],
  ['editor-math-reading.cjs', 'MATH_READING', 'math-reading'],
  ['editor-recent-files.cjs', 'RECENT', 'recent-files'],
  ['editor-reading-longform.cjs', 'LONGFORM', 'reading-longform'],
  ['editor-typography-rich.cjs', 'RICH_TYPOGRAPHY', 'typography-rich'],
  ['editor-export-pagination.cjs', 'PAGINATION', 'export-pagination'],
  ['editor-i18n.cjs', 'I18N', 'i18n'],
  ['editor-system-preview.cjs', 'SYSTEM_PREVIEW', 'system-preview'],
  ['editor-file-refresh.cjs', 'REFRESH', 'file-refresh'],
  ['editor-tab-close.cjs', 'TAB_CLOSE', 'tab-close'],
];
const failures = [];
for (const [file, prefix, name] of suites) {
  console.log(`Running packaged ${name}`);
  const env = { ...process.env };
  if (prefix) { env[`MOYE_${prefix}_EXECUTABLE`] = executable; env[`MOYE_${prefix}_OUTPUT`] = path.join(root, 'tests', `packaged-${name}-report.json`); }
  const result = spawnSync(process.execPath, [path.join(root, 'tests', file), ...(prefix ? [] : [executable])], { env, stdio: 'inherit', timeout: 240000 });
  if (result.error || result.status !== 0) failures.push({ name, status: result.status, error: result.error?.message });
}
console.log(JSON.stringify({ executable, suites: suites.length, failures }));
if (failures.length) process.exitCode = 1;
