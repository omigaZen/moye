'use strict';
// Legacy encoders are bundled offline. Decoding is strict: invalid byte streams
// and characters that cannot round-trip are never silently replaced on save.
const iconv = require('./vendor/iconv-lite');
const ENCODINGS = Object.freeze([
  Object.freeze({ id: 'utf-8', label: 'UTF-8' }),
  Object.freeze({ id: 'utf-16le', label: 'UTF-16 LE' }),
  Object.freeze({ id: 'utf-16be', label: 'UTF-16 BE' }),
  Object.freeze({ id: 'gb18030', label: 'GB18030' }),
  Object.freeze({ id: 'big5', label: 'Big5' }),
  Object.freeze({ id: 'shift_jis', label: 'Shift_JIS' }),
  Object.freeze({ id: 'euc-kr', label: 'EUC-KR' }),
]);
const known = new Set(ENCODINGS.map(value => value.id));
function normalizeEncoding(value, allowAuto = false) {
  if (typeof value !== 'string') throw new TypeError('文本编码无效。');
  const normalized = value.trim().toLowerCase().replace(/^utf8$/, 'utf-8').replace(/^utf16le$/, 'utf-16le').replace(/^utf16be$/, 'utf-16be').replace(/^shift-jis$/, 'shift_jis').replace(/^euckr$/, 'euc-kr');
  if (allowAuto && normalized === 'auto') return normalized;
  if (!known.has(normalized)) throw new TypeError('不支持的文本编码。');
  return normalized;
}
function labelFor(encoding, bom = false) { const label = ENCODINGS.find(value => value.id === encoding)?.label || encoding; return `${label}${bom ? ' BOM' : ''}`; }
function strictDecode(bytes, encoding) {
  try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`无法按 ${labelFor(encoding)} 解码；请选择正确编码或转换为 UTF-8。`); }
}
function bomInfo(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', length: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  return null;
}
function binaryText(text) { return text.includes('\0'); }
function decodeText(bytes, { encoding = 'auto' } = {}) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('需要文本字节。');
  const selected = normalizeEncoding(encoding, true), mark = bomInfo(bytes);
  let chosen = selected, guessed = false, text;
  if (selected === 'auto') {
    if (mark) chosen = mark.encoding;
    else {
      try { text = strictDecode(bytes, 'utf-8'); chosen = 'utf-8'; } catch {}
      if (text === undefined) { chosen = 'gb18030'; guessed = true; }
    }
  }
  const bom = !!mark && mark.encoding === chosen;
  text ??= strictDecode(bom ? bytes.subarray(mark.length) : bytes, chosen);
  if (binaryText(text)) throw new Error('此文件包含二进制内容或使用了不受支持的编码，请手动选择文本编码。');
  return { text, encoding: chosen, bom, encodingGuessed: guessed, warning: guessed ? '编码为推测的 GB18030；若显示不正确，请选择其他编码。' : '' };
}
function encodeText(text, { encoding = 'utf-8', bom = false } = {}) {
  const chosen = normalizeEncoding(encoding);
  if (typeof text !== 'string' || !text.isWellFormed()) throw new TypeError('文本包含未配对 Unicode 代理字符，无法安全保存。');
  if (binaryText(text)) throw new Error('文档包含二进制控制字符，无法安全保存。');
  let bytes;
  if (chosen === 'utf-8') bytes = Buffer.from(text, 'utf8');
  else if (chosen === 'utf-16le') bytes = Buffer.from(text, 'utf16le');
  else if (chosen === 'utf-16be') { bytes = Buffer.from(text, 'utf16le'); bytes.swap16(); }
  else bytes = iconv.encode(text, chosen);
  if (strictDecode(bytes, chosen) !== text) throw new Error(`${labelFor(chosen)} 不能无损保存这些字符。请明确转换为 UTF-8 后再保存。`);
  if (bom && chosen === 'utf-8') return Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]);
  if (bom && chosen === 'utf-16le') return Buffer.concat([Buffer.from([0xff,0xfe]),bytes]);
  if (bom && chosen === 'utf-16be') return Buffer.concat([Buffer.from([0xfe,0xff]),bytes]);
  return bytes;
}
module.exports = { ENCODINGS, normalizeEncoding, labelFor, bomInfo, decodeText, encodeText };
