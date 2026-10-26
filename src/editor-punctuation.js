/* Typora-documented input punctuation, with Moye's explicit unverified defaults.
 * Source mode and paste are deliberately literal. No OS text replacements run here.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyePunctuation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const excluded = '[data-type="code-block"],[data-type="code-span"],[data-type="code"],[data-type="math-block"],[data-type="inline-math"],[data-type="math-inline"],[data-type="yaml-front-matter"],[data-type="html-block"],[data-type="html-inline"],.vditor-ir__preview';
  const invisible = '.vditor-ir__preview,.vditor-ir__marker:not(.vditor-ir__marker--pre)';
  const quotes = { '"': ['“', '”'], "'": ['‘', '’'] };
  function escaped(prefix) { return (prefix.match(/\\+$/)?.[0].length || 0) % 2 === 1; }
  function quoteCharacter(character, before) {
    // Apostrophes after letters, digits and combining marks are closing quotes.
    if (character === "'" && /[\p{L}\p{N}\p{M}]$/u.test(before)) return '’';
    return !before || /[\s([{<“‘«‹—–]$/u.test(before) ? quotes[character][0] : quotes[character][1];
  }
  function literalURL(prefix) { return /(?:\b(?:[a-z][a-z\d+.-]*:\/\/|mailto:)|\bwww\.)\S*$/i.test(prefix) || /\b[^\s@]+@[^\s@]*$/.test(prefix); }
  function parent(node) { return node?.nodeType === 3 ? node.parentElement : node; }
  function eligible(range, element) {
    if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) return false;
    if (parent(range.startContainer)?.closest(excluded + ',.vditor-ir__marker--link') || parent(range.endContainer)?.closest(excluded + ',.vditor-ir__marker--link')) return false;
    if (!range.collapsed && [...element.querySelectorAll(excluded)].some(node => range.intersectsNode(node))) return false;
    return true;
  }
  function projection(range, element) {
    const block = parent(range.startContainer)?.closest('p,h1,h2,h3,h4,h5,h6,li,td,th') || element;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return !node.length || node.parentElement.closest(invisible) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    const nodes = []; let node, text = '';
    while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.data; }
    function offset(point, end = false) {
      const collapsed = point.cloneRange(); collapsed.collapse(!end);
      let result = 0;
      for (const entry of nodes) {
        if (entry.node === collapsed.startContainer) return entry.start + collapsed.startOffset;
        if (collapsed.comparePoint(entry.node, entry.node.length) === -1) result = entry.start + entry.node.length;
        else break;
      }
      return result;
    }
    function point(at) {
      const entry = nodes.find(item => item.start + item.node.length >= at);
      return entry && { node: entry.node, offset: Math.max(0, at - entry.start) };
    }
    return { text, nodes, block, start: offset(range), end: offset(range, true), point };
  }
  function setRange(range, backward = false) {
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    if (backward && !range.collapsed) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
  }
  function suffixRange(range, count, element) {
    const data = projection(range, element), start = data.point(data.start - count);
    if (!start || data.start < count) return null;
    const result = range.cloneRange(); result.setStart(start.node, start.offset); return result;
  }
  function install({ editor, getValues, isComposing = () => false, sync, captureSelection, restoreSelection, platform = navigator.platform }) {
    const element = editor.vditor.ir.element;
    let inserting = false, lastDash = null;
    const offs = [];
    const addUndo = () => editor.vditor.undo.addToUndoStack(editor.vditor);
    const currentRange = () => { const selection = getSelection(); return selection.rangeCount ? selection.getRangeAt(0) : null; };
    function render(data) {
      sync();
      let bookmark = captureSelection(), before = editor.getValue();
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data }));
      sync();
      const after = editor.getValue();
      if (before !== after) {
        const dmp = editor.vditor.undo.dmp, diff = dmp.diff_main(before, after, false);
        bookmark = { ...bookmark, start: dmp.diff_xIndex(diff, bookmark.start), end: dmp.diff_xIndex(diff, bookmark.end) };
      }
      restoreSelection(bookmark); addUndo(); restoreSelection(bookmark);
      return bookmark;
    }
    function insertNode(range, text) {
      range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node);
      range.setStart(node, node.length); range.collapse(true); setRange(range); return node;
    }
    function consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function beforeInput(event) {
      if (inserting || event.isComposing || isComposing() || event.inputType !== 'insertText' || !event.data || event.data.length !== 1) return;
      const values = getValues();
      const character = event.data;
      if (!(values['editor.smartQuotes'] && quotes[character]) && !(values['editor.smartDashes'] && (character === '-' || character === '.'))) return;
      let range = currentRange();
      // Chromium can retain an empty DOM range across adjacent text nodes after
      // undo caret markers. Normalize that visual caret before any mutation.
      if (range && !range.collapsed && !range.toString()) { range = range.cloneRange(); range.collapse(true); setRange(range); }
      if (!eligible(range, element)) { lastDash = null; return; }
      const context = projection(range, element), before = context.text.slice(0, context.start), after = context.text.slice(context.end);
      sync(); const source = editor.getValue(), sourceSelection = captureSelection(), sourceBefore = source.slice(0, sourceSelection.start);
      // HTML under construction and destinations remain literal as well as parsed nodes.
      if (literalURL(before) || /<[^>\n]*$/.test(sourceBefore) || /\]\([^\n)]*$/.test(sourceBefore)) { lastDash = null; return; }
      // A hyphen-only line is still a Markdown delimiter under construction.
      // Keep its ASCII spelling for rules, Setext headings and YAML fences.
      // This protects syntax; it is not Typora's general Unicode parse remapping.
      const lineBefore = before.slice(before.lastIndexOf('\n') + 1).replace(/\u200b/g, '');
      const lineAfter = after.split('\n')[0].replace(/\u200b/g, '');
      if (character === '-' && /^ {0,3}(?:-[ \t]*)*$/.test(lineBefore) && !lineAfter.trim()) { lastDash = null; return; }
      const isEscaped = escaped(sourceBefore);
      if (quotes[character]) {
        consume(event); lastDash = null;
        inserting = true;
        try {
          if (isEscaped) { addUndo(); insertNode(range, character); render(character); return; }
          const [opening, closing] = quotes[character], selected = !range.collapsed;
          const converted = selected ? opening : quoteCharacter(character, before);
          if (!selected && converted === closing && after.startsWith(closing)) {
            const next = context.point(context.end + 1); range.setStart(next.node, next.offset); range.collapse(true); setRange(range); return;
          }
          const pair = values['editor.autoPairBrackets'] && (selected || converted === opening && !/^[\p{L}\p{N}]/u.test(after));
          const backward = selected && getSelection().anchorNode === range.endContainer && getSelection().anchorOffset === range.endOffset;
          addUndo();
          if (selected && pair) {
            const contents = range.extractContents(), start = document.createTextNode(character), end = document.createTextNode(character), fragment = document.createDocumentFragment();
            fragment.append(start, contents, end); range.insertNode(fragment); range.setStartAfter(start); range.setEndBefore(end); setRange(range, backward);
            sync(); addUndo(); start.data = opening; end.data = closing; setRange(range, backward);
          } else if (pair) {
            // Undo inserts a caret marker that splits its text node. Keep the
            // closing quote in a separate node so that split cannot duplicate it.
            const start = document.createTextNode(character), end = document.createTextNode(character), fragment = document.createDocumentFragment();
            fragment.append(start, end); range.insertNode(fragment); range.setStart(start, 1); range.collapse(true); setRange(range);
            sync(); addUndo(); start.data = converted; end.data = closing;
            range.setStart(start, 1); range.collapse(true); setRange(range);
          } else {
            const node = insertNode(range, character);
            sync(); addUndo(); node.data = converted;
            range.setStart(node, 1); range.collapse(true); setRange(range);
          }
          render(character);
        } finally { inserting = false; }
        return;
      }
      if (!range.collapsed || isEscaped) { lastDash = null; return; }
      let replacement = null, count = 0, raw;
      const mac = /Mac|Darwin/i.test(platform);
      if (character === '-' && lastDash && lastDash.source === source && lastDash.caret === sourceSelection.start && lastDash.block === context.block && before.endsWith(lastDash.replacement)) {
        replacement = '—'; count = 1; raw = '---';
      } else if (character === '-' && before.endsWith('-') && !escaped(sourceBefore.replace(/-+$/, ''))) { replacement = mac ? '—' : '–'; count = 1; raw = '--'; }
      else if (character === '.' && before.endsWith('..') && !escaped(sourceBefore.slice(0, -2))) { replacement = '…'; count = 2; raw = '...'; }
      if (!replacement) { lastDash = null; return; }
      consume(event); inserting = true;
      try {
        addUndo();
        const replacing = suffixRange(range, count, element); if (!replacing) return;
        // Store the literal keystrokes separately: one Undo cancels conversion.
        const node = insertNode(replacing, raw); sync(); addUndo(); node.data = replacement;
        range = document.createRange(); range.setStart(node, replacement.length); range.collapse(true); setRange(range);
        const bookmark = render(character);
        lastDash = raw === '--' ? { source: editor.getValue(), caret: bookmark.start, replacement, block: projection(currentRange(), element).block } : null;
      } finally { inserting = false; }
    }
    function backspace(event) {
      if (event.isComposing || isComposing() || event.ctrlKey || event.metaKey || event.altKey || event.key !== 'Backspace') return;
      const values = getValues(); if (!values['editor.smartQuotes'] || !values['editor.autoPairBrackets']) return;
      const range = currentRange(); if (!range?.collapsed || !eligible(range, element)) return;
      const data = projection(range, element), before = data.text[data.start - 1], after = data.text[data.start];
      if (!Object.values(quotes).some(([left, right]) => left === before && right === after)) return;
      consume(event); inserting = true; lastDash = null;
      try {
        addUndo(); const start = data.point(data.start - 1), end = data.point(data.start + 1);
        range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); range.deleteContents(); range.collapse(true); setRange(range); render('');
      } finally { inserting = false; }
    }
    element.addEventListener('beforeinput', beforeInput, true); offs.push(() => element.removeEventListener('beforeinput', beforeInput, true));
    element.addEventListener('keydown', backspace, true); offs.push(() => element.removeEventListener('keydown', backspace, true));
    const reset = event => { if (!inserting && event.key !== '-' && event.key !== 'Shift') lastDash = null; };
    element.addEventListener('keydown', reset, true); offs.push(() => element.removeEventListener('keydown', reset, true));
    const clearDash = () => { lastDash = null; };
    for (const type of ['pointerdown', 'paste', 'blur', 'compositionstart']) { element.addEventListener(type, clearDash, true); offs.push(() => element.removeEventListener(type, clearDash, true)); }
    return { destroy() { offs.forEach(off => off()); }, refresh: clearDash };
  }
  return Object.freeze({ install, quoteCharacter, escaped, literalURL });
});
