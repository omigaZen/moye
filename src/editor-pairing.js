/* Local text input rules. Composition events always belong to the OS IME. */
(function (root) {
  'use strict';
  const normal = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '（': '）', '【': '】', '「': '」', '『': '』' };
  const markdown = { '*': '*', '_': '_', '`': '`', '$': '$' };
  const selectionOnly = { '~': '~', '=': '=', '^': '^' };
  const codeSelector = '[data-type="code-block"],[data-type="math-block"],[data-type="yaml-front-matter"],[data-type="code-span"],[data-type="code"]';

  // A closing fence must use the opening character and be at least as long.
  // Literal shorter/mismatched fences inside code cannot change its context.
  function sourceCode(value, offset) {
    const lines = value.slice(0, offset).split(/\r?\n/);
    let fence = null;
    for (const line of lines.slice(0, -1)) {
      if (fence) {
        const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
        if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null;
      } else {
        const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (open && (open[1][0] !== '`' || !open[2].includes('`'))) fence = { character: open[1][0], length: open[1].length };
      }
    }
    if (fence) return true;
    // On a normal source line, honor matching inline-code delimiter lengths.
    let inline = 0;
    const line = lines.at(-1);
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue; }
      if (line[i] !== '`') continue;
      let end = i + 1;
      while (line[end] === '`') end++;
      const length = end - i;
      if (!inline) inline = length;
      else if (length === inline) inline = 0;
      i = end - 1;
    }
    return inline !== 0;
  }
  function codeContext(mode, element, range) {
    if (mode === 'sv') return sourceCode(element.value, element.selectionStart);
    const container = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    return !!container.closest(codeSelector);
  }
  function adjacent(range, element, before) {
    const point = range.cloneRange(); point.collapse(before);
    const container = point.startContainer.nodeType === 3 ? point.startContainer.parentElement : point.startContainer;
    const block = container.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,pre') || element;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return !node.length || node.parentElement.closest('.vditor-ir__preview,.vditor-ir__marker:not(.vditor-ir__marker--pre)') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    let node, candidate = null;
    while ((node = walker.nextNode())) {
      if (node === point.startContainer) {
        const at = point.startOffset + (before ? -1 : 0);
        if (at >= 0 && at < node.length) return { node, offset: at, character: node.data[at] };
      }
      if (before && point.comparePoint(node, node.length) === -1) candidate = { node, offset: node.length - 1, character: node.data.at(-1) };
      if (!before && point.comparePoint(node, 0) === 1) return { node, offset: 0, character: node.data[0] };
    }
    return candidate;
  }
  function activePairs(values, code) {
    const pairs = values['editor.autoPairBrackets'] ? { ...normal } : {};
    if (!code && values['editor.autoPairMarkdown']) {
      Object.assign(pairs, markdown);
      if (!values['markdown.inlineMath']) delete pairs.$;
    }
    return pairs;
  }
  function install({ editor, getValues, isComposing, sync, captureSelection, restoreSelection }) {
    let inserting = false;
    const offs = [];
    for (const mode of ['ir', 'sv']) {
      const element = editor.vditor[mode].element;
      const handler = event => {
        if (inserting || event.isComposing || isComposing() || event.inputType !== 'insertText' || !event.data || [...event.data].length !== 1) return;
        const values = getValues(), character = event.data;
        const selection = getSelection(), range = mode === 'ir' && selection.rangeCount ? selection.getRangeAt(0) : null;
        if (mode === 'ir' && (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer))) return;
        const code = codeContext(mode, element, range), pairs = activePairs(values, code);
        const selected = mode === 'sv' ? element.value.slice(element.selectionStart, element.selectionEnd) : selection.toString();
        const previous = mode === 'ir' ? adjacent(range, element, true) : null;
        const next = mode === 'ir' ? adjacent(range, element, false) : null;
        const before = mode === 'sv' ? element.value[element.selectionStart - 1] || '' : previous?.character || '';
        const after = mode === 'sv' ? element.value[element.selectionEnd] || '' : next?.character || '';
        let close = pairs[character];
        if (selected && !code && values['editor.autoPairMarkdown'] && (character !== '=' || values['markdown.mark']) && (character !== '^' || values['markdown.sup']) && (character !== '~' || values['markdown.sub'])) close = close || selectionOnly[character];
        if (!selected && after === character && Object.values(pairs).includes(character)) {
          event.preventDefault(); event.stopImmediatePropagation();
          if (mode === 'sv') element.setSelectionRange(element.selectionEnd + 1, element.selectionEnd + 1);
          else { range.setStart(next.node, next.offset + 1); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
          return;
        }
        if (!close || !selected && ((character === "'" || character === '"' || character === '_') && /[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after))) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const backward = mode === 'ir' && selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
        editor.vditor.undo.addToUndoStack(editor.vditor);
        const start = mode === 'sv' ? element.selectionStart : 0;
        let bookmark;
        inserting = true;
        try {
          if (mode === 'ir' && !range.collapsed) {
            // Preserve actual inline nodes, and select their precise DOM range.
            // UTF-16 lengths cannot drive Selection.modify('character'): emoji,
            // combining sequences and ZWJ clusters have different lengths.
            const contents = range.extractContents(), opening = document.createTextNode(character), closing = document.createTextNode(close);
            const fragment = document.createDocumentFragment(); fragment.append(opening, contents, closing); range.insertNode(fragment);
            range.setStartAfter(opening); range.setEndBefore(closing);
            selection.removeAllRanges(); selection.addRange(range);
            if (backward) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
            sync();
            const beforeRender = editor.getValue();
            bookmark = captureSelection();
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: character }));
            sync();
            const afterRender = editor.getValue();
            if (beforeRender !== afterRender) {
              const dmp = editor.vditor.undo.dmp, diff = dmp.diff_main(beforeRender, afterRender, false);
              bookmark.start = dmp.diff_xIndex(diff, bookmark.start); bookmark.end = dmp.diff_xIndex(diff, bookmark.end);
            }
            restoreSelection(bookmark);
          } else {
            document.execCommand('insertText', false, character + selected + close);
            if (mode === 'sv') element.setSelectionRange(start + 1, start + 1 + selected.length);
            else selection.modify('move', 'backward', 'character');
          }
        } finally { inserting = false; }
        sync(); editor.vditor.undo.addToUndoStack(editor.vditor);
        if (bookmark) restoreSelection(bookmark);
      };
      element.addEventListener('beforeinput', handler, true);
      offs.push(() => element.removeEventListener('beforeinput', handler, true));
      const removePair = event => {
        if (event.key !== 'Backspace' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || isComposing()) return;
        const values = getValues(), selection = getSelection();
        const range = mode === 'ir' && selection.rangeCount ? selection.getRangeAt(0) : null;
        let before, after, previous, next;
        if (mode === 'sv') {
          if (element.selectionStart !== element.selectionEnd) return;
          before = element.value[element.selectionStart - 1]; after = element.value[element.selectionStart];
        } else {
          if (!range?.collapsed || !element.contains(range.startContainer)) return;
          previous = adjacent(range, element, true); next = adjacent(range, element, false);
          before = previous?.character; after = next?.character;
        }
        const pairs = activePairs(values, codeContext(mode, element, range));
        if (!before || !after || pairs[before] !== after) return;
        event.preventDefault(); event.stopImmediatePropagation();
        editor.vditor.undo.addToUndoStack(editor.vditor);
        if (mode === 'sv') element.setSelectionRange(element.selectionStart - 1, element.selectionEnd + 1);
        else { range.setStart(previous.node, previous.offset); range.setEnd(next.node, next.offset + 1); selection.removeAllRanges(); selection.addRange(range); }
        document.execCommand('delete'); sync(); editor.vditor.undo.addToUndoStack(editor.vditor);
      };
      element.addEventListener('keydown', removePair, true);
      offs.push(() => element.removeEventListener('keydown', removePair, true));
    }
    return { destroy() { offs.forEach(off => off()); } };
  }
  root.MoyePairing = Object.freeze({ install });
})(window);
