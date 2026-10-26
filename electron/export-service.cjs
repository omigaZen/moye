'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_PIXELS = 80 * 1024 * 1024;
const MAX_EXPORT_EDGE = 32767;
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function validateExportOptions(raw = {}) {
  if (!plainObject(raw)) throw new TypeError('导出设置无效。');
  const known = new Set(['format','width','scale','paperSize','landscape','theme','marginMm']);
  if (Object.keys(raw).some(key => !known.has(key))) throw new TypeError('导出设置包含未知字段。');
  const value = { format: 'pdf', width: 780, scale: 1, paperSize: 'A4', landscape: false, theme: 'paper', marginMm: 15, ...raw };
  if (!['pdf','png'].includes(value.format) || !['A4','Letter','A5','Legal'].includes(value.paperSize) || !['paper','current'].includes(value.theme) || typeof value.landscape !== 'boolean' || ![1,2,3].includes(value.scale)) throw new TypeError('导出设置的选项无效。');
  if (!Number.isInteger(value.width) || value.width < 400 || value.width > 4096 || !Number.isFinite(value.marginMm) || value.marginMm < 8 || value.marginMm > 30) throw new TypeError('导出宽度或页边距无效。');
  return Object.freeze(value);
}
function validateImageDimensions(width, height, scale = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || ![1,2,3].includes(scale)) throw new TypeError('导出图片尺寸无效。');
  const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
  if (pixelWidth > MAX_EXPORT_EDGE || pixelHeight > MAX_EXPORT_EDGE || pixelWidth * pixelHeight > MAX_EXPORT_PIXELS) throw new Error('整篇图片过大，请降低宽度或倍率，或改用 PDF 导出。');
  return { width: pixelWidth, height: pixelHeight, pixels: pixelWidth * pixelHeight };
}
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])); }
function pageGeometry(options = {}) {
  const value = validateExportOptions(options);
  const sizes = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
  const size = sizes[value.paperSize], widthMm = size[value.landscape ? 1 : 0], heightMm = size[value.landscape ? 0 : 1];
  return Object.freeze({ widthMm, heightMm, contentWidthMm: widthMm - value.marginMm * 2, contentHeightMm: heightMm - value.marginMm * 2 });
}
function printLayoutCss(options = {}) {
  const value = validateExportOptions(options), page = pageGeometry(value);
  const mediaHeight = Math.max(1, page.contentHeightMm - 8);
  return `@page{size:${value.paperSize}${value.landscape ? ' landscape' : ''};margin:${value.marginMm}mm}
*{box-sizing:border-box}html,body{margin:0;padding:0;height:auto!important;min-height:0!important}
body{padding:24px;overflow:visible!important;width:${value.width}px;max-width:none}main{width:100%;overflow:visible}
img,svg{max-width:100%}img,.moye-export-content svg:not(svg svg):not(.katex svg){height:auto}table{border-collapse:collapse;max-width:100%}thead{display:table-header-group}tfoot{display:table-footer-group}
tr{break-inside:avoid}h1,h2,h3,h4,h5,h6{break-after:avoid;page-break-after:avoid}p,li{orphans:3;widows:3}
pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}
.moye-export-content .moye-block-math{overflow:visible!important;max-width:100%!important;max-height:none!important}
.moye-export-content .moye-block-math>mjx-container{max-width:100%!important;min-width:0!important}
.moye-export-content .moye-block-math mjx-container>svg,.moye-export-content svg.moye-export-formula{max-width:100%!important;width:auto!important;height:auto!important;overflow:visible!important}
.moye-export-content pre code{white-space:pre-wrap!important;overflow-wrap:anywhere!important}
.moye-export-content .footnotes-defs-div,.moye-export-content .footnotes-defs-ol,.moye-export-content .footnotes,.moye-export-content [data-type="footnotes-block"]{break-inside:auto!important;overflow:visible!important;height:auto!important;max-height:none!important}
.moye-export-content :is(.footnotes-defs-div,.footnotes,[data-type="footnotes-block"]) :is(li,p,blockquote,div){break-inside:auto!important;max-width:100%!important;overflow:visible!important;height:auto!important;max-height:none!important;overflow-wrap:anywhere}
.moye-export-content sup{white-space:nowrap;line-height:0;vertical-align:super}
@media print{
html,body{width:auto!important;height:auto!important;overflow:visible!important}body{padding:0}main{width:auto;max-width:100%}
#editor.moye-export-document :is(h1,h2,h3,h4,h5,h6){break-after:avoid-page!important;page-break-after:avoid!important;break-inside:avoid!important}
pre{break-inside:auto}.moye-export-content :is(img,svg:not(svg svg):not(.katex svg)){break-inside:avoid;max-height:${mediaHeight}mm!important;object-fit:contain}
#editor.moye-export-document table{display:table!important;width:100%!important;max-width:100%!important;height:auto!important;overflow:visible!important;margin-left:0!important;margin-right:0!important;table-layout:auto!important;break-inside:auto!important}
thead{display:table-header-group!important;break-inside:avoid!important}tbody{display:table-row-group!important}tfoot{display:table-footer-group!important}
tr{break-inside:avoid!important;page-break-inside:avoid!important}
#editor.moye-export-document .moye-export-content table :is(th,td){min-width:0!important;white-space:normal!important;overflow-wrap:anywhere!important}
#editor.moye-export-document .moye-export-content table:has(tr>:nth-child(8)) :is(th,td){padding:1.2mm 1mm!important}
}`;
}
function inside(base, target) { const relative = path.relative(base, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function resourceAllowed(rawUrl, { appRoot, documentRoot } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 12 * 1024 * 1024) return false;
  if (/^data:(?:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)|font\/(?:woff2?|ttf|otf));base64,[A-Za-z0-9+/=\s]*$/i.test(rawUrl)) return true;
  let url; try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'file:' || url.hostname && url.hostname !== 'localhost') return false;
  let filename; try { filename = fileURLToPath(url); } catch { return false; }
  if (!/\.(?:css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(filename)) return false;
  for (const root of [appRoot, documentRoot]) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !inside(root, filename)) continue;
    try { if (inside(await fs.realpath(root), await fs.realpath(filename))) return true; }
    catch { if (/\.asar$/i.test(root) && inside(root, filename)) return true; }
  }
  return false;
}
function buildExportHtml({ html, css = '', baseUrl, title = '墨页文档', options = {} } = {}) {
  const validated = validateExportOptions(options);
  if (typeof html !== 'string' || typeof css !== 'string' || Buffer.byteLength(html) + Buffer.byteLength(css) > MAX_SNAPSHOT_BYTES) throw new Error('导出快照超过 8 MB，请缩小文档或分段导出。');
  // The renderer must supply a cleaned DOM clone. This check is an additional
  // fail-closed boundary; JavaScript remains disabled in the export window and
  // main must also enforce resourceAllowed through its isolated session.
  if (/<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|base|meta|link|form|input|button|textarea|select)\b/i.test(html) || /<[^>]*\s+on[a-z]+\s*=/i.test(html) || /<[^>]*\b(?:href|src|xlink:href)\s*=\s*['"]?\s*(?:javascript|vbscript)\s*:/i.test(html) || /<\/style/i.test(css) || /@import\b/i.test(css)) throw new Error('导出快照含不支持的活动内容。请重新生成阅读快照。');
  let base = '';
  if (baseUrl) { const url = new URL(baseUrl); if (url.protocol !== 'file:') throw new Error('导出资源目录无效。'); base = `<base href="${escapeHtml(url.href)}">`; }
  const print = printLayoutCss(validated);
  const paper = validated.theme === 'paper' ? 'html,body,main,.moye-export-document,.moye-export-content,[data-moye-color-theme]{--paper:#fff!important;--chrome:#fff!important;--sidebar:#f5f5f5!important;--ink:#222!important;--muted:#666!important;--line:#ccc!important;--accent:#174d75!important;--accent-bg:#edf2f6!important;--code:#f5f6f3!important;background:#fff!important;color:#222!important}.moye-export-document pre,.moye-export-document code{background:#f5f6f3!important;color:#222!important}.moye-export-document pre code *{color:inherit!important}.moye-export-document .hljs-keyword,.moye-export-document .hljs-selector-tag{color:#0550ae!important}.moye-export-document .hljs-string{color:#116329!important}.moye-export-document .hljs-comment{color:#6e7781!important}.moye-export-document .hljs-number,.moye-export-document .hljs-literal{color:#953800!important}.moye-export-document a{color:#174d75!important}' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; font-src file: data:; style-src 'unsafe-inline' file:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri file:">${base}<title>${escapeHtml(title).slice(0,1000)}</title><style>${css}\n${print}\n${paper}</style></head><body><main>${html}</main></body></html>`;
}
module.exports = { validateExportOptions, validateImageDimensions, resourceAllowed, buildExportHtml, pageGeometry, printLayoutCss, MAX_SNAPSHOT_BYTES, MAX_EXPORT_PIXELS, MAX_EXPORT_EDGE };
