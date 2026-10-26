/* Typography lives on non-editable ancestors and stylesheets, never text nodes. */
(function (global) {
  'use strict';
  const latinRange = 'U+0000-2E7F,U+A4D0-ABFF,U+D800-F8FF,U+FB00-FDFF,U+FE70-FEFF,U+FFF0-1FFFF,U+32400-10FFFF';
  const cjkRange = 'U+2E80-A4CF,U+AC00-D7FF,U+F900-FAFF,U+FE00-FE6F,U+FF00-FFEF,U+20000-323FF';
  const generic = new Set(['inherit', 'initial', 'unset', 'serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'cursive', 'fantasy', 'emoji', 'math', 'fangsong']);
  const faces = new Map();
  let faceSheet = null;

  function supports(property, value) { return Boolean(global.CSS?.supports?.(property, value)); }
  function nativePunctuationTrim() {
    return ['trim-all', 'trim-start'].find(value => supports('text-spacing-trim', value)) || null;
  }
  function capabilities() {
    return { textAutospace: supports('text-autospace', 'normal'), hangingPunctuation: supports('hanging-punctuation', 'first last'),
      textSpacingTrim: nativePunctuationTrim(), punctuationCompressionEditing: Boolean(nativePunctuationTrim()), punctuationCompressionReading: true,
      punctuationCompressionLimit: 'Native editing trim depends on browser support. Read-only full-width marks use bounded, measured glyph geometry; Latin punctuation, code and URL/path text are excluded.',
      roleFonts: true, roleFontLimit: 'Named local fonts with unicode ranges, followed by the existing document font; unavailable fonts fall back. Generic families do not create a local font face.',
      justification: 'Browser line justification; this is not Knuth–Plass paragraph optimisation.' };
  }
  function fontNames(value) {
    const names = [], expression = /(?:"([^"]*)"|'([^']*)'|([^,]+))(?:,|$)/g;
    let match;
    while ((match = expression.exec(value))) {
      const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (name && !generic.has(name.toLowerCase())) names.push(name);
    }
    return names;
  }
  function faceFor(value, cjk) {
    if (!value || value === 'inherit') return null;
    const names = fontNames(value); if (!names.length) return null;
    const key = `${cjk ? 'cjk' : 'latin'}|${names.join('|')}`;
    if (faces.has(key)) return faces.get(key).name;
    let hash = 2166136261;
    for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    const name = `MoyeRole-${cjk ? 'CJK' : 'Latin'}-${(hash >>> 0).toString(16)}`;
    const rule = `@font-face{font-family:${JSON.stringify(name)};src:${names.map(item => `local(${JSON.stringify(item)})`).join(',')};font-style:normal;font-weight:400;unicode-range:${cjk ? cjkRange : latinRange};font-display:swap}`;
    faces.set(key, { name, rule });
    if (!faceSheet?.isConnected) { faceSheet = document.createElement('style'); faceSheet.dataset.moyeTypographyFonts = 'local-only'; document.head.append(faceSheet); }
    // The number of user profiles is bounded, but a font picker may be edited
    // repeatedly. Keep the current aliases plus recent previews bounded too.
    if (faces.size > 96) faces.delete(faces.keys().next().value);
    faceSheet.textContent = [...faces.values()].map(face => face.rule).join('\n');
    return name;
  }
  function applyTo(element, values = {}) {
    if (!element?.style) return capabilities();
    const defaults = global.MoyeTypography?.defaults || {};
    const get = key => values[key] ?? defaults[key];
    const latin = faceFor(get('typography.latinFontFamily'), false), cjk = faceFor(get('typography.cjkFontFamily'), true);
    const aliases = [latin, cjk].filter(Boolean).map(name => JSON.stringify(name));
    element.classList.add('moye-typography');
    element.dataset.moyeCjkSpacing = String(Boolean(get('typography.cjkSpacing')));
    element.dataset.moyeHangingPunctuation = String(Boolean(get('typography.hangingPunctuation')));
    element.dataset.moyePunctuationCompression = String(Boolean(get('typography.punctuationCompression')));
    element.style.setProperty('--moye-punctuation-trim', get('typography.punctuationCompression') ? nativePunctuationTrim() || 'normal' : 'normal');
    element.dataset.moyeParagraphStyle = get('typography.paragraphStyle') || 'spaced';
    element.dataset.moyeTextAlign = get('typography.textAlign') || 'start';
    element.dataset.moyeColorTheme = get('typography.colorTheme') || 'moye';
    if (values['appearance.fontFamily']) element.style.setProperty('--body-font', values['appearance.fontFamily']);
    if (values['appearance.monospaceFontFamily']) element.style.setProperty('--mono-font', values['appearance.monospaceFontFamily']);
    if (values['appearance.fontSize']) element.style.setProperty('--font-size', `${values['appearance.fontSize']}px`);
    if (values['appearance.contentWidth']) element.style.setProperty('--content-width', `${values['appearance.contentWidth']}px`);
    if (values['appearance.lineHeight']) element.style.setProperty('--body-line-height', String(values['appearance.lineHeight']));
    element.style.setProperty('--moye-prose-font', [...aliases, 'var(--body-font)'].join(','));
    return capabilities();
  }
  function install({ editor, getValues, isComposing = () => false }) {
    const ir = editor.vditor.ir.element, host = ir.closest('.vditor') || ir.parentElement;
    let destroyed = false, deferred = false;
    function refresh() {
      if (destroyed) return;
      if (isComposing()) { deferred = true; return; }
      deferred = false;
      const values = getValues(); applyTo(host, values);
      document.body.dataset.moyeColorTheme = values['typography.colorTheme'] || 'moye';
    }
    const compositionEnd = () => { if (deferred) queueMicrotask(refresh); };
    ir.addEventListener('compositionend', compositionEnd);
    refresh();
    return { refresh, capabilities, destroy() {
      destroyed = true; ir.removeEventListener('compositionend', compositionEnd);
      host.classList.remove('moye-typography');
      for (const key of ['moyeCjkSpacing', 'moyeHangingPunctuation', 'moyePunctuationCompression', 'moyeParagraphStyle', 'moyeTextAlign', 'moyeColorTheme']) delete host.dataset[key];
      for (const key of ['--moye-prose-font', '--moye-punctuation-trim', '--body-font', '--mono-font', '--font-size', '--content-width', '--body-line-height']) host.style.removeProperty(key);
      delete document.body.dataset.moyeColorTheme;
    } };
  }
  global.MoyeTypographyView = Object.freeze({ applyTo, install, capabilities });
})(window);
