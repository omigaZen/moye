/* Source-offset TXT indexing. No DOM, HTML parsing or document normalization. */
(function (root) {
  'use strict';
  const chapterPattern = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇集](?:[\s　:：.、-].*)?|Chapter\s+(?:[IVXLCDM]+|\d+)(?:\b.*)?|序章|楔子|尾声|后记|前言|序言)$/i;
  function boundary(raw, at) {
    let result = Math.min(raw.length, at);
    if (result > 0 && result < raw.length && /[\uD800-\uDBFF]/.test(raw[result - 1]) && /[\uDC00-\uDFFF]/.test(raw[result])) result--;
    // Preserve ordinary combining sequences, variation selectors and emoji ZWJ
    // groups. Pathological unbounded combining sequences retain code points.
    let extra = 0;
    while (result < raw.length && extra < 64 && (/^[\p{Mark}\uFE0F\u200D]/u.test(raw.slice(result)) || raw[result - 1] === '\u200D')) {
      const width = raw.codePointAt(result) > 0xffff ? 2 : 1;
      if (extra + width > 64) break;
      result += width; extra += width;
    }
    return result;
  }
  function fingerprint(value) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(value.length - i - 1); }
    return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
  }
  function build(raw, options = {}) {
    if (typeof raw !== 'string') throw new TypeError('TXT source must be text.');
    const chars = Math.max(4096, Math.min(65536, Number.isInteger(options.maxWindowCharacters) ? options.maxWindowCharacters : 65536));
    const lines = Math.max(16, Math.min(256, Number.isInteger(options.maxWindowLines) ? options.maxWindowLines : 256));
    const windows = [], chapters = [], chapterOffsets = new Map();
    for (let start = 0; start < raw.length || !windows.length;) {
      let end = Math.min(raw.length, start + chars), cursor = start, count = 0;
      while (cursor < end && count < lines) { const nl = raw.indexOf('\n', cursor); if (nl < 0 || nl >= end) break; cursor = nl + 1; count++; }
      if (count >= lines) end = cursor;
      else if (end < raw.length) { const nl = raw.lastIndexOf('\n', end - 1); end = nl > start + chars / 4 ? nl + 1 : boundary(raw, end); }
      if (end <= start && raw.length) end = boundary(raw, start + 2);
      windows.push(Object.freeze({ start, end, continuation: start > 0 && raw[start - 1] !== '\n' }));
      if (end >= raw.length) break; start = end;
    }
    if (options.chapterDetection !== false) {
      for (let start = 0; start < raw.length;) {
        const nl = raw.indexOf('\n', start), end = nl < 0 ? raw.length : nl;
        if (end - start <= 124) { const text = raw.slice(start, end).trim(); if (text && text.length <= 120 && chapterPattern.test(text)) { const index = chapters.length; chapters.push(Object.freeze({ index, level: 2, text, id: `chapter-${index}`, offset: start })); chapterOffsets.set(start, index); } }
        if (nl < 0) break; start = nl + 1;
      }
    }
    function windowForOffset(offset) {
      const target = Math.max(0, Math.min(raw.length, Number.isFinite(offset) ? offset : 0));
      let low = 0, high = windows.length - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (windows[mid].start <= target) low = mid; else high = mid - 1; }
      return low;
    }
    let codePoints = raw.length;
    for (let i = 0; i < raw.length - 1; i++) if (raw.charCodeAt(i) >= 0xd800 && raw.charCodeAt(i) <= 0xdbff && raw.charCodeAt(i + 1) >= 0xdc00 && raw.charCodeAt(i + 1) <= 0xdfff) { codePoints--; i++; }
    return Object.freeze({ raw, codePoints, windows: Object.freeze(windows), chapters: Object.freeze(chapters), chapterOffsets, windowForOffset,
      signature: `${raw.length}:${fingerprint(raw.slice(0, 4096) + raw.slice(-4096))}` });
  }
  const api = Object.freeze({ build, boundary, fingerprint, chapterPattern });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MoyeTxtChapters = api;
})(typeof window !== 'undefined' ? window : globalThis);
