/* Bounded box/glue/penalty paragraph optimisation for the separate reading view.
   Independent implementation; not a TeX engine or TeX-identical layout claim. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeParagraphTypesetter = api;
})(typeof globalThis === 'object' ? globalThis : this, function (global) {
  'use strict';
  const openPunctuation = /^[（［｛〈《「『【〔〖〘〚‘“([{]$/u;
  const closePunctuation = /^[，。、；：？！）］｝〉》」』】〕〗〙〛’”.,;:!?\])}]$/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const word = /^[\p{L}\p{N}_\p{M}]+$/u;
  const maximumTokens = 700, maximumParagraphCharacters = 4096, maximumDocumentCharacters = 18000;
  const maximumApplyMilliseconds = 100, maximumParagraphMilliseconds = 45;
  const compressiblePunctuation = new Set([...'〈《「『【〔〖〘〚（［｛，、。；：！？〉》」』】〕〗〙〛）］｝']);
  const inlineTags = new Set(['A', 'STRONG', 'EM', 'B', 'I', 'S', 'DEL', 'MARK', 'U', 'SMALL', 'SUB', 'SUP', 'SPAN', 'ABBR', 'CITE']);
  const now = () => global.performance?.now?.() ?? Date.now();
  const originals = new WeakMap();
  const applications = new WeakMap();
  const copyStates = new Map();
  const copyNonce = global.crypto?.getRandomValues ? [...global.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(36)).join('-') : `${Math.random()}-${Date.now()}`;
  let copySerial = 0;
  let fontEpoch = 0, fontsObserved = false;
  const fitness = ratio => ratio < -0.5 ? 0 : ratio <= 0.5 ? 1 : ratio <= 1 ? 2 : 3;

  function breakLines(boxes, options = {}) {
    if (!Array.isArray(boxes) || !boxes.length || boxes.length > maximumTokens) return null;
    const width = Number(options.width), firstLineWidth = Number(options.firstLineWidth ?? width), tolerance = options.tolerance ?? 4;
    if (!(width > 0) || !(firstLineWidth > 0) || !Number.isFinite(width) || !Number.isFinite(firstLineWidth)) return null;
    const prefix = { width: [0], stretch: [0], shrink: [0] };
    for (const box of boxes) {
      if (!Number.isFinite(box.width) || box.width < 0) return null;
      for (const key of ['width', 'stretch', 'shrink']) prefix[key].push(prefix[key].at(-1) + (box[key] || 0));
    }
    const states = Array.from({ length: boxes.length + 1 }, () => new Map());
    states[0].set(1, { cost: 0, previous: null, end: 0, fitness: 1, lines: 0 });
    for (let end = 1; end <= boxes.length; end++) {
      if ((end & 7) === 0 && options.deadline !== undefined && (options.clock || now)() >= options.deadline) return null;
      if (end !== boxes.length && boxes[end - 1].breakAfter === false) continue;
      for (let start = end - 1; start >= 0; start--) {
        if (!states[start].size) continue;
        const last = end === boxes.length, available = start === 0 ? firstLineWidth : width;
        const natural = prefix.width[end] - prefix.width[start] - (boxes[end - 1].hang || 0) - (boxes[end - 1].boundaryGap || 0);
        const stretch = prefix.stretch[end] - prefix.stretch[start] - (boxes[end - 1].stretch || 0);
        const shrink = prefix.shrink[end] - prefix.shrink[start] - (boxes[end - 1].shrink || 0);
        const difference = available - natural;
        let ratio = difference >= 0 ? stretch > 0 ? difference / stretch : difference < 0.5 ? 0 : Infinity : shrink > 0 ? difference / shrink : -Infinity;
        if (last && difference >= 0) ratio = 0;
        if (ratio < -1 || ratio > tolerance || !Number.isFinite(ratio)) continue;
        const lineFitness = fitness(ratio), badness = Math.min(10000, 100 * Math.abs(ratio) ** 3);
        const penalty = Math.max(-9999, Math.min(9999, boxes[end - 1].penalty || 0));
        const lineCost = (10 + badness) ** 2 + (penalty >= 0 ? penalty ** 2 : -(penalty ** 2))
          + (last && start > 0 && natural < available * 0.15 ? 3000 : 0);
        for (const previous of states[start].values()) {
          const cost = previous.cost + lineCost + (Math.abs(lineFitness - previous.fitness) > 1 ? 10000 : 0);
          const old = states[end].get(lineFitness);
          if (!old || cost < old.cost) states[end].set(lineFitness, { cost, previous, start, end, fitness: lineFitness, ratio, natural, available, last, lines: previous.lines + 1 });
        }
      }
    }
    const endings = [...states[boxes.length].values()];
    if (!endings.length) return null;
    let best = endings.reduce((left, right) => left.cost <= right.cost ? left : right);
    const cost = best.cost, lines = [];
    while (best.previous) { const { start, end, ratio, natural, available, last } = best; lines.push({ start, end, ratio, natural, available, last }); best = best.previous; }
    lines.reverse();
    return { lines, cost, method: 'box-glue-penalty dynamic programming with adjacent fitness demerits' };
  }

  function tokenize(text) {
    const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    const graphemes = segmenter ? [...segmenter.segment(text)].map(part => ({ text: part.segment, start: part.index })) : [...text].reduce((all, character) => { all.push({ text: character, start: all.length ? all.at(-1).start + all.at(-1).text.length : 0 }); return all; }, []);
    const tokens = [];
    for (const part of graphemes) {
      const kind = /^ +$/.test(part.text) ? 'space' : cjk.test(part.text) ? 'cjk' : word.test(part.text) ? 'word' : 'symbol';
      const previous = tokens.at(-1);
      if (previous && kind === previous.kind && ['word', 'space'].includes(kind)) { previous.text += part.text; previous.end += part.text.length; }
      else tokens.push({ ...part, end: part.start + part.text.length, kind });
    }
    tokens.forEach((token, index) => {
      const next = tokens[index + 1];
      token.breakAfter = !next || !openPunctuation.test(token.text) && !closePunctuation.test(next.text)
        && (token.kind === 'space' || token.kind === 'cjk' || next.kind === 'cjk' || /[-/‐–—]$/.test(token.text));
    });
    return tokens;
  }

  function restore(root) {
    if (!root?.querySelectorAll) return;
    for (const key of applications.get(root)?.copyKeys || []) copyStates.delete(key);
    applications.delete(root);
    for (const paragraph of root.querySelectorAll('[data-moye-typeset]')) {
      const old = originals.get(paragraph); if (!old) continue;
      paragraph.replaceChildren(old.fragment.cloneNode(true));
      if (old.style === null) paragraph.removeAttribute('style'); else paragraph.setAttribute('style', old.style);
      if (old.type === null) delete paragraph.dataset.moyeTypeset; else paragraph.setAttribute('data-moye-typeset', old.type);
      if (old.originalCopyKey === null) delete paragraph.dataset.moyeTypesetCopyKey; else paragraph.setAttribute('data-moye-typeset-copy-key', old.originalCopyKey);
      copyStates.delete(old.copyKey); originals.delete(paragraph);
    }
  }
  // Full-width CJK marks only: decimal points, ASCII paths, Latin punctuation
  // and letters (including Japanese/Korean text) never enter this adjustment.
  function punctuationGeometry(text, naturalWidth, ink = {}) {
    if (!compressiblePunctuation.has(text) || !(naturalWidth > 0)) return null;
    const left = Number(ink.left), right = Number(ink.right), size = Number(ink.fontSize || naturalWidth);
    if (![left, right, size].every(Number.isFinite) || right <= left) return null;
    const inkWidth = right - left;
    const width = Math.max(naturalWidth * 0.5, inkWidth + Math.max(0.5, size * 0.06));
    if (width >= naturalWidth - 0.5) return null;
    return { naturalWidth, width, offset: (width - inkWidth) / 2 - left, inkWidth };
  }
  function protectedRanges(text) {
    // Treat quoted path atoms conservatively, including relative Windows paths
    // and filenames containing spaces. Exclusion affects display only.
    const expression = /"[^"\r\n]*[\\/][^"\r\n]*"|'[^'\r\n]*[\\/][^'\r\n]*'|(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"']+|[^\s<>"']*[\\/][^\s<>"']*/gu;
    return [...text.matchAll(expression)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  }
  function textNodes(element) {
    const nodes = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node, offset = 0;
    while ((node = walker.nextNode())) { nodes.push({ node, start: offset, end: offset + node.length }); offset += node.length; }
    return nodes;
  }
  function point(nodes, position, ending = false) {
    // End ranges at the preceding text node. Choosing the following node at
    // offset zero clones an empty link/ID into the previous line.
    const item = nodes.find(item => ending ? position > item.start && position <= item.end : position >= item.start && position < item.end) || nodes.at(-1);
    return { node: item.node, offset: Math.max(0, Math.min(item.node.length, position - item.start)) };
  }
  function inlineReason(paragraph) {
    const css = getComputedStyle(paragraph);
    if (css.direction !== 'ltr' || css.writingMode !== 'horizontal-tb') return 'unsupportedWritingDirection';
    const generated = element => ['::before', '::after'].some(pseudo => { const content = getComputedStyle(element, pseudo).content; return content && !['none', 'normal', '\"\"', "''"].includes(content); });
    if (generated(paragraph)) return 'generatedInlineContent';
    for (const element of paragraph.querySelectorAll('*')) {
      if (!inlineTags.has(element.tagName) || element.hasAttribute('contenteditable') || element.matches('[data-reading-alias-id],[data-reading-markdown],.katex,.language-math,.moye-reading-math-source,.moye-reading-rendered')) return 'unsupportedInlineContent';
      const style = getComputedStyle(element);
      if (style.display !== 'inline' || style.position !== 'static' || style.transform !== 'none' || style.direction !== 'ltr'
        || ['paddingLeft', 'paddingRight', 'marginLeft', 'marginRight', 'borderLeftWidth', 'borderRightWidth'].some(key => parseFloat(style[key]) !== 0)) return 'complexInlineGeometry';
      if (generated(element)) return 'generatedInlineContent';
    }
    return null;
  }
  function inlineMeasurer(paragraph) {
    const clone = paragraph.cloneNode(true), originalElements = [paragraph, ...paragraph.querySelectorAll('*')], cloneElements = [clone, ...clone.querySelectorAll('*')];
    const properties = ['font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontKerning', 'fontVariantCaps', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'wordSpacing', 'lineHeight', 'verticalAlign', 'textTransform'];
    originalElements.forEach((element, index) => {
      const css = getComputedStyle(element), target = cloneElements[index];
      target.removeAttribute('id'); target.removeAttribute('data-reading-source-id');
      for (const key of properties) if (css[key]) target.style[key] = css[key];
      Object.assign(target.style, { textAutospace: 'no-autospace', textSpacingTrim: 'space-all', whiteSpace: 'pre' });
    });
    Object.assign(clone.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', maxWidth: 'none', minWidth: '0', height: 'auto', margin: '0', padding: '0', border: '0', textIndent: '0', display: 'block', contentVisibility: 'visible' });
    clone.setAttribute('aria-hidden', 'true'); clone.dataset.moyeTypesetMeasure = '';
    document.body.append(clone);
    const nodes = textNodes(clone), range = document.createRange();
    return { measure(token) { const a = point(nodes, token.start), b = point(nodes, token.end, true); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset); return range.getBoundingClientRect().width; }, destroy() { clone.remove(); } };
  }
  function clonedInterval(paragraph, nodes, start, end, identifiers) {
    const a = point(nodes, start), b = point(nodes, end, true), range = document.createRange(); range.setStart(a.node, a.offset); range.setEnd(b.node, b.offset);
    let content = range.cloneContents(), ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType !== 1) ancestor = ancestor.parentElement;
    // Range omits common ancestors, including a strong/em/a around one token.
    while (ancestor && ancestor !== paragraph) { const wrapper = ancestor.cloneNode(false); wrapper.append(content); content = document.createDocumentFragment(); content.append(wrapper); ancestor = ancestor.parentElement; }
    for (const element of content.querySelectorAll('[id]')) {
      if (identifiers.has(element.id)) { element.removeAttribute('id'); element.removeAttribute('data-reading-source-id'); }
      else identifiers.add(element.id);
    }
    return content;
  }
  function rememberOriginal(paragraph) {
    const original = { fragment: document.createDocumentFragment(), style: paragraph.getAttribute('style'), type: paragraph.getAttribute('data-moye-typeset'), originalCopyKey: paragraph.getAttribute('data-moye-typeset-copy-key'), copyKey: `${copyNonce}-${++copySerial}`, origins: new Map() };
    for (const child of paragraph.childNodes) original.fragment.append(child.cloneNode(true));
    originals.set(paragraph, original);
    paragraph.dataset.moyeTypesetCopyKey = original.copyKey;
    for (const [index, element] of [...paragraph.querySelectorAll('*')].entries()) {
      const key = `${original.copyKey}-${index}`; original.origins.set(key, element.getAttribute('data-moye-typeset-origin')); element.dataset.moyeTypesetOrigin = key;
    }
    copyStates.set(original.copyKey, original); return original.copyKey;
  }
  function glyphBox(content, token) {
    if (!token.punctuation) return content;
    const glyph = document.createElement('span'); glyph.dataset.moyeTypesetGlyph = '';
    Object.assign(glyph.style, { display: 'inline-block', whiteSpace: 'pre', transform: `translateX(${token.punctuation.offset}px)`, textIndent: '0' });
    glyph.append(content); return glyph;
  }
  function apply(root, values = {}, options = {}) {
    const report = { algorithm: 'Knuth–Plass-style box/glue/penalty dynamic programming with DOM-shaped inline metrics; bounded, not TeX-identical', optimizedParagraphs: 0, compressedParagraphs: 0, compressedMarks: 0, fallbackParagraphs: 0, reasons: {}, maximumTokens, maximumParagraphCharacters, maximumDocumentCharacters, maximumApplyMilliseconds, maximumParagraphMilliseconds };
    if (!root?.querySelectorAll || root.isContentEditable || root.closest('[contenteditable="true"]')) { report.skippedEditable = true; return report; }
    if (!fontsObserved && document.fonts?.addEventListener) { fontsObserved = true; document.fonts.addEventListener('loadingdone', () => { fontEpoch++; }); }
    const signature = JSON.stringify([fontEpoch, root.clientWidth, ...['appearance.fontFamily', 'appearance.monospaceFontFamily', 'appearance.fontSize', 'appearance.contentWidth', 'appearance.lineHeight', 'typography.latinFontFamily', 'typography.cjkFontFamily', 'typography.cjkSpacing', 'typography.hangingPunctuation', 'typography.punctuationCompression', 'typography.paragraphStyle', 'typography.textAlign', 'markdown.preserveWhitespace'].map(key => values[key])]);
    const oldApplication = applications.get(root), children = [...root.children];
    if (!options.force && oldApplication?.signature === signature && oldApplication.text === root.textContent
      && oldApplication.children.length === children.length && children.every((child, index) => oldApplication.children[index] === child)
      && oldApplication.optimized.every(paragraph => paragraph.firstElementChild?.hasAttribute('data-moye-typeset-line'))) return { ...oldApplication.report, reused: true };
    restore(root);
    const optimal = values['typography.textAlign'] === 'optimal', compress = values['typography.punctuationCompression'] === true;
    if (!optimal && !compress) return report;
    const context = document.createElement('canvas').getContext('2d');
    const deadline = now() + maximumApplyMilliseconds;
    let documentCharacters = 0; const copyKeys = [];
    const fallback = reason => { report.fallbackParagraphs++; report.reasons[reason] = (report.reasons[reason] || 0) + 1; };
    const paragraphs = [...root.querySelectorAll(':scope > p, :scope > blockquote p, :scope > ul p, :scope > ol p')];
    for (const paragraph of paragraphs) {
      const text = paragraph.textContent;
      if (!text.trim()) continue;
      if (now() >= deadline) { fallback('boundedTimeBudget'); continue; }
      if (/[\t\r\n\p{Script=Arabic}\p{Script=Hebrew}\u202a-\u202e\u2066-\u2069]/u.test(text)) { fallback('complexInlineOrExplicitLineBreak'); continue; }
      const unsupported = inlineReason(paragraph);
      if (unsupported) { fallback(unsupported); continue; }
      if (text.length > maximumParagraphCharacters || documentCharacters + text.length > maximumDocumentCharacters) { fallback('boundedDocumentBudget'); continue; }
      const tokens = tokenize(text);
      if (tokens.length > maximumTokens || tokens.length < 2) { fallback('boundedTokenBudget'); continue; }
      if (!optimal && !tokens.some(token => compressiblePunctuation.has(token.text))) { fallback('noCompressibleMarks'); continue; }
      documentCharacters += text.length;
      const paragraphDeadline = Math.min(deadline, now() + maximumParagraphMilliseconds), nodes = textNodes(paragraph), protectedText = protectedRanges(text);
      for (const token of tokens) token.protectedPresentation = protectedText.some(item => token.start < item.end && token.end > item.start) || nodes.some(item => item.start < token.end && item.end > token.start && item.node.parentElement.closest('a,code,pre,kbd,samp'));
      const css = getComputedStyle(paragraph), size = parseFloat(css.fontSize) || 17;
      const width = paragraph.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0), indent = parseFloat(css.textIndent) || 0;
      let expired = false, measurement;
      try {
        measurement = inlineMeasurer(paragraph);
        for (const [tokenIndex, token] of tokens.entries()) {
          if ((tokenIndex & 15) === 0 && now() >= paragraphDeadline) { expired = true; break; }
          let measured = measurement.measure(token);
          if (token.kind === 'space' && values['markdown.preserveWhitespace'] === false) { if (context) { context.font = css.font || `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`; measured = context.measureText(' ').width + (parseFloat(css.wordSpacing) || 0); } }
          if (compress && context && compressiblePunctuation.has(token.text) && !token.protectedPresentation) {
            const items = nodes.filter(item => item.start < token.end && item.end > token.start);
            if (items.length === 1 && !items[0].node.parentElement.closest('a,code,pre,kbd,samp')) {
              const style = getComputedStyle(items[0].node.parentElement); context.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              const ink = context.measureText(token.text);
              token.punctuation = punctuationGeometry(token.text, measured, { left: -ink.actualBoundingBoxLeft, right: ink.actualBoundingBoxRight, fontSize: parseFloat(style.fontSize) || size });
            }
          }
          const next = tokens[tokenIndex + 1];
          token.boundaryGap = values['typography.cjkSpacing'] && next && !token.protectedPresentation && !next.protectedPresentation && (token.kind === 'cjk' && next.kind === 'word' || token.kind === 'word' && next.kind === 'cjk') ? size * 0.125 : 0;
          token.width = (token.punctuation?.width ?? measured) + token.boundaryGap;
          token.stretch = token.kind === 'space' ? Math.max(1, measured * 0.6) : token.kind === 'cjk' ? size * 0.12 : 0;
          token.shrink = token.kind === 'space' ? measured * 0.33 : token.kind === 'cjk' ? size * 0.035 : 0;
          token.hang = values['typography.hangingPunctuation'] && closePunctuation.test(token.text) ? Math.min(token.width * 0.5, size * 0.5) : 0;
          token.penalty = token.kind === 'space' ? 0 : /[-‐]$/.test(token.text) ? 50 : 0;
        }
      } finally { measurement?.destroy(); }
      if (expired) { fallback('boundedTimeBudget'); continue; }
      const result = optimal ? breakLines(tokens, { width, firstLineWidth: width - indent, deadline: paragraphDeadline }) : null;
      const chosen = result && result.lines.length >= 2;
      const compressed = tokens.filter(token => token.punctuation);
      if (!chosen && !compressed.length) { fallback(optimal ? result ? 'singleLine' : now() >= paragraphDeadline ? 'boundedTimeBudget' : 'noFeasibleOptimisation' : 'noCompressibleMarks'); continue; }
      copyKeys.push(rememberOriginal(paragraph));
      const fragment = document.createDocumentFragment(), identifiers = new Set();
      if (chosen) {
        result.lines.forEach((line, lineIndex) => {
          const lineElement = document.createElement('span'); lineElement.dataset.moyeTypesetLine = String(lineIndex);
          Object.assign(lineElement.style, { display: 'block', whiteSpace: 'nowrap', textAlign: 'start', textIndent: '0', marginInlineStart: lineIndex === 0 ? `${indent}px` : '0', lineHeight: 'inherit' });
          for (let index = line.start; index < line.end; index++) {
            const token = tokens[index], box = document.createElement('span'); box.dataset.moyeTypesetBox = '';
            box.append(glyphBox(clonedInterval(paragraph, nodes, token.start, token.end, identifiers), token));
            const adjustment = index === line.end - 1 || line.last ? 0 : line.ratio * (line.ratio >= 0 ? token.stretch : token.shrink);
            Object.assign(box.style, { display: 'inline-block', whiteSpace: 'pre', verticalAlign: 'baseline', width: `${Math.max(0, token.width + adjustment - (index === line.end - 1 ? token.boundaryGap : 0))}px`, textIndent: '0' });
            lineElement.append(box);
          }
          fragment.append(lineElement);
        });
      } else {
        // Browser wrapping remains intact when alignment is not optimised: only
        // marks receive boxes; words/URLs retain their original wrapping model.
        let start = 0;
        for (const token of compressed) {
          if (token.start > start) fragment.append(clonedInterval(paragraph, nodes, start, token.start, identifiers));
          const box = document.createElement('span'); box.dataset.moyeTypesetBox = '';
          Object.assign(box.style, { display: 'inline-block', whiteSpace: 'pre', verticalAlign: 'baseline', width: `${token.punctuation.width}px`, textIndent: '0' });
          box.append(glyphBox(clonedInterval(paragraph, nodes, token.start, token.end, identifiers), token)); fragment.append(box); start = token.end;
        }
        if (start < text.length) fragment.append(clonedInterval(paragraph, nodes, start, text.length, identifiers));
      }
      paragraph.replaceChildren(fragment); paragraph.style.textSpacingTrim = 'space-all'; paragraph.dataset.moyeTypeset = chosen ? 'optimal' : 'punctuation';
      if (chosen) { paragraph.style.textIndent = '0'; report.optimizedParagraphs++; }
      if (paragraph.textContent !== text) throw new Error('Paragraph optimisation changed document text.');
      if (compressed.length) { report.compressedParagraphs++; report.compressedMarks += compressed.length; }
    }
    applications.set(root, { signature, text: root.textContent, children: [...root.children], copyKeys, optimized: [...root.querySelectorAll('[data-moye-typeset="optimal"]')], report: { ...report } });
    return report;
  }
  function unwrapCopy(fragment) {
    if (!fragment?.querySelectorAll) return fragment;
    const paragraphs = [...(fragment.matches?.('[data-moye-typeset-copy-key]') ? [fragment] : []), ...fragment.querySelectorAll('[data-moye-typeset-copy-key]')];
    for (const paragraph of paragraphs) {
      // Source HTML cannot invent style restoration or merge identities: a
      // random key must resolve to state created by this live typesetter.
      const state = copyStates.get(paragraph.dataset.moyeTypesetCopyKey);
      if (!state) continue;
      for (const element of [...paragraph.querySelectorAll('[data-moye-typeset-line],[data-moye-typeset-box],[data-moye-typeset-glyph]')].reverse()) element.replaceWith(...element.childNodes);
      const identity = new Set(['id', 'data-reading-source-id', 'data-moye-typeset-origin']);
      const attributes = element => [...element.attributes].filter(attribute => !identity.has(attribute.name));
      function compatible(a, b) {
        const origin = a.dataset.moyeTypesetOrigin;
        if (!origin || origin !== b.dataset.moyeTypesetOrigin || !state.origins.has(origin)) return false;
        if (b.id && a.id !== b.id || b.dataset.readingSourceId && a.dataset.readingSourceId !== b.dataset.readingSourceId) return false;
        const left = attributes(a), right = attributes(b);
        return left.length === right.length && left.every(attribute => b.getAttribute(attribute.name) === attribute.value);
      }
      function merge(parent) {
        for (const child of [...parent.children]) merge(child);
        let child = parent.firstChild;
        while (child) {
          const next = child.nextSibling;
          if (next && child.nodeType === 1 && next.nodeType === 1 && inlineTags.has(child.tagName) && child.tagName === next.tagName && compatible(child, next)) {
            child.append(...next.childNodes); next.remove(); merge(child); continue;
          }
          child = next;
        }
        parent.normalize();
      }
      merge(paragraph);
      for (const element of paragraph.querySelectorAll('[data-moye-typeset-origin]')) {
        const origin = element.dataset.moyeTypesetOrigin;
        if (!state.origins.has(origin)) continue;
        const previous = state.origins.get(origin);
        if (previous === null) delete element.dataset.moyeTypesetOrigin; else element.setAttribute('data-moye-typeset-origin', previous);
      }
      if (state.style === null) paragraph.removeAttribute('style'); else paragraph.setAttribute('style', state.style);
      if (state.type === null) delete paragraph.dataset.moyeTypeset; else paragraph.setAttribute('data-moye-typeset', state.type);
      if (state.originalCopyKey === null) delete paragraph.dataset.moyeTypesetCopyKey; else paragraph.setAttribute('data-moye-typeset-copy-key', state.originalCopyKey);
    }
    return fragment;
  }
  function invalidate(root) { applications.delete(root); }
  return Object.freeze({ tokenize, breakLines, punctuationGeometry, protectedRanges, apply, restore, invalidate, unwrapCopy, maximumTokens, maximumParagraphCharacters, maximumDocumentCharacters, maximumApplyMilliseconds, maximumParagraphMilliseconds });
});
