/* Local, reversible UI localization. Document nodes and user values are never
   translated. Mutation observers are scoped to small application UI surfaces. */
(function (root, factory) {
  'use strict';
  const api = factory(root, typeof module === 'object' && module.exports ? require('./locales/en-US.js') : root.MoyeEnglishCatalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeI18n = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root, english) {
  'use strict';
  if (!english || typeof english !== 'object') throw new Error('Load the Moye English UI catalog before i18n.js.');
  const supportedLocales = Object.freeze(['zh-CN', 'en-US']);
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = Object.entries(english).filter(([key]) => /\{\d+\}/.test(key)).map(([key, output]) => {
    const indices = [], pieces = key.split(/(\{\d+\})/g);
    const expression = pieces.map(piece => { const match = /^\{(\d+)\}$/.exec(piece); if (!match) return escape(piece); indices.push(match[1]); return '([\\s\\S]*?)'; }).join('');
    return { key, expression: new RegExp('^' + expression + '$'), indices, literals: pieces.filter(piece => piece && !/^\{\d+\}$/.test(piece)), output, specificity: key.replace(/\{\d+\}/g, '').length };
  }).sort((a, b) => b.specificity - a.specificity);
  function resolveLocale(choice = 'zh-CN', systemLocale = 'en-US') {
    if (choice === 'system') return /^zh(?:[-_]|$)/i.test(systemLocale || '') ? 'zh-CN' : 'en-US';
    if (/^en(?:[-_]|$)/i.test(choice || '')) return 'en-US';
    return 'zh-CN';
  }
  const nestedArguments = Object.freeze({
    '第 {0} 行：{1}': ['1'], '第 {0} 行：{1} {2}': ['1', '2'],
    '自动保存失败：{0}': ['0'], '草稿保存失败：{0}': ['0'], '编辑器启动失败：{0}': ['0'],
    '图表无法绘制：{0}': ['0'], '图表保留源码：{0}': ['0'], '已导出。{0}': ['0'],
    '外部设置文件暂未载入，继续使用上次有效设置。{0}': ['0'],
    '设置文件无效，已保留为 {0}，本次使用应用默认值。{1}': ['1'],
    '设置“{0}”的值无效。': ['0'], '恢复{0}': ['0'], '{0}排版样例': ['0'],
    '快捷键 {0} 同时分配给“{1}”和“{2}”。': ['1', '2'],
    '此主题用于{0}色外观，请先切换外观。': ['0'], '“{0}”仅用于{1}色外观，当前外观不匹配。': ['1'],
    '{0}，可移除此记录或通过“打开”重新选择。': ['0'],
  });
  function translateCore(text, depth = 0) {
    if (Object.hasOwn(english, text)) return english[text];
    for (const pattern of patterns) {
      if (!pattern.literals.every(literal => text.includes(literal))) continue;
      const match = pattern.expression.exec(text); if (!match) continue;
      const values = Object.create(null); let valid = true;
      pattern.indices.forEach((index, i) => { if (Object.hasOwn(values, index) && values[index] !== match[i + 1]) valid = false; values[index] = match[i + 1]; });
      if (valid && depth < 3) for (const index of nestedArguments[pattern.key] || []) if (typeof values[index] === 'string') values[index] = translateCore(values[index], depth + 1);
      if (valid) return pattern.output.replace(/\{(\d+)\}/g, (token, index) => Object.hasOwn(values, index) ? values[index] : token);
    }
    const shortcut = /^([\s\S]+?)(\s+\(?(?:Ctrl|Control|Alt|Shift|Command|Cmd|Meta|⌘|⌥|⇧|⌃)[\s\S]*)$/.exec(text);
    if (shortcut && Object.hasOwn(english, shortcut[1]) && /^[\x20-\x7e\n\r\t⌘⌥⇧⌃←→↑↓]+$/.test(shortcut[2])) return english[shortcut[1]] + shortcut[2];
    return text;
  }
  function t(text, locale = 'zh-CN', systemLocale) {
    if (typeof text !== 'string' || text.length > 4096 || resolveLocale(locale, systemLocale) !== 'en-US') return text;
    let translated = translateCore(text);
    if (translated !== text) return translated;
    const whitespace = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (whitespace && whitespace[2] !== text) {
      translated = translateCore(whitespace[2]);
      if (translated !== whitespace[2]) return whitespace[1] + translated + whitespace[3];
    }
    // IPC error prefixes are fixed transport text, not file names or source.
    const ipc = /^(Error invoking remote method '[^']+': (?:Error|TypeError): )([\s\S]+)$/.exec(text);
    if (ipc) return ipc[1] + translateCore(ipc[2]);
    return text;
  }
  function localizeDefinitions(definitions, locale, systemLocale) {
    return definitions.map(definition => ({ ...definition, category: t(definition.category, locale, systemLocale), label: t(definition.label, locale, systemLocale), description: t(definition.description, locale, systemLocale), ...(definition.options ? { options: definition.options.map(option => ({ ...option, label: t(option.label, locale, systemLocale) })) } : {}) }));
  }
  const uiRoots = [
    '.app-header', '.statusbar', '.sidebar-heading', '.sidebar-bottom', '#outline', '#find-bar', '#workspace-tabs',
    '#more-menu', '#about-dialog', '#recovery-banner', '#toast', '#external-change-banner', '#settings-reload-banner',
    '.moye-settings', '.moye-workspace', '.moye-recent', '.moye-recent-files', '.moye-reading__controls',
    '.moye-reading-next', '.moye-reading__long-navigation', '.moye-reading__long-status', '.moye-reading__next-document', '.moye-reading__next', '.moye-reading-next-document', '.moye-image-viewer', '.moye-image-viewer__toolbar',
    '.moye-image-viewer__caption', '.moye-table-tools', '.encoding-dialog', '.image-dialog', '.vditor-toolbar',
  ].join(',');
  const documentBoundary = '.vditor-ir,.vditor-sv,.vditor-wysiwyg,.vditor-preview,.moye-reading-content,[contenteditable="true"],[data-moye-typeset-measure],pre,code,svg,math,mjx-container,.katex';
  const userContent = '#document-name,#outline button,#workspace-tabs [data-workspace-tab],.moye-workspace__item,.moye-recent__name,.moye-recent__path,[data-i18n-user-content],[data-moye-user-content],[data-settings-preview],.moye-theme-editor__sample';
  const translatedAttributes = Object.freeze(['aria-label', 'aria-description', 'title', 'placeholder', 'data-tooltip', 'data-placeholder', 'data-content-note']);
  function install(options = {}) {
    const doc = options.document || root.document;
    if (!doc?.documentElement || !doc.defaultView?.MutationObserver) throw new TypeError('UI localization needs a document with MutationObserver.');
    const view = doc.defaultView, textValues = new WeakMap(), attributeValues = new WeakMap(), owned = new WeakSet();
    const observed = new Set(), attributeTargets = new Set(), queued = new Set();
    let locale = resolveLocale(options.getLocale?.() || options.locale || 'zh-CN', options.getSystemLocale?.() || view.navigator.language);
    let disposed = false, frame = null;
    const editorVocabularies = new WeakMap();
    const counters = { rootScans: 0, translatedTexts: 0, translatedAttributes: 0, ignoredContent: 0 };
    const getElement = node => node?.nodeType === 1 ? node : node?.parentElement;
    function blocked(element, scope) {
      if (!element) return true;
      if (element.closest(userContent)) return true;
      const boundary = element.closest(documentBoundary);
      if (boundary && !(owned.has(scope) && !scope.contains(boundary))) return true;
      if (element.tagName === 'OPTION') {
        const select = element.parentElement;
        if (select?.matches('[data-typography-profile]') && !['daily', 'technical', 'book', 'compact'].includes(element.value)) return true;
        if (select?.matches('[data-color-theme-file]') && element.value) return true;
        if (select?.matches('[data-setting-key="typography.colorTheme"]') && element.value.startsWith('custom:')) return true;
      }
      return false;
    }
    function paintText(node, policy = null) {
      let record = textValues.get(node);
      if (!record || node.data !== record.rendered) record = { source: node.data, rendered: node.data };
      let translated;
      if (policy) {
        translated = record.source;
        if (locale === 'en-US') {
          if (policy === 'profile') translated = translated.replace(/ · 自定义$/, ' · Custom');
          if (policy === 'theme-file') translated = translated.replace(/ · 文件有误$/, ' · Invalid file');
          if (policy === 'color-theme') translated = translated.replace(/^主题不可用：/, 'Theme unavailable: ').replace(/ · 深色(（外观不匹配）)?$/, (_, mismatch) => ' · Dark' + (mismatch ? ' (appearance mismatch)' : '')).replace(/ · 浅色(（外观不匹配）)?$/, (_, mismatch) => ' · Light' + (mismatch ? ' (appearance mismatch)' : ''));
        }
      } else if (node.parentElement?.closest('.shortcut-grid')) {
        const command = /^(.*?)( \([a-z][a-z-]*\))$/.exec(record.source);
        translated = command ? t(command[1], locale) + command[2] : t(record.source, locale);
      } else translated = t(record.source, locale);
      if (node.data !== translated) { node.data = translated; counters.translatedTexts++; }
      record.rendered = translated; textValues.set(node, record);
    }
    function paintAttributes(element, attributes = translatedAttributes) {
      let saved = attributeValues.get(element); if (!saved) { saved = new Map(); attributeValues.set(element, saved); }
      for (const name of attributes) {
        if (element.matches('[data-recent-open]') && name === 'title') continue;
        if (!element.hasAttribute(name)) { saved.delete(name); continue; }
        const current = element.getAttribute(name); let record = saved.get(name);
        if (!record || current !== record.rendered) record = { source: current, rendered: current };
        const translated = t(record.source, locale);
        if (current !== translated) { element.setAttribute(name, translated); counters.translatedAttributes++; }
        record.rendered = translated; saved.set(name, record);
      }
    }
    function scan(scope) {
      if (disposed || !scope.isConnected || blocked(scope, scope)) return;
      counters.rootScans++;
      function visit(node) {
        if (node.nodeType === 3) { paintText(node); return; }
        if (node.nodeType === 1 && node.tagName === 'OPTION') {
          const select = node.parentElement;
          const policy = select?.matches('[data-typography-profile]') && !['daily', 'technical', 'book', 'compact'].includes(node.value) ? 'profile'
            : select?.matches('[data-color-theme-file]') && node.value ? 'theme-file'
            : select?.matches('[data-setting-key="typography.colorTheme"]') && node.value.startsWith('custom:') ? 'color-theme' : null;
          if (policy) { for (const child of node.childNodes) if (child.nodeType === 3) paintText(child, policy); return; }
        }
        if (node.nodeType === 1 && node.id === 'document-name') {
          const title = node.getAttribute('title'), previous = attributeValues.get(node)?.get('title');
          // A real title here is an absolute path. Only these two fixed UI
          // placeholders are eligible; the displayed file name stays data.
          if (['文档名称与路径', '尚未保存到文件'].includes(title) || previous && title === previous.rendered && ['文档名称与路径', '尚未保存到文件'].includes(previous.source)) paintAttributes(node, ['title']);
          return;
        }
        if (node.nodeType !== 1 || blocked(node, scope)) { counters.ignoredContent++; return; }
        if (node.tagName === 'TIME' && node.matches('.moye-recent__time') && node.dateTime) {
          const date = new Date(node.dateTime);
          if (Number.isFinite(date.getTime())) {
            const display = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
            if (node.textContent !== display) node.textContent = display;
          }
          return;
        }
        paintAttributes(node);
        // Values in form fields and illustrative document/code samples are data.
        if (['INPUT', 'TEXTAREA', 'SCRIPT', 'STYLE'].includes(node.tagName)) return;
        for (const child of [...node.childNodes]) visit(child);
      }
      visit(scope);
    }
    function pruneDisconnected() {
      let removed = false;
      for (const scope of observed) if (!scope.isConnected) { observed.delete(scope); removed = true; }
      for (const scope of attributeTargets) if (!scope.isConnected) { attributeTargets.delete(scope); removed = true; }
      if (removed) {
        uiObserver.disconnect(); attributeObserver.disconnect();
        for (const scope of observed) uiObserver.observe(scope, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: translatedAttributes });
        for (const scope of attributeTargets) if (!observed.has(scope)) attributeObserver.observe(scope, { attributes: true, attributeFilter: translatedAttributes });
      }
      return removed;
    }
    function drain() {
      frame = null; if (disposed) return;
      if (pruneDisconnected()) for (const scope of observed) queued.add(scope);
      const pending = [...queued]; queued.clear();
      pending.forEach(scope => attributeTargets.has(scope) && !observed.has(scope) ? paintAttributes(scope) : scan(scope));
    }
    function schedule(scope) {
      if (disposed) return; queued.add(scope);
      if (frame === null) frame = view.requestAnimationFrame(drain);
    }
    const uiObserver = new view.MutationObserver(records => {
      for (const record of records) {
        const target = getElement(record.target);
        // Only observe roots adopted below; never search document text here.
        for (const scope of observed) if (scope === target || scope.contains(target)) { schedule(scope); break; }
      }
    });
    const attributeObserver = new view.MutationObserver(records => { for (const record of records) schedule(record.target); });
    function adopt(element, explicitlyOwned = false) {
      if (!element || element.nodeType !== 1 || observed.has(element)) return;
      if (explicitlyOwned) owned.add(element);
      if (blocked(element, element)) return;
      // An existing UI root already observes this nested element.
      if (!explicitlyOwned && [...observed].some(parent => parent.contains(element))) return;
      observed.add(element); uiObserver.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: translatedAttributes }); scan(element);
    }
    function adoptAttributes(element) {
      if (!element || element.nodeType !== 1) return element;
      if (!attributeTargets.has(element)) {
        attributeTargets.add(element);
        if (!observed.has(element)) attributeObserver.observe(element, { attributes: true, attributeFilter: translatedAttributes });
      }
      paintAttributes(element); return element;
    }
    const discoveryContainers = new WeakSet();
    function watchContainer(element) {
      if (!element || discoveryContainers.has(element)) return;
      discoveryContainers.add(element); discovery.observe(element, { childList: true });
    }
    function discover(element) {
      if (!element || element.nodeType !== 1 || element.closest(documentBoundary) || element.closest(userContent)) return;
      if (element.matches(uiRoots)) adopt(element);
      for (const match of element.querySelectorAll(uiRoots)) adopt(match);
      if (element.matches('.moye-reading')) { watchContainer(element); adoptAttributes(element); }
      for (const surface of element.querySelectorAll('.moye-reading')) if (!surface.closest(documentBoundary)) { watchContainer(surface); adoptAttributes(surface); }
    }
    const discovery = new view.MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) discover(node); });
    function refresh() {
      if (disposed) return;
      pruneDisconnected();
      // Full UI discovery occurs only at startup or an explicit locale change.
      for (const element of doc.querySelectorAll(uiRoots)) adopt(element);
      for (const element of observed) { if (element.isConnected) scan(element); else observed.delete(element); }
      for (const element of attributeTargets) { if (element.isConnected) paintAttributes(element); else attributeTargets.delete(element); }
      adoptAttributes(doc.querySelector('.editor-region'));
      watchContainer(doc.body); watchContainer(doc.querySelector('.workspace')); watchContainer(doc.querySelector('#editor')); watchContainer(doc.querySelector('.editor-region'));
      for (const surface of doc.querySelectorAll('.moye-reading')) if (!surface.closest(documentBoundary)) { watchContainer(surface); adoptAttributes(surface); }
    }
    function localizeEditorVocabulary() {
      const vocabulary = view.VditorI18n;
      if (!vocabulary || typeof vocabulary !== 'object' || Object.isFrozen(vocabulary)) return;
      let original = editorVocabularies.get(vocabulary);
      if (!original) { original = new Map(Object.entries(vocabulary).filter(([, value]) => typeof value === 'string')); editorVocabularies.set(vocabulary, original); }
      for (const [key, source] of original) vocabulary[key] = t(source, locale);
    }
    function setLocale(choice, systemLocale = options.getSystemLocale?.() || view.navigator.language) {
      if (disposed) return locale;
      const next = resolveLocale(choice, systemLocale), changed = next !== locale; locale = next;
      doc.documentElement.lang = locale; doc.documentElement.dataset.uiLanguage = locale;
      localizeEditorVocabulary(); refresh();
      if (changed) { doc.dispatchEvent(new view.CustomEvent('moye:language-changed', { detail: { locale } })); options.onChange?.(locale); }
      return locale;
    }
    const api = {
      setLocale, refresh, getLocale: () => locale,
      t: text => t(text, locale),
      register(element) { adopt(element, true); return element; },
      registerAttributes: adoptAttributes,
      stats: () => ({ ...counters, locale, observedUiRoots: observed.size, attributeTargets: attributeTargets.size }),
      dispose() { disposed = true; uiObserver.disconnect(); attributeObserver.disconnect(); discovery.disconnect(); if (frame !== null) view.cancelAnimationFrame(frame); queued.clear(); observed.clear(); attributeTargets.clear(); if (active === api) active = null; },
    };
    active = api; setLocale(locale); return api;
  }
  let active = null;
  return Object.freeze({ supportedLocales, resolveLocale, t, translate: t, localizeDefinitions, install, catalog: english, get active() { return active; } });
});
