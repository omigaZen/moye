/* Separate, non-editable reading surface. The live editor is never reparsed or
   disabled by this module, so entering/leaving reading keeps its undo history. */
(function (root) {
  'use strict';
  let serial = 0;
  const diagramLoads = new Map();
  const diagramEngines = Object.freeze({
    flowchart: ['flowchart.js/flowchart.min.js', 'vditorFlowchartScript', 'flowchart'],
    graphviz: ['graphviz/viz.js', 'vditorGraphVizScript', 'Viz'],
    echarts: ['echarts/echarts.min.js', 'vditorEchartsScript', 'echarts'],
    mindmap: ['echarts/echarts.min.js', 'vditorEchartsScript', 'echarts'],
    markmap: ['markmap/markmap.min.js', 'vditorMarkerScript', 'markmap'],
    abc: ['abcjs/abcjs_basic.min.js', 'vditorAbcjsScript', 'ABCJS'],
    wavedrom: ['wavedrom/wavedrom.min.js', 'vditorWavedromScript', 'wavedrom'],
    smiles: ['smiles-drawer/smiles-drawer.min.js', 'moyeSmilesScript', 'SmilesDrawer'],
  });
  function loadDiagram(language, cdn) {
    const [file, id, globalName] = diagramEngines[language];
    if (root[globalName]) return Promise.resolve(root[globalName]);
    if (diagramLoads.has(file)) return diagramLoads.get(file);
    const promise = new Promise((resolve, reject) => {
      if (typeof cdn !== 'string' || !cdn.startsWith('file:')) { reject(new Error('缺少本地图表资源。')); return; }
      let script = document.getElementById(id);
      const loaded = () => { cleanup(); if (root[globalName]) resolve(root[globalName]); else reject(new Error('本地图表组件未就绪。')); };
      const failed = () => { cleanup(); reject(new Error('本地图表组件加载失败。')); };
      const timer = setTimeout(failed, 10000);
      const cleanup = () => { clearTimeout(timer); script?.removeEventListener('load', loaded); script?.removeEventListener('error', failed); };
      if (!script) { script = node('script'); script.id = id; script.src = `${cdn.replace(/\/$/, '')}/dist/js/${file}`; document.head.append(script); }
      script.addEventListener('load', loaded); script.addEventListener('error', failed);
      if (root[globalName]) loaded();
    }).catch(error => { diagramLoads.delete(file); throw error; });
    diagramLoads.set(file, promise); return promise;
  }
  const safeLink = value => /^(?:https?:|mailto:|tel:|file:|#)/i.test(value || '') || !/^[a-z][a-z\d+.-]*:/i.test(value || '');
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function plainText(element) {
    if (element.nodeType === Node.TEXT_NODE) return element.data;
    if (element.nodeType !== Node.ELEMENT_NODE && element.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (element.nodeType === Node.ELEMENT_NODE) {
      if (element.matches('script,style,.moye-reading__controls')) return '';
      if (element.tagName === 'BR') return '\n';
      if (element.tagName === 'IMG') return element.getAttribute('alt') || '';
      if (element.tagName === 'TR') return [...element.children].map(plainText).join('\t') + '\n';
    }
    const value = [...element.childNodes].map(plainText).join('');
    if (element.nodeType === Node.ELEMENT_NODE && element.hasAttribute('data-plain-continuation')) return value;
    if (element.nodeType === Node.ELEMENT_NODE && !element.hasAttribute('data-moye-typeset-line') && /^(?:P|LI|H[1-6]|PRE|BLOCKQUOTE)$/.test(element.tagName)) return value.replace(/\n+$/, '') + '\n';
    return value;
  }
  function sanitize(container, prefix) {
    container.querySelectorAll('script,iframe,object,embed,link,meta,base,form,textarea,select,button,.vditor-copy,wbr,pre>span[style*="position: absolute"]').forEach(element => element.remove());
    container.querySelectorAll('style').forEach(element => { if (!element.closest('.moye-reading-rendered svg') || /(?:@import|expression\s*\(|url\(\s*['"]?(?:https?:|javascript:))/i.test(element.textContent)) element.remove(); });
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name) || ['contenteditable', 'autofocus', 'srcdoc', 'spellcheck', 'tabindex'].includes(attribute.name)) element.removeAttribute(attribute.name);
        if (['href', 'xlink:href'].includes(attribute.name) && !safeLink(attribute.value)) element.removeAttribute(attribute.name);
        if (attribute.name === 'style' && /(?:@import|expression\s*\(|url\(\s*['"]?(?:https?:|javascript:))/i.test(attribute.value)) element.removeAttribute(attribute.name);
      }
      if (element.tagName === 'INPUT') { element.disabled = true; element.tabIndex = -1; }
      if (element.tagName === 'A') element.rel = 'noopener noreferrer';
    }
    // MathJax/SVG IDs must be namespaced together with all their references;
    // keeping duplicate glyph IDs beside the editable surface corrupts formulas.
    const identifiers = new Map(), scopeMaps = new Map(), usedIds = new Set();
    for (const element of container.querySelectorAll('[id]')) {
      const original = element.id;
      let replacement = `${prefix}${original}`, suffix = 1;
      while (usedIds.has(replacement)) replacement = `${prefix}${original}-${suffix++}`;
      usedIds.add(replacement);
      if (!identifiers.has(original)) identifiers.set(original, replacement);
      const scope = element.closest('svg') || container;
      if (!scopeMaps.has(scope)) scopeMaps.set(scope, new Map());
      if (!scopeMaps.get(scope).has(original)) scopeMaps.get(scope).set(original, replacement);
      element.dataset.readingSourceId = original;
      element.id = replacement;
    }
    for (const element of container.querySelectorAll('*')) for (const attribute of [...element.attributes]) {
      const local = scopeMaps.get(element.closest('svg') || container);
      const resolve = id => local?.get(id) || identifiers.get(id);
      let value = attribute.value;
      if (['href', 'xlink:href'].includes(attribute.name) && value.startsWith('#') && resolve(value.slice(1))) value = '#' + resolve(value.slice(1));
      value = value.replace(/url\(#([^\s)]+)\)/g, (match, id) => resolve(id) ? `url(#${resolve(id)})` : match);
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
    for (const style of container.querySelectorAll('style')) {
      let value = style.textContent;
      const mappings = scopeMaps.get(style.closest('svg')) || identifiers;
      for (const [original, replacement] of mappings) value = value.replace(new RegExp('#' + original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\s{.:\\[>+,)]|$)', 'g'), '#' + replacement);
      style.textContent = value;
    }
  }
  function install(options) {
    const editor = options?.editor;
    if (!editor?.vditor?.ir?.element || typeof editor.getValue !== 'function') throw new TypeError('Reading mode needs an initialized editor.');
    const host = editor.vditor.element;
    const identifier = `moye-reading-${++serial}-`;
    const surface = node('section', 'moye-reading');
    surface.hidden = true;
    surface.setAttribute('aria-label', '阅读模式');
    const content = node('article', 'moye-reading-content vditor-reset');
    content.tabIndex = 0; content.setAttribute('role', 'document'); content.setAttribute('aria-label', '只读文档，空格或 PageDown 翻页');
    content.setAttribute('contenteditable', 'false');
    const hotzone = node('div', 'moye-reading__hotzone'); hotzone.setAttribute('aria-hidden', 'true');
    const controls = node('div', 'moye-reading__controls'); controls.setAttribute('role', 'toolbar'); controls.setAttribute('aria-label', '阅读操作');
    const backButton = node('button', '', '↩ 返回'); backButton.type = 'button'; backButton.disabled = true; backButton.dataset.readingAction = 'back';
    const exitButton = node('button', '', '返回书写'); exitButton.type = 'button'; exitButton.dataset.readingAction = 'edit';
    controls.append(backButton, exitButton); surface.append(content, hotzone, controls); host.append(surface);
    const longNavigation = node('nav', 'moye-reading__long-navigation'); longNavigation.hidden = true; longNavigation.setAttribute('aria-label', '长文分段阅读');
    const previousWindow = node('button', '', '上一段'), nextWindow = node('button', '', '下一段'), windowLabel = node('output');
    previousWindow.type = nextWindow.type = 'button'; previousWindow.dataset.readingAction = 'previous-segment'; nextWindow.dataset.readingAction = 'next-segment';
    longNavigation.append(previousWindow, windowLabel, nextWindow); surface.append(longNavigation);
    const nextPrompt = node('aside', 'moye-reading__next-document'); nextPrompt.hidden = true;
    const nextDocumentButton = node('button'), dismissNextPrompt = node('button', '', '不再提示'); nextDocumentButton.type = dismissNextPrompt.type = 'button';
    nextDocumentButton.dataset.readingAction = 'next-document'; dismissNextPrompt.dataset.readingAction = 'dismiss-next-document'; nextPrompt.append(nextDocumentButton, dismissNextPrompt); surface.append(nextPrompt);
    const longStatus = node('span', 'moye-reading__long-status'); longStatus.setAttribute('role', 'status'); longStatus.setAttribute('aria-live', 'polite'); surface.append(longStatus);
    let enabled = false, entering = false, disposed = false, bookmark = null, lastRendered = '', lastPreviewSignature = '', lastFormatSignature = '', currentDocumentKey = null, refreshTimer = null, revealTimer = null;
    let history = [], renderGeneration = 0, stablePosition = null, positionFrame = null, readonlyAnchor = null, inertParts = [], mathReport = null, mathPromise = Promise.resolve(null);
    const getValues = () => options.getValues?.() || {};
    const isComposing = () => options.isComposing?.() === true;
    const stats = { renders: 0, pages: 0, navigations: 0, modeChanges: 0 };
    const plainTextOverrides = new Map();
    let virtualModel = null, currentWindow = 0, wholePlainSelection = false, longPersistTimer = null, nextEntry = null, neighborGeneration = 0, nextDismissed = false, nextOpening = false, lastPromptEnabled = true;
    const longPositions = new Map(), positionStorageName = 'moye.txt-positions.v1';
    const documentKey = () => options.getDocumentKey?.() || options.getDocumentName?.() || 'current';
    const isPlainText = () => plainTextOverrides.get(documentKey()) ?? (getValues()['reading.txtMode'] === 'plain' || getValues()['reading.txtMode'] !== 'markdown' && /\.txt$/i.test(options.getDocumentName?.() || ''));
    function saveEditorSelection() {
      const mode = editor.getCurrentMode(), element = editor.vditor[mode].element;
      const selected = getSelection();
      const range = selected.rangeCount && element.contains(selected.anchorNode) ? selected.getRangeAt(0).cloneRange() : null;
      return { mode, element, range, anchorNode: selected.anchorNode, anchorOffset: selected.anchorOffset, focusNode: selected.focusNode, focusOffset: selected.focusOffset,
        start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, focus: document.activeElement };
    }
    function restoreEditorSelection(saved) {
      if (!saved?.element?.isConnected) return;
      const element = saved.element;
      if (saved.mode === 'sv') element.setSelectionRange(saved.start, saved.end, saved.direction);
      else if (saved.range?.startContainer.isConnected && saved.range.endContainer.isConnected) {
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(saved.range);
        if (saved.anchorNode?.isConnected && saved.focusNode?.isConnected) selection.setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
      }
      const focus = saved.focus?.isConnected && !surface.contains(saved.focus) ? saved.focus : element;
      focus.focus?.({ preventScroll: true }); element.scrollTop = saved.scrollTop; element.scrollLeft = saved.scrollLeft;
    }
    function readingPosition() {
      const bounds = content.getBoundingClientRect(), blocks = [...content.children];
      if (virtualModel && (!bounds.width || !bounds.height)) return stablePosition?.offset !== undefined ? stablePosition : { window: currentWindow, offset: virtualModel.windows[currentWindow].start, delta: 0, scrollTop: 0, index: 0 };
      const first = blocks.findIndex(block => block.getBoundingClientRect().bottom > bounds.top + 2);
      if (virtualModel) {
        const block = blocks[Math.max(0, first)], point = block && visiblePlainPoint(block, bounds);
        return { window: currentWindow, offset: Number(block?.dataset.txtSourceStart ?? virtualModel.windows[currentWindow].start) + (point?.offset || 0), delta: point?.top !== undefined ? point.top - bounds.top : block ? block.getBoundingClientRect().top - bounds.top : 0, scrollTop: content.scrollTop, index: Math.max(0, first) };
      }
      if (first < 0) return { index: 0, delta: 0, scrollTop: content.scrollTop };
      return { index: first, delta: blocks[first].getBoundingClientRect().top - bounds.top, scrollTop: content.scrollTop };
    }
    function restorePosition(position) {
      if (virtualModel && position && Number.isFinite(position.offset)) {
        if (typeof position.context === 'string' && position.context) {
          let expected = position.offset;
          if (typeof position.chapterText === 'string') { const matches = virtualModel.chapters.filter(item => item.text === position.chapterText); const chapter = matches.sort((a,b)=>Math.abs(a.offset-position.offset)-Math.abs(b.offset-position.offset))[0]; if (chapter) expected = chapter.offset + (position.chapterRelative || 0); }
          const start = Math.max(0, expected - 65536), area = virtualModel.raw.slice(start, expected + 65536), matches = []; let from = 0, index;
          while (matches.length < 64 && (index = area.indexOf(position.context, from)) >= 0) { matches.push(start + index + (position.contextOffset || 0)); from = index + 1; }
          const resolved = matches.sort((a,b)=>Math.abs(a-expected)-Math.abs(b-expected))[0]; position = { ...position, offset: resolved ?? Math.min(virtualModel.raw.length, expected) };
        }
        const target = virtualModel.windowForOffset(position.offset);
        if (target !== currentWindow) mountWindow(target);
        const blocks = [...content.querySelectorAll('[data-txt-source-start]')], block = blocks.findLast(item => Number(item.dataset.txtSourceStart) <= position.offset) || blocks[0];
        if (block) { const point = plainPointAt(block, Math.max(0, position.offset - Number(block.dataset.txtSourceStart))); content.scrollTop += (point?.top ?? block.getBoundingClientRect().top) - content.getBoundingClientRect().top - (Number.isFinite(position.delta) ? position.delta : 0); }
        return;
      }
      if (!position) return;
      if (position.semantic && readonlyAnchor?.restore(position.semantic, { force: true })) return;
      const block = content.children[position.index];
      if (block) content.scrollTop += block.getBoundingClientRect().top - content.getBoundingClientRect().top - position.delta;
      else content.scrollTop = position.scrollTop;
    }
    function capturePosition() {
      const position = readingPosition();
      if (!virtualModel) return { ...position, semantic: readonlyAnchor?.capture() || null };
      const start = Math.max(0, position.offset - 32), chapter = virtualModel.chapters.findLast(item => item.offset <= position.offset);
      return { ...position, context: virtualModel.raw.slice(start, position.offset + 64), contextOffset: position.offset - start, chapterText: chapter?.text || '', chapterRelative: chapter ? position.offset - chapter.offset : 0 };
    }
    function plainPointAt(block, offset) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let text, count = 0;
      while ((text = walker.nextNode())) { if (count + text.length >= offset) { const range = document.createRange(); range.setStart(text, Math.min(text.length, offset - count)); range.collapse(true); const rect = range.getBoundingClientRect(); return rect.height ? { top: rect.top, offset } : null; } count += text.length; }
      return null;
    }
    function visiblePlainPoint(block, bounds) {
      const x = Math.max(block.getBoundingClientRect().left + 3, bounds.left + (parseFloat(getComputedStyle(content).paddingLeft) || 0) + 4), y = bounds.top + 8;
      const caret = document.caretPositionFromPoint?.(x, y), range = caret ? null : document.caretRangeFromPoint?.(x, y), text = caret?.offsetNode || range?.startContainer, offset = caret?.offset ?? range?.startOffset;
      if (text && block.contains(text)) { const before = document.createRange(); before.selectNodeContents(block); before.setEnd(text, offset); return plainPointAt(block, before.toString().length); }
      // The first visible line can be blank or under padding. Binary-search a
      // source text point rather than anchoring an offscreen paragraph edge.
      let low = 0, high = block.textContent.length;
      while (low < high) { const mid = Math.floor((low + high) / 2), point = plainPointAt(block, mid); if (!point || point.top < bounds.top) low = mid + 1; else high = mid; }
      return plainPointAt(block, low);
    }
    function applyPlainPreset() {
      const preset = isPlainText() ? getValues()['reading.txtPreset'] : 'inherit';
      surface.dataset.txtPreset = ['book', 'compact'].includes(preset) ? preset : 'inherit';
      content.classList.toggle('moye-txt-book', surface.dataset.txtPreset === 'book'); content.classList.toggle('moye-txt-compact', surface.dataset.txtPreset === 'compact');
    }
    function storedLongPosition(model) {
      if (getValues()['reading.rememberPosition'] === false) return null;
      let saved = longPositions.get(documentKey());
      if (!saved) try { const text = localStorage.getItem(positionStorageName) || '{}'; if (text.length < 131072) saved = JSON.parse(text)[root.MoyeTxtChapters.fingerprint(documentKey())]; } catch (_) { /* Private/disabled storage is optional. */ }
      if (!saved || !Number.isInteger(saved.offset) || saved.offset < 0 || !Number.isFinite(saved.delta) || Math.abs(saved.delta) > 1e7) return null;
      return { ...saved, offset: Math.min(model.raw.length, saved.offset) };
    }
    function rememberLongPosition() {
      if (!virtualModel || !currentDocumentKey || getValues()['reading.rememberPosition'] === false) return;
      const saved = { ...readingPosition(), updated: Date.now(), length: virtualModel.raw.length, signature: virtualModel.signature }; delete saved.scrollTop; delete saved.index;
      longPositions.delete(currentDocumentKey); longPositions.set(currentDocumentKey, saved); if (longPositions.size > 80) longPositions.delete(longPositions.keys().next().value);
      // Only stable file identities persist; untitled document IDs stay local.
      if (!/^(?:[A-Za-z]:[\\/]|\/|file:)/.test(currentDocumentKey)) return;
      try { const text = localStorage.getItem(positionStorageName) || '{}', records = text.length < 131072 ? JSON.parse(text) : {}; const values = records && !Array.isArray(records) && typeof records === 'object' ? records : {}; values[root.MoyeTxtChapters.fingerprint(currentDocumentKey)] = saved; const ordered = Object.entries(values).filter(([key, value]) => /^[a-z0-9]+-[a-z0-9]+$/.test(key) && value && Number.isInteger(value.offset)).sort((a,b) => (a[1].updated || 0) - (b[1].updated || 0)).slice(-80); localStorage.setItem(positionStorageName, JSON.stringify(Object.fromEntries(ordered))); } catch (_) { /* Storage failure never blocks reading. */ }
    }
    function mountWindow(index, { notify = true, extendTo = 0 } = {}) {
      if (!virtualModel) return false;
      cancelAnimationFrame(positionFrame); positionFrame = null;
      currentWindow = Math.max(0, Math.min(virtualModel.windows.length - 1, index));
      const window = virtualModel.windows[currentWindow], fragment = node('div');
      const end = Math.min(virtualModel.raw.length, Math.max(window.end, Math.min(extendTo, window.end + 4096)));
      renderPlain(virtualModel.raw.slice(window.start, end), fragment, { sourceOffset: window.start, model: virtualModel });
      sanitize(fragment, identifier); content.replaceChildren(...fragment.childNodes); content.scrollTop = 0; wholePlainSelection = false;
      content.dataset.readingVirtual = 'true'; surface.classList.toggle('moye-reading--window-continuation', window.continuation);
      previousWindow.disabled = currentWindow === 0; nextWindow.disabled = currentWindow === virtualModel.windows.length - 1;
      windowLabel.textContent = `分段阅读 ${currentWindow + 1} / ${virtualModel.windows.length} · Ctrl/⌘+A 选择整篇`;
      longNavigation.hidden = false; root.MoyeParagraphTypesetter?.apply(content, getValues());
      stats.virtualized = true; stats.windows = virtualModel.windows.length; stats.currentWindow = currentWindow; stats.mountedCharacters = content.textContent.length; stats.mountedElements = content.querySelectorAll('*').length;
      if (notify) { options.onRendered?.(content); stablePosition = readingPosition(); content.dispatchEvent(new CustomEvent('moye-reading-rendered', { bubbles: true, detail: { generation: renderGeneration } })); }
      updateNextPrompt(); return true;
    }
    function moveWindow(direction) {
      if (!enabled || !virtualModel || isComposing()) return false;
      const index = currentWindow + direction; if (index < 0 || index >= virtualModel.windows.length) return false;
      rememberLongPosition(); mountWindow(index); if (direction < 0) content.scrollTop = content.scrollHeight;
      didNavigate(); content.focus({ preventScroll: true }); return true;
    }
    function selectSourceRange(start, end = start) {
      if (!enabled || !isPlainText() || disposed || isComposing() || !Number.isInteger(start) || !Number.isInteger(end)) return false;
      const raw = virtualModel?.raw ?? lastRendered;
      start = Math.max(0, Math.min(raw.length, start)); end = Math.max(start, Math.min(raw.length, end));
      if (virtualModel) mountWindow(virtualModel.windowForOffset(start), { extendTo: end });
      const locate = offset => {
        const blocks = [...content.querySelectorAll('[data-txt-source-start]')], block = blocks.findLast(item => Number(item.dataset.txtSourceStart) <= offset) || blocks[0];
        if (!block) return { node: content, offset: 0 };
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let remaining = Math.max(0, offset - Number(block.dataset.txtSourceStart)), text, last;
        while ((text = walker.nextNode())) { if (remaining <= text.length) return { node: text, offset: remaining }; remaining -= text.length; last = text; }
        return last ? { node: last, offset: last.length } : { node: block, offset: 0 };
      };
      const a = locate(start), b = locate(end), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
      content.focus({ preventScroll: true }); getSelection().removeAllRanges(); getSelection().addRange(range);
      a.node.parentElement?.scrollIntoView({ block: 'center' }); didNavigate(); return true;
    }
    function updateNextPrompt() {
      const lastWindow = !virtualModel || currentWindow === virtualModel.windows.length - 1;
      const atEnd = content.scrollHeight - content.clientHeight - content.scrollTop <= 28;
      nextPrompt.hidden = !(enabled && !nextDismissed && getValues()['reading.nextDocumentPrompt'] !== false && nextEntry && lastWindow && atEnd);
      nextDocumentButton.disabled = nextOpening; nextDocumentButton.textContent = nextEntry ? `下一篇：${nextEntry.name || ''}` : '下一篇';
      surface.classList.toggle('moye-reading--next-visible', !nextPrompt.hidden);
    }
    async function updateNeighbor() {
      const generation = ++neighborGeneration, key = documentKey(); nextEntry = null; updateNextPrompt();
      if (getValues()['reading.nextDocumentPrompt'] === false || typeof options.getNextDocument !== 'function') return;
      try { const entry = await options.getNextDocument(); if (generation === neighborGeneration && key === documentKey() && enabled && entry && typeof entry.id === 'string') nextEntry = entry; } catch (_) { /* A missing workspace is a normal reading state. */ }
      if (generation === neighborGeneration) updateNextPrompt();
    }
    function reuseRenderedBlocks(fragment, { skipMath = false } = {}) {
      // Reuse already-rendered previews instead of running a second numbering
      // pipeline. This also preserves exact SVG fonts and offline diagrams.
      const source = editor.vditor.ir.element;
      const previews = [...source.querySelectorAll('.vditor-ir__preview')];
      const candidates = [...fragment.querySelectorAll('pre > code,.language-math,.language-mermaid,.language-flowchart,.language-graphviz,.language-echarts,.language-mindmap,.language-markmap,.language-abc,.language-wavedrom')];
      const used = new Set();
      for (const target of candidates) {
        const text = target.textContent.trim();
        const language = [...target.classList].find(name => name.startsWith('language-'))?.slice(9) || '';
        if (language === 'math' && skipMath) continue;
        if (Object.hasOwn(diagramEngines, language)) continue;
        const preview = previews.find(item => {
          if (used.has(item)) return false;
          const wrapper = item.closest('[data-type]');
          const sourceCode = wrapper?.querySelector('pre:not(.vditor-ir__preview) code,code')?.textContent?.trim();
          const mathSource = item.getAttribute('data-math') || item.querySelector('[data-math]')?.getAttribute('data-math') || wrapper?.getAttribute('data-math');
          if (language === 'math') return (mathSource?.trim() === text || sourceCode === text) && !!item.querySelector('mjx-container,.katex,svg');
          return sourceCode === text && (!!item.querySelector('svg,canvas') || !!item.querySelector('code'));
        });
        if (!preview) continue;
        used.add(preview);
        const block = target.parentElement?.tagName === 'PRE' || target.tagName === 'DIV';
        const codeBlock = target.parentElement?.tagName === 'PRE' && language !== 'math' && !!preview.querySelector('code');
        const copy = node(codeBlock ? 'pre' : block ? 'div' : 'span', 'moye-reading-rendered');
        for (const child of preview.childNodes) copy.append(child.cloneNode(true));
        const oldCanvases = [...preview.querySelectorAll('canvas')];
        copy.querySelectorAll('canvas').forEach((canvas, index) => { try { const image = node('img'); image.alt = '图表预览'; image.src = oldCanvases[index].toDataURL('image/png'); image.style.cssText = canvas.style.cssText; canvas.replaceWith(image); } catch (_) { canvas.replaceWith(node('code', '', text)); } });
        if (language === 'math') copy.dataset.readingMarkdown = target.parentElement?.tagName === 'PRE' ? '```math\n' + text + '\n```' : (block ? '$$\n' : '$') + text + (block ? '\n$$' : '$');
        if (target.parentElement?.tagName === 'PRE') target.parentElement.replaceWith(copy);
        else target.replaceWith(copy);
      }
    }
    function renderFallbacks(generation, { skipMath = false } = {}) {
      const Vditor = root.Vditor, cdn = editor.vditor.options.cdn;
      if (!Vditor || generation !== renderGeneration) return;
      const hljs = editor.vditor.options.preview.hljs;
      Vditor.highlightRender?.(hljs, content, cdn);
      // Unrendered math remains valid, copyable source. Do not mutate the shared
      // MathJax equation counter merely by opening a second presentation.
      for (const math of content.querySelectorAll('.language-math')) {
        if (skipMath) continue;
        if (math.querySelector('mjx-container,.katex,svg')) continue;
        const fence = math.parentElement?.tagName === 'PRE', block = math.tagName === 'DIV';
        math.classList.add('moye-reading-math-source');
        math.setAttribute('aria-label', '公式源码');
        if (!fence) math.textContent = (block ? '$$\n' : '$') + math.textContent + (block ? '\n$$' : '$');
      }
    }
    async function renderDiagramFallbacks(generation) {
      const report = { rendered: 0, errors: [], skipped: 0 };
      if (getValues()['markdown.diagrams'] === false) return report;
      const checkedJson = text => {
        const parsed = JSON.parse(text); let count = 0;
        const validate = (value, depth = 0) => {
          if (++count > 2500 || depth > 24) throw new Error('图表数据结构过大。');
          if (typeof value === 'string' && /(?:https?:|file:|javascript:|data:|image:\/\/|^\s*\/\/|<\/?[a-z])/i.test(value)) throw new Error('图表含外部资源或 HTML。');
          if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype', 'src', 'href', 'xlink:href'].includes(key) || /^on[a-z]/i.test(key)) throw new Error('不支持的图表属性。'); validate(child, depth + 1); }
        };
        validate(parsed); return parsed;
      };
      const candidates = [...content.querySelectorAll(Object.keys(diagramEngines).map(language => `.language-${language}`).join(','))];
      let accepted = 0;
      for (const code of candidates) {
        const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
        if (!Object.hasOwn(diagramEngines, language) || code.closest('.moye-reading-rendered')) continue;
        const source = code.textContent, original = '```' + language + '\n' + source.replace(/\n$/, '') + '\n```';
        const panel = node('div', 'moye-reading-rendered moye-reading-diagram'); panel.dataset.readingMarkdown = original; panel.dataset.readingDiagram = language;
        const literal = node('pre'); literal.append(node('code', '', source)); panel.append(literal);
        const encodedTree = code.getAttribute('data-code');
        (code.parentElement?.tagName === 'PRE' ? code.parentElement : code).replaceWith(panel);
        const current = () => !disposed && enabled && generation === renderGeneration && panel.isConnected;
        const fallback = error => { literal.hidden = false; panel.replaceChildren(literal); panel.dataset.readingDiagramError = error.message; panel.title = `图表保留源码：${error.message}`; report.errors.push({ language, message: error.message }); };
        if (++accepted > 12 || source.length > 8192 || source.split('\n').length > 240 || (source.match(/(?:->|--|;)/g) || []).length > 160) { report.skipped++; fallback(new Error('图表超过本次只读绘制预算。')); continue; }
        // These local engines accept image URLs and HTML. Keep such inputs as
        // source instead of introducing network/resource loads in a new view.
        if (/(?:https?:|file:|javascript:|data:|image:\/\/|url\s*\(|<\/?[a-z]|!\[)/i.test(source)) { report.skipped++; fallback(new Error('图表含外部资源或 HTML，已保留源码。')); continue; }
        try {
          const engine = await loadDiagram(language, editor.vditor.options.cdn);
          if (!current()) break;
          const drawing = node('div', 'moye-reading-diagram__drawing'); panel.append(drawing); literal.hidden = true;
          const dark = document.documentElement.dataset.theme === 'dark' || document.body.classList.contains('dark');
          if (language === 'flowchart') engine.parse(source).drawSVG(drawing);
          else if (language === 'graphviz') {
            const workerCode = `importScripts(${JSON.stringify(editor.vditor.options.cdn.replace(/\/$/, '') + '/dist/js/graphviz/full.render.js')});`;
            const url = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })), worker = new Worker(url);
            let timer;
            try { const svg = await Promise.race([new engine({ worker }).renderSVGElement(source), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('图表绘制超时。')), 4000); })]); drawing.append(svg); }
            finally { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); }
          } else if (language === 'echarts' || language === 'mindmap') {
            let option;
            if (language === 'echarts') option = checkedJson(source);
            else { const tree = checkedJson(encodedTree ? decodeURIComponent(encodedTree) : editor.vditor.lute.RenderEChartsJSON(source)); option = { series: [{ type: 'tree', data: [tree], initialTreeDepth: -1, label: { position: 'insideRight' }, roam: false }] }; }
            drawing.style.cssText = 'width:100%;height:340px;min-width:240px';
            const chart = engine.init(drawing, dark ? 'dark' : undefined, { renderer: 'svg' });
            try { chart.setOption({ ...option, animation: false }); const svg = drawing.querySelector('svg'); if (!svg) throw new Error('图表未生成可导出的图像。'); const copy = svg.cloneNode(true); chart.dispose(); drawing.replaceChildren(copy); } catch (error) { chart.dispose(); throw error; }
          } else if (language === 'markmap') {
            const transformed = new engine.Transformer().transform(source), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.style.cssText = 'width:100%;height:340px'; drawing.append(svg);
            // Deliberately do not load Transformer feature scripts/styles.
            const map = engine.Markmap.create(svg, { duration: 0, zoom: false, pan: false }, transformed.root); await map.fit();
          } else if (language === 'abc') engine.renderAbc(drawing, source, { responsive: 'resize' });
          else if (language === 'wavedrom') engine.renderWaveElement(++serial, checkedJson(source), drawing, engine.waveSkin, false);
          else if (language === 'smiles') {
            if (source.length > 512) throw new Error('分子结构超过只读绘制预算。');
            const tree = await new Promise((resolve, reject) => engine.parse(source.trim(), resolve, reject));
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); drawing.append(svg); new engine.SvgDrawer({ width: 600, height: 340 }).draw(tree, svg, dark ? 'dark' : 'light', null, false);
          }
          if (!current()) break;
          if (!drawing.querySelector('svg,canvas')) throw new Error('图表未生成图像。');
          sanitize(drawing, `${identifier}diagram-${generation}-${accepted}-`); literal.remove(); panel.dataset.readingDiagramReady = 'true'; report.rendered++; keepPosition();
        } catch (error) { if (current()) fallback(error); }
      }
      return report;
    }
    function keepPosition() {
      if (!enabled || disposed || isComposing()) return;
      if (readonlyAnchor && !virtualModel) { readonlyAnchor.afterLayout(); return; }
      cancelAnimationFrame(positionFrame);
      const saved = stablePosition;
      positionFrame = requestAnimationFrame(() => {
        positionFrame = null;
        if (!enabled || disposed || isComposing()) return;
        if (saved) restorePosition(saved);
        stablePosition = readingPosition();
      });
    }
    function captureReadingSelection() {
      const selection = getSelection();
      if (!selection.rangeCount || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return null;
      const range = selection.getRangeAt(0), prefix = document.createRange(); prefix.selectNodeContents(content); prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length; prefix.setEnd(range.endContainer, range.endOffset);
      return { start, end: prefix.toString().length, backward: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset && !range.collapsed };
    }
    function restoreReadingSelection(saved) {
      if (!saved) return;
      const locate = offset => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); let text, previous, count = 0;
        while ((text = walker.nextNode())) { if (count + text.length >= offset) return { node: text, offset: offset - count }; count += text.length; previous = text; }
        return previous ? { node: previous, offset: previous.length } : { node: content, offset: 0 };
      };
      const a = locate(saved.start), b = locate(saved.end), selection = getSelection();
      selection.setBaseAndExtent(saved.backward ? b.node : a.node, saved.backward ? b.offset : a.offset, saved.backward ? a.node : b.node, saved.backward ? a.offset : b.offset);
    }
    function refresh({ preservePosition = true, displayOnly = false } = {}) {
      if (disposed || !enabled || isComposing()) return false;
      const key = documentKey(), changedDocument = key !== currentDocumentKey;
      if (changedDocument) { if (!entering) { rememberLongPosition(); readonlyAnchor?.remember(); } currentDocumentKey = key; preservePosition = false; history = []; backButton.disabled = true; }
      const formatSignature = JSON.stringify([isPlainText(), getValues()['reading.paragraphRule'], getValues()['reading.chapterDetection']]);
      if (formatSignature !== lastFormatSignature || changedDocument) displayOnly = false;
      content.style.whiteSpace = getValues()['markdown.preserveWhitespace'] === false ? 'normal' : 'pre-wrap';
      surface.classList.toggle('moye-reading--immersive', getValues()['reading.immersive'] === true);
      const promptEnabled = getValues()['reading.nextDocumentPrompt'] !== false; if (promptEnabled && !lastPromptEnabled) nextDismissed = false; lastPromptEnabled = promptEnabled;
      applyPlainPreset(); updateNextPrompt();
      if (displayOnly) {
        const selected = captureReadingSelection();
        root.MoyeParagraphTypesetter?.apply(content, getValues());
        restoreReadingSelection(selected); keepPosition(); if (!nextEntry) updateNeighbor(); return true;
      }
      const position = preservePosition ? stablePosition || readingPosition() : null;
      const semanticAnchor = preservePosition && !virtualModel ? readonlyAnchor?.beforeLayout() : null;
      const selected = preservePosition ? captureReadingSelection() : null;
      const raw = options.getSource?.() ?? editor.getValue();
      const fragment = document.createElement('div');
      const plain = isPlainText(); surface.classList.toggle('moye-reading--plaintext', plain);
      const shouldVirtualize = plain && raw.length >= 262144 && !!root.MoyeTxtChapters;
      if (shouldVirtualize) {
        if (!virtualModel || virtualModel.raw !== raw || changedDocument || formatSignature !== lastFormatSignature) virtualModel = root.MoyeTxtChapters.build(raw, { chapterDetection: getValues()['reading.chapterDetection'] !== false });
        const saved = position?.offset !== undefined ? position : storedLongPosition(virtualModel);
        mountWindow(saved ? virtualModel.windowForOffset(saved.offset) : 0, { notify: false });
        if (saved) restorePosition(saved);
      } else { virtualModel = null; longNavigation.hidden = true; delete content.dataset.readingVirtual; surface.classList.remove('moye-reading--window-continuation'); stats.virtualized = false; }
      const prepared = !plain && root.MoyeMathReadingSyntax ? root.MoyeMathReadingSyntax.prepare(raw, getValues()) : null;
      // Reading owns a separate math document, including ordinary dollar/fence
      // formulas. Exports can then await all formulas even if the live editor's
      // asynchronous preview has not finished, without advancing its counter.
      const independentMath = !plain && typeof root.MoyeMathReadingSyntax?.render === 'function';
      if (plain && !virtualModel) renderPlain(raw, fragment);
      else if (!plain) {
        fragment.innerHTML = editor.vditor.lute.Md2HTML(prepared?.markdown ?? raw);
        if (prepared) root.MoyeMathReadingSyntax.decorate(fragment, prepared);
        reuseRenderedBlocks(fragment, { skipMath: independentMath });
      }
      const headings = [...fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      const originalHeadings = [...editor.vditor.ir.element.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      headings.forEach((heading, index) => { if (!heading.id) heading.id = originalHeadings[index]?.id || heading.textContent.trim().toLowerCase().replace(/\s+/g, '-') || `heading-${index}`; });
      sanitize(fragment, identifier);
      if (!virtualModel) content.replaceChildren(...fragment.childNodes);
      stats.renders++; renderGeneration++; lastRendered = raw; lastPreviewSignature = previewSignature(); lastFormatSignature = formatSignature;
      if (!plain) renderFallbacks(renderGeneration, { skipMath: independentMath });
      options.onRendered?.(content);
      root.MoyeParagraphTypesetter?.apply(content, getValues());
      restoreReadingSelection(selected);
      root.moye?.contentExperience?.refresh(content);
      if (independentMath) {
        const generation = renderGeneration;
        mathPromise = Promise.resolve(root.MoyeMathReadingSyntax.render(content, getValues(), {
          cdn: editor.vditor.options.cdn, math: editor.vditor.options.preview.math,
          isCurrent: () => !disposed && enabled && generation === renderGeneration,
          onRendered: () => keepPosition(),
        })).then(report => { if (generation === renderGeneration) mathReport = report; return report; }).catch(error => { if (generation === renderGeneration) mathReport = { pass: false, error: error.message }; return mathReport; });
      } else { mathReport = null; mathPromise = Promise.resolve(null); }
      if (!plain) mathPromise = Promise.all([mathPromise, renderDiagramFallbacks(renderGeneration)]).then(([report]) => report);
      if (position) restorePosition(position);
      stablePosition = readingPosition();
      if (changedDocument && !virtualModel) readonlyAnchor?.documentChanged(`reader:${key}`);
      else if (semanticAnchor && !virtualModel) readonlyAnchor?.afterLayout(semanticAnchor);
      updateNeighbor();
      content.dispatchEvent(new CustomEvent('moye-reading-rendered', { bubbles: true, detail: { generation: renderGeneration } }));
      return true;
    }
    function renderPlain(raw, fragment, { sourceOffset = 0, model = null } = {}) {
      const detect = getValues()['reading.chapterDetection'] !== false;
      const chapter = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节回卷部篇集](?:[\s　:：.、-].*)?|Chapter\s+(?:[IVXLCDM]+|\d+)(?:\b.*)?|序章|楔子|尾声|后记|前言|序言)$/i;
      const paragraphRule = getValues()['reading.paragraphRule'] || 'lines';
      let pendingStart = null, pendingEnd = 0, localChapter = 0;
      const appendParagraph = (text, sourceStart) => {
        // Chunk pathological single-line inputs without changing their text.
        // content-visibility then lays out only nearby chunks in large TXT files.
        for (let start = 0; start < text.length || start === 0;) {
          let end = Math.min(text.length, start + 8192);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
          if (root.MoyeTxtChapters && end < text.length) end = root.MoyeTxtChapters.boundary(text, end);
          const p = node('p', 'moye-reading-plain-paragraph', text.slice(start, end));
          p.dataset.txtSourceStart = String(sourceOffset + sourceStart + start); p.dataset.txtSourceEnd = String(sourceOffset + sourceStart + end);
          if (end < text.length) p.setAttribute('data-plain-continuation', 'true');
          fragment.append(p);
          if (!text.length) break;
          start = end;
        }
      };
      const flush = () => { if (pendingStart !== null) { appendParagraph(raw.slice(pendingStart, pendingEnd), pendingStart); pendingStart = null; } };
      for (let lineStart = 0; lineStart <= raw.length;) {
        const newline = raw.indexOf('\n', lineStart), end = newline < 0 ? raw.length : newline;
        const line = raw.slice(lineStart, raw[end - 1] === '\r' ? end - 1 : end);
        const title = line.trim();
        if (detect && title.length <= 120 && chapter.test(title)) { flush(); const heading = node('h2', 'moye-reading-plain-chapter', line); heading.id = `chapter-${model?.chapterOffsets.get(sourceOffset + lineStart) ?? localChapter++}`; heading.dataset.txtSourceStart = String(sourceOffset + lineStart); heading.dataset.txtSourceEnd = String(sourceOffset + lineStart + line.length); fragment.append(heading); }
        else if (!title) { flush(); if (paragraphRule === 'lines') appendParagraph('', lineStart); }
        else if (paragraphRule === 'blankLines') { if (pendingStart === null) pendingStart = lineStart; pendingEnd = lineStart + line.length; }
        else appendParagraph(line, lineStart);
        if (newline < 0) break; lineStart = newline + 1;
      }
      flush();
    }
    function previewSignature() {
      const ir = editor.vditor.ir.element;
      // Only diagrams still reuse the live preview. Independent reading math
      // and code workers must not rebuild this document when IR finishes later.
      return String([...ir.querySelectorAll('.vditor-ir__preview svg,.vditor-ir__preview canvas')].filter(media => !media.closest('mjx-container,.katex')).length);
    }
    async function whenReady() {
      // Diagram/code readiness may rebuild the snapshot during a math render.
      // An exporter awaiting the older promise must also await its replacement.
      let pending, report;
      do {
        pending = mathPromise; report = await pending;
        await root.moye?.contentExperience?.whenReady?.();
      } while (!disposed && enabled && pending !== mathPromise);
      return report;
    }
    async function getExportRoot({ maxCharacters = 2000000 } = {}) {
      await whenReady();
      if (!virtualModel) return content;
      const maximum = Number.isInteger(maxCharacters) ? Math.max(1, Math.min(2000000, maxCharacters)) : 2000000;
      if (virtualModel.raw.length > maximum) throw new Error('长篇纯文本超出整篇导出限额，请按章节分段导出。不会只导出当前阅读分段。');
      let estimatedBlocks = virtualModel.chapters.length + Math.ceil(virtualModel.raw.length / 8192);
      const boundaries = getValues()['reading.paragraphRule'] === 'lines' ? /\n/g : /\n[ \t\r]*\n/g;
      while (boundaries.exec(virtualModel.raw)) { if (++estimatedBlocks > 20000) throw new Error('整篇导出的段落过多，请按章节分段导出。不会只导出当前阅读分段。'); }
      const result = content.cloneNode(false); result.removeAttribute('id'); result.removeAttribute('data-reading-virtual'); result.dataset.readingComplete = 'true';
      renderPlain(virtualModel.raw, result, { model: virtualModel }); sanitize(result, `${identifier}export-`);
      return result;
    }
    function setEnabled(value) {
      const next = value === true;
      if (disposed || enabled === next) return enabled;
      if (isComposing()) return enabled;
      if (!next) { rememberLongPosition(); readonlyAnchor?.remember(); neighborGeneration++; }
      enabled = next; stats.modeChanges++;
      if (enabled) {
        entering = true;
        bookmark = saveEditorSelection(); history = []; backButton.disabled = true;
        inertParts = [...host.children].filter(element => element !== surface).map(element => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
        for (const part of inertParts) { part.element.inert = true; part.element.setAttribute('aria-hidden', 'true'); }
        surface.hidden = false; host.classList.add('moye-reading-active'); document.body.classList.add('reading-mode');
        refresh({ preservePosition: false }); if (!virtualModel) content.scrollTop = bookmark.scrollTop;
        stablePosition = readingPosition();
        if (!virtualModel) readonlyAnchor?.documentChanged(`reader:${documentKey()}`);
        content.focus({ preventScroll: true });
        entering = false;
      } else {
        surface.hidden = true; host.classList.remove('moye-reading-active'); document.body.classList.remove('reading-mode');
        for (const part of inertParts) if (part.element.isConnected) { part.element.inert = part.inert; if (part.ariaHidden === null) part.element.removeAttribute('aria-hidden'); else part.element.setAttribute('aria-hidden', part.ariaHidden); }
        inertParts = [];
        restoreEditorSelection(bookmark); bookmark = null;
      }
      updateNextPrompt(); options.onModeChange?.(enabled);
      surface.dispatchEvent(new CustomEvent('moye-reading-mode', { bubbles: true, detail: { enabled } }));
      return enabled;
    }
    function navigateTo(target, { remember = true } = {}) {
      if (!enabled || disposed || isComposing()) return false;
      if (virtualModel) {
        const id = typeof target === 'string' ? target.replace(/^#/, '').replace(identifier, '') : target?.id?.replace(identifier, '');
        const chapter = typeof target === 'number' ? virtualModel.chapters[target] : virtualModel.chapters.find(item => item.id === id);
        if (chapter) { if (remember) { history.push(readingPosition()); if (history.length > 40) history.shift(); backButton.disabled = false; } mountWindow(virtualModel.windowForOffset(chapter.offset)); const element = content.querySelector(`#${CSS.escape(identifier + chapter.id)}`); if (element) content.scrollTop += element.getBoundingClientRect().top - content.getBoundingClientRect().top - 24; didNavigate(); content.focus({ preventScroll: true }); stats.navigations++; return true; }
      }
      let element = target;
      if (typeof target === 'number') element = content.querySelectorAll('h1,h2,h3,h4,h5,h6')[target];
      else if (typeof target === 'string') {
        let id = target.replace(/^#/, ''); try { id = decodeURIComponent(id); } catch (_) { /* literal ID */ }
        element = [...content.querySelectorAll('[id]')].find(item => item.id === id || item.id === identifier + id || item.dataset.readingSourceId === id);
      } else if (target?.id && !content.contains(target)) return navigateTo(target.id, { remember });
      if (!element || !content.contains(element)) return false;
      if (remember) { history.push(readingPosition()); if (history.length > 40) history.shift(); backButton.disabled = false; }
      content.scrollTop += element.getBoundingClientRect().top - content.getBoundingClientRect().top - 24;
      didNavigate();
      content.focus({ preventScroll: true }); stats.navigations++;
      return true;
    }
    function back() {
      if (!enabled || !history.length) return false;
      restorePosition(history.pop()); didNavigate(); backButton.disabled = history.length === 0; content.focus({ preventScroll: true }); return true;
    }
    function didNavigate() {
      stablePosition = readingPosition();
      if (virtualModel) rememberLongPosition(); else readonlyAnchor?.documentChanged(`reader:${documentKey()}`, { restorePosition: false }); updateNextPrompt();
    }
    function lineStarts() {
      const bounds = content.getBoundingClientRect(), points = new Set([0]);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, { acceptNode: text => {
        if (!text.data.trim() || text.parentElement.closest('svg,mjx-container,script,style,.vditor-copy')) return NodeFilter.FILTER_REJECT;
        const paragraph = text.parentElement.closest('.moye-reading-plain-paragraph');
        if (paragraph) { const rect = paragraph.getBoundingClientRect(); if (rect.bottom < bounds.top - content.clientHeight || rect.top > bounds.bottom + content.clientHeight) return NodeFilter.FILTER_REJECT; }
        return NodeFilter.FILTER_ACCEPT;
      } });
      let text;
      // Range client rects give actual visual lines, including wrapped CJK,
      // headings and table cells. No guessed average line height is needed.
      while ((text = walker.nextNode())) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rect of range.getClientRects()) if (rect.height > 0) points.add(Math.max(0, Math.round((rect.top - bounds.top + content.scrollTop) * 4) / 4));
      }
      for (const media of content.querySelectorAll('img,svg,pre,table')) points.add(Math.max(0, Math.round((media.getBoundingClientRect().top - bounds.top + content.scrollTop) * 4) / 4));
      return [...points].sort((a, b) => a - b);
    }
    function page(direction) {
      if (!enabled || disposed || isComposing()) return false;
      if (virtualModel && (direction > 0 && content.scrollTop >= content.scrollHeight - content.clientHeight - 2 || direction < 0 && content.scrollTop <= 2)) { if (moveWindow(direction)) { stats.pages++; return true; } }
      const points = lineStarts(), current = content.scrollTop, height = content.clientHeight;
      const visible = points.filter(point => point >= current - 1 && point < current + height - 1);
      const overlap = direction > 0 ? visible[Math.max(0, visible.length - 2)] : visible[1];
      let destination;
      if (direction > 0) {
        const minimum = current + height / 2, desired = overlap ?? current + height;
        destination = points.find(point => point >= Math.max(minimum, desired) - 1) ?? current + height;
      } else {
        const desired = (overlap ?? current) - height;
        destination = [...points].reverse().find(point => point <= Math.min(current - height / 2, desired) + 1) ?? 0;
      }
      destination = Math.max(0, Math.min(content.scrollHeight - height, destination));
      content.scrollTo({ top: destination, behavior: 'instant' }); stats.pages++;
      didNavigate();
      return Math.abs(content.scrollTop - current) > 0.5;
    }
    function selectAll() {
      if (!enabled || disposed) return false;
      if (virtualModel) { wholePlainSelection = true; longStatus.textContent = `已选择整篇，共 ${virtualModel.codePoints} 个字符，复制将包含所有分段。`; }
      const range = document.createRange(); range.selectNodeContents(content);
      getSelection().removeAllRanges(); getSelection().addRange(range); return true;
    }
    function clampDocumentSelection() {
      if (!enabled || disposed || isComposing() || document.activeElement !== content) return;
      const selection = getSelection();
      if (virtualModel && wholePlainSelection && selection.rangeCount) { const range = selection.getRangeAt(0); if (!(range.startContainer === content && range.startOffset === 0 && range.endContainer === content && range.endOffset === content.childNodes.length)) wholePlainSelection = false; }
      if (!selection.rangeCount || content.contains(selection.anchorNode) && content.contains(selection.focusNode)) return;
      const ancestor = selection.getRangeAt(0).commonAncestorContainer;
      // Native menu Select All can select the entire HTML document when the
      // focused rich document is read-only. Constrain it to the reading page.
      if (ancestor === document.body || ancestor === document.documentElement || ancestor === document) selectAll();
    }
    function keydown(event) {
      if (!enabled || event.defaultPrevented || event.isComposing || isComposing()) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') { event.preventDefault(); event.stopPropagation(); selectAll(); return; }
      if (wholePlainSelection && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')) { wholePlainSelection = false; longStatus.textContent = ''; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target !== content && event.target?.closest('input,textarea,select,button,[contenteditable="true"]')) return;
      const direction = event.key === 'PageDown' || event.key === ' ' && !event.shiftKey ? 1 : event.key === 'PageUp' || event.key === ' ' && event.shiftKey ? -1 : 0;
      if (direction) { event.preventDefault(); event.stopPropagation(); page(direction); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEnabled(false); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); if (virtualModel) mountWindow(event.key === 'Home' ? 0 : virtualModel.windows.length - 1); content.scrollTop = event.key === 'Home' ? 0 : content.scrollHeight; didNavigate(); }
    }
    function click(event) {
      if (!enabled) return;
      const image = event.target.closest('img');
      const anchor = event.target.closest('a');
      if (image && (!anchor || event.altKey)) { event.preventDefault(); event.stopPropagation(); (options.onImage || (image => root.MoyeImageViewer.open(image)))(image); return; }
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      const href = anchor.getAttribute('href') || '';
      if (!href.trim()) return;
      if (href.startsWith('#')) navigateTo(href);
      else if (safeLink(href)) options.onOpenLink?.(anchor.href || href);
    }
    function copy(event) {
      clampDocumentSelection();
      const selection = getSelection();
      if (!event.clipboardData || !selection.rangeCount || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return;
      if (virtualModel) {
        let text;
        if (wholePlainSelection) text = virtualModel.raw;
        else {
          const range = selection.getRangeAt(0), offsetAt = (container, offset, end) => {
            const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
            let block = parent.closest('[data-txt-source-start]');
            if (!block && container === content) { const child = content.childNodes[Math.min(content.childNodes.length - 1, offset)]; block = child?.nodeType === Node.ELEMENT_NODE ? child : child?.parentElement; if (end && offset >= content.childNodes.length) return Number(block?.dataset.txtSourceEnd ?? virtualModel.windows[currentWindow].end); }
            if (!block || !content.contains(block)) return virtualModel.windows[currentWindow][end ? 'end' : 'start'];
            if (!block.contains(container)) return Number(block.dataset[end ? 'txtSourceEnd' : 'txtSourceStart']);
            const prefix = document.createRange(); prefix.selectNodeContents(block); prefix.setEnd(container, offset); return Number(block.dataset.txtSourceStart) + prefix.toString().length;
          };
          text = virtualModel.raw.slice(offsetAt(range.startContainer, range.startOffset, false), offsetAt(range.endContainer, range.endOffset, true));
        }
        event.clipboardData.setData('text/plain', text);
        if (text.length <= 2000000) { const pre = node('pre', '', text); event.clipboardData.setData('text/html', pre.outerHTML); }
        event.preventDefault(); event.stopPropagation(); return;
      }
      const fragment = selection.getRangeAt(0).cloneContents();
      const wrapper = node('div'); wrapper.append(fragment);
      root.MoyeParagraphTypesetter?.unwrapCopy(wrapper);
      wrapper.querySelectorAll('[data-reading-markdown]').forEach(math => math.replaceWith(document.createTextNode(math.dataset.readingMarkdown)));
      wrapper.querySelectorAll('[data-moye-typeset-line]').forEach(line => line.replaceWith(...line.childNodes));
      wrapper.querySelectorAll('[id],[data-reading-source-id]').forEach(element => { element.removeAttribute('id'); element.removeAttribute('data-reading-source-id'); });
      const text = plainText(wrapper).replace(/\n+$/, ''), html = wrapper.innerHTML;
      let markdown;
      try { markdown = editor.html2md(html).trimEnd(); } catch (_) { markdown = text; }
      const payload = { text, html, markdown };
      const override = options.onCopy?.(payload);
      event.clipboardData.setData('text/plain', typeof override === 'string' ? override : getValues()['editor.copyPlainTextAsMarkdown'] ? markdown : text);
      event.clipboardData.setData('text/html', html);
      event.preventDefault(); event.stopPropagation();
    }
    function reveal() { surface.classList.add('moye-reading--controls-visible'); clearTimeout(revealTimer); revealTimer = setTimeout(() => { if (!controls.matches(':focus-within,:hover')) surface.classList.remove('moye-reading--controls-visible'); }, 1600); }
    const preventEdit = event => { event.preventDefault(); event.stopPropagation(); };
    content.addEventListener('keydown', keydown); content.addEventListener('click', click); content.addEventListener('copy', copy);
    document.addEventListener('selectionchange', clampDocumentSelection);
    content.addEventListener('scroll', () => { if (enabled && positionFrame === null) stablePosition = readingPosition(); if (virtualModel) { clearTimeout(longPersistTimer); longPersistTimer = setTimeout(rememberLongPosition, 300); } updateNextPrompt(); });
    content.addEventListener('wheel', () => { cancelAnimationFrame(positionFrame); positionFrame = null; stablePosition = readingPosition(); }, { passive: true });
    content.addEventListener('pointerdown', () => { wholePlainSelection = false; longStatus.textContent = ''; cancelAnimationFrame(positionFrame); positionFrame = null; stablePosition = readingPosition(); });
    content.addEventListener('load', keepPosition, true);
    for (const event of ['beforeinput', 'paste', 'cut', 'drop']) content.addEventListener(event, preventEdit);
    backButton.addEventListener('click', back); exitButton.addEventListener('click', () => setEnabled(false)); hotzone.addEventListener('pointerenter', reveal); controls.addEventListener('pointerenter', reveal);
    previousWindow.addEventListener('click', () => moveWindow(-1)); nextWindow.addEventListener('click', () => moveWindow(1));
    nextDocumentButton.addEventListener('click', async () => { if (!nextEntry || nextOpening || isComposing()) return; nextOpening = true; updateNextPrompt(); try { await options.onOpenNext?.(nextEntry); } catch (error) { options.onNotice?.(error.message); } finally { nextOpening = false; updateNeighbor(); } });
    dismissNextPrompt.addEventListener('click', () => { nextDismissed = true; updateNextPrompt(); try { Promise.resolve(options.onNextPromptDismiss?.()).catch(error => options.onNotice?.(error.message)); } catch (error) { options.onNotice?.(error.message); } content.focus({ preventScroll: true }); });
    const observer = new MutationObserver(() => {
      if (!enabled || disposed) return;
      clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { if ((options.getSource?.() ?? editor.getValue()) !== lastRendered || previewSignature() !== lastPreviewSignature) refresh(); }, 80);
    });
    observer.observe(editor.vditor.ir.element, { childList: true, subtree: true, characterData: true });
    const sizeObserver = new ResizeObserver(keepPosition); sizeObserver.observe(content);
    const fontsChanged = () => refresh({ displayOnly: true }); document.fonts?.addEventListener('loadingdone', fontsChanged);
    if (root.MoyeReadingAnchor) readonlyAnchor = root.MoyeReadingAnchor.install({
      editor: { vditor: { ir: { element: content }, sv: { element: editor.vditor.sv.element } }, getCurrentMode: () => 'ir' },
      isComposing, isSuspended: () => !enabled || disposed || !!virtualModel,
      getDocumentKey: () => `reader:${documentKey()}`,
      rememberPositions: () => getValues()['reading.rememberPosition'] !== false && !virtualModel,
    });
    return Object.freeze({ setEnabled, toggle: () => setEnabled(!enabled), isEnabled: () => enabled, refresh, navigateTo, back, page, selectAll, selectSourceRange, getRoot: () => content, getExportRoot, getSurface: () => surface, whenReady, getMathReport: () => mathReport, stats,
      isPlainText, setPlainText(value = null) { const key = documentKey(); if (value === null) plainTextOverrides.delete(key); else { plainTextOverrides.set(key, value === true); if (plainTextOverrides.size > 100) plainTextOverrides.delete(plainTextOverrides.keys().next().value); } if (enabled) refresh({ preservePosition: false }); },
      getOutline() { if (virtualModel) return virtualModel.chapters.map(item => ({ ...item, id: identifier + item.id })); return [...content.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, index) => ({ index, level: Number(heading.tagName.slice(1)), text: heading.textContent.trim(), id: heading.id })); },
      getVirtualState() { return { virtualized: !!virtualModel, windows: virtualModel?.windows.length || 1, currentWindow, sourceLength: virtualModel?.raw.length || lastRendered.length, mountedCharacters: content.textContent.length, mountedElements: content.querySelectorAll('*').length }; },
      capturePosition, restorePosition(position) { restorePosition(position); stablePosition = readingPosition(); },
      destroy() { if (disposed) return; if (enabled) setEnabled(false); readonlyAnchor?.destroy(); disposed = true; neighborGeneration++; observer.disconnect(); sizeObserver.disconnect(); document.removeEventListener('selectionchange', clampDocumentSelection); document.fonts?.removeEventListener('loadingdone', fontsChanged); cancelAnimationFrame(positionFrame); clearTimeout(refreshTimer); clearTimeout(revealTimer); clearTimeout(longPersistTimer); surface.remove(); } });
  }

  function openImage(image, options = {}) {
    const src = typeof image === 'string' ? image : image?.currentSrc || image?.src;
    if (typeof src !== 'string' || !/^(?:file:|https?:|data:image\/|blob:)/i.test(src)) throw new TypeError('图片地址无效。');
    const previousFocus = options.returnFocus || document.activeElement;
    const dialog = node('dialog', 'moye-image-viewer'); dialog.setAttribute('aria-label', '图片预览');
    const toolbar = node('div', 'moye-image-viewer__toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '图片缩放');
    const minus = node('button', '', '−'), plus = node('button', '', '+'), fitButton = node('button', '', '适应窗口'), originalButton = node('button', '', '100%'), closeButton = node('button', '', '×'), label = node('output', '', '正在载入…');
    minus.setAttribute('aria-label', '缩小图片'); plus.setAttribute('aria-label', '放大图片'); closeButton.setAttribute('aria-label', '关闭图片预览');
    for (const button of [minus, plus, fitButton, originalButton, closeButton]) button.type = 'button';
    minus.dataset.imageAction = 'out'; plus.dataset.imageAction = 'in'; fitButton.dataset.imageAction = 'fit'; originalButton.dataset.imageAction = 'original'; closeButton.dataset.imageAction = 'close';
    const stage = node('div', 'moye-image-viewer__stage'); stage.tabIndex = 0;
    const picture = node('img'); picture.alt = image?.alt || options.alt || ''; picture.draggable = false;
    const caption = node('p', 'moye-image-viewer__caption', `${picture.alt ? picture.alt + ' · ' : ''}Ctrl/⌘ + 滚轮缩放 · 拖动查看 · Esc 关闭`);
    stage.append(picture); toolbar.append(minus, label, plus, fitButton, originalButton, closeButton); dialog.append(toolbar, stage, caption); document.body.append(dialog);
    let scale = 1, fitMode = true, dragging = null, closed = false;
    const clamp = value => Math.max(0.05, Math.min(8, value));
    function update() {
      const width = Math.max(1, picture.naturalWidth) * scale, height = Math.max(1, picture.naturalHeight) * scale;
      picture.style.width = `${width}px`; picture.style.height = `${height}px`;
      picture.style.marginLeft = `${Math.max(16, (stage.clientWidth - width) / 2)}px`;
      picture.style.marginTop = `${Math.max(16, (stage.clientHeight - height) / 2)}px`;
      label.value = `${Math.round(scale * 100)}%`; label.textContent = label.value;
      fitButton.setAttribute('aria-pressed', String(fitMode)); originalButton.setAttribute('aria-pressed', String(Math.abs(scale - 1) < 0.001));
    }
    function setScale(next, { atX, atY } = {}) {
      if (closed || !Number.isFinite(next)) return scale;
      const before = scale, x = atX ?? stage.clientWidth / 2, y = atY ?? stage.clientHeight / 2;
      fitMode = false; scale = clamp(next); update();
      stage.scrollLeft = (stage.scrollLeft + x) * scale / before - x;
      stage.scrollTop = (stage.scrollTop + y) * scale / before - y;
      return scale;
    }
    function fit() { fitMode = true; scale = Math.min(1, (stage.clientWidth - 32) / Math.max(1, picture.naturalWidth), (stage.clientHeight - 32) / Math.max(1, picture.naturalHeight)); scale = Math.max(0.01, scale); update(); stage.scrollTop = stage.scrollLeft = 0; return scale; }
    function original() { setScale(1); return scale; }
    function close() { if (closed) return; dialog.close(); }
    picture.addEventListener('load', () => fitMode ? fit() : update());
    picture.addEventListener('error', () => { label.textContent = '图片无法载入'; caption.textContent = '请检查图片文件是否仍在原位置。'; });
    minus.addEventListener('click', () => setScale(scale / 1.25)); plus.addEventListener('click', () => setScale(scale * 1.25)); fitButton.addEventListener('click', fit); originalButton.addEventListener('click', original); closeButton.addEventListener('click', close);
    stage.addEventListener('wheel', event => { if (!event.ctrlKey && !event.metaKey && options.wheelZoom !== true) return; event.preventDefault(); const bounds = stage.getBoundingClientRect(); setScale(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { atX: event.clientX - bounds.left, atY: event.clientY - bounds.top }); }, { passive: false });
    stage.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragging = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, pointerId: event.pointerId }; stage.setPointerCapture(event.pointerId); stage.classList.add('is-dragging'); event.preventDefault(); });
    stage.addEventListener('pointermove', event => { if (!dragging || event.pointerId !== dragging.pointerId) return; stage.scrollLeft = dragging.left + dragging.x - event.clientX; stage.scrollTop = dragging.top + dragging.y - event.clientY; });
    const release = () => { dragging = null; stage.classList.remove('is-dragging'); };
    stage.addEventListener('pointerup', release); stage.addEventListener('pointercancel', release);
    stage.addEventListener('dblclick', () => fitMode ? original() : fit());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); else if (event.key === ' ' && event.target === stage) { event.preventDefault(); event.stopPropagation(); close(); } else if (event.key === '+' || event.key === '=') { event.preventDefault(); setScale(scale * 1.25); } else if (event.key === '-') { event.preventDefault(); setScale(scale / 1.25); } else if (event.key === '0') { event.preventDefault(); fit(); } else if (event.key === '1') { event.preventDefault(); original(); } });
    dialog.addEventListener('close', () => { closed = true; resize.disconnect(); dialog.remove(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); });
    const resize = new ResizeObserver(() => { if (fitMode && picture.complete) fit(); }); resize.observe(stage);
    dialog.showModal(); picture.src = src; stage.focus({ preventScroll: true });
    return Object.freeze({ dialog, stage, picture, close, setScale, fit, original, getScale: () => scale });
  }
  root.MoyeReading = Object.freeze({ install, plainText });
  root.MoyeImageViewer = Object.freeze({ open: openImage });
})(window);
