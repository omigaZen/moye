/* Automatic links are a view overlay. Never put generated anchors into Markdown. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeAutoLinks = api;
})(typeof window === 'object' ? window : globalThis, function (root) {
  'use strict';
  const highlightName = 'moye-autolink';
  const candidate = /https?:\/\/|www\.|@/i;
  const excluded = 'a,[data-type="a"],[data-type="link-ref"],code,pre,[data-type*="math"],[data-type="yaml-front-matter"],.katex,mjx-container,.MathJax,img,svg,script,style,.vditor-ir__preview,.vditor-ir__marker,[contenteditable="false"]';
  function allowedURL(url) {
    if (typeof url !== 'string' || /[\u0000-\u0020\u007f]/.test(url)) return false;
    try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch (_) { return false; }
  }
  // LinkType 2 is produced by normal Lute automatic-link parsing. Explicit
  // Markdown links have no LinkType=2 and are deliberately not overlaid.
  function extract(text, parser) {
    if (!candidate.test(text)) return [];
    const ast = JSON.parse(parser.RenderJSON(text)), result = [];
    let cursor = 0;
    function visit(node) {
      if (node.Type === 'NodeLink' && node.LinkType === 2) {
        const children = node.Children || [];
        const label = children.filter(child => child.Type === 'NodeLinkText').map(child => child.Data || '').join('');
        const url = children.find(child => child.Type === 'NodeLinkDest')?.Data;
        const start = label ? text.indexOf(label, cursor) : -1;
        if (start >= 0) {
          cursor = start + label.length;
          if (allowedURL(url)) result.push({ url, text: label, start, end: cursor });
        }
        return;
      }
      if (typeof node.Data === 'string' && node.Data) {
        const start = text.indexOf(node.Data, cursor);
        if (start >= 0) cursor = start + node.Data.length;
      }
      for (const child of node.Children || []) visit(child);
    }
    visit(ast);
    return result;
  }
  function create(options) {
    const element = options?.element;
    if (!element || element.nodeType !== 1) throw new TypeError('Automatic links require an editor element.');
    const document = element.ownerDocument, view = document.defaultView;
    const cache = new WeakMap();
    let parser, links = [], timer, destroyed = false, composing = false, overlay;
    function normalParser() {
      if (parser) return parser;
      // Accept a factory, never mutate the editor's configured IR parser.
      const factory = options.lute?.New ? options.lute : root.Lute;
      if (!factory?.New) return null;
      parser = factory.New(); parser.SetVditorIR(false); parser.SetGFMAutoLink(true);
      return parser;
    }
    function clear() {
      links = [];
      if (view.CSS?.highlights?.get(highlightName) === overlay) view.CSS.highlights.delete(highlightName);
      overlay = undefined;
    }
    function refresh() {
      clearTimeout(timer); timer = null;
      if (destroyed) return [];
      if (!options.isEnabled?.()) { clear(); return []; }
      if (composing || options.isComposing?.()) return getLinks();
      const lute = normalParser();
      if (!lute) { clear(); return []; }
      const ranges = [], next = [];
      const walker = document.createTreeWalker(element, view.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const blocked = node.parentElement?.closest(excluded);
          return !candidate.test(node.data) || (blocked && blocked !== element && element.contains(blocked)) ? view.NodeFilter.FILTER_REJECT : view.NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        let item = cache.get(node);
        if (!item || item.text !== node.data) {
          let matches;
          try { matches = extract(node.data, lute); } catch (_) { matches = []; }
          item = { text: node.data, matches }; cache.set(node, item);
        }
        for (const match of item.matches) {
          const range = document.createRange(); range.setStart(node, match.start); range.setEnd(node, match.end);
          ranges.push(range); next.push({ url: match.url, text: match.text, range });
        }
      }
      links = next;
      if (view.CSS?.highlights && typeof view.Highlight === 'function') {
        overlay = new view.Highlight(...ranges); view.CSS.highlights.set(highlightName, overlay);
      }
      return getLinks();
    }
    function getLinks() { return links.map(link => ({ url: link.url, text: link.text, range: link.range.cloneRange() })); }
    function schedule() {
      if (destroyed) return;
      clearTimeout(timer); timer = setTimeout(refresh, 120);
    }
    function compositionStart() { composing = true; }
    function compositionEnd() { composing = false; schedule(); }
    function click(event) {
      if (!(event.ctrlKey || event.metaKey) || typeof options.onOpen !== 'function' || composing || options.isComposing?.() || !options.isEnabled?.()) return;
      // A live Range may track edited text while its cached URL is still old.
      // Resolve this intentional click against the current DOM before opening.
      refresh();
      for (const link of links) {
        if (!element.contains(link.range.startContainer)) continue;
        const hit = [...link.range.getClientRects()].some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
        if (!hit) continue;
        event.preventDefault(); event.stopImmediatePropagation();
        Promise.resolve(options.onOpen(link.url)).catch(error => console.error(error));
        return;
      }
    }
    const observer = new view.MutationObserver(schedule);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    element.addEventListener('input', schedule);
    element.addEventListener('compositionstart', compositionStart);
    element.addEventListener('compositionend', compositionEnd);
    element.addEventListener('click', click, true);
    refresh();
    return Object.freeze({ refresh, getLinks, destroy() {
      if (destroyed) return;
      destroyed = true; clearTimeout(timer); observer.disconnect();
      element.removeEventListener('input', schedule); element.removeEventListener('compositionstart', compositionStart);
      element.removeEventListener('compositionend', compositionEnd); element.removeEventListener('click', click, true); clear();
    } });
  }
  return Object.freeze({ create, extract, highlightName });
});
