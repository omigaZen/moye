/* Extra TeX delimiters are interpreted only in the separate reading surface.
   The editor source, active MathJax input jax and undo stack are never changed. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeMathReadingSyntax = api;
})(typeof globalThis === 'object' ? globalThis : this, function (global) {
  'use strict';
  const maximumSourceCharacters = 2 * 1024 * 1024, maximumFormulaCharacters = 4096, maximumAliases = 512;
  const maximumRenderFormulas = 512, maximumRenderCharacters = 65536;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  let renderSerial = 0, katexLoading = null;
  function escaped(source, index) { let slashes = 0; while (index > 0 && source[--index] === '\\') slashes++; return slashes % 2 === 1; }
  function tagAt(source, index) {
    if (source[index] !== '<') return null;
    const start = /^<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/.exec(source.slice(index, index + 160));
    if (!start) return null;
    let quote = null, end = index + start[0].length;
    while (end < source.length && end - index <= 16384) {
      const character = source[end++];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') return { name: start[1].toLowerCase(), end, close: source[index + 1] === '/', self: /\/\s*>$/.test(source.slice(index, end)) || voidTags.has(start[1].toLowerCase()) };
    }
    return null;
  }
  function prepare(value, options = {}) {
    const source = String(value ?? '');
    const result = { markdown: source, aliases: [], nativeMath: [], metadata: { sourceLength: source.length, sourceUnchanged: true, readingOnly: true, protectedRanges: 0, skipped: {}, maximumSourceCharacters, maximumFormulaCharacters, maximumAliases } };
    if (source.length > maximumSourceCharacters) { result.metadata.skipped.sourceBudget = 1; return result; }
    const mask = new Uint8Array(source.length), protect = (start, end, kind = 1) => { for (let index = start; index < end; index++) mask[index] |= kind; result.metadata.protectedRanges++; };
    const inline = (options.inline ?? options['markdown.inlineMath']) !== false, display = (options.display ?? options['markdown.mathBlock']) !== false;
    const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0].length);
    let fence = null, frontmatter = lines[0] && /^\uFEFF?---[ \t]*(?:\r?\n|\r|$)/.test(lines[0][0]) ? { start: 0 } : null;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex], raw = line[0], text = raw.replace(/[\r\n]+$/, ''), start = line.index, end = start + raw.length;
      if (frontmatter) { protect(start, end); if (lineIndex > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(text)) frontmatter = null; continue; }
      const opening = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})([^\r\n]*)$/.exec(text);
      if (fence) {
        protect(start, end);
        const closing = /^[ \t]*(?:>[ \t]*)*(`+|~+)[ \t]*$/.exec(text);
        if (closing && closing[1][0] === fence.mark && closing[1].length >= fence.length) {
          if (fence.language === 'math') result.nativeMath.push({ kind: 'fence', display: true, start: fence.start, end, source: source.slice(fence.start, end).replace(/(?:\r\n|\r|\n)$/, ''), tex: source.slice(fence.bodyStart, start).replace(/(?:\r\n|\r|\n)$/, '') });
          fence = null;
        }
        continue;
      }
      if (opening) { protect(start, end); fence = { mark: opening[1][0], length: opening[1].length, language: opening[2].trim().split(/\s/)[0].toLowerCase(), start, bodyStart: end }; continue; }
      if (/^(?: {4}|\t)/.test(text) || /^[ \t]{0,3}\[(?!\^)[^\]\r\n]+\]:/.test(text)) protect(start, end);
    }
    // Exact-run lookups keep unmatched backticks linear rather than repeatedly
    // searching the remaining document. Code precedes HTML classification.
    const ticks = [...source.matchAll(/`+/g)].filter(match => !mask[match.index]), nextTick = new Map();
    for (let index = ticks.length - 1; index >= 0; index--) { const tick = ticks[index]; tick.next = nextTick.get(tick[0].length); nextTick.set(tick[0].length, tick); }
    for (const tick of ticks) if (!mask[tick.index] && !escaped(source, tick.index) && tick.next) protect(tick.index, tick.next.index + tick[0].length);
    // Mask HTML regions, including attributes and nested/raw element content.
    for (let index = 0; index < source.length; index++) {
      if (mask[index] || source[index] !== '<' || escaped(source, index)) continue;
      if (source.startsWith('<!--', index)) { const close = source.indexOf('-->', index + 4), end = close < 0 ? source.length : close + 3; protect(index, end); index = end - 1; continue; }
      if (source.startsWith('<![CDATA[', index)) { const close = source.indexOf(']]>', index + 9), end = close < 0 ? source.length : close + 3; protect(index, end); index = end - 1; continue; }
      if (/^<(?:![A-Za-z]|\?)/.test(source.slice(index, index + 4))) {
        let quote = null, brackets = 0, end = index + 2;
        for (; end < source.length; end++) {
          const character = source[end];
          if (quote) { if (character === quote) quote = null; }
          else if (character === '"' || character === "'") quote = character;
          else if (character === '[') brackets++;
          else if (character === ']') brackets = Math.max(0, brackets - 1);
          else if (character === '>' && !brackets) { end++; break; }
        }
        protect(index, end); index = end - 1; continue;
      }
      if (/^<(?:https?:|mailto:|file:)/i.test(source.slice(index, index + 16))) { const close = source.indexOf('>', index + 1); if (close >= 0) { protect(index, close + 1); index = close; } continue; }
      const tag = tagAt(source, index); if (!tag) continue;
      let end = tag.end;
      if (!tag.close && !tag.self) {
        let depth = 1, next = end;
        while (depth && (next = source.indexOf('<', next)) >= 0) {
          const candidate = tagAt(source, next);
          if (candidate?.name === tag.name) depth += candidate.close ? -1 : candidate.self ? 0 : 1;
          next = candidate?.end || next + 1;
          if (!depth) end = next;
        }
        if (depth) end = source.length;
      }
      protect(index, end); index = end - 1;
    }
    for (const match of source.matchAll(/\b(?:https?:\/\/|ftp:\/\/|file:\/\/|mailto:)[^\s<>]+/gi)) protect(match.index, match.index + match[0].length, 2);
    for (let index = 0; index < source.length - 1; index++) {
      if (mask[index] || source[index] !== '!' || source[index + 1] !== '[' || escaped(source, index)) continue;
      let depth = 1, end = index + 2;
      for (; end < source.length && depth; end++) { if (!escaped(source, end)) { if (source[end] === '[') depth++; else if (source[end] === ']') depth--; } }
      if (!depth) { protect(index, end - 1); index = end - 1; }
    }
    let scanBudget = source.length * 8 + 1024;
    // Markdown destinations/titles are literal; image labels are literal too.
    for (let index = 0; index < source.length - 1; index++) {
      if (mask[index] || source[index] !== ']' || source[index + 1] !== '(' || escaped(source, index)) continue;
      let depth = 1, end = index + 2;
      for (; end < source.length && depth; end++) {
        if (--scanBudget < 0) { protect(index, source.length); result.metadata.skipped.scanBudget = 1; break; }
        if (escaped(source, end)) continue;
        if (source[end] === '(') depth++; else if (source[end] === ')') depth--;
        if (source[end] === '\n' && source[end + 1] === '\n') break;
      }
      if (scanBudget < 0) break;
      if (depth) continue;
      let start = index + 1;
      const labelStart = source.lastIndexOf('[', index);
      if (labelStart > 0 && source[labelStart - 1] === '!' && !escaped(source, labelStart - 1)) start = labelStart - 1;
      protect(start, end); index = end - 1;
    }
    // Existing dollar-delimited math is not recursively normalised. Recording
    // it also lets the unified reading renderer retain its original delimiters.
    for (let index = 0; index < source.length; index++) {
      if (mask[index] || source[index] !== '$' || escaped(source, index)) continue;
      const length = source[index + 1] === '$' ? 2 : 1, marker = '$'.repeat(length), start = index;
      if (length === 1 && /\s/.test(source[index + 1] || ' ')) continue;
      let next = index + length, end = -1;
      while ((next = source.indexOf(marker, next)) >= 0) {
        if (--scanBudget < 0) { protect(index, source.length); result.metadata.skipped.scanBudget = 1; break; }
        if (!mask[next] && !escaped(source, next) && (length === 2 || source[next + 1] !== '$' && !/\s/.test(source[next - 1] || ' ') && !/\d/.test(source[next + 1] || ''))) { end = next + length; break; }
        next += length;
      }
      if (scanBudget < 0) break;
      if (end >= 0) {
        protect(start, end); result.nativeMath.push({ kind: 'dollar', display: length === 2, start, end, source: source.slice(start, end), tex: source.slice(start + length, end - length) }); index = end - 1;
      }
    }
    let hash = 2166136261; for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
    let nonce = 0, prefix;
    do { prefix = `MOYEMATHREADING${(hash >>> 0).toString(16)}X${nonce++}Q`; } while (source.includes(prefix) && nonce < 1024);
    if (source.includes(prefix)) { result.metadata.skipped.tokenCollisionBudget = 1; return result; }
    result.metadata.tokenPrefix = prefix;
    const parts = []; let previous = 0;
    for (let index = 0; index < source.length - 1 && result.aliases.length < maximumAliases; index++) {
      if (mask[index] || source[index] !== '\\' || escaped(source, index) || !['(', '['].includes(source[index + 1])) continue;
      const isDisplay = source[index + 1] === '['; if (isDisplay ? !display : !inline) continue;
      const close = isDisplay ? ']' : ')', start = index;
      let next = index + 2, end = -1, ambiguous = false;
      for (; next < source.length - 1 && next - index <= maximumFormulaCharacters + 2; next++) {
        if (mask[next] & 1) { ambiguous = true; break; }
        if (!isDisplay && /[\r\n]/.test(source[next])) { ambiguous = true; break; }
        if (source[next] === '\\' && !escaped(source, next)) {
          if (source[next + 1] === close) { end = next + 2; break; }
          if (['(', '['].includes(source[next + 1])) { ambiguous = true; break; }
        }
      }
      if (end < 0 || ambiguous) continue;
      const tex = source.slice(start + 2, end - 2);
      if (!tex.trim() || /\n[ \t]*\n/.test(tex)) continue;
      const id = result.aliases.length, token = `${prefix}${id}END`;
      result.aliases.push({ id, token, source: source.slice(start, end), tex, display: isDisplay, start, end });
      parts.push(source.slice(previous, start), token); previous = end; index = end - 1;
    }
    if (result.aliases.length) { parts.push(source.slice(previous)); result.markdown = parts.join(''); }
    result.nativeMath.sort((a, b) => a.start - b.start);
    return result;
  }
  function decorate(container, prepared) {
    if (!container?.querySelectorAll || !prepared) return [];
    const aliases = new Map((prepared.aliases || []).map(alias => [alias.token, alias])), prefix = prepared.metadata?.tokenPrefix;
    const pattern = new RegExp(prefix + '[0-9]+END', 'g');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT), texts = []; let current;
    while (aliases.size && (current = walker.nextNode())) if (current.textContent.includes(prefix) && !current.parentElement.closest('script,style,code,pre')) texts.push(current);
    const nodes = [];
    for (const text of texts) {
      const fragment = document.createDocumentFragment(); let previous = 0;
      for (const match of text.textContent.matchAll(pattern)) {
        const alias = aliases.get(match[0]); if (!alias) continue;
        fragment.append(document.createTextNode(text.textContent.slice(previous, match.index)));
        const node = document.createElement('span'); node.className = 'language-math moye-reading-math-alias'; node.dataset.readingAliasId = String(alias.id); node.dataset.readingTex = alias.tex; node.dataset.readingDisplay = String(alias.display); node.dataset.readingMarkdown = alias.source; node.setAttribute('aria-label', '公式源码'); node.textContent = alias.source;
        node.style.display = alias.display ? 'block' : 'inline-block'; node.style.maxWidth = '100%'; node.style.overflowX = 'auto';
        fragment.append(node); nodes.push(node); previous = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(text.textContent.slice(previous))); text.replaceWith(fragment);
    }
    for (const node of nodes) {
      const parent = node.parentElement;
      if (node.dataset.readingDisplay === 'true' && parent?.tagName === 'P' && parent.textContent.trim() === node.textContent.trim() && parent.children.length === 1) {
        const block = document.createElement('div'); for (const attribute of [...node.attributes]) block.setAttribute(attribute.name, attribute.value); block.append(...node.childNodes); parent.replaceWith(block); nodes[nodes.indexOf(node)] = block;
      }
    }
    const used = new Set();
    for (const node of container.querySelectorAll('.language-math:not([data-reading-alias-id])')) {
      const fence = node.parentElement?.tagName === 'PRE', display = fence || node.tagName === 'DIV', text = node.textContent;
      const original = (prepared.nativeMath || []).find(item => !used.has(item) && (fence ? item.kind === 'fence' : item.kind === 'dollar' && item.display === display) && item.tex.trim() === text.trim());
      if (original) { used.add(original); node.dataset.readingMarkdown = original.source; }
    }
    return nodes;
  }

  async function katex(cdn) {
    if (global.katex) return global.katex;
    if (katexLoading) return katexLoading;
    if (typeof cdn !== 'string' || !cdn.startsWith('file:')) throw new Error('缺少本地 KaTeX 资源。');
    const load = (filename, id) => new Promise((resolve, reject) => {
      let script = document.getElementById(id); if (!script) { script = document.createElement('script'); script.id = id; script.src = cdn.replace(/\/$/, '') + '/dist/js/katex/' + filename; document.head.append(script); }
      if (script.dataset.moyeLoaded === 'true') { resolve(); return; }
      const timeout = setTimeout(() => { cleanup(); reject(new Error('本地 KaTeX 加载超时。')); }, 10000);
      const cleanup = () => { clearTimeout(timeout); script.removeEventListener('load', loaded); script.removeEventListener('error', failed); };
      const loaded = () => { script.dataset.moyeLoaded = 'true'; cleanup(); resolve(); }, failed = () => { cleanup(); reject(new Error('本地 KaTeX 加载失败。')); };
      script.addEventListener('load', loaded); script.addEventListener('error', failed);
    });
    katexLoading = (async () => {
      if (!document.getElementById('vditorKatexStyle')) { const style = document.createElement('link'); style.id = 'vditorKatexStyle'; style.rel = 'stylesheet'; style.href = cdn.replace(/\/$/, '') + '/dist/js/katex/katex.min.css'; document.head.append(style); }
      await load('katex.min.js', 'vditorKatexScript'); await load('mhchem.min.js', 'vditorKatexChemScript');
      if (!global.katex) throw new Error('KaTeX 未就绪。'); return global.katex;
    })();
    try { return await katexLoading; } finally { katexLoading = null; }
  }
  function namespaceMath(container, prefix) {
    const ids = new Map();
    for (const node of container.querySelectorAll('[id]')) { const before = node.id; node.id = prefix + before; ids.set(before, node.id); }
    for (const node of container.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['srcdoc', 'contenteditable', 'tabindex'].includes(attribute.name)) { node.removeAttribute(attribute.name); continue; }
      let value = attribute.value;
      if (['href', 'xlink:href'].includes(attribute.name) && value.startsWith('#') && ids.has(value.slice(1))) value = '#' + ids.get(value.slice(1));
      value = value.replace(/url\(#([^\s)]+)\)/g, (match, id) => ids.has(id) ? `url(#${ids.get(id)})` : match);
      if (['href', 'xlink:href'].includes(attribute.name) && /^(?:javascript|data|vbscript):/i.test(value)) node.removeAttribute(attribute.name); else if (value !== attribute.value) node.setAttribute(attribute.name, value);
    }
  }
  async function render(container, values = {}, options = {}) {
    const report = { engine: values['math.engine'] || options.math?.engine || 'MathJax', rendered: 0, errors: [], skipped: 0, isolated: true,
      budget: { maximumFormulaCharacters, maximumRenderFormulas, maximumRenderCharacters, attempted: 0, characters: 0, rejected: 0 } };
    const nodes = Array.isArray(container) ? container : [...(container?.querySelectorAll?.('.language-math') || [])];
    const selected = nodes.filter(node => {
      const fence = node.parentElement?.tagName === 'PRE';
      if (fence && values['markdown.codeBlockMath'] === false || !fence && (node.dataset.readingDisplay === 'true' || node.tagName === 'DIV') && values['markdown.mathBlock'] === false) { report.skipped++; return false; }
      return true;
    });
    if (!selected.length) return report;
    // Account for every syntax, including ordinary dollar and math-fence nodes.
    // A rejected long formula does not spend a later valid sibling's allowance.
    const entries = selected.map(node => {
      const fence = node.parentElement?.tagName === 'PRE', display = node.dataset.readingDisplay === 'true' || fence || node.tagName === 'DIV';
      const tex = String(node.dataset.readingTex ?? node.textContent ?? '');
      const original = node.dataset.readingMarkdown || (fence ? '```math\n' + tex + '\n```' : display ? '$$\n' + tex + '\n$$' : '$' + tex + '$');
      let budgetError;
      if (tex.length > maximumFormulaCharacters) budgetError = { code: 'formula-characters', message: `单个阅读公式超过 ${maximumFormulaCharacters} 个 UTF-16 单元，保留源码。` };
      else if (report.budget.attempted >= maximumRenderFormulas) budgetError = { code: 'formula-count', message: `阅读公式渲染次数超过 ${maximumRenderFormulas}，保留源码。` };
      else if (report.budget.characters + tex.length > maximumRenderCharacters) budgetError = { code: 'document-characters', message: `阅读公式总字符预算超过 ${maximumRenderCharacters} 个 UTF-16 单元，保留源码。` };
      else { report.budget.attempted++; report.budget.characters += tex.length; }
      return { node, fence, display, tex, original, budgetError };
    });
    let converter;
    if (entries.some(entry => !entry.budgetError)) try {
      if (report.engine === 'KaTeX') {
        const engine = await katex(options.cdn);
        const raw = options.math?.macros || global.MoyeMath?.previewOptions({ engine: 'KaTeX', macros: values['math.macros'] || '{}' }).macros || {};
        const macros = JSON.parse(JSON.stringify(raw));
        converter = async (tex, display) => { const node = document.createElement('span'); node.innerHTML = engine.renderToString(tex, { displayMode: display, output: 'html', macros, trust: false, throwOnError: true }); return node; };
      } else {
        // The reading/export surface may be entered before any IR formula was
        // rendered. Wait for the pinned local loader instead of relying on an
        // already populated editor preview. Existing input jax are untouched.
        if (!global.MathJax?.startup?.promise && global.MoyeMath?.configure) await global.MoyeMath.configure({ cdn: options.cdn, engine: 'MathJax', macros: values['math.macros'] || '{}', autoNumber: values['math.autoNumber'] === true, numberingStyle: values['math.numberingStyle'] || 'all', physics: values['math.physics'] === true });
        const mathjax = global.MathJax; if (!mathjax?.startup?.promise) throw new Error('MathJax 未就绪。');
        await mathjax.startup.promise;
        const startup = mathjax.startup, TeX = startup.constructors.tex, SVG = startup.constructors.svg;
        if (!TeX || !SVG || !startup.mathjax?.document) throw new Error('当前 MathJax 组件不支持隔离阅读渲染。');
        const tags = values['math.autoNumber'] ? values['math.numberingStyle'] || 'all' : 'none';
        // Reading promises source fallback for invalid TeX. The default
        // noundefined/noerrors packages instead paint an unknown command or
        // its source as successful math, hiding a parse failure from callers.
        const packages = mathjax.config.tex.packages.filter(name => !['noundefined', 'noerrors'].includes(name));
        const input = new TeX({ ...mathjax.config.tex, packages, macros: global.MoyeMath?.macrosFrom(values['math.macros'] || '{}') || {}, tags });
        const output = new SVG({ ...mathjax.config.svg, fontCache: 'local' });
        const document = startup.mathjax.document(global.document, { ...mathjax.config.options, InputJax: input, OutputJax: output });
        converter = (tex, display) => document.convertPromise(tex, { display, format: 'TeX' });
      }
    } catch (error) { report.errors.push({ stage: 'initialise', message: error.message }); }
    const prefix = `moye-reading-isolated-math-${++renderSerial}-`;
    for (const [index, entry] of entries.entries()) {
      let { node } = entry;
      if (options.isCurrent && !options.isCurrent()) { report.stale = true; break; }
      const { fence, display, tex, original, budgetError } = entry;
      node.dataset.readingMarkdown = original; node.dataset.readingTex = tex;
      if (budgetError) {
        node.textContent = original; node.classList.remove('moye-reading-rendered'); node.classList.add('moye-reading-math-source', 'vditor-reset--error'); node.setAttribute('aria-label', '公式源码，超出阅读限制'); node.title = budgetError.message;
        report.skipped++; report.budget.rejected++; report.errors.push({ index, stage: 'budget', ...budgetError }); continue;
      }
      try {
        if (!converter) throw new Error(report.errors[0]?.message || '公式渲染器不可用。');
        const rendered = await converter(tex, display);
        if (options.isCurrent && !options.isCurrent()) { report.stale = true; break; }
        const error = rendered.querySelector?.('[data-mjx-error],[data-mml-node="merror"],.katex-error');
        if (error) throw new Error(error.getAttribute('data-mjx-error') || error.textContent || '公式语法错误。');
        namespaceMath(rendered, `${prefix}${index}-`);
        if (fence) {
          const block = document.createElement('div'); for (const attribute of [...node.attributes]) block.setAttribute(attribute.name, attribute.value);
          node.parentElement.replaceWith(block); node = block;
        }
        node.replaceChildren(rendered); node.classList.remove('moye-reading-math-source', 'vditor-reset--error'); node.classList.add('moye-reading-rendered'); node.setAttribute('aria-label', '数学公式');
        node.dataset.readingDisplay = String(display); node.style.overflowX = 'auto'; node.style.maxWidth = '100%';
        report.rendered++;
      } catch (error) {
        node.textContent = original; node.classList.remove('moye-reading-rendered'); node.classList.add('moye-reading-math-source', 'vditor-reset--error'); node.setAttribute('aria-label', '公式源码，渲染失败'); node.title = error.message; report.errors.push({ index, message: error.message });
      }
    }
    options.onRendered?.(report); return report;
  }
  return Object.freeze({ prepare, decorate, render, namespaceMath, maximumSourceCharacters, maximumFormulaCharacters, maximumAliases, maximumRenderFormulas, maximumRenderCharacters });
});
