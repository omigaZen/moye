#!/usr/bin/env node
'use strict';
const api = require('../electron/system-preview-registration.cjs');
const { thumbnailerContent, install, uninstall } = api;
async function main(argv) {
  const [action, ...rest] = argv, options = {};
  if (!['print', 'install', 'uninstall'].includes(action)) throw new Error('Usage: system-preview-linux.cjs print|install|uninstall [--executable /path/Moye] [--data-home /path]');
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--executable', '--data-home'].includes(rest[i]) || !rest[i + 1]) throw new Error('Invalid installation option.');
    const key = rest[i] === '--executable' ? 'executable' : 'dataHome'; if (options[key]) throw new Error('Repeated installation option.'); options[key] = rest[i + 1];
  }
  if (action === 'print') process.stdout.write(thumbnailerContent(options.executable));
  else console.log(JSON.stringify(await (action === 'install' ? install(options) : uninstall(options))));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = api;
