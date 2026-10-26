/* Syntax paint for the existing native textarea. Its value, selection and edit
   history remain native; the view is discarded whenever its snapshot is stale. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeSourcePresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_CHARS = 200000, MAX_TOKENS = 12000, MAX_LINE = 20000, MAX_LEX_MS = 12;
  function tokenize(value, options = {}) {
    if (typeof value !== 'string') throw new TypeError('Source text must be a string.');
    const maxChars = options.maxChars ?? MAX_CHARS, maxTokens = options.maxTokens ?? MAX_TOKENS;
    if (value.length > maxChars) return { tokens: [], fallback: 'large-document' };
    const now = options.now || (() => performance.now()), deadline = now() + (options.maxDurationMs ?? MAX_LEX_MS);
    const timedOut = { tokens: [], fallback: 'time-budget' };
    let operations = 0;
    // Check inside nested scans too: unfinished links can otherwise repeatedly
    // walk the same line without producing a single token for the DOM budget.
    const expired = force => ((++operations & 127) === 0 || force) && now() > deadline;
    const tokens = [];
    const emit = (start, end, type) => { if (end > start) tokens.push({ start, end, type }); };
    let position = 0, fence = null, frontmatter = false, comment = false;
    while (position < value.length) {
      if (expired(true)) return timedOut;
      let end = value.indexOf('\n', position); if (end < 0) end = value.length;
      let contentEnd = end; if (value[contentEnd - 1] === '\r') contentEnd--;
      const line = value.slice(position, contentEnd);
      if (line.length > MAX_LINE) return { tokens: [], fallback: 'long-line' };
      const fencing = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (position === 0 && line === '---' && /(?:^|\n)(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/.test(value.slice(end + 1))) { frontmatter = true; emit(position, contentEnd, 'meta'); }
      else if (frontmatter) { emit(position, contentEnd, 'meta'); if (/^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false; }
      else if (fence) {
        if (fencing && fencing[2][0] === fence.character && fencing[2].length >= fence.length && !fencing[3].trim()) { emit(position, contentEnd, 'fence'); fence = null; }
        else emit(position, contentEnd, 'code');
      } else if (fencing) { fence = { character: fencing[2][0], length: fencing[2].length }; emit(position, contentEnd, 'fence'); }
      else if (comment || line.trimStart().startsWith('<!--')) {
        emit(position, contentEnd, 'comment'); comment = !line.includes('-->');
      } else if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) emit(position, contentEnd, 'marker');
      else {
        const heading = /^( {0,3}#{1,6})(\s+)(.*)$/.exec(line);
        const prefix = heading ? heading[1] + heading[2] : (/^(?: {0,3}> ?)+/.exec(line)?.[0] || /^(?:\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/.exec(line)?.[0] || '');
        if (prefix) emit(position, position + prefix.length, 'marker');
        const base = heading ? 'heading' : null;
        let i = prefix.length, plain = i;
        const flush = until => { if (base) emit(position + plain, position + until, base); };
        while (i < line.length) {
          if (expired()) return timedOut;
          let token = null, length = 0;
          if (line[i] === '\\' && i + 1 < line.length) { i += 2; continue; }
          if (line[i] === '`') {
            let count = 1; while (line[i + count] === '`') { if (expired()) return timedOut; count++; }
            const delimiter = '`'.repeat(count); let close = line.indexOf(delimiter, i + count);
            while (close >= 0 && (line[close - 1] === '`' || line[close + count] === '`')) { if (expired()) return timedOut; close = line.indexOf(delimiter, close + count); }
            if (close >= 0) { token = 'code'; length = close + count - i; }
            else { i += count; continue; }
          } else if (line[i] === '[' || (line[i] === '!' && line[i + 1] === '[')) {
            const bracket = line[i] === '!' ? i + 1 : i;
            let close = line.indexOf(']', bracket + 1);
            while (close >= 0 && line[close - 1] === '\\') { if (expired()) return timedOut; close = line.indexOf(']', close + 1); }
            if (close >= 0 && close - i <= 8192 && line[close + 1] === '(') {
              let depth = 1, stop = close + 2;
              while (stop < line.length && stop - i <= 8192 && depth) {
                if (expired()) return timedOut;
                if (line[stop] === '\\') { stop += 2; continue; }
                if (line[stop] === '(') depth++; else if (line[stop] === ')') depth--;
                stop++;
              }
              if (!depth) { token = 'link'; length = stop - i; }
            } else if (close >= 0 && close - i <= 8192 && line[close + 1] === '[') {
              const stop = line.indexOf(']', close + 2); if (stop >= 0) { token = 'link'; length = stop + 1 - i; }
            }
          } else if (line[i] === '<' && /^(?:https?:\/\/|mailto:)/.test(line.slice(i + 1, i + 10))) {
            const close = line.indexOf('>', i + 1); if (close >= 0) { token = 'link'; length = close + 1 - i; }
          } else if ('*_~='.includes(line[i])) {
            const doubled = line[i + 1] === line[i], delimiter = doubled ? line[i].repeat(2) : line[i];
            const intrawordUnderscore = line[i] === '_' && /[\p{L}\p{N}]/u.test(line[i - 1] || '');
            if (!intrawordUnderscore && (doubled || '*_'.includes(line[i])) && line[i + delimiter.length] && !/\s/.test(line[i + delimiter.length])) {
              let close = line.indexOf(delimiter, i + delimiter.length);
              while (close >= 0 && close - i <= 8192) {
                if (expired()) return timedOut;
                let escapes = 0; for (let at = close - 1; at >= 0 && line[at] === '\\'; at--) { if (expired()) return timedOut; escapes++; }
                if (escapes % 2 === 0) break;
                close = line.indexOf(delimiter, close + delimiter.length);
              }
              if (close > i + delimiter.length && close - i <= 8192 && !/\s/.test(line[close - 1])) { token = line[i] === '~' ? 'strike' : line[i] === '=' ? 'mark' : doubled ? 'strong' : 'emphasis'; length = close + delimiter.length - i; }
            }
          }
          if (token) { flush(i); emit(position + i, position + i + length, token); i += length; plain = i; }
          else i++;
          if (tokens.length > maxTokens) return { tokens: [], fallback: 'token-budget' };
        }
        flush(line.length);
      }
      if (tokens.length > maxTokens) return { tokens: [], fallback: 'token-budget' };
      position = end < value.length ? end + 1 : value.length;
    }
    return expired(true) ? timedOut : { tokens, fallback: null };
  }
  function install({ editor, getValues = () => ({}), isComposing = () => false } = {}) {
    const source = editor?.vditor?.sv?.element;
    if (!source || source.tagName !== 'TEXTAREA') throw new TypeError('Source presentation needs the native textarea.');
    const overlay = document.createElement('div'); overlay.className = 'moye-source-presentation'; overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true'); overlay.setAttribute('inert', '');
    const paint = document.createElement('div'); paint.className = 'moye-source-paint'; overlay.append(paint); document.body.append(overlay);
    const counters = { paints: 0, staleDropped: 0, fallback: 'initial', tokenCount: 0, lastDurationMs: 0, lastValueLength: 0 };
    const metrics = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'fontOpticalSizing', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent', 'textTransform', 'direction', 'textAlign', 'overflowWrap', 'wordBreak', 'whiteSpace', 'lineBreak', 'hyphens', 'textRendering', 'textAutospace'];
    let disposed = false, localComposition = false, generation = 0, timer = null, paintedValue = null, lastMetricSignature = null;
    const offs = [], forcedColors = matchMedia('(forced-colors: active)');
    function listen(target, type, callback, options) { target.addEventListener(type, callback, options); offs.push(() => target.removeEventListener(type, callback, options)); }
    function native(reason) { source.classList.remove('moye-source-colorized'); overlay.hidden = true; counters.fallback = reason; }
    function isVisible() { return editor.getCurrentMode() === 'sv' && !document.body.classList.contains('reading-mode') && source.getClientRects().length > 0 && !source.closest('[hidden]'); }
    function position() {
      if (disposed || overlay.hidden) return;
      const bounds = source.getBoundingClientRect();
      Object.assign(overlay.style, { left: `${bounds.left + source.clientLeft}px`, top: `${bounds.top + source.clientTop}px`, width: `${source.clientWidth}px`, height: `${source.clientHeight}px` });
      paint.style.left = `${-source.scrollLeft}px`; paint.style.top = `${-source.scrollTop}px`;
    }
    function refresh() {
      if (disposed) return;
      const ticket = ++generation; clearTimeout(timer); timer = null;
      if (getValues()['code.sourceHighlight'] === false) { native('disabled'); return; }
      if (!isVisible()) { native('inactive'); return; }
      if (localComposition || isComposing()) { native('composition'); return; }
      if (forcedColors.matches) { native('forced-colors'); return; }
      const value = source.value;
      if (value.length > MAX_CHARS) { native('large-document'); return; }
      native('pending');
      const css = getComputedStyle(source);
      if (css.writingMode !== 'horizontal-tb') { native('writing-mode'); return; }
      overlay.style.backgroundColor = css.backgroundColor;
      const signature = metrics.map(key => css[key] || '').join('|') + `|${source.clientWidth}`;
      if (paintedValue === value && lastMetricSignature === signature && paint.childNodes.length) {
        counters.fallback = null; overlay.hidden = false; source.classList.add('moye-source-colorized'); position(); return;
      }
      const render = () => {
        timer = null;
        if (disposed || ticket !== generation || source.value !== value || !isVisible() || localComposition || isComposing()) { counters.staleDropped++; return; }
        const latest = getComputedStyle(source), latestSignature = metrics.map(key => latest[key] || '').join('|') + `|${source.clientWidth}`;
        if (latestSignature !== signature) { counters.staleDropped++; refresh(); return; }
        const started = performance.now(), parsed = tokenize(value);
        if (parsed.fallback) { native(parsed.fallback); return; }
        if (!parsed.tokens.length) { native('plain-text'); return; }
        const fragment = document.createDocumentFragment(); let previous = 0;
        for (const token of parsed.tokens) {
          if (token.start > previous) fragment.append(document.createTextNode(value.slice(previous, token.start)));
          const span = document.createElement('span'); span.className = `moye-source-token moye-source-token--${token.type}`; span.dataset.start = String(token.start); span.dataset.end = String(token.end); span.textContent = value.slice(token.start, token.end); fragment.append(span); previous = token.end;
          if (performance.now() - started > 18) { native('time-budget'); return; }
        }
        fragment.append(document.createTextNode(value.slice(previous) + '\u200b'));
        if (disposed || ticket !== generation || source.value !== value || !isVisible() || localComposition || isComposing()) { counters.staleDropped++; return; }
        for (const key of metrics) paint.style[key] = css[key] || '';
        // Chromium's textarea inner editor floors fractional line heights to
        // LayoutUnit (1/64 px); regular div line boxes otherwise round upward.
        const lineHeight = parseFloat(css.lineHeight);
        if (Number.isFinite(lineHeight)) paint.style.lineHeight = `${Math.floor(lineHeight * 64) / 64}px`;
        paint.style.width = `${source.clientWidth}px`;
        paint.replaceChildren(fragment);
        paintedValue = value; lastMetricSignature = signature;
        counters.paints++; counters.tokenCount = parsed.tokens.length; counters.lastDurationMs = performance.now() - started; counters.lastValueLength = value.length; counters.fallback = null;
        overlay.hidden = false; source.classList.add('moye-source-colorized'); position();
      };
      // Short edits settle before the next paint. Longer source documents use
      // native text during a bounded, cancellable idle delay.
      if (value.length < 32000) queueMicrotask(render); else timer = setTimeout(render, 60);
    }
    function composition(event) { localComposition = event.type === 'compositionstart'; if (localComposition) { generation++; clearTimeout(timer); native('composition'); } else queueMicrotask(refresh); }
    listen(source, 'input', refresh, true); listen(source, 'scroll', position, { passive: true });
    listen(source, 'compositionstart', composition, true); listen(source, 'compositionend', composition, true);
    listen(window, 'resize', refresh); listen(forcedColors, 'change', refresh);
    listen(document, 'moye-reading-mode', refresh);
    if (document.fonts) listen(document.fonts, 'loadingdone', refresh);
    const resize = new ResizeObserver(refresh); resize.observe(source);
    // Vditor changes mode visibility via ancestor styles, while document loads
    // assign textarea.value without firing input. These observers are paint-only.
    const visibility = new MutationObserver(refresh); visibility.observe(source, { attributes: true, attributeFilter: ['style', 'wrap', 'hidden', 'readonly'] });
    const hostVisibility = new MutationObserver(refresh); if (source.parentElement) hostVisibility.observe(source.parentElement, { attributes: true, attributeFilter: ['style', 'hidden'] });
    const typewriterLayout = new MutationObserver(refresh); let typewriterSheet = null;
    function watchTypewriter() {
      const next = document.querySelector('style[data-moye-typewriter]');
      if (next === typewriterSheet) return;
      typewriterLayout.disconnect(); typewriterSheet = next;
      if (next) typewriterLayout.observe(next, { childList: true, characterData: true, subtree: true });
    }
    const headChildren = new MutationObserver(watchTypewriter); headChildren.observe(document.head, { childList: true }); watchTypewriter();
    refresh();
    return Object.freeze({
      refresh,
      stats: () => ({ ...counters, active: !overlay.hidden && source.classList.contains('moye-source-colorized'), generation, scrollTop: source.scrollTop, scrollLeft: source.scrollLeft }),
      destroy() { if (disposed) return; disposed = true; generation++; clearTimeout(timer); offs.forEach(off => off()); resize.disconnect(); visibility.disconnect(); hostVisibility.disconnect(); typewriterLayout.disconnect(); headChildren.disconnect(); native('destroyed'); overlay.remove(); paint.replaceChildren(); paintedValue = null; },
    });
  }
  return Object.freeze({ install, tokenize, limits: Object.freeze({ maxChars: MAX_CHARS, maxTokens: MAX_TOKENS, maxLine: MAX_LINE, maxLexMs: MAX_LEX_MS }) });
});
