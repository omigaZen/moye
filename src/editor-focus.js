/* View-only focus ranges and caret scrolling. Editable DOM and undo remain untouched. */
(function (global) {
  'use strict';
  const highlightName = 'moye-focus-dim';
  const ignored = 'script,style,.vditor-linenumber__rows,.vditor-linenumber__temp';
  function create({ editor, isEnabled = () => false, isTypewriterEnabled = () => false, alwaysCenter = () => true, isComposing = () => false }) {
    const ir = editor.vditor.ir.element, source = editor.vditor.sv.element;
    const host = ir.closest('.vditor') || ir.parentElement;
    const sheet = document.createElement('style'); sheet.dataset.moyeFocus = 'view'; document.head.append(sheet);
    const layoutSheet = document.createElement('style'); layoutSheet.dataset.moyeTypewriter = 'view'; document.head.append(layoutSheet);
    const masks = document.createElement('div'); masks.className = 'moye-focus-source-mask'; masks.setAttribute('aria-hidden', 'true');
    masks.innerHTML = '<div></div><div></div>'; masks.hidden = true; document.body.append(masks);
    const mirror = document.createElement('div'); mirror.className = 'moye-focus-caret-mirror'; mirror.setAttribute('aria-hidden', 'true'); document.body.append(mirror);
    let frame = 0, pendingCenter = false, localComposition = false, destroyed = false, lastBlock = null, sourceMeasurement = null;
    const offs = [];
    const listen = (target, type, callback, options) => { target.addEventListener(type, callback, options); offs.push(() => target.removeEventListener(type, callback, options)); };
    const composing = () => localComposition || isComposing();
    const mode = () => editor.getCurrentMode();
    function path(element) {
      const pieces = [];
      while (element && element !== ir) {
        pieces.unshift(`${element.tagName.toLowerCase()}:nth-child(${Array.prototype.indexOf.call(element.parentElement.children, element) + 1})`);
        element = element.parentElement;
      }
      return element === ir ? pieces.join('>') : '';
    }
    function semantic(node) {
      let element = node?.nodeType === 1 ? node : node?.parentElement;
      if (!element || !ir.contains(element)) return null;
      // The actual editable root is a PRE; it must never become a code block.
      const cell = element.closest('td,th'); if (cell && ir.contains(cell)) return cell;
      const code = element.closest('[data-type="code-block"],[data-type="math-block"],[data-type="yaml-front-matter"]'); if (code && code !== ir) return code;
      const leaf = element.closest('p,h1,h2,h3,h4,h5,h6,li,hr');
      if (leaf && leaf !== ir) return leaf;
      while (element.parentElement && element.parentElement !== ir) element = element.parentElement;
      return element === ir ? null : element;
    }
    function sourceCaret() {
      const css = getComputedStyle(source);
      const keys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent', 'textTransform', 'direction', 'textAlign', 'overflowWrap', 'wordBreak', 'whiteSpace'];
      const offset = source.selectionDirection === 'backward' ? source.selectionStart : source.selectionEnd;
      const value = source.value, width = source.clientWidth, signature = keys.map(key => css[key]).join('|');
      if (!sourceMeasurement || sourceMeasurement.value !== value || sourceMeasurement.offset !== offset || sourceMeasurement.width !== width || sourceMeasurement.signature !== signature) {
        for (const key of keys) mirror.style[key] = css[key];
        mirror.style.width = `${width}px`; mirror.style.whiteSpace = css.whiteSpace === 'pre' ? 'pre' : 'pre-wrap';
        const marker = document.createElement('span'); marker.textContent = '\u200b';
        mirror.replaceChildren(document.createTextNode(value.slice(0, offset)), marker);
        const measured = marker.getBoundingClientRect(), base = mirror.getBoundingClientRect();
        const height = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2;
        sourceMeasurement = { value, offset, width, signature, height, top: measured.top - base.top - (height - measured.height) / 2 };
      }
      return { top: source.getBoundingClientRect().top + source.clientTop + sourceMeasurement.top - source.scrollTop, height: sourceMeasurement.height };
    }
    function irCaret() {
      const selection = getSelection();
      if (!selection.rangeCount || !ir.contains(selection.focusNode)) return null;
      const point = document.createRange(); point.setStart(selection.focusNode, selection.focusOffset); point.collapse(true);
      let rect = point.getBoundingClientRect();
      if (!rect.height) {
        const block = semantic(selection.focusNode); if (!block) return null;
        const box = block.getBoundingClientRect(), height = parseFloat(getComputedStyle(block).lineHeight) || 24;
        return { top: box.top, height: Math.min(box.height || height, height) };
      }
      return { top: rect.top, height: rect.height };
    }
    function centerCaret() {
      const element = mode() === 'sv' ? source : ir;
      if (document.activeElement !== element && !element.contains(document.activeElement)) return;
      const caret = mode() === 'sv' ? sourceCaret() : irCaret(); if (!caret) return;
      const box = element.getBoundingClientRect(), target = box.top + element.clientTop + element.clientHeight / 2;
      const distance = caret.top + caret.height / 2 - target;
      if (Math.abs(distance) > 1) element.scrollTop += distance;
    }
    function dimIR() {
      const selection = getSelection();
      let block = selection.rangeCount && ir.contains(selection.focusNode) ? semantic(selection.focusNode) : null;
      if (block) lastBlock = block;
      else if (lastBlock?.isConnected && ir.contains(lastBlock)) block = lastBlock;
      const ranges = [], walker = document.createTreeWalker(ir, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.length && !node.parentElement.closest(ignored) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
      let code = null, lineStart = 0, lineEnd = 0;
      if (block?.matches('[data-type="code-block"],[data-type="math-block"],[data-type="yaml-front-matter"]') && selection.rangeCount && block.contains(selection.focusNode)) {
        code = (selection.focusNode.nodeType === 1 ? selection.focusNode : selection.focusNode.parentElement).closest('pre');
        if (code === ir || !code || !block.contains(code)) code = null;
        if (code) {
          const prefix = document.createRange(); prefix.selectNodeContents(code); prefix.setEnd(selection.focusNode, selection.focusOffset);
          const offset = prefix.toString().length, value = code.textContent;
          lineStart = offset ? value.lastIndexOf('\n', offset - 1) + 1 : 0;
          lineEnd = value.indexOf('\n', offset); if (lineEnd < 0) lineEnd = value.length;
        }
      }
      let codeOffset = 0, node;
      const add = (text, start, end) => { if (end <= start) return; const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end); ranges.push(range); };
      while ((node = walker.nextNode())) {
        if (code?.contains(node)) {
          add(node, 0, Math.min(node.length, Math.max(0, lineStart - codeOffset)));
          add(node, Math.max(0, lineEnd - codeOffset), node.length); codeOffset += node.length;
        } else if (!block || semantic(node) !== block || code) add(node, 0, node.length);
      }
      if (global.CSS?.highlights && global.Highlight) CSS.highlights.set(highlightName, new Highlight(...ranges));
      const rules = [];
      ir.querySelectorAll('img,svg,video,canvas,iframe,input[type="checkbox"]').forEach(element => {
        if (semantic(element) !== block) rules.push(`.moye-focus-view .vditor-ir .vditor-reset>${path(element)}{opacity:.35!important}`);
      });
      ir.querySelectorAll('li').forEach(element => {
        if (element !== block && !element.contains(block)) rules.push(`.moye-focus-view .vditor-ir .vditor-reset>${path(element)}::marker{color:var(--blur-text-color,color-mix(in srgb,var(--ink) 35%,var(--paper)))!important}`);
      });
      sheet.textContent = rules.join('\n');
    }
    function dimSource() {
      const rect = source.getBoundingClientRect(), caret = sourceCaret();
      masks.hidden = false;
      Object.assign(masks.style, { left: `${rect.left + source.clientLeft}px`, top: `${rect.top + source.clientTop}px`, width: `${source.clientWidth}px`, height: `${source.clientHeight}px` });
      const top = Math.max(0, Math.min(source.clientHeight, caret.top - rect.top - source.clientTop));
      const bottom = Math.max(0, Math.min(source.clientHeight, caret.top + caret.height - rect.top - source.clientTop));
      masks.children[0].style.height = `${top}px`;
      masks.children[1].style.top = `${bottom}px`;
    }
    function paint() {
      frame = 0; if (destroyed || composing()) return;
      const shouldCenter = pendingCenter; pendingCenter = false;
      const typewriter = isTypewriterEnabled(); host.classList.toggle('moye-typewriter-view', typewriter);
      if (typewriter) {
        const active = mode() === 'sv' ? source : ir;
        const lineHeight = parseFloat(getComputedStyle(active).lineHeight) || 24;
        const padding = Math.max(0, active.clientHeight / 2 - lineHeight / 2);
        layoutSheet.textContent = `#editor.moye-typewriter-view .vditor-ir .vditor-reset,#editor.moye-typewriter-view .vditor-sv{padding-top:${padding}px!important;padding-bottom:${padding}px!important}`;
      } else layoutSheet.textContent = '';
      if (shouldCenter && isTypewriterEnabled()) centerCaret();
      const enabled = isEnabled(); host.classList.toggle('moye-focus-view', enabled);
      if (!enabled || mode() !== 'ir') { global.CSS?.highlights?.delete(highlightName); sheet.textContent = ''; }
      if (!enabled || mode() !== 'sv') masks.hidden = true;
      if (enabled) { if (mode() === 'sv') dimSource(); else dimIR(); }
    }
    function refresh({ typing = false, center = true } = {}) {
      if (destroyed) return;
      pendingCenter ||= center && (typing || alwaysCenter());
      if (!frame && !composing()) frame = requestAnimationFrame(paint);
    }
    listen(document, 'selectionchange', () => refresh());
    for (const element of [ir, source]) {
      listen(element, 'input', event => { if (!event.isComposing) refresh({ typing: true }); });
      listen(element, 'keyup', () => refresh());
      listen(element, 'pointerup', () => refresh());
      listen(element, 'scroll', () => { if (mode() === 'sv') refresh({ center: false }); }, { passive: true });
      listen(element, 'compositionstart', () => { localComposition = true; });
      listen(element, 'compositionend', () => { localComposition = false; queueMicrotask(() => refresh({ typing: true })); });
    }
    listen(global, 'resize', () => refresh({ center: false }));
    const mutation = new MutationObserver(() => refresh({ center: false })); mutation.observe(ir, { childList: true, characterData: true, subtree: true });
    const resize = new ResizeObserver(() => refresh({ center: false })); resize.observe(ir); resize.observe(source);
    refresh();
    return { refresh, destroy() { destroyed = true; if (frame) cancelAnimationFrame(frame); offs.forEach(off => off()); mutation.disconnect(); resize.disconnect(); global.CSS?.highlights?.delete(highlightName); host.classList.remove('moye-focus-view', 'moye-typewriter-view'); sheet.remove(); layoutSheet.remove(); masks.remove(); mirror.remove(); } };
  }
  global.MoyeFocus = { create, install: create };
})(window);
