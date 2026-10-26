(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeMarkdownConfig = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Keep creation and explicit reload on the same configuration path. These
  // are Moye parser controls; a Lute flag is not evidence of Typora parity.
  const bindings = Object.freeze([
    ['markdown.inlineMath', 'inlineMath', 'SetInlineMath', true],
    ['markdown.sup', 'sup', 'SetSup', true],
    ['markdown.sub', 'sub', 'SetSub', true],
    ['markdown.mark', 'mark', 'SetMark', true],
    ['markdown.autoLink', 'gfmAutoLink', 'SetGFMAutoLink', true],
    ['markdown.toc', 'toc', 'SetToC', true],
    ['markdown.footnotes', 'footnotes', 'SetFootnotes', true],
    ['markdown.mathBlock', 'mathBlockPreview', 'SetVditorMathBlockPreview', true],
  ].map(([key, option, setter, fallback]) => Object.freeze({ key, option, setter, fallback })));

  function boolean(values, key, fallback) {
    const value = values[key] === undefined ? fallback : values[key];
    if (typeof value !== 'boolean') throw new TypeError(`Markdown setting ${key} must be boolean.`);
    return value;
  }
  function options(values) {
    const result = Object.fromEntries(bindings.map(binding => [binding.option, boolean(values, binding.key, binding.fallback)]));
    // Disabled math/diagram previews keep editable source blocks. All normal
    // code blocks retain preview/highlighting independently of diagram choice.
    result.codeBlockPreview = true;
    result.moyeDiagrams = boolean(values, 'markdown.diagrams', true);
    result.moyeCodeBlockMath = boolean(values, 'markdown.codeBlockMath', true);
    return result;
  }
  function apply(lute, markdown, values) {
    const next = options(values);
    // Check capabilities before changing any state; unsupported setters must
    // fail visibly instead of leaving a saved but ineffective preference.
    for (const { setter } of bindings) {
      if (typeof lute[setter] !== 'function') throw new TypeError(`Markdown parser does not support ${setter}.`);
    }
    if (typeof lute.SetVditorCodeBlockPreview !== 'function') throw new TypeError('Markdown parser does not support code block previews.');
    for (const { setter, option } of bindings) lute[setter](next[option]);
    lute.SetVditorCodeBlockPreview(true);
    Object.assign(markdown, next);
    return markdown;
  }
  function applyView(element, values) {
    // Lute's SetSoftBreak2HardBreak has no effect in its IR renderer. The IR
    // keeps literal whitespace in text nodes, so use the browser's whitespace
    // policy rather than inserting <br> or mutating Markdown. Explicit hard
    // breaks and code/pre elements keep their own markup and CSS behavior.
    element.style.whiteSpace = boolean(values, 'markdown.preserveWhitespace', true) ? 'pre-wrap' : 'normal';
  }

  return Object.freeze({ bindings, options, apply, applyView });
});
