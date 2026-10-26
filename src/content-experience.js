/* Generated preview work: dedicated-worker code colour, bounded diagrams,
 * and local formula overflow. The editable source PRE is never decorated. */
(function (global) {
  'use strict';
  const base = new URL('./', document.currentScript?.src || location.href);
  const controllers = new WeakMap(), waiting = new Map();
  const otherEngines = new Set(['abc', 'smiles', 'markmap', 'flowchart', 'echarts', 'mindmap', 'plantuml', 'graphviz', 'wavedrom', 'math']);
  const maxCodeLength = 180000, maxDiagramLength = 12000, maxDiagramLines = 180, maxDiagramEdges = 120;
  let nextDiagramId = 0, mermaidPromise = null, mermaidQueue = Promise.resolve();
  function languageOf(element) { return [...element.classList].find(name => name.startsWith('language-'))?.slice(9) || ''; }
  function escapeHTML(value) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function readonlyPreview(panel) {
    return panel?.matches('.vditor-ir__preview') && panel.closest('[data-type="code-block"],[data-type="math-block"]');
  }
  function dispatch(panel, vditor, language) {
    if (panel?.firstElementChild) language = languageOf(panel.firstElementChild);
    if (!panel || otherEngines.has(language)) return false;
    // This hook runs before Vditor's internal synchronous highlight/diagram
    // dispatch. A queued plain preview remains available for the first frame.
    const instance = controllers.get(vditor);
    if (instance) instance.accept(panel, language);
    else {
      if (!waiting.has(vditor)) waiting.set(vditor, new Map());
      waiting.get(vditor).set(panel, language);
    }
    panel.setAttribute('contenteditable', 'false');
    return true;
  }
  function loadMermaid(cdn) {
    if (global.mermaid) return Promise.resolve(global.mermaid);
    if (!mermaidPromise) mermaidPromise = new Promise((resolve, reject) => {
      let script = document.getElementById('vditorMermaidScript');
      const created = !script;
      if (!script) { script = document.createElement('script'); script.id = 'vditorMermaidScript'; script.src = `${cdn}/dist/js/mermaid/mermaid.min.js`; }
      const loadingTimer = setTimeout(() => reject(new Error('本地图表组件加载超时')), 6000);
      script.addEventListener('load', () => { clearTimeout(loadingTimer); global.mermaid ? resolve(global.mermaid) : reject(new Error('图表组件未能初始化')); }, { once: true });
      script.addEventListener('error', () => { clearTimeout(loadingTimer); reject(new Error('本地图表组件加载失败')); }, { once: true });
      if (created) document.head.append(script);
    });
    return mermaidPromise;
  }
  function diagramLimit(source) {
    if (source.length > maxDiagramLength) return `图表源代码超过 ${maxDiagramLength} 字符，已保留源码预览。`;
    if (source.split('\n').length > maxDiagramLines) return `图表超过 ${maxDiagramLines} 行，已保留源码预览。`;
    if ((source.match(/(?:-{1,3}|={1,3}|\.{1,3})[><]/g) || []).length > maxDiagramEdges) return `图表连线超过 ${maxDiagramEdges} 条，已保留源码预览。`;
    let depth = 0;
    for (const line of source.split('\n')) {
      if (/^\s*subgraph\b/.test(line) && ++depth > 12) return '图表嵌套超过 12 层，已保留源码预览。';
      if (/^\s*end\s*$/.test(line)) depth = Math.max(0, depth - 1);
    }
    return '';
  }
  function install({ editor, getValues = () => ({}), isComposing = () => false, preserveLayout = callback => callback(), writeClipboard = text => navigator.clipboard.writeText(text) }) {
    const vditor = editor.vditor, ir = vditor.ir.element;
    let destroyed = false, generation = 0, nextJobId = 0, worker = null, busy = null, timer = 0, kickoff = 0, fitFrame = 0;
    let states = new WeakMap(), queue = [];
    const roots = new Set([ir]), mathNodes = new Set(), mathOriginal = new WeakMap(), blockedLanguages = new Set(), deferred = new Map(), deferredPanels = new Map(), codePanels = new Map(), copyBindings = new WeakSet();
    const stats = { workerJobs: 0, workerResults: 0, staleResults: 0, timeouts: 0, plainFallbacks: 0, diagramsRendered: 0, diagramsRejected: 0, diagramErrors: 0 };
    const values = () => getValues() || {};
    function isCurrent(record) {
      return !destroyed && record.generation === generation && record.element.isConnected && states.get(record.element) === record && sourceFor(record.element, record.panel) === record.source;
    }
    function sourceFor(element, panel) {
      const node = panel?.closest('[data-type="code-block"],[data-type="math-block"]')?.querySelector(':scope>.vditor-ir__marker--pre>code');
      // Read-only Mermaid output has no editable sibling. Once this controller
      // has replaced its source with SVG, retain the exact source separately
      // from the labels in that generated SVG.
      const current = states.get(element);
      return node ? node.textContent : current?.kind === 'diagram' && element.querySelector('svg') ? current.source : element.textContent;
    }
    function change(callback) { return preserveLayout(callback); }
    function shouldDefer(element) {
      if (isComposing()) return true;
      const selection = getSelection();
      if (!selection.rangeCount || selection.isCollapsed) return false;
      try { return selection.getRangeAt(0).intersectsNode(element); } catch (_) { return false; }
    }
    function note(panel, message) {
      if (message) { panel.dataset.contentNote = String(message).slice(0, 240); panel.setAttribute('aria-description', panel.dataset.contentNote); }
      else { delete panel.dataset.contentNote; panel.removeAttribute('aria-description'); }
      global.MoyeI18n?.active?.registerAttributes(panel);
    }
    function codePanel(element) { return element.parentElement?.tagName === 'PRE' ? element.parentElement : null; }
    function decorate(record) {
      const { element, panel, source, language } = record, settings = values();
      panel.classList.add('moye-code-preview'); panel.setAttribute('contenteditable', 'false');
      if (!codePanels.has(panel)) resize.observe(panel);
      codePanels.set(panel, record);
      if (settings['code.languageBadge'] !== false && language) panel.dataset.codeLanguage = language; else delete panel.dataset.codeLanguage;
      element.classList.add('hljs');
      let copy = panel.querySelector(':scope>.moye-code-copy');
      if (!copy) {
        copy = document.createElement('button'); copy.className = 'moye-code-copy'; copy.type = 'button'; copy.setAttribute('aria-label', '复制代码'); copy.title = '复制代码'; copy.setAttribute('contenteditable', 'false');
        panel.append(copy);
      }
      global.MoyeI18n?.active?.register(copy);
      if (!copyBindings.has(copy)) {
        copyBindings.add(copy); delete copy.dataset.copied;
        copy.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
        copy.addEventListener('click', async event => {
          event.preventDefault(); event.stopPropagation();
          const current = states.get(element); if (!current) return;
          try { await writeClipboard(current.source.replace(/\n$/, '')); copy.dataset.copied = 'true'; setTimeout(() => { if (copy.isConnected) delete copy.dataset.copied; }, 1200); }
          catch (_) { copy.setAttribute('aria-label', '复制失败，请选择代码后复制'); }
        });
      }
      // A badge is a pseudo-element and the button has no text nodes: neither
      // becomes document text when the preview is selected or copied.
      record.settings = `${settings['code.highlight'] !== false}|${settings['code.lineNumbers'] === true}|${settings['code.languageBadge'] !== false}|${settings['code.wrap'] !== false}`;
      record.source = source;
    }
    function addLineNumbers(element, source) {
      const template = document.createElement('template'); template.innerHTML = element.innerHTML;
      if (template.content.textContent !== source) return;
      const textNodes = [], walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) textNodes.push(node);
      if (!textNodes.length) return;
      const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [''];
      let position = 0, nodeIndex = 0, nodeStart = 0;
      const at = offset => {
        while (nodeIndex < textNodes.length - 1 && nodeStart + textNodes[nodeIndex].length < offset) { nodeStart += textNodes[nodeIndex].length; nodeIndex++; }
        return { node: textNodes[nodeIndex], offset: Math.min(textNodes[nodeIndex].length, Math.max(0, offset - nodeStart)) };
      };
      const output = document.createDocumentFragment(), wrappers = [];
      for (const line of lines) {
        const start = at(position), end = at(position + line.length), range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
        const wrapper = document.createElement('span'); wrapper.className = 'moye-code-line'; wrapper.append(range.cloneContents()); output.append(wrapper); wrappers.push(wrapper); position += line.length;
      }
      element.replaceChildren(output); element.classList.add('vditor-linenumber');
      const rows = document.createElement('span'); rows.className = 'vditor-linenumber__rows'; rows.setAttribute('aria-hidden', 'true');
      for (const wrapper of wrappers) { const row = document.createElement('span'); row.style.height = `${wrapper.getBoundingClientRect().height}px`; rows.append(row); }
      element.append(rows);
    }
    function updateLineNumberHeights(record) {
      if (!record.element.isConnected || !record.element.classList.contains('vditor-linenumber') || isComposing()) return;
      const lines = [...record.element.querySelectorAll(':scope>.moye-code-line')], rows = [...record.element.querySelectorAll(':scope>.vditor-linenumber__rows>span')];
      const heights = lines.map(line => line.getBoundingClientRect().height);
      rows.forEach((row, index) => { if (heights[index] > 0) row.style.height = `${heights[index]}px`; });
    }
    function applyHTML(record, html, message = '') {
      if (!isCurrent(record)) { stats.staleResults++; return false; }
      if (shouldDefer(record.element)) { deferred.set(record.element, () => applyHTML(record, html, message)); return false; }
      const template = document.createElement('template'); template.innerHTML = html;
      if (template.content.textContent !== record.source) { stats.staleResults++; return false; }
      change(() => {
        record.element.innerHTML = html; record.element.classList.remove('vditor-linenumber');
        decorate(record); if (values()['code.lineNumbers'] === true) addLineNumbers(record.element, record.source);
        note(record.panel, message);
      });
      record.html = html; return true;
    }
    function plain(record, message = '') {
      stats.plainFallbacks++;
      if (isCurrent(record) && values()['code.lineNumbers'] !== true && [...record.element.childNodes].every(node => node.nodeType === Node.TEXT_NODE) && record.element.textContent === record.source) {
        decorate(record); note(record.panel, message); record.html = escapeHTML(record.source); return true;
      }
      return applyHTML(record, escapeHTML(record.source), message);
    }
    function stopWorker() { if (worker) worker.terminate(); worker = null; clearTimeout(timer); timer = 0; }
    function workerFailed(message, timeout = false) {
      const job = busy; busy = null; stopWorker();
      if (job) {
        if (timeout) { stats.timeouts++; blockedLanguages.add(job.language); }
        plain(job, message); job.status = 'plain';
      }
      pump();
    }
    function ensureWorker() {
      if (worker) return true;
      try {
        worker = new Worker(new URL('highlight-worker.js', base));
        worker.addEventListener('message', event => {
          const job = busy, result = event.data;
          if (!job || result?.id !== job.id) return;
          clearTimeout(timer); timer = 0; busy = null;
          if (!isCurrent(job)) stats.staleResults++;
          else if (result.error) { plain(job, '高亮未能完成，已保留纯文本代码。'); job.status = 'plain'; }
          else if (typeof result.html === 'string' && result.worker === true) {
            job.html = result.html;
            const finish = () => { if (applyHTML(job, result.html)) { stats.workerResults++; job.status = 'highlighted'; job.durationMs = result.durationMs; } };
            if (shouldDefer(job.element)) deferred.set(job.element, finish); else finish();
          }
          pump();
        });
        worker.addEventListener('error', event => { event.preventDefault(); workerFailed('本地高亮组件不可用，已保留纯文本代码。'); });
        return true;
      } catch (_) { worker = null; return false; }
    }
    function pump() {
      if (destroyed || busy) return;
      let job;
      while ((job = queue.shift())) { if (isCurrent(job) && job.status === 'queued' && values()['code.highlight'] !== false) break; stats.staleResults++; }
      if (!job) return;
      if (isComposing()) { queue.unshift(job); kickoff = setTimeout(() => { kickoff = 0; pump(); }, 80); return; }
      if (blockedLanguages.has(job.language)) { plain(job, '此语言高亮超时，本次会话使用纯文本。'); job.status = 'plain'; queueMicrotask(pump); return; }
      if (!ensureWorker()) { plain(job, '当前环境不支持后台高亮，已保留纯文本代码。'); job.status = 'plain'; queueMicrotask(pump); return; }
      busy = job; stats.workerJobs++;
      worker.postMessage({ id: job.id, source: job.source, language: job.language });
      timer = setTimeout(() => workerFailed('此语言高亮超过 1.5 秒，已保留纯文本代码。', true), 1500);
    }
    function schedulePump() {
      if (kickoff || destroyed) return;
      kickoff = requestAnimationFrame(() => { kickoff = setTimeout(() => { kickoff = 0; pump(); }, 0); });
    }
    function acceptCode(element, panel, language) {
      if (!panel || element.closest('.vditor-ir__marker--pre,.vditor-wysiwyg__pre') || !readonlyPreview(panel) && !element.closest('.moye-reading-content,[data-moye-readonly]')) return;
      const source = sourceFor(element, panel), previous = states.get(element), settings = values();
      const signature = `${settings['code.highlight'] !== false}|${settings['code.lineNumbers'] === true}|${settings['code.languageBadge'] !== false}|${settings['code.wrap'] !== false}`;
      const highlightEnabled = settings['code.highlight'] !== false;
      if (previous && previous.source === source && previous.language === language && previous.generation === generation && previous.highlightEnabled === highlightEnabled) {
        // Theme, wrapping, badges and line numbers are presentation changes.
        // Keep an in-flight worker job and synchronously update the existing
        // preview instead of waiting for another tokenization round trip.
        const wantsNumbers = settings['code.lineNumbers'] === true;
        const rows = element.querySelector(':scope>.vditor-linenumber__rows>span');
        const numbered = element.classList.contains('vditor-linenumber');
        const needsNumbers = wantsNumbers ? !numbered || !rows : numbered || !!rows || !!element.querySelector(':scope>.moye-code-line');
        if (previous.settings !== signature) decorate(previous);
        if (needsNumbers) applyHTML(previous, typeof previous.html === 'string' ? previous.html : escapeHTML(source), panel.dataset.contentNote || '');
        return;
      }
      const record = { id: ++nextJobId, element, panel, source, language, generation, highlightEnabled, status: 'queued' }; states.set(element, record);
      decorate(record);
      if (settings['code.highlight'] === false || source.length > maxCodeLength) {
        plain(record, source.length > maxCodeLength ? `代码超过 ${maxCodeLength} 字符，已保留纯文本预览。` : ''); record.status = 'plain'; return;
      }
      if (previous?.source === source && previous.language === language && previous.html && previous.status === 'highlighted') {
        applyHTML(record, previous.html); record.status = 'highlighted'; return;
      }
      // Remove a former theme's spans only in this generated preview. This
      // gives a plain, immediately readable frame before the worker replies.
      plain(record); queue.push(record); schedulePump();
    }
    function diagramCurrent(record) {
      return !destroyed && record.generation === generation && record.enabled === (values()['markdown.diagrams'] !== false) && record.element.isConnected && states.get(record.element) === record && sourceFor(record.element, record.panel) === record.source;
    }
    function diagramFallback(record, message) {
      if (!diagramCurrent(record)) { stats.staleResults++; return; }
      if (shouldDefer(record.element)) { deferred.set(record.element, () => diagramFallback(record, message)); return; }
      change(() => {
        const pre = document.createElement('pre'); pre.className = 'moye-diagram-source'; pre.textContent = record.source;
        record.element.replaceChildren(pre); record.element.dataset.processed = 'true'; record.panel.classList.add('moye-diagram-preview'); note(record.panel, message);
      });
    }
    function acceptDiagram(element, panel) {
      const source = sourceFor(element, panel), previous = states.get(element), dark = document.body.classList.contains('dark'), enabled = values()['markdown.diagrams'] !== false;
      if (previous?.source === source && previous.generation === generation && previous.dark === dark && previous.enabled === enabled) return;
      if (enabled && !previous && element.querySelector('svg') && element.dataset.processed === 'true') return;
      const record = { kind: 'diagram', element, panel, source, generation, dark, enabled }; states.set(element, record); deferred.delete(element);
      // Use only applied syntax settings supplied by the host. Replacing the
      // record also invalidates a queued or already-rendering enabled diagram.
      if (!enabled) { diagramFallback(record, ''); return; }
      const limit = diagramLimit(source);
      if (limit) { stats.diagramsRejected++; diagramFallback(record, limit); return; }
      diagramFallback(record, '正在绘制图表…');
      mermaidQueue = mermaidQueue.catch(() => {}).then(async () => {
        if (!diagramCurrent(record)) { stats.staleResults++; return; }
        const id = `moye-mermaid-${++nextDiagramId}`;
        try {
          const mermaid = await loadMermaid(vditor.options.cdn);
          if (!diagramCurrent(record)) { stats.staleResults++; return; }
          mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, suppressErrorRendering: true, maxTextSize: maxDiagramLength, maxEdges: maxDiagramEdges, theme: dark ? 'dark' : 'default', fontFamily: '"Noto Sans SC", sans-serif', altFontFamily: '"Noto Sans SC", sans-serif', flowchart: { htmlLabels: true, useMaxWidth: true }, sequence: { useMaxWidth: true, diagramMarginX: 8, diagramMarginY: 8, boxMargin: 8, showSequenceNumbers: true }, gantt: { leftPadding: 75, rightPadding: 20 } });
          await mermaid.parse(source);
          if (!diagramCurrent(record)) { stats.staleResults++; return; }
          const result = await mermaid.render(id, source);
          if (!diagramCurrent(record)) { stats.staleResults++; return; }
          record.svg = result.svg;
          const finish = () => { if (!diagramCurrent(record)) { stats.staleResults++; return; } if (shouldDefer(element)) { deferred.set(element, finish); return; } change(() => { element.innerHTML = result.svg; element.dataset.processed = 'true'; panel.classList.add('moye-diagram-preview'); note(panel, ''); }); stats.diagramsRendered++; };
          finish();
        } catch (error) { stats.diagramErrors++; diagramFallback(record, `图表无法绘制：${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 180)}`); }
        finally { document.getElementById(`d${id}`)?.remove(); }
      });
    }
    function accept(panel, language) {
      if (isComposing()) { deferredPanels.set(panel, language); return; }
      const element = panel.firstElementChild; if (!element) return;
      if (language === 'mermaid') acceptDiagram(element, panel);
      else if (!otherEngines.has(language) && element.tagName === 'CODE') acceptCode(element, panel, language);
    }
    function collectMath(root) {
      const selector = '[data-type="math-block"]>.vditor-ir__preview>.language-math,[data-type="code-block"]>.vditor-ir__preview>.language-math,.moye-reading-content .language-math';
      if (root.matches?.('.language-math') && (root.closest('[data-type="math-block"],[data-type="code-block"],.moye-reading-content'))) mathNodes.add(root);
      root.querySelectorAll?.(selector).forEach(node => mathNodes.add(node));
    }
    function fitMath() {
      fitFrame = 0; if (destroyed || isComposing()) return;
      const fit = values()['math.overflow'] === 'fit';
      for (const element of mathNodes) {
        if (!element.isConnected) { mathNodes.delete(element); continue; }
        if (!mathOriginal.has(element)) mathOriginal.set(element, element.dataset.mathScale ? '' : element.style.fontSize);
        element.classList.add('moye-block-math'); element.dataset.mathOverflow = fit ? 'fit' : 'scroll'; element.style.fontSize = mathOriginal.get(element);
        if (!fit) { delete element.dataset.mathScale; continue; }
        const rendered = element.querySelector('mjx-container,.katex-display') || element.firstElementChild;
        if (!rendered) continue;
        const available = element.clientWidth, natural = Math.max(rendered.scrollWidth, rendered.getBoundingClientRect().width, rendered.querySelector('svg')?.getBoundingClientRect().width || 0);
        const scale = available > 0 && natural > available + 1 ? Math.max(0.1, available / natural) : 1;
        if (scale < 1) element.style.fontSize = `${scale * 100}%`;
        element.dataset.mathScale = String(scale);
      }
    }
    function scheduleFits() { if (!fitFrame && !destroyed) fitFrame = requestAnimationFrame(fitMath); }
    function keepMathEditorFocus(event) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || isComposing()) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const preview = target?.closest('.vditor-ir__preview');
      if (!preview || !ir.contains(preview) || !preview.querySelector('.language-math') || target.closest('a,button,input,select,textarea,[role="button"]')) return;
      // MathJax emits a focusable container even with its menu disabled. Its
      // native mouse-down focus blurs IR, whose blur handler can focus the old
      // caret and scroll before mouse-up. Preserve focus until Vditor's normal
      // click handler moves the caret into the formula's editable source.
      // The separate reading root, modified clicks and native scrollbars keep
      // their own interaction; no click or selection is synthesized here.
      if (target.closest('mjx-container,.katex,.katex-display')) event.preventDefault();
    }
    ir.addEventListener('mousedown', keepMathEditorFocus, true);
    function refresh(root = ir) {
      if (destroyed || !root?.querySelectorAll) return;
      for (const [panel] of codePanels) if (!panel.isConnected) { resize.unobserve(panel); codePanels.delete(panel); }
      roots.add(root);
      root.querySelectorAll('.vditor-ir__preview').forEach(panel => accept(panel, languageOf(panel.firstElementChild || panel)));
      if (root !== ir) {
        root.querySelectorAll('pre>code').forEach(element => { const language = languageOf(element); if (!otherEngines.has(language) && language !== 'mermaid') acceptCode(element, codePanel(element), language); });
        root.querySelectorAll('.language-mermaid').forEach(element => acceptDiagram(element, element.closest('pre') || element.parentElement));
      }
      collectMath(root); scheduleFits();
    }
    const mutation = new MutationObserver(records => {
      if (isComposing()) return;
      let mathChanged = false;
      for (const record of records) {
        if (record.target.parentElement?.closest('.language-math,[data-type="math-block"]')) mathChanged = true;
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE && (node.matches('.language-math,[data-type="math-block"]') || node.querySelector('.language-math'))) { collectMath(node); mathChanged = true; }
      }
      if (mathChanged) scheduleFits();
    });
    mutation.observe(ir, { childList: true, subtree: true });
    const resize = new ResizeObserver(entries => { for (const entry of entries) { const record = codePanels.get(entry.target); if (record && entry.contentRect.height > 0) updateLineNumberHeights(record); } scheduleFits(); }); resize.observe(ir);
    const flushDeferred = () => { const work = [...deferred.values()]; deferred.clear(); work.forEach(callback => callback()); };
    const selectionChanged = () => { if (deferred.size && !isComposing()) flushDeferred(); };
    const compositionDone = () => { const panels = [...deferredPanels]; deferredPanels.clear(); panels.forEach(([panel, language]) => { if (panel.isConnected) accept(panel, language); }); flushDeferred(); pump(); scheduleFits(); }; ir.addEventListener('compositionend', compositionDone); document.addEventListener('selectionchange', selectionChanged);
    async function whenReady({ timeoutMs = 8000 } = {}) {
      // Export callers must observe the latest render chain, not just the
      // promise that happened to exist before a reading snapshot was rebuilt.
      // Selection-deferred DOM painting is already computed and does not keep
      // this barrier pending or destroy the user's selection to finish it.
      const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(50, Math.min(10000, timeoutMs)) : 8000;
      const deadline = performance.now() + boundedTimeout;
      let deadlineTimer;
      const timeout = new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error('内容预览尚未完成，请稍后再导出。')), boundedTimeout); });
      const settle = async () => {
        let stableTurns = 0;
        while (!destroyed) {
          if (performance.now() >= deadline) throw new Error('内容预览尚未完成，请稍后再导出。');
          const pendingDiagrams = mermaidQueue, version = generation;
          await pendingDiagrams;
          pump(); if (!isComposing()) flushDeferred();
          await new Promise(resolve => setTimeout(resolve, 16));
          if (pendingDiagrams !== mermaidQueue || version !== generation || busy || queue.length || deferredPanels.size) { stableTurns = 0; continue; }
          if (++stableTurns >= 2) { fitMath(); return { ready: true, generation, deferredPreviews: deferred.size }; }
        }
        throw new Error('文档预览已关闭，请重新打开后导出。');
      };
      try { return await Promise.race([settle(), timeout]); }
      finally { clearTimeout(deadlineTimer); }
    }
    function documentChanged() {
      generation++; queue = []; deferred.clear(); deferredPanels.clear(); for (const [panel] of codePanels) resize.unobserve(panel); codePanels.clear(); if (busy) { busy = null; stopWorker(); } states = new WeakMap(); mathNodes.clear(); refresh();
    }
    function destroy() {
      if (destroyed) return; destroyed = true; generation++; queue = []; stopWorker(); if (kickoff) { cancelAnimationFrame(kickoff); clearTimeout(kickoff); } if (fitFrame) cancelAnimationFrame(fitFrame);
      mutation.disconnect(); resize.disconnect(); ir.removeEventListener('mousedown', keepMathEditorFocus, true); ir.removeEventListener('compositionend', compositionDone); document.removeEventListener('selectionchange', selectionChanged); controllers.delete(vditor); roots.clear(); mathNodes.clear(); deferred.clear(); deferredPanels.clear(); codePanels.clear();
    }
    const api = { accept, refresh, documentChanged, whenReady, destroy, stats };
    controllers.set(vditor, api);
    const queued = waiting.get(vditor); waiting.delete(vditor); queued?.forEach((language, panel) => { if (panel.isConnected) accept(panel, language); });
    refresh(); return api;
  }
  global.MoyeContentExperience = Object.freeze({ install, dispatch, limits: Object.freeze({ maxCodeLength, maxDiagramLength, maxDiagramLines, maxDiagramEdges }) });
})(window);
