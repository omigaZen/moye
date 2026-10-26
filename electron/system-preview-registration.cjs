'use strict';
// Generate, install or remove only Moye's per-user thumbnailer registration.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const owner = '# Managed by Moye system-preview installer; format=1';
function quoteExec(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new TypeError('Moye executable must be an absolute filename.');
  // Thumbnailer Exec is parsed by GShell, not a shell. Escape its quoted word
  // characters and the thumbnailer field-code percent sign separately.
  return '"' + value.replace(/[%]/g, '%%').replace(/["\\`$]/g, '\\$&') + '"';
}
function thumbnailerContent(executable) {
  return `${owner}\n[Thumbnailer Entry]\nTryExec=${executable.replace(/\\/g, '\\\\')}\nExec=${quoteExec(executable)} --system-preview --input %u --output %o --size %s\nMimeType=text/markdown;text/x-markdown;text/plain;\n`;
}
function dataHome(options = {}) {
  const value = options.dataHome || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError('XDG data home must be absolute.');
  return path.resolve(value);
}
async function location(options = {}) {
  const directory = path.join(dataHome(options), 'thumbnailers');
  const info = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Thumbnailer directory must be a real directory.');
  return { directory, file: path.join(directory, 'moye.thumbnailer') };
}
async function install(options = {}) {
  const content = thumbnailerContent(options.executable), target = await location(options);
  const executableInfo = await fs.stat(options.executable);
  if (!executableInfo.isFile()) throw new Error('Moye executable does not exist.');
  const oldInfo = await fs.lstat(target.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (oldInfo && (!oldInfo.isFile() || oldInfo.isSymbolicLink())) throw new Error('Refusing an unexpected registration target.');
  if (oldInfo && !(await fs.readFile(target.file, 'utf8')).startsWith(owner + '\n')) throw new Error('An unrelated moye.thumbnailer already exists; it was not replaced.');
  await fs.mkdir(target.directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(target.directory, `.moye-${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, target.file); }
  finally { await fs.rm(temporary, { force: true }); }
  return { installed: true, path: target.file };
}
async function uninstall(options = {}) {
  const target = await location(options), info = await fs.lstat(target.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return { removed: false, path: target.file };
  if (!info.isFile() || info.isSymbolicLink() || !(await fs.readFile(target.file, 'utf8')).startsWith(owner + '\n')) throw new Error('The registration is not owned by Moye; it was not removed.');
  await fs.unlink(target.file); return { removed: true, path: target.file };
}
module.exports = { quoteExec, thumbnailerContent, install, uninstall, dataHome };
