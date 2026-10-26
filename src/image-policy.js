(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeImagePolicy = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // This deliberately accepts only document-relative copy folders. A document
  // cannot turn an insertion preference into arbitrary filesystem writes.
  function validateFolder(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\x00-\x1f<>:"|?*]/.test(value)) return false;
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false;
    if (normalized.replace(/\$\{filename\}/g, '').includes('${')) return false;
    return normalized.split('/').every(part => {
      if (!part || part === '..') return false;
      if (part === '.') return true;
      if (/[. ]$/.test(part)) return false;
      const fixed = part.replace(/\$\{filename\}/g, 'document');
      return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fixed);
    });
  }

  function normalizePolicy(values = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('图片设置无效。');
    const read = (name, fallback) => Object.hasOwn(values, `images.${name}`) ? values[`images.${name}`] : Object.hasOwn(values, name) ? values[name] : fallback;
    const policy = {
      insertAction: read('insertAction', 'copy'), assetFolder: read('assetFolder', '${filename}.assets'),
      pathStyle: read('pathStyle', 'auto'), relativePrefix: read('relativePrefix', true),
      escapePath: read('escapePath', true), applyToLocal: read('applyToLocal', true),
    };
    if (!['copy', 'reference'].includes(policy.insertAction) || !validateFolder(policy.assetFolder)
      || !['auto', 'relative', 'absolute'].includes(policy.pathStyle)
      || ['relativePrefix', 'escapePath', 'applyToLocal'].some(key => typeof policy[key] !== 'boolean')) throw new TypeError('图片设置无效。');
    return policy;
  }

  function shouldCopyImage(source, values = {}) {
    const policy = normalizePolicy(values);
    // Clipboard/drop byte streams have no stable original path. They must be
    // materialized even when local-file rules are disabled or reference is set.
    if (['bitmap', 'clipboard', 'drop', 'bytes'].includes(source)) return true;
    return source === 'local' && policy.applyToLocal && policy.insertAction === 'copy';
  }

  function applyParser(lute) {
    if (!lute || typeof lute.SetImgPathAllowSpace !== 'function') throw new TypeError('Markdown parser does not support readable image paths.');
    // This controls reading existing Markdown, independently of the preferred
    // syntax for newly inserted images. IR serialization removes angle brackets.
    lute.SetImgPathAllowSpace(true);
  }

  return Object.freeze({ validateFolder, normalizePolicy, shouldCopyImage, applyParser });
});
