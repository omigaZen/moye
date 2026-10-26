/* Cache Vditor 4.0.1 outline generation when its actual heading inputs match. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeOutlineCache = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const installations = new WeakMap();

  function install(editor) {
    const vditor = editor?.vditor;
    const outline = vditor?.outline;
    if (!outline || typeof outline.render !== 'function') throw new TypeError('An initialized Vditor outline is required.');
    if (installations.has(outline)) return installations.get(outline);
    const original = outline.render;
    const counts = { hits: 0, misses: 0, fallbacks: 0, invalidations: 0 };
    let cached = null, destroyed = false;

    function snapshot(instance, current) {
      const preview = current.preview;
      const content = preview.element.style.display === 'block' ? preview.previewElement : current[current.currentMode].element;
      const target = instance.element.lastElementChild;
      const nodes = [], headings = [];
      // This is the same direct-child heading set and DOM index used by
      // markdown/outlineRender.ts, including IDs and inline formatting.
      Array.from(content.children).forEach((node, index) => {
        if (!/^H[1-6]$/.test(node.tagName)) return;
        nodes.push(node);
        headings.push([index, node.outerHTML.replaceAll('<wbr>', '')]);
      });
      const key = JSON.stringify({
        mode: current.currentMode, display: preview.element.style.display,
        cdn: current.options.cdn, markdown: current.options.preview.markdown,
        math: current.options.preview.math, theme: current.options.preview.theme,
        icon: !!content.ownerDocument.getElementById('vditorIconScript'), headings,
      }, (_key, value) => {
        // Unknown callable configuration cannot be represented by JSON;
        // preserve upstream rendering instead of guessing equivalence.
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new TypeError('Uncacheable outline configuration.');
        return value;
      });
      return { content, target, lute: current.lute, nodes, key };
    }

    function wrapped(current) {
      let before;
      try { before = snapshot(this, current); }
      catch (_) {
        cached = null; counts.fallbacks++;
        return original.apply(this, arguments);
      }
      if (cached && before.content === cached.content && before.target === cached.target && before.lute === cached.lute && before.key === cached.key
        && before.nodes.length === cached.nodes.length && before.nodes.every((node, index) => node === cached.nodes[index])) {
        counts.hits++;
        return cached.result;
      }
      counts.misses++;
      // Outline.render only chooses the source and calls outlineRender; it
      // has no resize/visibility side effects. All document input parsing,
      // selection restoration, undo and renderToc calls still run normally.
      cached = null;
      const result = original.apply(this, arguments);
      try {
        // Upstream assigns heading IDs while rendering. Save those actual
        // IDs, rather than the pre-render signature which would miss again.
        cached = { ...snapshot(this, current), result };
      } catch (_) { counts.fallbacks++; }
      return result;
    }

    outline.render = wrapped;
    const controller = Object.freeze({
      invalidate() { cached = null; counts.invalidations++; },
      stats() { return { ...counts }; },
      destroy() {
        if (destroyed) return;
        destroyed = true; cached = null;
        if (outline.render === wrapped) outline.render = original;
        installations.delete(outline);
      },
    });
    installations.set(outline, controller);
    return controller;
  }
  return Object.freeze({ install });
});
