(function (root) {
  'use strict';
  const removedTags = new Set(['SCRIPT','IFRAME','FRAME','FRAMESET','OBJECT','EMBED','BASE','META','LINK','FORM','BUTTON','TEXTAREA','SELECT','AUDIO','VIDEO','SOURCE']);
  function safeUrl(raw, base, { image = false } = {}) {
    if (!raw) return '';
    if (!image && raw.startsWith('#')) return raw;
    try { const url = new URL(raw, base); if (image) return ['file:','data:','http:','https:'].includes(url.protocol) ? url.href : ''; return ['file:','http:','https:','mailto:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function rebaseCss(css, base) {
    return css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (match, quote, value) => {
      if (value.startsWith('#') || value.startsWith('data:')) return match;
      try { const url = new URL(value, base); return url.protocol === 'file:' ? `url("${url.href.replace(/"/g,'%22')}")` : 'url("")'; } catch { return 'url("")'; }
    });
  }
  function stylesFromDocument(document) {
    const output = [], seen = new Set();
    function visit(sheet) {
      if (!sheet || seen.has(sheet)) return; seen.add(sheet);
      let rules; try { rules = sheet.cssRules; } catch { return; }
      for (const rule of rules) {
        if (rule.type === 3) { visit(rule.styleSheet); continue; }
        const selector = rule.selectorText;
        if (selector && selector.split(',').every(part => /\.(?:app-header|brand|sidebar|statusbar|more-menu|find-bar|toast|workspace-tabs|document-tab|moye-settings|moye-workspace|moye-image-viewer|moye-table-tools)(?:\b|__)/.test(part))) continue;
        const css = rebaseCss(rule.cssText, sheet.href || document.baseURI);
        if (!/@import\b|<\/style/i.test(css)) output.push(css);
      }
    }
    [...document.styleSheets].forEach(visit);
    return output.join('\n');
  }
  function removePresentationOnlyLayout(clone) {
    // Paragraph line boxes and formula scaling were measured for the reading
    // viewport. A PDF page or a phone-width PNG must lay out these runs anew.
    if (typeof root.MoyeParagraphTypesetter?.unwrapCopy === 'function') root.MoyeParagraphTypesetter.unwrapCopy(clone);
    else {
      for (const node of [...clone.querySelectorAll('[data-moye-typeset-line],[data-moye-typeset-box],[data-moye-typeset-glyph]')].reverse()) node.replaceWith(...node.childNodes);
      for (const paragraph of clone.querySelectorAll('[data-moye-typeset]')) {
        // Do not restore arbitrary CSS from document-controlled data fields.
        // The live typesetter knows its own private original-style records.
        paragraph.style.removeProperty('text-indent'); paragraph.style.removeProperty('text-spacing-trim');
        delete paragraph.dataset.moyeTypeset; delete paragraph.dataset.moyeTypesetOriginalStyle; delete paragraph.dataset.moyeTypesetHadStyle;
      }
    }
    for (const math of clone.querySelectorAll('[data-math-scale]')) { math.style.removeProperty('font-size'); delete math.dataset.mathScale; }
    for (const node of clone.querySelectorAll('[data-export-ignore],.moye-reading__next,.moye-reading-virtual-spacer,[data-reading-spacer]')) node.remove();
  }
  function repairLocalReferences(clone) {
    const ids = new Set([...clone.querySelectorAll('[id]')].map(node => node.id));
    if (clone.id) ids.add(clone.id);
    const aliases = new Map();
    for (const node of clone.querySelectorAll('[data-reading-source-id]')) if (!aliases.has(node.dataset.readingSourceId)) aliases.set(node.dataset.readingSourceId, node.id);
    for (const link of clone.querySelectorAll('a[href^="#"]')) {
      const raw = link.getAttribute('href').slice(1);
      let decoded = raw; try { decoded = decodeURIComponent(raw); } catch { /* A literal percent sign is legal in an ID. */ }
      const id = [decoded, raw].find(candidate => ids.has(candidate));
      const target = id || aliases.get(decoded) || aliases.get(raw);
      if (target) link.setAttribute('href', '#' + encodeURIComponent(target));
    }
  }
  function vectorizeHtmlMath(clone, sourceStyle) {
    const formulas = [...clone.querySelectorAll('.katex-display')].filter(node => !node.closest('svg'));
    if (!formulas.length) return;
    // Unlike MathJax SVG, KaTeX HTML cannot shrink as one replaced element when
    // the final paper is narrower than the reading column. Wrap its *passive*
    // HTML in an SVG viewport so the print renderer can preserve its full ratio.
    const document = clone.ownerDocument, view = document.defaultView;
    const probe = document.createElement('div'); probe.className = 'vditor-reset'; probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, { position: 'fixed', left: '-100000px', top: '0', width: 'max-content', maxWidth: 'none', visibility: 'hidden', pointerEvents: 'none', fontFamily: sourceStyle.fontFamily, fontSize: sourceStyle.fontSize, lineHeight: sourceStyle.lineHeight });
    document.body.append(probe); const deadline = view.performance.now() + 2500;
    try {
      for (const formula of formulas) {
        if (view.performance.now() > deadline) throw new RangeError('公式导出布局超过限额，请分段导出。');
        const measured = formula.cloneNode(true);
        Object.assign(measured.style, { margin: '0', width: 'max-content', maxWidth: 'none', overflow: 'visible', textAlign: 'left' });
        probe.replaceChildren(measured);
        const bounds = measured.getBoundingClientRect();
        const width = Math.ceil(Math.max(bounds.width, measured.scrollWidth)), height = Math.ceil(Math.max(bounds.height, measured.scrollHeight));
        if (!(width > 0 && height > 0) || width * height > 32 * 1024 * 1024) throw new RangeError('公式导出尺寸超过限额，请拆分公式或分段导出。');
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('moye-export-formula'); svg.setAttribute('viewBox', `0 0 ${width + 2} ${height + 2}`); svg.setAttribute('width', String(width + 2)); svg.setAttribute('height', String(height + 2)); svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject'); foreign.setAttribute('x', '1'); foreign.setAttribute('y', '1'); foreign.setAttribute('width', String(width)); foreign.setAttribute('height', String(height));
        const html = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'); html.style.fontSize = sourceStyle.fontSize; html.style.lineHeight = sourceStyle.lineHeight; html.style.width = `${width}px`; html.style.height = `${height}px`;
        html.append(measured); foreign.append(html); svg.append(foreign); formula.replaceWith(svg);
      }
    } finally { probe.remove(); }
  }
  function availablePixels(original, document) {
    if (!original?.complete || !original.naturalWidth || !original.naturalHeight || original.naturalWidth * original.naturalHeight > 20 * 1024 * 1024) throw new Error('图片像素不可用。');
    const canvas = document.createElement('canvas'); canvas.width = original.naturalWidth; canvas.height = original.naturalHeight;
    canvas.getContext('2d').drawImage(original, 0, 0); const data = canvas.toDataURL('image/png');
    if (!data.startsWith('data:image/png;base64,')) throw new Error('图片像素尺寸无法复用。'); return data;
  }
  async function capture({ element, styleElement, checkResources, title = '墨页文档', values = {}, theme = 'current' } = {}) {
    if (!['paper','current'].includes(theme)) throw new TypeError('导出主题无效。');
    if (!element?.cloneNode || element.nodeType !== 1) throw new TypeError('需要完整的阅读内容。');
    if (element.dataset.readingVirtual === 'true') throw new TypeError('请先生成完整阅读快照，不能只导出当前章节窗口。');
    const layoutElement = styleElement || element;
    if (!layoutElement?.isConnected || layoutElement.ownerDocument !== element.ownerDocument) throw new TypeError('需要同一文档内已呈现的阅读样式。');
    const document = element.ownerDocument, view = document.defaultView;
    const text = value => root.MoyeI18n?.active?.t ? root.MoyeI18n.active.t(value) : root.MoyeI18n?.t ? root.MoyeI18n.t(value, values['ui.language'] || 'zh-CN', view.navigator.language) : value;
    if (document.fonts?.status === 'loading') await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))]);
    const clone = element.cloneNode(true), warnings = [];
    // Pair nodes before removing controls/presentation wrappers. Positional
    // cursors after cleanup can copy a different image's pixels or error state.
    const originalImages = [...element.querySelectorAll('img')], imageSources = new WeakMap();
    [...clone.querySelectorAll('img')].forEach((node, index) => imageSources.set(node, originalImages[index]));
    const sourceStyle = view.getComputedStyle(layoutElement);
    removePresentationOnlyLayout(clone);
    vectorizeHtmlMath(clone, sourceStyle);
    repairLocalReferences(clone);
    const selectedImageUrl = node => safeUrl(imageSources.get(node)?.currentSrc || node.getAttribute('src'), document.baseURI, { image: true });
    const fileUrls = [...new Set([...clone.querySelectorAll('img')].map(selectedImageUrl).filter(url => url.startsWith('file:')))];
    const nativeCheck = typeof checkResources === 'function' ? checkResources : root.desktop?.checkExportResources ? urls => root.desktop.checkExportResources({ urls }) : null;
    const allowedFiles = new Map();
    if (nativeCheck) {
      for (let index = 0; index < fileUrls.length; index += 512) {
        const batch = fileUrls.slice(index, index + 512), short = batch.filter(url => url.length <= 16384);
        let result; try { result = short.length ? await nativeCheck(short) : []; } catch { result = null; }
        if (!Array.isArray(result) || result.length !== short.length || result.some(value => typeof value !== 'boolean')) { result = short.map(() => false); warnings.push('部分图像改用当前显示的像素，无法复用的图像将保留说明。'); }
        short.forEach((url, offset) => allowedFiles.set(url, result[offset])); batch.filter(url => url.length > 16384).forEach(url => allowedFiles.set(url, false));
      }
    } else {
      // A standalone consumer without the native checker gets only lexical
      // application/document scopes. It never gains filesystem read access.
      const scopes = [];
      for (const [base, relative] of [[view.location.href, '../'], [document.baseURI, './']]) try { const url = new URL(relative, base); if (url.protocol === 'file:') scopes.push(url.href); } catch {}
      for (const url of fileUrls) allowedFiles.set(url, scopes.some(scope => url.startsWith(scope)));
    }
    const comments = [], walker = document.createTreeWalker(clone, view.NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) comments.push(walker.currentNode); comments.forEach(comment => comment.remove());
    for (const node of [...clone.querySelectorAll('*')]) {
      if (!clone.contains(node)) continue;
      if (removedTags.has(node.tagName.toUpperCase()) || node.matches('.vditor-copy,.moye-reading__controls,[data-export-ignore]')) { node.remove(); continue; }
      if (node.tagName === 'INPUT') { const mark = document.createElement('span'); mark.className = 'moye-export-checkbox'; mark.textContent = node.checked || node.hasAttribute('checked') ? '☑' : '☐'; node.replaceWith(mark); continue; }
      if (node.tagName.toUpperCase() === 'STYLE' && /@import|expression\s*\(|javascript\s*:/i.test(node.textContent)) { node.remove(); continue; }
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || ['contenteditable','tabindex','draggable','autofocus','srcdoc','action','formaction','form','download','spellcheck'].includes(name)) node.removeAttribute(attribute.name);
        else if (name === 'style' && /@import|expression\s*\(|(?:java|vb)script\s*:/i.test(attribute.value)) node.removeAttribute(attribute.name);
        else if (['href','xlink:href'].includes(name)) { const safe = safeUrl(attribute.value, document.baseURI); if (safe) node.setAttribute(attribute.name, safe); else node.removeAttribute(attribute.name); }
      }
      if (node.tagName === 'IMG') {
        const original = imageSources.get(node), safe = selectedImageUrl(node);
        let unavailable = !safe;
        node.removeAttribute('srcset'); node.removeAttribute('sizes');
        node.setAttribute('loading', 'eager');
        if (!safe) { node.removeAttribute('src'); warnings.push('有图片使用了不支持的地址。'); }
        else if (/^https?:/i.test(safe)) {
          // The isolated export window never fetches remote resources. Reuse
          // already available pixels only when the browser permits canvas read.
          try { node.src = availablePixels(original, document); }
          catch { unavailable = true; warnings.push('部分远程图片无法复用像素，已保留说明。'); }
        } else if (original?.complete && !original.naturalWidth) { unavailable = true; warnings.push('部分图片无法载入，已保留替代说明。'); }
        else if (safe.startsWith('file:') && allowedFiles.get(safe) !== true) {
          try { node.src = availablePixels(original, document); }
          catch { unavailable = true; warnings.push('部分本地图片无法纳入导出，已保留替代说明。'); }
        } else node.src = safe;
        if (unavailable) {
          const fallback = document.createElement('span'); fallback.className = 'moye-export-image-fallback';
          fallback.setAttribute('role', 'img'); fallback.textContent = text(node.alt ? `［图片不可用：${node.alt}］` : '［图片不可用］'); node.replaceWith(fallback);
        }
      }
    }
    // The root itself can carry editable attributes even when children do not.
    for (const name of [...clone.attributes].map(attribute => attribute.name)) if (/^on/i.test(name) || ['contenteditable','tabindex','autofocus','spellcheck'].includes(name.toLowerCase())) clone.removeAttribute(name);
    for (const [key, value] of Object.entries({position:'static',width:'100%',height:'auto',minHeight:'0',maxHeight:'none',overflow:'visible',padding:'0',margin:'0',fontFamily:sourceStyle.fontFamily,fontSize:sourceStyle.fontSize,lineHeight:sourceStyle.lineHeight})) clone.style.setProperty(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value, 'important');
    clone.style.removeProperty('color'); clone.style.removeProperty('background'); clone.style.removeProperty('background-color');
    if (theme === 'paper') { clone.style.setProperty('color','#222','important'); clone.style.setProperty('background-color','#fff','important'); }
    clone.classList.add('moye-export-content');
    const wrapper = document.createElement('div'); wrapper.id = 'editor'; wrapper.className = 'moye-export-document';
    const originalHost = layoutElement.closest('#editor');
    if (originalHost) { for (const name of originalHost.classList) wrapper.classList.add(name); for (const attribute of [...originalHost.attributes]) if (attribute.name.startsWith('data-moye-')) wrapper.setAttribute(attribute.name,attribute.value); }
    if (theme === 'paper') wrapper.dataset.moyeColorTheme = 'moye';
    const readingSurface = layoutElement.closest('.moye-reading');
    if (readingSurface) {
      const context = document.createElement('div'); context.className = readingSurface.className; context.classList.add('moye-export-reading-context');
      for (const attribute of [...readingSurface.attributes]) if (attribute.name.startsWith('data-')) context.setAttribute(attribute.name, attribute.value);
      context.append(clone); wrapper.append(context);
    } else wrapper.append(clone);
    const palette = document.createElement('section'); palette.className = [...document.body.classList].filter(value => /^[A-Za-z0-9_-]+$/.test(value) && (theme !== 'paper' || value !== 'dark')).join(' ');
    const language = layoutElement.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang; if (language) palette.lang = language;
    palette.append(wrapper);
    const computed = view.getComputedStyle(document.body), variableNames = new Set(['--paper','--chrome','--sidebar','--ink','--muted','--line','--accent','--accent-bg','--code','--font-size','--content-width','--body-font','--mono-font','--body-line-height','--tab-size']);
    for (let index = 0; index < sourceStyle.length; index++) if (sourceStyle[index].startsWith('--')) variableNames.add(sourceStyle[index]);
    let variables = ':root{';
    for (const key of variableNames) { const value = sourceStyle.getPropertyValue(key) || computed.getPropertyValue(key); if (value && !/[{}<>]/.test(value)) variables += `${key}:${value};`; }
    if (theme === 'paper') variables += '--paper:#fff!important;--chrome:#fff!important;--sidebar:#f5f5f5!important;--ink:#222!important;--muted:#666!important;--line:#ccc!important;--accent:#174d75!important;--accent-bg:#edf2f6!important;--code:#f5f6f3!important;';
    variables += '}';
    const overrides = '#editor.moye-export-document{height:auto!important;min-height:0!important;width:100%!important;overflow:visible!important}.moye-export-document .moye-export-reading-context{position:static!important;inset:auto!important;display:block!important;height:auto!important;min-height:0!important;overflow:visible!important}.moye-export-content{height:auto!important;min-height:0!important;overflow:visible!important;max-width:none!important}.moye-export-content *{content-visibility:visible!important;contain:none!important;contain-intrinsic-size:none!important}.moye-export-content .moye-reading-rendered,.moye-export-content .moye-table-scroll,.moye-export-content .moye-block-math{overflow:visible!important;max-height:none!important}.moye-export-content .moye-export-checkbox{display:inline-block;margin-right:.4em}.moye-export-content .moye-export-image-fallback{display:inline-block;max-width:100%;white-space:normal;overflow-wrap:anywhere;padding:.25em .5em;border:1px dashed var(--line);color:var(--muted)}.moye-export-content:focus-visible{box-shadow:none!important}';
    return { theme, html: palette.outerHTML, css: stylesFromDocument(document) + '\n' + variables + '\n' + overrides, title: String(title).slice(0,200), width: Math.round(layoutElement.getBoundingClientRect().width), height: element.isConnected ? Math.ceil(element.scrollHeight) : 0, warnings: [...new Set(warnings)] };
  }
  root.MoyeExportSnapshot = Object.freeze({ capture, stylesFromDocument, rebaseCss });
})(typeof window === 'object' ? window : globalThis);
