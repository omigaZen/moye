/* Reading anchors adjust scrolling only: no editable DOM, selection or undo edits. */
(function (global) {
  'use strict';
  const storageName = 'moye.reading-positions.v1';
  const ignored = 'script,style,.vditor-linenumber__rows,.vditor-linenumber__temp,wbr';
  const maximumEntries = 80;
  const maximumSourceMirror = 256 * 1024;
  function fingerprint(value) {
    let first = 2166136261, second = 5381;
    for (let index = 0; index < value.length; index++) {
      first = Math.imul(first ^ value.charCodeAt(index), 16777619);
      second = Math.imul(second, 33) ^ value.charCodeAt(value.length - index - 1);
    }
    return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
  }
  function install({ editor, isComposing = () => false, getDocumentKey = () => null, isSuspended = () => false, rememberPositions = () => true, storage = global.localStorage }) {
    if (!editor?.vditor?.ir?.element || !editor?.vditor?.sv?.element) throw new TypeError('Reading anchors require the real editor roots.');
    const ir = editor.vditor.ir.element, source = editor.vditor.sv.element;
    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, { position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden', pointerEvents: 'none', height: 'auto', minHeight: '0', overflow: 'visible' });
    document.body.append(mirror);
    const stats = { captures: 0, restores: 0, automaticRestores: 0, skipped: 0, persisted: 0 };
    let destroyed = false, localComposition = false, restoring = false, baseline = null, pending = null;
    let frame = 0, captureFrame = 0, settleTimer = 0, restorePass = 0, intent = 0, epoch = 0;
    let currentKey = keyFor(getDocumentKey()), lastSignature = '', lastInputAt = -Infinity, ignoreScrollUntil = 0;
    let sourceMirror = null;
    const offs = [], observed = new Set();
    const listen = (target, type, callback, options) => { target.addEventListener(type, callback, options); offs.push(() => target.removeEventListener(type, callback, options)); };
    const composing = () => localComposition || isComposing();
    const mode = () => editor.getCurrentMode();
    const active = () => mode() === 'sv' ? source : ir;
    const now = () => performance.now();
    function keyFor(value) { return typeof value === 'string' && value ? fingerprint(value) : null; }
    function readPositions() {
      try {
        const value = JSON.parse(storage?.getItem(storageName) || '{}');
        if (!value || Array.isArray(value) || typeof value !== 'object') return {};
        return Object.fromEntries(Object.entries(value).filter(([key, item]) => /^[a-z0-9]+-[a-z0-9]+$/.test(key) && item && typeof item === 'object').slice(-maximumEntries));
      } catch (_) { return {}; }
    }
    function valid(bookmark) {
      return bookmark && (bookmark.mode === 'ir' || bookmark.mode === 'sv')
        && Number.isFinite(bookmark.y) && Math.abs(bookmark.y) < 1e8
        && Number.isInteger(bookmark.offset) && bookmark.offset >= 0 && bookmark.offset < 1e9
        && Number.isFinite(bookmark.ratio) && bookmark.ratio >= 0 && bookmark.ratio <= 1
        && (bookmark.mode === 'sv' || Number.isInteger(bookmark.block) && bookmark.block >= 0 && bookmark.block < 1e7 && typeof bookmark.hash === 'string');
    }
    function serializable(bookmark) {
      const result = { mode: bookmark.mode, offset: bookmark.offset, y: bookmark.y, ratio: bookmark.ratio };
      if (bookmark.mode === 'sv' && bookmark.coarse) result.coarse = true;
      if (bookmark.mode === 'ir') { result.block = bookmark.block; result.hash = bookmark.hash; }
      return result;
    }
    function persist(bookmark, key = currentKey) {
      if (!rememberPositions() || !key || !valid(bookmark)) return;
      try {
        const entries = readPositions(), previous = entries[key] || {};
        delete entries[key];
        entries[key] = { ...previous, [bookmark.mode]: serializable(bookmark), updated: Date.now() };
        const ordered = Object.entries(entries).sort((a, b) => (a[1].updated || 0) - (b[1].updated || 0)).slice(-maximumEntries);
        storage?.setItem(storageName, JSON.stringify(Object.fromEntries(ordered))); stats.persisted++;
      } catch (_) { /* Storage failure must never interfere with editing. */ }
    }
    function textNodes(block) {
      const result = [], walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.length && !node.parentElement?.closest(ignored) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
      let node; while ((node = walker.nextNode())) result.push(node);
      return result;
    }
    function hashBlock(block) {
      const text = textNodes(block).filter(node => !node.parentElement.closest('.vditor-ir__preview')).map(node => node.data).join('');
      return fingerprint(`${block.tagName}:${block.getAttribute('data-type') || ''}:${text}`);
    }
    function pointRect(node, offset) {
      if (!node?.isConnected) return null;
      try {
        const range = document.createRange(); range.setStart(node, Math.min(node.length, Math.max(0, offset))); range.collapse(true);
        const rect = range.getClientRects()[0] || range.getBoundingClientRect();
        return rect.height ? rect : null;
      } catch (_) { return null; }
    }
    function pointInBlock(block, top, bottom) {
      const nodes = textNodes(block), bounds = block.getBoundingClientRect();
      const xs = [Math.max(bounds.left + 6, ir.getBoundingClientRect().left + (parseFloat(getComputedStyle(ir).paddingLeft) || 0) + 6), bounds.left + Math.min(bounds.width / 2, 100)];
      const step = Math.max(12, Math.min(32, parseFloat(getComputedStyle(block).lineHeight) || 24));
      for (let y = Math.max(top + 5, bounds.top + 4); y < Math.min(bottom, bounds.bottom); y += step) {
        for (const x of xs) {
          const caret = document.caretPositionFromPoint?.(x, y);
          const range = caret ? null : document.caretRangeFromPoint?.(x, y);
          const node = caret?.offsetNode || range?.startContainer, offset = caret?.offset ?? range?.startOffset;
          if (node?.nodeType !== Node.TEXT_NODE || !block.contains(node) || !nodes.includes(node)) continue;
          const rect = pointRect(node, offset);
          if (rect && rect.bottom > top && rect.top < bottom) return { nodes, node, offset, rect };
        }
      }
      // A long paragraph may begin far above the viewport. Binary-search its
      // text range rather than anchoring the paragraph's offscreen top edge.
      for (const node of nodes) {
        const range = document.createRange(); range.selectNodeContents(node);
        if (![...range.getClientRects()].some(rect => rect.height && rect.bottom > top && rect.top < bottom)) continue;
        let low = 0, high = node.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2), rect = pointRect(node, middle);
          if (!rect || rect.bottom <= top + 2) low = middle + 1; else high = middle;
        }
        const rect = pointRect(node, low);
        if (rect) return { nodes, node, offset: low, rect };
      }
      return null;
    }
    function sourceLayout() {
      if (source.value.length > maximumSourceMirror) return null;
      const css = getComputedStyle(source);
      const keys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent', 'textTransform', 'direction', 'textAlign', 'overflowWrap', 'wordBreak'];
      const signature = [source.clientWidth, ...keys.map(key => css[key]), css.whiteSpace].join('|');
      if (!sourceMirror || sourceMirror.signature !== signature || sourceMirror.value !== source.value) {
        for (const key of keys) mirror.style[key] = css[key];
        mirror.style.boxSizing = 'border-box'; mirror.style.width = `${source.clientWidth}px`;
        mirror.style.whiteSpace = source.wrap === 'off' || css.whiteSpace === 'pre' ? 'pre' : 'pre-wrap';
        const text = document.createTextNode(source.value || '\u200b'); mirror.replaceChildren(text);
        sourceMirror = { signature, value: source.value, text };
      }
      return sourceMirror;
    }
    function sourceTop(offset) {
      const layout = sourceLayout(); if (!layout) return 0;
      const rect = pointRect(layout.text, Math.min(offset, layout.text.length));
      return rect ? rect.top - mirror.getBoundingClientRect().top : 0;
    }
    function capture() {
      if (destroyed || composing() || isSuspended() || !['ir', 'sv'].includes(mode())) return null;
      const element = active();
      if (!element.clientHeight || !element.clientWidth) return null;
      const ratio = Math.max(0, Math.min(1, element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight)));
      let bookmark;
      if (mode() === 'sv' && source.value.length > maximumSourceMirror) {
        // The textarea owns the full text. A source anchor must not shape a
        // second multi-megabyte copy merely to estimate one offscreen line.
        bookmark = { mode: 'sv', offset: source.selectionStart, y: 0, ratio, coarse: true };
      } else if (mode() === 'sv') {
        const layout = sourceLayout(), css = getComputedStyle(source), lineHeight = parseFloat(css.lineHeight) || 26;
        const target = source.scrollTop - lineHeight * 0.1;
        let low = 0, high = source.value.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (sourceTop(middle) < target) low = middle + 1; else high = middle;
        }
        bookmark = { mode: 'sv', offset: Math.min(low, layout.value.length), y: sourceTop(low) - source.scrollTop, ratio };
      } else {
        const bounds = ir.getBoundingClientRect(), top = bounds.top + ir.clientTop, bottom = top + ir.clientHeight;
        const children = [...ir.children].filter(child => !child.matches(ignored));
        const block = children.find(child => { const box = child.getBoundingClientRect(); return box.height > 0 && box.bottom > top + 3 && box.top < bottom; });
        if (!block) return null;
        const point = pointInBlock(block, top, bottom);
        let offset = 0;
        if (point) for (const node of point.nodes) { if (node === point.node) { offset += point.offset; break; } offset += node.length; }
        bookmark = { mode: 'ir', block: children.indexOf(block), hash: hashBlock(block), offset, y: (point?.rect.top ?? block.getBoundingClientRect().top) - top, ratio, elementAnchor: !point };
        Object.defineProperty(bookmark, '_node', { value: block });
      }
      Object.defineProperties(bookmark, { _intent: { value: intent }, _epoch: { value: epoch }, _key: { value: currentKey } });
      stats.captures++; return bookmark;
    }
    function signature() {
      const element = active(), css = getComputedStyle(element);
      return `${mode()}|${element.clientWidth}|${element.clientHeight}|${element.scrollHeight}|${css.font}|${css.lineHeight}|${css.padding}`;
    }
    function restore(bookmark, { force = false, automatic = false } = {}) {
      if (destroyed || composing() || isSuspended() || !valid(bookmark) || bookmark.mode !== mode()
        || !force && (bookmark._intent !== undefined && bookmark._intent !== intent || bookmark._epoch !== undefined && bookmark._epoch !== epoch || bookmark._key !== undefined && bookmark._key !== currentKey)) { stats.skipped++; return false; }
      const element = active(); let target;
      if (bookmark.mode === 'sv' && (bookmark.coarse || source.value.length > maximumSourceMirror)) target = bookmark.ratio * Math.max(0, element.scrollHeight - element.clientHeight);
      else if (bookmark.mode === 'sv') target = sourceTop(Math.min(source.value.length, bookmark.offset)) - bookmark.y;
      else {
        const children = [...ir.children].filter(child => !child.matches(ignored));
        let block = bookmark._node?.isConnected && bookmark._node.parentElement === ir ? bookmark._node : children[bookmark.block];
        if (!block || hashBlock(block) !== bookmark.hash) {
          const matches = children.map((node, index) => ({ node, index })).filter(item => hashBlock(item.node) === bookmark.hash);
          block = matches.sort((a, b) => Math.abs(a.index - bookmark.block) - Math.abs(b.index - bookmark.block))[0]?.node || block;
        }
        if (!block) target = bookmark.ratio * Math.max(0, element.scrollHeight - element.clientHeight);
        else {
          let remaining = bookmark.offset, point = null;
          if (!bookmark.elementAnchor) for (const node of textNodes(block)) { if (remaining <= node.length) { point = pointRect(node, remaining); break; } remaining -= node.length; }
          const top = point?.top ?? block.getBoundingClientRect().top;
          target = element.scrollTop + top - (element.getBoundingClientRect().top + element.clientTop) - bookmark.y;
        }
      }
      if (!Number.isFinite(target)) { stats.skipped++; return false; }
      restoring = true;
      ignoreScrollUntil = now() + 80;
      element.scrollTop = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight));
      queueMicrotask(() => { restoring = false; });
      lastSignature = signature(); stats.restores++; if (automatic) stats.automaticRestores++;
      return true;
    }
    function cancelPending() {
      pending = null; restorePass = 0;
      if (frame) cancelAnimationFrame(frame); frame = 0;
    }
    function updateBaseline() {
      if (destroyed || pending || composing() || isSuspended()) return;
      observeMedia(); baseline = capture(); lastSignature = signature();
    }
    function scheduleCapture(delay = 0) {
      clearTimeout(settleTimer);
      if (delay && captureFrame) { cancelAnimationFrame(captureFrame); captureFrame = 0; }
      const run = () => { if (!captureFrame) captureFrame = requestAnimationFrame(() => { captureFrame = 0; updateBaseline(); }); };
      if (delay) settleTimer = setTimeout(run, delay); else run();
    }
    function restoreFrame() {
      frame = 0; if (!pending || destroyed) return;
      if (composing()) return;
      const book = pending;
      if (!restore(book, { automatic: true })) { cancelPending(); scheduleCapture(); return; }
      if (++restorePass < 2) frame = requestAnimationFrame(restoreFrame);
      // Keep the same text offset across successive passive reflows. Choosing
      // a new line's first glyph after every resize accumulates line-height
      // drift when a window is made narrow and wide again.
      else { pending = null; restorePass = 0; baseline = book; lastSignature = signature(); }
    }
    function afterLayout(bookmark = baseline) {
      if (!bookmark || destroyed || isSuspended() || now() - lastInputAt < 180 && !pending) return;
      if (!pending) { pending = bookmark; restorePass = 0; }
      if (!frame && !composing()) frame = requestAnimationFrame(restoreFrame);
    }
    function beforeLayout() {
      if (isSuspended() || composing()) return null;
      const bookmark = capture();
      if (bookmark) { baseline = bookmark; pending = bookmark; restorePass = 0; }
      return bookmark;
    }
    function preserve(callback) {
      const bookmark = beforeLayout(); let result;
      try { result = callback(); } catch (error) { afterLayout(bookmark); throw error; }
      if (result?.then) return Promise.resolve(result).finally(() => afterLayout(bookmark));
      afterLayout(bookmark); return result;
    }
    function remember() {
      const bookmark = capture() || baseline;
      if (bookmark) { baseline = bookmark; persist(bookmark); }
      return bookmark;
    }
    function documentChanged(value = getDocumentKey(), { restorePosition = true } = {}) {
      cancelPending(); epoch++; currentKey = keyFor(value); baseline = null; sourceMirror = null; lastInputAt = -Infinity;
      const stored = rememberPositions() && currentKey && readPositions()[currentKey]?.[mode()];
      if (restorePosition && valid(stored)) {
        const bookmark = { ...stored };
        Object.defineProperties(bookmark, { _intent: { value: intent }, _epoch: { value: epoch }, _key: { value: currentKey } });
        afterLayout(bookmark);
      } else scheduleCapture();
    }
    function forget(value = getDocumentKey()) {
      const key = keyFor(value); if (!key) return;
      try { const entries = readPositions(); delete entries[key]; storage?.setItem(storageName, JSON.stringify(entries)); } catch (_) {}
    }
    function userIntent(event) {
      if (restoring || event?.isComposing || composing()) return;
      intent++; ignoreScrollUntil = 0; cancelPending();
      if (event?.type === 'beforeinput' || event?.type === 'input') {
        lastInputAt = now(); baseline = null; scheduleCapture(300);
      } else scheduleCapture();
    }
    for (const element of [ir, source]) {
      listen(element, 'beforeinput', userIntent, true); listen(element, 'input', userIntent, true);
      listen(element, 'wheel', userIntent, { passive: true }); listen(element, 'touchstart', userIntent, { passive: true });
      listen(element, 'pointerdown', userIntent, true);
      listen(element, 'keydown', event => { if (!event.isComposing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Enter', 'Tab', 'Backspace', 'Delete'].includes(event.key)) userIntent(event); }, true);
      listen(element, 'scroll', () => { if (!restoring && !pending && now() >= ignoreScrollUntil) scheduleCapture(); }, { passive: true });
      listen(element, 'compositionstart', () => { localComposition = true; intent++; cancelPending(); });
      listen(element, 'compositionend', () => { localComposition = false; baseline = null; lastInputAt = now(); scheduleCapture(300); });
    }
    listen(global, 'resize', () => afterLayout());
    listen(ir, 'load', event => { if (event.target instanceof HTMLImageElement) afterLayout(); }, true);
    listen(document.fonts, 'loadingdone', () => afterLayout());
    listen(global, 'pagehide', () => remember());
    const resize = new ResizeObserver(() => { if (!destroyed && !composing() && !isSuspended() && now() - lastInputAt >= 180 && lastSignature && signature() !== lastSignature) afterLayout(); });
    resize.observe(ir); resize.observe(source);
    function observeMedia() {
      for (const element of observed) if (!element.isConnected || !ir.contains(element)) { resize.unobserve(element); observed.delete(element); }
      ir.querySelectorAll('img,.vditor-ir__preview').forEach(element => { if (!observed.has(element)) { observed.add(element); resize.observe(element); } });
    }
    const mutations = new MutationObserver(records => {
      if (pending || composing() || now() - lastInputAt < 180) return;
      if (records.some(record => record.type === 'childList')) observeMedia();
      if (lastSignature && signature() !== lastSignature) afterLayout();
    });
    mutations.observe(ir, { subtree: true, childList: true }); observeMedia(); scheduleCapture();
    return {
      capture, restore, beforeLayout, afterLayout, preserve, documentChanged, remember, forget, stats,
      destroy() { if (destroyed) return; remember(); destroyed = true; cancelPending(); clearTimeout(settleTimer); if (captureFrame) cancelAnimationFrame(captureFrame); offs.forEach(off => off()); mutations.disconnect(); resize.disconnect(); mirror.remove(); },
    };
  }
  global.MoyeReadingAnchor = Object.freeze({ install });
})(window);
