/* global Vditor, MoyeDocument */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const desktop = window.desktop;
  const state = new MoyeDocument.DocumentState();
  const cdn = new URL('./vendor/vditor', location.href).href.replace(/\/$/, '');
  let editor, activeDocument = { name: '欢迎使用.md', path: null, baseUrl: '' };
  let loading = false, composing = false, pendingEditorChange = false, draftTimer, updateTimer, toastTimer;
  let restoredDraft = null, zoom = Number(localStorage.getItem('moye.zoom') || 100);
  let outlineVisible = localStorage.getItem('moye.outline') !== 'false';
  let dark = localStorage.getItem('moye.theme') === 'dark';
  let actionQueue = Promise.resolve();
  let findIndex = -1, findHits = [], findNodes = [], lastFindQuery = '';
  let footnoteReturn = null;
  const settingsSchema = window.MoyeSettingsSchema;
  let preferences = { ...settingsSchema.defaults }, appliedSyntax = { ...preferences }, settingsRevision = 0;
  let systemTheme = 'light', systemLocale = navigator.language || 'zh-CN', i18n, settingsPanel, settingsQueue = Promise.resolve(), autoSaveTimer, preferencesBookmark, reloadingPreferences = false;
  let lastKernelTheme = '';
  let activeWorkspaceId = null;
  let encodingPending = false;
  let themeSnapshot = { themes: [], errors: [] };
  let exportBusy = false, readingReturnMode = null, documentTransition = false;
  let settingsWarning = '', deferredSettingsSnapshot = null;
  let recentView = null;
  const workspaceTabs = new Map();

  function rememberRecentView() {
    syncCurrentEditor();
    const reading = window.moye.reading.isEnabled(), element = documentFocusTarget();
    const selection = window.getSelection();
    recentView = { documentId: activeDocument.documentId, path: activeDocument.path, source: state.text,
      mode: editor.getCurrentMode(), reading, element, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
      position: reading ? window.moye.reading.capturePosition?.() : null,
      selection: reading ? (selection.rangeCount && element.contains(selection.anchorNode) && element.contains(selection.focusNode)
        ? { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode, focusOffset: selection.focusOffset } : null)
        : editor.getCurrentMode() === 'sv' ? { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection } : captureLiveSelection() };
  }
  function restoreRecentView() {
    const bookmark = recentView; recentView = null;
    const element = documentFocusTarget(); element?.focus({ preventScroll: true });
    if (!bookmark || bookmark.documentId !== activeDocument.documentId || bookmark.path !== activeDocument.path || bookmark.source !== state.text ||
      bookmark.mode !== editor.getCurrentMode() || bookmark.reading !== window.moye.reading.isEnabled() || element !== bookmark.element) return;
    if (bookmark.reading) {
      window.moye.reading.restorePosition?.(bookmark.position);
      const selected = bookmark.selection;
      if (selected?.anchorNode.isConnected && selected.focusNode.isConnected && element.contains(selected.anchorNode) && element.contains(selected.focusNode)) {
        window.getSelection().setBaseAndExtent(selected.anchorNode, selected.anchorOffset, selected.focusNode, selected.focusOffset);
      }
    } else if (bookmark.mode === 'sv') element.setSelectionRange(bookmark.selection.start, bookmark.selection.end, bookmark.selection.direction);
    else restoreLiveSelection(bookmark.selection);
    element.scrollTop = bookmark.scrollTop; element.scrollLeft = bookmark.scrollLeft;
  }

  function pinWorkspaceTab(id) {
    const tab = workspaceTabs.get(id), wasPreview = tab?.preview;
    if (!tab) return;
    tab.preview = false; renderWorkspaceTabs();
    if (wasPreview && id === activeWorkspaceId && activeDocument.path && desktop?.rememberCurrentRecent) {
      const documentId = activeDocument.documentId;
      desktop.rememberCurrentRecent({ documentId }).catch(error => { if (activeDocument.documentId === documentId) toast(error.message); });
    }
  }
  function queueRecentOpen(entry) {
    return enqueueAction(() => duringDocumentTransition(async () => {
      const snapshot = await desktop.listRecentFiles();
      const retained = snapshot.entries.find(item => item.id === entry.id);
      if (retained?.available && retained.path === activeDocument.path) {
        const wasPreview = activeWorkspaceId && workspaceTabs.get(activeWorkspaceId)?.preview;
        if (wasPreview) pinWorkspaceTab(activeWorkspaceId);
        else await desktop.rememberCurrentRecent({ documentId: activeDocument.documentId });
        return true;
      }
      const existing = retained?.available && [...workspaceTabs].find(([, tab]) => tab.path === retained.path);
      if (existing) return openWorkspaceEntryNow({ ...existing[1], id: existing[0], preview: false });
      if (!await canLeave()) return false;
      rememberWorkspaceTab();
      const doc = await desktop.openRecentFile({ id: entry.id });
      if (!doc) return false;
      loadDocument(doc); return true;
    }));
  }
  function queueDocumentNeighbor(entry) {
    if (entry.navigation !== 'document') return queueWorkspaceOpen({ ...entry, preview: true });
    return enqueueAction(() => duringDocumentTransition(async () => {
      if (entry.ownerDocumentId !== activeDocument.documentId || !await canLeave()) return false;
      rememberWorkspaceTab();
      const doc = await desktop.openDocumentNeighbor({ id: entry.id, ownerDocumentId: entry.ownerDocumentId });
      if (!doc) return false;
      loadDocument(doc); return true;
    }));
  }
  async function documentNeighbor(direction) {
    if (!desktop) return null;
    const documentId = activeDocument.documentId, workspaceId = activeWorkspaceId;
    const entry = workspaceId ? await desktop.workspaceNeighbor({ id: workspaceId, direction }) : await desktop.documentNeighbor({ direction });
    return documentId === activeDocument.documentId && workspaceId === activeWorkspaceId ? entry : null;
  }

  function rememberWorkspaceTab() {
    if (!activeWorkspaceId || !workspaceTabs.has(activeWorkspaceId)) return;
    syncCurrentEditor();
    const tab = workspaceTabs.get(activeWorkspaceId);
    // A discarded edit is never revived by switching back to a retained tab.
    if (state.dirty) { tab.content = state.saved; tab.history = null; tab.state = null; return; }
    checkpointUndo();
    tab.content = state.text;
    tab.state = { text: state.text, saved: state.saved, canonical: state.canonical, savedCanonical: state.savedCanonical, rawStates: new Map(state.rawStates) };
    tab.history = Object.fromEntries(['ir', 'sv', 'wysiwyg'].filter(mode => editor.vditor.undo[mode]).map(mode => [mode, structuredClone(editor.vditor.undo[mode])]));
    tab.mode = editor.getCurrentMode();
    tab.selection = tab.mode === 'sv' ? { start: activeElement().selectionStart, end: activeElement().selectionEnd, direction: activeElement().selectionDirection } : captureLiveSelection();
  }
  function checkpointUndo() {
    const undo = editor.vditor.undo, current = undo.addCaret(editor.vditor, true);
    const contentOnly = text => String(text || '').replace(/<wbr>/g, '').replace(/ vditor-ir__node--expand/g, '');
    if (contentOnly(current) !== contentOnly(undo[editor.getCurrentMode()].lastText)) undo.addToUndoStack(editor.vditor);
  }
  function renderWorkspaceTabs() {
    const bar = $('workspace-tabs'); if (!bar) return;
    bar.hidden = !workspaceTabs.size; bar.replaceChildren();
    for (const [id, tab] of workspaceTabs) {
      const wrap = document.createElement('div'); wrap.className = 'document-tab'; wrap.classList.toggle('is-preview', tab.preview);
      const duplicated = [...workspaceTabs.values()].filter(item => item.name === tab.name).length > 1;
      const parent = (tab.relativePath || tab.path || '').split(/[\\/]/).slice(-2, -1)[0];
      const button = document.createElement('button'); button.type = 'button'; button.textContent = tab.name + (duplicated && parent ? ` — ${parent}` : ''); button.title = tab.path || tab.name; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(id === activeWorkspaceId)); button.dataset.workspaceTab = id;
      button.addEventListener('click', () => queueWorkspaceOpen({ ...tab, id, preview: tab.preview }));
      button.addEventListener('dblclick', () => pinWorkspaceTab(id));
      const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${tab.name}`);
      close.addEventListener('click', () => enqueueAction(() => duringDocumentTransition(() => closeWorkspaceTab(id))));
      wrap.append(button, close); bar.append(wrap);
    }
  }
  async function closeWorkspaceTab(id) {
    if (!workspaceTabs.has(id)) return false;
    if (id !== activeWorkspaceId) { workspaceTabs.delete(id); renderWorkspaceTabs(); return true; }
    if (!await canLeave()) return false;
    const next = [...workspaceTabs].find(([candidate]) => candidate !== id);
    if (next) {
      if (!await openWorkspaceEntryNow({ ...next[1], id: next[0], preview: next[1].preview }, { canLeaveApproved: true })) return false;
    } else { cancelPendingDraft(); loadDocument(await desktop.newDocument()); }
    workspaceTabs.delete(id); renderWorkspaceTabs(); return true;
  }
  async function duringDocumentTransition(operation) {
    if (composing) { toast('请先完成当前输入法选词。'); return false; }
    const host = $('editor'), wasInert = host.inert, wasTransition = documentTransition;
    documentTransition = true; host.inert = true; host.setAttribute('aria-busy', 'true');
    try { return await operation(); }
    finally { documentTransition = wasTransition; host.inert = wasInert; host.removeAttribute('aria-busy'); if (!document.querySelector('dialog[open]')) documentFocusTarget()?.focus({ preventScroll: true }); }
  }
  async function openWorkspaceEntry(entry) {
    return duringDocumentTransition(() => openWorkspaceEntryNow(entry));
  }
  async function openWorkspaceEntryNow(entry, { canLeaveApproved = false } = {}) {
    if (!desktop) return false;
    if (composing || reloadingPreferences) { toast('请先完成当前输入法选词或载入。'); return false; }
    if (entry.id === activeWorkspaceId) {
      if (!entry.preview) pinWorkspaceTab(entry.id);
      return true;
    }
    if (!canLeaveApproved && !await canLeave()) return false;
    rememberWorkspaceTab();
    const cached = workspaceTabs.get(entry.id);
    const preview = entry.preview !== false && cached?.preview !== false;
    const replacedPreviews = preview ? [...workspaceTabs].filter(([id, tab]) => id !== entry.id && tab.preview).map(([id]) => id) : [];
    if (workspaceTabs.size - replacedPreviews.length + (cached ? 0 : 1) > 20) { toast('最多保留 20 个标签，请先关闭一个。'); return false; }
    const doc = await desktop.openWorkspaceEntry({ id: entry.id, preview });
    if (!doc) return false;
    cancelPendingDraft(); activeWorkspaceId = null; loadDocument(doc);
    if (cached?.state && cached.state.saved === doc.content) {
      if (cached.mode && cached.mode !== editor.getCurrentMode()) setMode(cached.mode);
      if (cached.history) for (const [mode, history] of Object.entries(cached.history)) editor.vditor.undo[mode] = structuredClone(history);
      Object.assign(state, cached.state, { rawStates: new Map(cached.state.rawStates) });
      if (cached.selection) {
        if (cached.mode === 'sv') activeElement().setSelectionRange(cached.selection.start, cached.selection.end, cached.selection.direction);
        else restoreLiveSelection(cached.selection);
      }
      editor.vditor.undo.resetIcon(editor.vditor);
    }
    for (const id of replacedPreviews) workspaceTabs.delete(id);
    workspaceTabs.set(entry.id, { ...cached, ...entry, path: doc.path, name: doc.name, content: doc.content, preview });
    activeWorkspaceId = entry.id; window.moye.workspace?.setActive(entry.id); renderWorkspaceTabs(); updateMetadata();
    window.moye.reading?.refresh({ displayOnly: true });
    return true;
  }
  function queueWorkspaceOpen(entry) {
    const next = actionQueue.then(() => openWorkspaceEntry(entry)); actionQueue = next.catch(error => toast(error.message)); return next;
  }
  const syntaxKeys = settingsSchema.definitions.filter(d => d.key.startsWith('markdown.') || d.key.startsWith('math.') && d.key !== 'math.overflow').map(d => d.key);

  function isReloadPending() { return syntaxKeys.some(key => preferences[key] !== appliedSyntax[key]); }
  function rememberPreferencesCaret() {
    if (!editor) return;
    const mode = editor.getCurrentMode(), el = activeElement();
    const selection = getSelection();
    if (mode === 'sv') preferencesBookmark = { mode, scrollTop: el.scrollTop, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
    else if (selection.rangeCount && el.contains(selection.anchorNode)) preferencesBookmark = { mode, scrollTop: el.scrollTop, ...captureLiveSelection() };
  }
  function updateShortcutHelp() {
    const grid = document.querySelector('.shortcut-grid');
    if (!grid) return;
    const bindings = window.moye?.shortcuts?.getBindings() || window.MoyeShortcuts.resolve(preferences['editor.keyBindings']);
    const fragment = document.createDocumentFragment();
    for (const command of window.MoyeShortcuts.commands) {
      const name = document.createElement('span'), key = document.createElement('kbd');
      name.textContent = `${command.label} (${command.id})`; key.textContent = bindings[command.id] || '未分配';
      fragment.append(name, key);
    }
    grid.replaceChildren(fragment);
  }
  function applyLivePreferences() {
    const readingAnchor = window.moye?.readingAnchor?.beforeLayout();
    i18n?.setLocale(preferences['ui.language'], systemLocale);
    outlineVisible = preferences['appearance.sidebarVisible'];
    dark = preferences['appearance.theme'] === 'dark' || preferences['appearance.theme'] === 'system' && systemTheme === 'dark';
    document.body.classList.toggle('dark', dark);
    document.body.classList.toggle('outline-hidden', !outlineVisible);
    document.body.classList.toggle('toolbar-hidden', !preferences['appearance.toolbarVisible']);
    document.body.classList.toggle('focus-mode', preferences['editor.focusMode']);
    document.body.classList.toggle('code-wrap', preferences['code.wrap']);
    const css = document.documentElement.style;
    css.setProperty('--font-size', `${preferences['appearance.fontSize']}px`);
    css.setProperty('--content-width', `${preferences['appearance.contentWidth']}px`);
    css.setProperty('--body-font', preferences['appearance.fontFamily']);
    css.setProperty('--mono-font', preferences['appearance.monospaceFontFamily']);
    css.setProperty('--body-line-height', preferences['appearance.lineHeight']);
    css.setProperty('--tab-size', preferences['editor.tabSize']);
    zoom = Math.round(preferences['appearance.fontSize'] / 17 * 100);
    $('zoom-reset').textContent = `${zoom}%`;
    $('theme-toggle').textContent = dark ? '深色' : '浅色';
    $('settings-reload-banner').hidden = !isReloadPending();
    for (const key of ['math.autoNumber', 'math.numberingStyle', 'math.physics']) {
      const control = document.querySelector(`input[data-setting-key="${key}"],select[data-setting-key="${key}"]`);
      if (control) control.disabled = preferences['math.engine'] !== 'MathJax';
    }
    if (editor) {
      editor.vditor.options.tab = ' '.repeat(preferences['editor.tabSize']);
      editor.vditor.options.typewriterMode = false;
      editor.vditor.options.preview.maxWidth = preferences['appearance.contentWidth'];
      const hljs = editor.vditor.options.preview.hljs;
      const refreshCode = hljs.lineNumber !== preferences['code.lineNumbers'] || hljs.style !== preferences['code.theme'];
      hljs.lineNumber = preferences['code.lineNumbers']; hljs.style = preferences['code.theme'];
      editor.vditor.hint.recentLanguage = preferences['code.defaultLanguage'];
      for (const mode of ['ir', 'sv']) editor.vditor[mode].element.spellcheck = preferences['general.spellcheck'];
      const kernelTheme = `${dark}:${hljs.style}`;
      if (kernelTheme !== lastKernelTheme) {
        editor.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', hljs.style, `${cdn}/dist/css/content-theme`);
        lastKernelTheme = kernelTheme;
      }
      if (refreshCode) {
        const root = editor.vditor.ir.element;
        Vditor.highlightRender(hljs, root, cdn);
      }
      window.dispatchEvent(new Event('resize'));
    }
    window.moye?.focus?.refresh({ center: false }); window.moye?.shortcuts?.refresh(); updateShortcutHelp();
    window.moye?.typography?.refresh();
    applyCustomTheme();
    window.moye?.reading?.refresh({ displayOnly: true });
    window.moye?.tables?.refresh();
    window.moye?.contentExperience?.refresh(); window.moye?.sourcePresentation?.refresh();
    window.moye?.readingAnchor?.afterLayout(readingAnchor);
    clearInterval(autoSaveTimer);
    if (preferences['general.autoSave']) autoSaveTimer = setInterval(() => {
      if (!editor || composing || loading || !activeDocument.path || !(state.dirty || pendingEditorChange)) return;
      performAction('auto-save').catch(error => toast(`自动保存失败：${error.message}`));
    }, preferences['general.autoSaveIntervalMinutes'] * 60000);
  }
  function acceptSettings(snapshot) {
    if (!snapshot) return;
    const warning = snapshot.externalError || snapshot.warnings?.[0] || '';
    if (warning && warning !== settingsWarning) toast(warning);
    settingsWarning = warning;
    preferences = settingsSchema.normalize(snapshot.values);
    settingsRevision = snapshot.revision || 0; systemTheme = snapshot.systemTheme || systemTheme; systemLocale = snapshot.systemLocale || systemLocale;
    applyLivePreferences(); settingsPanel?.refresh();
  }
  function applyCustomTheme() {
    if (!window.MoyeColorThemes) return;
    for (const key of window.MoyeColorThemes.variableKeys) document.body.style.removeProperty(key);
    if (!preferences['typography.colorTheme']?.startsWith('custom:')) return;
    const result = window.MoyeColorThemes.resolve(themeSnapshot.themes, preferences['typography.colorTheme'], dark ? 'dark' : 'light');
    for (const [key, value] of Object.entries(result.variables)) document.body.style.setProperty(key, value);
    document.body.dataset.customThemeValid = String(result.valid);
  }
  function deferSettings(snapshot) {
    if (!deferredSettingsSnapshot || snapshot.revision >= deferredSettingsSnapshot.revision) deferredSettingsSnapshot = snapshot;
  }
  function settingsOperation(operation) {
    const pending = settingsQueue.then(async () => {
      if (composing) throw new Error('请先完成当前输入法选词，再修改设置。');
      const result = await operation();
      if (result) { if (composing) deferSettings(result); else acceptSettings(result); }
      return { ...preferences };
    });
    settingsQueue = pending.catch(() => {});
    return pending;
  }
  function updatePreferences(patch) {
    settingsSchema.validatePatch(patch);
    if (patch['math.macros'] !== undefined) window.MoyeMath.macrosFrom(patch['math.macros']);
    return settingsOperation(async () => desktop ? desktop.updateSettings({ patch, expectedRevision: settingsRevision }) : { values: { ...preferences, ...patch }, revision: settingsRevision + 1 });
  }
  function quickPreference(patch) { return updatePreferences(patch).catch(error => toast(error.message)); }
  function reloadPreferences() {
    const next = actionQueue.then(reloadPreferencesNow);
    actionQueue = next.catch(() => {});
    return next;
  }
  async function reloadPreferencesNow() {
    await settingsPanel?.flush();
    await settingsQueue;
    if (!isReloadPending()) return;
    if (composing) throw new Error('请先完成当前输入法选词。');
    syncCurrentEditor(); rememberPreferencesCaret();
    const text = state.text, focus = document.activeElement, documentId = activeDocument.documentId, nextPreferences = { ...preferences };
    const selectedControl = focus?.matches('input,textarea') ? { start: focus.selectionStart, end: focus.selectionEnd, direction: focus.selectionDirection } : null;
    const bookmark = preferencesBookmark || { mode: editor.getCurrentMode(), start: 0, end: 0, direction: 'forward', scrollTop: activeElement().scrollTop };
    reloadingPreferences = true; editor.disabled();
    try {
    const math = await window.MoyeMath.configure({ cdn, engine: nextPreferences['math.engine'], macros: nextPreferences['math.macros'], autoNumber: nextPreferences['math.autoNumber'], numberingStyle: nextPreferences['math.numberingStyle'], physics: nextPreferences['math.physics'] });
    if (documentId !== activeDocument.documentId || composing) throw new Error('文档状态已变化，请完成输入后重试重新载入。');
    const lute = editor.vditor.lute, markdown = editor.vditor.options.preview.markdown;
    window.MoyeMarkdownConfig.apply(lute, markdown, nextPreferences);
    window.MoyeImagePolicy.applyParser(lute);
    window.MoyeMarkdownConfig.applyView(editor.vditor.ir.element, nextPreferences);
    editor.vditor.options.preview.math = math;
    loading = true;
    try {
      window.MoyeMath.resetDocument(); setDocumentValue(text); state.observe(editor.getValue()); pendingEditorChange = false;
      if (bookmark.mode === 'sv') editor.vditor.sv.element.setSelectionRange(bookmark.start, bookmark.end, bookmark.direction);
      else restoreLiveSelection(bookmark);
      activeElement().scrollTop = bookmark.scrollTop;
      appliedSyntax = nextPreferences;
    } finally { loading = false; }
    $('outline').dataset.signature = ''; updateOutline(); updateMetadata(); applyLivePreferences(); window.moye?.reading?.refresh(); settingsPanel?.refresh();
    if (focus?.isConnected && focus !== document.body) { focus.focus({ preventScroll: true }); if (selectedControl && focus.setSelectionRange && selectedControl.start !== null) focus.setSelectionRange(selectedControl.start, selectedControl.end, selectedControl.direction || 'none'); }
    scheduleDraft(); toast('已重新载入，文档内容已保留。');
    } finally { reloadingPreferences = false; editor.enable(); window.moye.autoLinks?.refresh(); }
  }

  function toast(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
  }
  function documentFocusTarget() { return window.moye?.reading?.isEnabled() ? window.moye.reading.getRoot() : activeElement(); }
  function activeElement() { return editor?.vditor[editor.getCurrentMode()].element; }
  function closeMenus() { $('more-menu').hidden = true; $('more-button').setAttribute('aria-expanded', 'false'); }
  function updateMetadata() {
    $('document-name').textContent = activeDocument.name || '未命名.md';
    $('document-name').title = activeDocument.path || '尚未保存到文件';
    const edited = state.dirty || pendingEditorChange || encodingPending;
    if (edited && activeWorkspaceId && workspaceTabs.get(activeWorkspaceId)?.preview) pinWorkspaceTab(activeWorkspaceId);
    $('dirty-dot').hidden = !edited;
    $('save-status').textContent = edited ? '有未保存的更改' : (activeDocument.path ? '已保存到本地' : '本地文档');
    document.title = `${edited ? '● ' : ''}${activeDocument.name} — 墨页`;
    desktop?.setEdited({ edited });
    if ($('encoding-button')) {
      $('encoding-button').textContent = `${activeDocument.encoding || 'UTF-8'}${activeDocument.encodingGuessed ? ' ?' : ''}`;
      $('encoding-button').title = activeDocument.encodingWarning || '查看、重新解释或转换文件编码';
    }
  }
  function updateStats() {
    const stats = MoyeDocument.wordStats(state.text);
    $('word-count').textContent = `${stats.words.toLocaleString()} 字`;
    $('word-count').title = `${stats.characters.toLocaleString()} 个字符 · 约 ${stats.minutes} 分钟阅读`;
  }
  function renderedHeadings() {
    return Array.from(editor.vditor.ir.element.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(node => !node.closest('.vditor-ir__preview'));
  }
  function updateOutline() {
    const nav = $('outline');
    const plainReading = window.moye?.reading?.isEnabled() && window.moye.reading.isPlainText?.();
    if (editor.getCurrentMode() === 'ir' && !plainReading) {
      // setValue updates the hidden outline but leaves source-generated TOC
      // anchors without the editor's unique heading suffixes. Reconcile them.
      const toc = editor.vditor.outline.render(editor.vditor);
      if (appliedSyntax['markdown.toc']) editor.vditor.ir.element.querySelectorAll('.vditor-toc').forEach(node => { if (node.innerHTML !== toc) node.innerHTML = toc; });
      editor.vditor.ir.element.querySelectorAll('sup[data-type="footnotes-ref"]').forEach(node => { node.title = 'Ctrl / ⌘ + 单击，跳转到脚注定义'; });
    }
    const headings = renderedHeadings();
    const data = plainReading ? window.moye.reading.getOutline().map(item => ({ ...item, label: item.text })) : headings.map((node, index) => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('[data-type="heading-marker"]').forEach(n => n.remove());
      return { index, level: Number(node.tagName[1]), label: clone.textContent.trim() };
    });
    const signature = JSON.stringify(data);
    if (nav.dataset.signature === signature) return;
    nav.dataset.signature = signature; nav.replaceChildren();
    if (!data.length) { const p = document.createElement('p'); p.className = 'outline-empty'; p.textContent = '添加标题后，会在这里生成大纲。'; nav.append(p); return; }
    for (const heading of data) {
      const button = document.createElement('button');
      button.dataset.level = String(heading.level); button.textContent = heading.label || '未命名标题'; button.title = heading.label;
      button.addEventListener('click', () => {
        if (window.moye?.reading?.isEnabled()) {
          if (plainReading) window.moye.reading.navigateTo(heading.id);
          else { const node = window.moye.reading.getRoot()?.querySelectorAll('h1,h2,h3,h4,h5,h6')[heading.index]; if (node) window.moye.reading.navigateTo(node); }
          nav.querySelectorAll('button').forEach(b => b.classList.remove('active')); button.classList.add('active'); return;
        }
        if (editor.getCurrentMode() === 'sv') setMode('ir');
        const node = renderedHeadings()[heading.index];
        node?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        nav.querySelectorAll('button').forEach(b => b.classList.remove('active')); button.classList.add('active');
      });
      nav.append(button);
    }
  }
  function input(value) {
    if (loading || composing) return;
    pendingEditorChange = false;
    const sourceMode = editor.getCurrentMode() === 'sv';
    state.input(sourceMode ? editor.vditor.sv.element.value : value, sourceMode);
    window.moye?.sourcePresentation?.refresh();
    updateMetadata();
    clearTimeout(updateTimer); updateTimer = setTimeout(() => { updateStats(); updateOutline(); }, 140);
    scheduleDraft();
  }
  function setDocumentValue(text) {
    if (editor.getCurrentMode() === 'sv') {
      // Native source loads keep an exact undo baseline without scheduling an
      // unnecessary hidden preview or normalizing the terminal line break.
      const kernel = editor.vditor;
      clearTimeout(kernel.sv.processTimeoutId); clearTimeout(kernel.preview.mdTimeoutId);
      kernel.sv.element.value = text; kernel.sv.element.setSelectionRange(0, 0);
      editor.clearStack();
      if (kernel.preview.element.style.display === 'block') kernel.preview.render(kernel);
    } else editor.setValue(text, true);
  }
  function syncCurrentEditor() {
    if (editor && !loading && !composing) input(editor.getValue());
  }
  function cancelPendingDraft() { clearTimeout(draftTimer); draftTimer = null; }
  function draftSnapshot() { return { content: state.text, path: activeDocument.path || null, documentId: activeDocument.documentId }; }
  function scheduleDraft() {
    cancelPendingDraft();
    if (!state.dirty || !desktop) return;
    const snapshot = draftSnapshot();
    draftTimer = setTimeout(() => {
      draftTimer = null;
      desktop.stashDraft(snapshot).catch(error => toast(`草稿保存失败：${error.message}`));
    }, 700);
  }
  function configureBase(baseUrl) {
    editor.vditor.options.preview.markdown.linkBase = baseUrl || '';
    editor.vditor.lute.SetLinkBase(baseUrl || '');
  }
  function loadDocument(doc, { recovered = false } = {}) {
    window.moye?.readingAnchor?.remember();
    loading = true; cancelPendingDraft(); clearTimeout(updateTimer);
    pendingEditorChange = false;
    encodingPending = false;
    if (!doc.workspaceId) {
      const existing = doc.path && [...workspaceTabs].find(([, tab]) => tab.path === doc.path);
      activeWorkspaceId = existing ? existing[0] : null;
      if (existing) {
        doc = { ...doc, workspaceId: existing[0] };
        // A native Open has already reread disk after the leave confirmation.
        // Keep its existing tab identity, but never revive a stale saved view.
        workspaceTabs.set(existing[0], { ...existing[1], preview: false, content: doc.content, state: null, history: null, selection: null });
      }
      renderWorkspaceTabs(); window.moye?.workspace?.setActive(activeWorkspaceId);
    }
    $('external-change-banner').hidden = true;
    footnoteReturn = null; $('footnote-back').hidden = true;
    const longText = (/\.txt$/i.test(doc.name || '') || preferences['reading.txtMode'] === 'plain') && (doc.content || '').length >= 256 * 1024;
    if (longText && editor.getCurrentMode() !== 'sv') setMode('sv');
    loading = true;
    activeDocument = { ...doc, name: doc.name || '未命名.md' };
    const preparingLongRead = longText && preferences['reading.txtMode'] !== 'markdown';
    if (preparingLongRead) $('editor').classList.add('moye-loading-long-source');
    try {
      configureBase(doc.baseUrl);
      window.MoyeMath.resetDocument(); setDocumentValue(doc.content || '');
      state.load(doc.content || '', editor.getValue());
      if (recovered) state.saved = '';
      loading = false;
      if (preparingLongRead && !window.moye?.reading?.isEnabled()) setReading(true);
    } finally { loading = false; $('editor').classList.remove('moye-loading-long-source'); }
    activeElement().scrollTop = 0;
    $('outline').dataset.signature = '';
    updateMetadata(); updateStats(); updateOutline();
    documentFocusTarget()?.focus({ preventScroll: true });
    window.moye?.typography?.refresh(); window.moye?.reading?.refresh({ preservePosition: false }); window.moye?.tables?.refresh();
    window.moye?.readingAnchor?.documentChanged(activeDocument.path || activeDocument.documentId || null);
    window.moye?.contentExperience?.documentChanged(); window.moye?.sourcePresentation?.refresh();
    if (doc.recentWarning) toast(doc.recentWarning);
  }
  function toolbarAction(name) {
    const button = editor.vditor.toolbar.elements[name]?.querySelector('button');
    if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  function mapOffset(from, to, offset) {
    if (from === to) return Math.min(offset, to.length);
    const diff = editor.vditor.undo.dmp;
    return Math.min(to.length, diff.diff_xIndex(diff.diff_main(from, to, false), offset));
  }
  // Insert a bookmark into a detached clone and serialize it. Diff mapping
  // preserves the correct occurrence even when multiple paragraphs are equal.
  function captureLivePoint(container, offset) {
    const live = editor.vditor.ir.element;
    if (!container || !live.contains(container)) return 0;
    const path = []; let node = container;
    while (node !== live) { path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node)); node = node.parentNode; }
    const clone = live.cloneNode(true); node = clone;
    for (const index of path) node = node.childNodes[index];
    let marker;
    do { marker = `MOYECARET${crypto.randomUUID().replace(/-/g, '')}`; } while (state.text.includes(marker));
    const insert = document.createRange(); insert.setStart(node, Math.min(offset, node.nodeType === 3 ? node.length : node.childNodes.length)); insert.collapse(true); insert.insertNode(document.createTextNode(marker));
    const source = editor.vditor.lute.VditorIRDOM2Md(clone.innerHTML);
    const at = source.indexOf(marker);
    return at < 0 ? 0 : mapOffset(source.replace(marker, ''), state.text, at);
  }
  function captureLiveSelection() {
    const selection = window.getSelection();
    const live = editor.vditor.ir.element;
    if (!selection.rangeCount || !live.contains(selection.anchorNode)) return { start: 0, end: 0, direction: 'forward' };
    const range = selection.getRangeAt(0);
    return { start: captureLivePoint(range.startContainer, range.startOffset), end: captureLivePoint(range.endContainer, range.endOffset), direction: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset && !range.collapsed ? 'backward' : 'forward' };
  }
  function restoreLiveSelection(bookmark) {
    editor.focus();
    const data = textNodes(true), projection = data.map(n => n.text).join('');
    const start = mapOffset(state.text, projection, bookmark.start), end = mapOffset(state.text, projection, bookmark.end);
    selectTextRange(data, start, end, bookmark.direction);
  }
  function ensureSourceCaretVisible() {
    const el = editor.vditor.sv.element;
    const style = getComputedStyle(el), mirror = document.createElement('div');
    Object.assign(mirror.style, {
      position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden',
      width: `${el.offsetWidth}px`, boxSizing: 'border-box', height: 'auto',
      whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: style.wordBreak,
      font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
      padding: style.padding, border: style.border, tabSize: style.tabSize,
    });
    const offset = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    mirror.textContent = el.value.slice(0, offset);
    const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker);
    document.body.append(mirror);
    const top = marker.offsetTop, height = parseFloat(style.lineHeight) || 26;
    el.scrollTop = Math.max(0, top + height / 2 - el.clientHeight / 2);
    mirror.remove();
  }
  function setMode(mode) {
    if (reloadingPreferences) return;
    if (composing) { toast('请先完成当前输入法选词。'); return; }
    if (window.moye?.reading?.isEnabled()) { readingReturnMode = null; window.moye.reading.setEnabled(false); }
    if (editor.getCurrentMode() === mode) return;
    syncCurrentEditor();
    let bookmark;
    if (mode === 'sv') {
      bookmark = captureLiveSelection();
    } else {
      const el = editor.vditor.sv.element;
      bookmark = { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
      state.input(editor.vditor.sv.element.value, true);
    }
    loading = true;
    const button = editor.vditor.toolbar.elements['edit-mode'].querySelector(`button[data-mode="${mode}"]`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    if (mode === 'sv') {
      editor.vditor.sv.element.value = state.text;
      editor.vditor.sv.element.setSelectionRange(bookmark.start, bookmark.end, bookmark.direction);
      editor.vditor.sv.element.focus();
    } else restoreLiveSelection(bookmark);
    state.observe(editor.getValue());
    // Pin the mode's current document before the next debounced input can
    // overwrite it, so Undo after a mode switch returns to this exact state.
    editor.vditor.undo.addToUndoStack(editor.vditor);
    if (mode === 'sv') { editor.vditor.sv.element.setSelectionRange(bookmark.start, bookmark.end, bookmark.direction); ensureSourceCaretVisible(); }
    else if (bookmark.direction === 'backward') {
      const selection = window.getSelection();
      if (selection.rangeCount) { const range = selection.getRangeAt(0); selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset); }
    }
    loading = false;
    $('live-mode').setAttribute('aria-pressed', String(mode === 'ir'));
    $('source-mode').setAttribute('aria-pressed', String(mode === 'sv'));
    updateOutline(); updateMetadata(); window.moye?.focus?.refresh({ center: false });
    window.moye?.typography?.refresh(); window.moye?.tables?.refresh();
    window.moye?.sourcePresentation?.refresh();
  }
  function setReading(enabled) {
    if (composing || reloadingPreferences) { toast('请先完成当前输入法选词或载入。'); return; }
    if (enabled && !window.moye?.reading?.isEnabled()) { readingReturnMode = editor.getCurrentMode(); syncCurrentEditor(); }
    window.moye?.reading?.setEnabled(enabled);
    if (!enabled && readingReturnMode) { const previous = readingReturnMode; readingReturnMode = null; if (previous !== editor.getCurrentMode()) setMode(previous); }
    window.moye?.typography?.refresh(); window.moye?.tables?.refresh();
    updateOutline();
  }
  async function save(saveAs = false) {
    if (!desktop) { downloadDocument(); return true; }
    if (composing) { toast('请先完成当前输入法选词。'); return false; }
    syncCurrentEditor();
    const previousPath = activeDocument.path, previousWorkspaceId = activeWorkspaceId, previousSaved = state.saved;
    cancelPendingDraft();
    const snapshot = state.text;
    let result;
    editor.disabled();
    try { result = await desktop.saveDocument({ content: snapshot, saveAs }); }
    catch (error) { scheduleDraft(); throw error; }
    finally { editor.enable(); }
    if (!result) { scheduleDraft(); return false; }
    cancelPendingDraft();
    activeDocument = { ...activeDocument, ...result };
    encodingPending = false;
    configureBase(result.baseUrl);
    if (state.text === snapshot && !pendingEditorChange) {
      if (result.content !== snapshot) {
        const mode = editor.getCurrentMode();
        const bookmark = mode === 'ir' ? captureLiveSelection() : { start: editor.vditor.sv.element.selectionStart, end: editor.vditor.sv.element.selectionEnd, direction: editor.vditor.sv.element.selectionDirection };
        loading = true; if (mode === 'sv') editor.vditor.sv.element.value = result.content; else editor.setValue(result.content); state.load(result.content, editor.getValue()); loading = false;
        if (mode === 'ir') restoreLiveSelection(bookmark); else { editor.vditor.sv.element.setSelectionRange(bookmark.start, bookmark.end, bookmark.direction); ensureSourceCaretVisible(); }
        editor.vditor.undo.addToUndoStack(editor.vditor);
      } else state.save();
    } else { state.saved = result.content; await desktop.stashDraft(draftSnapshot()); }
    if (result.path !== previousPath && previousWorkspaceId) {
      const previousTab = workspaceTabs.get(previousWorkspaceId);
      if (previousTab) { previousTab.content = previousSaved; previousTab.state = null; previousTab.history = null; }
      activeWorkspaceId = null; delete activeDocument.workspaceId;
    }
    const entry = result.workspaceEntry;
    if (entry && (workspaceTabs.has(entry.id) || workspaceTabs.size < 20)) {
      workspaceTabs.set(entry.id, { ...workspaceTabs.get(entry.id), ...entry, path: result.path, name: result.name, content: result.content, preview: false });
      activeWorkspaceId = entry.id; activeDocument.workspaceId = entry.id;
    }
    window.moye.workspace?.setActive(activeWorkspaceId); renderWorkspaceTabs();
    if (activeWorkspaceId) rememberWorkspaceTab();
    window.moye.reading?.refresh({ displayOnly: true });
    updateMetadata(); toast(result.recentWarning || '已保存'); return true;
  }
  async function canLeave() {
    if (composing) { toast('请先完成当前输入法选词。'); return false; }
    syncCurrentEditor();
    if (!state.dirty && !encodingPending) return true;
    if (!desktop) return window.confirm('当前内容尚未保存，确定放弃更改吗？');
    const response = await desktop.confirmDiscard();
    if (response === 'save') return save();
    return response === 'discard';
  }
  function downloadDocument() {
    const blob = new Blob([state.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = activeDocument.name; a.click(); URL.revokeObjectURL(url); state.save(); updateMetadata();
  }
  async function readSample(name) {
    const response = await fetch(new URL(`./samples/${name}`, location.href));
    if (!response.ok && response.status !== 0) throw new Error('示例文件读取失败');
    return { name, path: null, baseUrl: new URL('./samples/', location.href).href, content: await response.text() };
  }
  async function imageFiles(files) {
    if (!desktop) { toast('本地图片插入请使用桌面版。'); return; }
    if (!activeDocument.path) { toast('请先保存文档，再插入图片。'); return; }
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error('图片不能超过 25 MB。');
      const result = await desktop.importImage({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      editor.insertMD(`${result.markdown}\n`);
    }
    input(editor.getValue());
  }
  function toggleOutline() { return quickPreference({ 'appearance.sidebarVisible': !preferences['appearance.sidebarVisible'] }); }
  function toggleTheme() { return quickPreference({ 'appearance.theme': dark ? 'light' : 'dark' }); }
  function setZoom(value) { return quickPreference({ 'appearance.fontSize': Math.max(12, Math.min(32, Math.round(17 * value / 100))) }); }

  function textNodes(includeMarkers = false) {
    const root = !includeMarkers && window.moye?.reading?.isEnabled() ? window.moye.reading.getRoot() : editor.vditor.ir.element, data = []; let length = 0, previousBlock;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) { return node.parentElement.closest(includeMarkers ? '.vditor-ir__preview' : '.vditor-ir__preview,[data-type="heading-marker"],.vditor-ir__marker:not(.vditor-ir__marker--pre)') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    let node; while ((node = walker.nextNode())) {
      const block = node.parentElement.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,pre');
      if (previousBlock && block !== previousBlock) { data.push({ node: null, start: length, text: '\n' }); length++; }
      data.push({ node, start: length, text: node.textContent }); length += node.textContent.length;
      previousBlock = block;
    }
    return data;
  }
  function selectTextRange(data, start, end, direction = 'forward') {
    const a = data.find(n => n.node && n.start + n.text.length >= start), b = data.find(n => n.node && n.start + n.text.length >= end);
    if (!a || !b) return false;
    const range = document.createRange(); range.setStart(a.node, Math.max(0, start - a.start)); range.setEnd(b.node, Math.max(0, end - b.start));
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    if (direction === 'backward') selection.setBaseAndExtent(b.node, Math.max(0, end - b.start), a.node, Math.max(0, start - a.start));
    a.node.parentElement.scrollIntoView({ block: 'nearest' }); return true;
  }
  function computeFind() {
    const query = $('find-input').value;
    if (window.moye?.reading?.isEnabled() && window.moye.reading.isPlainText()) findHits = MoyeDocument.literalMatches(state.text, query);
    else if (!window.moye?.reading?.isEnabled() && editor.getCurrentMode() === 'sv') findHits = MoyeDocument.literalMatches(editor.vditor.sv.element.value, query);
    else { findNodes = textNodes(); findHits = MoyeDocument.literalMatches(findNodes.map(n => n.text).join(''), query); }
    if (query !== lastFindQuery) findIndex = -1;
    lastFindQuery = query;
    $('find-count').textContent = query ? `${findIndex >= 0 ? findIndex + 1 : 0}/${findHits.length}` : '';
  }
  function find(direction = 1) {
    computeFind(); if (!findHits.length) return;
    findIndex = (findIndex + direction + findHits.length) % findHits.length;
    const at = findHits[findIndex], end = at + $('find-input').value.length;
    if (window.moye.reading?.isEnabled()) {
      if (window.moye.reading.isPlainText()) window.moye.reading.selectSourceRange(at, end);
      else selectTextRange(findNodes, at, end);
    }
    else if (editor.getCurrentMode() === 'sv') { editor.vditor.sv.element.focus(); editor.vditor.sv.element.setSelectionRange(at, end); ensureSourceCaretVisible(); }
    else selectTextRange(findNodes, at, end);
    $('find-count').textContent = `${findIndex + 1}/${findHits.length}`;
  }
  function replaceOne() {
    if (composing || window.moye?.reading?.isEnabled()) return;
    computeFind();
    if (findIndex >= findHits.length) findIndex = findHits.length - 1;
    if (findIndex < 0) { find(); return; }
    if (!findHits.length) return;
    const at = findHits[findIndex];
    if (editor.getCurrentMode() === 'sv') { const el = editor.vditor.sv.element; el.setSelectionRange(at, at + $('find-input').value.length); editor.updateValue($('replace-input').value); }
    else { editor.focus(); selectTextRange(findNodes, at, at + $('find-input').value.length); document.execCommand('insertText', false, $('replace-input').value); }
    input(editor.getValue()); findIndex--; find();
  }
  function replaceAll() {
    if (composing || window.moye?.reading?.isEnabled()) return;
    const query = $('find-input').value; if (!query) return;
    syncCurrentEditor(); computeFind();
    const hits = [...findHits]; if (!hits.length) return;
    editor.vditor.undo.addToUndoStack(editor.vditor);
    if (editor.getCurrentMode() === 'sv') {
      editor.vditor.sv.element.value = editor.vditor.sv.element.value.split(query).join($('replace-input').value);
    } else {
      editor.focus();
      for (const at of hits.reverse()) {
        selectTextRange(textNodes(), at, at + query.length);
        document.execCommand('insertText', false, $('replace-input').value);
      }
    }
    input(editor.getValue());
    updateMetadata(); updateStats(); updateOutline(); computeFind(); toast(`已替换 ${hits.length} 处`);
  }
  function openFind() { $('find-bar').hidden = false; $('find-input').focus(); $('find-input').select(); computeFind(); }
  function selectionMarkdown() {
    if (editor.getCurrentMode() === 'sv') {
      const el = editor.vditor.sv.element;
      return el.selectionStart !== el.selectionEnd ? el.value.slice(el.selectionStart, el.selectionEnd) : state.text;
    }
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed || !editor.vditor.ir.element.contains(selection.anchorNode)) return state.text;
    const range = selection.getRangeAt(0);
    let contents = document.createElement('div'); contents.append(range.cloneContents());
    let ancestor = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
    while (ancestor && ancestor !== editor.vditor.ir.element && /^(STRONG|EM|S|DEL|A|CODE|MARK|SUB|SUP|U|SPAN)$/.test(ancestor.tagName)) {
      const wrapper = ancestor.matches('span[data-type="a"]') ? document.createElement('a') : ancestor.cloneNode(false);
      if (ancestor.matches('span[data-type="a"]')) wrapper.setAttribute('href', ancestor.querySelector('.vditor-ir__marker--link')?.textContent || '');
      wrapper.append(...contents.childNodes); contents.append(wrapper); ancestor = ancestor.parentElement;
    }
    contents.querySelectorAll('span[data-type="a"]').forEach(node => {
      const link = document.createElement('a');
      link.setAttribute('href', node.querySelector('.vditor-ir__marker--link')?.textContent || '');
      const label = node.querySelector('.vditor-ir__link');
      link.append(...(label || node).childNodes); node.replaceWith(link);
    });
    contents.querySelectorAll('[class*="vditor-ir__marker"],.vditor-ir__preview').forEach(node => node.remove());
    return editor.html2md(contents.innerHTML).trimEnd();
  }
  async function copyText(text) {
    if (desktop) await desktop.writeClipboard({ text });
    else await navigator.clipboard.writeText(text);
  }
  function showImage(image) {
    if (window.MoyeImageViewer) return window.MoyeImageViewer.open({ src: image.src, alt: image.alt, returnFocus: document.activeElement });
    const dialog = document.createElement('dialog'); dialog.className = 'image-dialog';
    const close = document.createElement('button'); close.className = 'dialog-close'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图片预览');
    const img = document.createElement('img'); img.src = image.src; img.alt = image.alt;
    dialog.append(close, img); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }); dialog.showModal();
  }
  function showEncodingDialog() {
    if (!desktop || composing) return;
    const dialog = document.createElement('dialog'); dialog.className = 'encoding-dialog'; dialog.setAttribute('aria-label', '文件编码');
    const heading = document.createElement('h2'); heading.textContent = '文件编码';
    const message = document.createElement('p'); message.textContent = activeDocument.encodingWarning || `当前按 ${activeDocument.encoding || 'UTF-8'} 读取和保存。`;
    const label = document.createElement('label'); label.append(document.createTextNode('选择编码'));
    const select = document.createElement('select'); select.setAttribute('aria-label', '选择文本编码');
    for (const encoding of activeDocument.availableEncodings || [{ id: 'utf-8', label: 'UTF-8' }]) { const option = document.createElement('option'); option.value = encoding.id; option.textContent = encoding.label; select.append(option); }
    select.value = activeDocument.encodingId || 'utf-8'; label.append(select);
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const button = (text, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { message.textContent = e.message; } finally { b.disabled = false; } }); actions.append(b); return b; };
    if (activeDocument.encodingGuessed) button('确认当前编码', async () => { const { content, ...metadata } = await desktop.changeEncoding({ mode: 'confirm' }); activeDocument = { ...activeDocument, ...metadata }; updateMetadata(); dialog.close(); });
    const reread = button('按此编码重新读取', () => enqueueAction(() => duringDocumentTransition(async () => { if (!await canLeave()) return; const doc = await desktop.changeEncoding({ mode: 'reinterpret', encoding: select.value, discard: true }); loadDocument(doc); dialog.close(); })));  reread.disabled = !activeDocument.path;
    button('下次保存转换为此编码', async () => { const { content, ...metadata } = await desktop.changeEncoding({ mode: 'convert', encoding: select.value }); activeDocument = { ...activeDocument, ...metadata }; encodingPending = true; updateMetadata(); dialog.close(); toast('编码已选择，保存后写入磁盘。'); });
    button('关闭', async () => dialog.close()); dialog.append(heading, message, label, actions); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
  }
  function showExportDialog(format) {
    if (!desktop || composing) { toast('请完成输入后在桌面版导出。'); return; }
    const dialog = document.createElement('dialog'); dialog.className = 'encoding-dialog'; dialog.setAttribute('aria-label', format === 'pdf' ? '导出 PDF' : '导出图片');
    const heading = document.createElement('h2'); heading.textContent = format === 'pdf' ? '导出 PDF' : '导出整篇图片';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '按当前排版生成，文档内容不会改变。';
    const field = (labelText, choices, selected) => { const label = document.createElement('label'); label.textContent = labelText; const select = document.createElement('select'); select.setAttribute('aria-label', labelText); for (const [value, text] of choices) { const option = document.createElement('option'); option.value = String(value); option.textContent = text; select.append(option); } select.value = String(selected); label.append(select); dialog.append(label); return select; };
    dialog.append(heading, status);
    const width = field('图片或排版宽度', [['current', `当前正文（${preferences['appearance.contentWidth']} px）`], ['400', '手机（400 px）'], ['672', '平板（672 px）'], ['custom', '自定义']], 'current');
    const customWidth = document.createElement('input'); customWidth.type = 'number'; customWidth.min = '400'; customWidth.max = '4096'; customWidth.value = String(preferences['appearance.contentWidth']); customWidth.hidden = true; customWidth.setAttribute('aria-label', '自定义导出宽度'); dialog.append(customWidth); width.addEventListener('change', () => { customWidth.hidden = width.value !== 'custom'; });
    const scale = field('图片倍率', [[1, '1×'], [2, '2×'], [3, '3×']], 1); scale.parentElement.hidden = format !== 'png';
    const paper = field('纸张', [['A4','A4'],['Letter','Letter'],['A5','A5'],['Legal','Legal']], 'A4'); paper.parentElement.hidden = format !== 'pdf';
    const orientation = field('页面方向', [['portrait','纵向'],['landscape','横向']], 'portrait'); orientation.dataset.exportOption = 'orientation'; orientation.parentElement.hidden = format !== 'pdf';
    const marginLabel = document.createElement('label'); marginLabel.textContent = '页边距（毫米）';
    const margin = document.createElement('input'); margin.type = 'number'; margin.min = '8'; margin.max = '30'; margin.step = '1'; margin.value = '15'; margin.dataset.exportOption = 'margin-mm'; margin.setAttribute('aria-label', '页边距（毫米）'); marginLabel.append(margin); marginLabel.hidden = format !== 'pdf'; dialog.append(marginLabel);
    const theme = field('导出配色', [['current','当前配色'],['paper','白纸']], format === 'png' ? 'current' : 'paper');
    const actions = document.createElement('div'); actions.className = 'dialog-actions'; const run = document.createElement('button'), close = document.createElement('button'); run.type = close.type = 'button'; run.textContent = '选择保存位置并导出'; close.textContent = '关闭'; actions.append(run, close); dialog.append(actions); document.body.append(dialog);
    close.addEventListener('click', () => { if (!exportBusy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (exportBusy) event.preventDefault(); }); dialog.addEventListener('close', () => dialog.remove());
    run.addEventListener('click', async () => {
      if (exportBusy) return;
      const pixels = width.value === 'current' ? preferences['appearance.contentWidth'] : width.value === 'custom' ? Number(customWidth.value) : Number(width.value);
      if (!Number.isInteger(pixels) || pixels < 400 || pixels > 4096) { status.textContent = '宽度需为 400—4096 的整数。'; return; }
      if (format === 'pdf' && (!Number.isInteger(Number(margin.value)) || Number(margin.value) < 8 || Number(margin.value) > 30)) { status.textContent = '页边距需为 8—30 毫米的整数。'; return; }
      exportBusy = true; run.disabled = close.disabled = true; status.textContent = '正在生成导出文件…';
      const wasReading = window.moye.reading.isEnabled(), documentId = activeDocument.documentId;
      try {
        syncCurrentEditor(); if (!wasReading) setReading(true);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await window.moye.reading.whenReady();
        const exportRoot = await window.moye.reading.getExportRoot();
        const snapshot = await window.MoyeExportSnapshot.capture({ element: exportRoot, styleElement: window.moye.reading.getRoot(), title: activeDocument.name, values: preferences, theme: theme.value, checkResources: urls => desktop.checkExportResources({ urls }) });
        if (documentId !== activeDocument.documentId) throw new Error('文档已切换，请重新导出。');
        const result = await desktop.exportDocument({ ...snapshot, documentId, options: { format, width: pixels, scale: Number(scale.value), paperSize: paper.value, landscape: format === 'pdf' && orientation.value === 'landscape', marginMm: format === 'pdf' ? Number(margin.value) : 15, theme: theme.value } });
        if (result?.saved) { status.textContent = result.warnings?.length ? `已导出。${result.warnings.join(' ')}` : '已导出。'; toast(`已导出 ${format.toUpperCase()}`); }
        else status.textContent = '已取消导出。';
      } catch (error) { status.textContent = error.message || '导出失败，请重试。'; }
      finally { if (!wasReading) setReading(false); exportBusy = false; run.disabled = close.disabled = false; }
    });
    dialog.showModal();
  }
  async function action(name) {
    if (exportBusy) { if (name === 'close' || name === 'close-window') await desktop?.cancelClose(); toast('正在导出，请稍候。'); return; }
    closeMenus();
    if (name !== 'preferences') await settingsPanel?.flush();
    const formatCommand = window.MoyeShortcuts.commands.find(command => command.id === name && command.toolbar);
    if (formatCommand) {
      const focused = document.activeElement;
      if (composing || window.moye?.reading?.isEnabled() || settingsPanel?.isOpen() || (focused?.matches('input,textarea,[contenteditable="true"]') && !$('editor').contains(focused))) return;
      const button = editor.vditor.toolbar.elements[formatCommand.toolbar]?.querySelector('button');
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); syncCurrentEditor(); }
      return;
    }
    if (name === 'new') { if (!await canLeave()) return; rememberWorkspaceTab(); cancelPendingDraft(); loadDocument(desktop ? await desktop.newDocument() : { name: '未命名.md', content: '' }); }
    else if (name === 'recent') { if (composing) { toast('请先完成当前输入法选词。'); return; } return window.moye.recentFiles.show(); }
    else if (name === 'system-preview') return desktop?.configureSystemPreview();
    else if (name === 'open') {
      if (!await canLeave()) return;
      rememberWorkspaceTab();
      if (desktop) { cancelPendingDraft(); const doc = await desktop.openDocument(); if (doc) loadDocument(doc); else scheduleDraft(); }
      else { const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.md,.markdown,.txt'; fileInput.onchange = async () => { const file = fileInput.files[0]; if (file) loadDocument({ name: file.name, content: await file.text() }); }; fileInput.click(); }
    } else if (name === 'workspace') {
      if (!desktop) { toast('文件夹浏览需要桌面版。'); return; }
      const snapshot = await desktop.chooseWorkspace();
      if (snapshot) { activeWorkspaceId = null; workspaceTabs.clear(); renderWorkspaceTabs(); window.moye.workspace.show(); await window.moye.workspace.refresh(snapshot); }
    } else if (name === 'previous-file' || name === 'next-file') {
      const entry = await documentNeighbor(name === 'previous-file' ? -1 : 1);
      if (entry?.navigation === 'document') {
        if (!await canLeave()) return false;
        rememberWorkspaceTab(); const doc = await desktop.openDocumentNeighbor({ id: entry.id, ownerDocumentId: entry.ownerDocumentId });
        if (doc) loadDocument(doc); return !!doc;
      }
      if (entry) return openWorkspaceEntry({ ...entry, preview: true });
    }
    else if (name === 'save' || name === 'save-as') return save(name === 'save-as');
    else if (name === 'export-pdf' || name === 'export-image') return showExportDialog(name === 'export-pdf' ? 'pdf' : 'png');
    else if (name === 'auto-save') { if (activeDocument.path && !composing && (state.dirty || pendingEditorChange)) return save(); }
    else if (name === 'close' || name === 'close-window') {
      const imageDialog = document.querySelector('.moye-image-viewer[open]');
      if (imageDialog) { imageDialog.close(); await desktop?.cancelClose(); return; }
      if (name === 'close') {
        const modal = document.querySelector('dialog[open]'); if (modal) { modal.close(); await desktop?.cancelClose(); return; }
        if (activeWorkspaceId && workspaceTabs.size > 1) return duringDocumentTransition(() => closeWorkspaceTab(activeWorkspaceId));
      }
      let approved = false;
      try {
        if (await canLeave()) { cancelPendingDraft(); await desktop?.closeWindow(); approved = true; }
      } finally { if (!approved) { await desktop?.cancelClose(); scheduleDraft(); } }
    }
    else if (name === 'source') setMode(editor.getCurrentMode() === 'ir' ? 'sv' : 'ir');
    else if (name === 'reading') setReading(!window.moye?.reading?.isEnabled());
    else if (name === 'outline') return toggleOutline();
    else if (name === 'theme') return toggleTheme();
    else if (name === 'focus') return updatePreferences({ 'editor.focusMode': !preferences['editor.focusMode'] });
    else if (name === 'typewriter') return updatePreferences({ 'editor.typewriterMode': !preferences['editor.typewriterMode'] });
    else if (name === 'toolbar') return updatePreferences({ 'appearance.toolbarVisible': !preferences['appearance.toolbarVisible'] });
    else if (name === 'preferences') { if (composing) { toast('请先完成当前输入法选词。'); return; } syncCurrentEditor(); rememberPreferencesCaret(); settingsPanel.open(); }
    else if (name === 'find') openFind();
    else if (name === 'undo' || name === 'redo') {
      if (window.moye?.reading?.isEnabled()) return;
      const focused = document.activeElement;
      if (focused && (focused.matches('input,textarea') || focused.isContentEditable) && !$('editor').contains(focused)) {
        document.execCommand(name); return;
      }
      if (composing) return;
      checkpointUndo();
      editor.vditor.undo[name](editor.vditor); input(editor.getValue());
    } else if (name === 'image') { if (window.moye?.reading?.isEnabled()) return; if (desktop) { const images = await desktop.chooseImages(); for (const image of images) editor.insertMD(`${image.markdown}\n`); input(editor.getValue()); } else toast('本地图片插入请使用桌面版。'); }
    else if (name === 'copy-markdown') { syncCurrentEditor(); await copyText(selectionMarkdown()); toast('已复制 Markdown'); }
    else if (name === 'syntax' || name === 'help') {
      if (!await canLeave()) return;
      cancelPendingDraft();
      loadDocument(desktop ? await desktop.openSample({ name: '完整语法验收.md' }) : await readSample('完整语法验收.md'));
    }
    else if (name === 'restore-draft') {
      if (!desktop || !await canLeave()) return;
      cancelPendingDraft();
      const restored = await desktop.restoreDraft();
      if (!restored) { scheduleDraft(); $('recovery-banner').hidden = true; toast('没有可恢复的草稿'); return; }
      loadDocument(restored, { recovered: true });
      $('recovery-banner').hidden = true;
      await desktop.stashDraft(draftSnapshot());
      toast('已恢复为未保存副本');
    }
    else if (name === 'about') $('about-dialog').showModal();
  }
  function enqueueAction(operation) {
    const next = actionQueue.then(operation);
    actionQueue = next.catch(error => { console.error(error); toast(error.message || '操作失败，请重试。'); });
    return next;
  }
  function performAction(name) {
    enqueueAction(() => ['new', 'open', 'syntax', 'help', 'restore-draft', 'previous-file', 'next-file'].includes(name) ? duringDocumentTransition(() => action(name)) : action(name));
    return actionQueue;
  }

  async function initialize() {
    let settings = desktop ? await desktop.getSettings() : { values: settingsSchema.defaults, revision: 0 };
    if (settings.revision === 0) {
      const legacy = {};
      if (localStorage.getItem('moye.theme')) legacy['appearance.theme'] = localStorage.getItem('moye.theme') === 'dark' ? 'dark' : 'light';
      if (localStorage.getItem('moye.outline') !== null) legacy['appearance.sidebarVisible'] = localStorage.getItem('moye.outline') !== 'false';
      const oldZoom = Number(localStorage.getItem('moye.zoom'));
      if (localStorage.getItem('moye.zoom') !== null && Number.isFinite(oldZoom)) legacy['appearance.fontSize'] = Math.max(12, Math.min(32, Math.round(17 * oldZoom / 100)));
      if (Object.keys(legacy).length) settings = desktop ? await desktop.updateSettings({ patch: legacy, expectedRevision: 0 }) : { values: { ...settings.values, ...legacy }, revision: 1 };
    }
    preferences = settingsSchema.normalize(settings.values); appliedSyntax = { ...preferences }; settingsRevision = settings.revision || 0; systemTheme = settings.systemTheme || 'light'; systemLocale = settings.systemLocale || systemLocale;
    i18n = window.MoyeI18n.install({ document, getLocale: () => preferences['ui.language'], getSystemLocale: () => systemLocale });
    if (desktop) themeSnapshot = await desktop.getThemes();
    if (desktop) $('system-preview-setup').hidden = (await desktop.getPlatform()).platform !== 'linux';
    applyLivePreferences();
    const math = await window.MoyeMath.configure({ cdn, engine: preferences['math.engine'], macros: preferences['math.macros'], autoNumber: preferences['math.autoNumber'], numberingStyle: preferences['math.numberingStyle'], physics: preferences['math.physics'] });
    settingsPanel = window.MoyeSettingsPanel.create({
      definitions: settingsSchema.definitions, getValues: () => ({ ...preferences }), onApply: updatePreferences,
      onReset: () => settingsOperation(async () => desktop ? desktop.resetSettings({ expectedRevision: settingsRevision }) : { values: settingsSchema.defaults, revision: settingsRevision + 1 }),
      onImport: () => settingsOperation(async () => desktop ? desktop.importSettings({ expectedRevision: settingsRevision }) : null),
      onExport: () => desktop?.exportSettings(), onReload: reloadPreferences, isReloadPending,
      onOpenConfiguration: desktop ? () => desktop.openSettingsFile() : null,
      onReloadConfiguration: desktop ? () => settingsOperation(() => desktop.reloadSettings()) : null,
      colorThemes: desktop ? { getSnapshot: () => themeSnapshot, onSave: async options => { themeSnapshot = await desktop.saveTheme(options); applyCustomTheme(); return themeSnapshot; },
        onRemove: async options => { themeSnapshot = await desktop.removeTheme(options); applyCustomTheme(); return themeSnapshot; }, onOpenFolder: () => desktop.openThemesFolder(), onApply: updatePreferences } : null,
    });
    desktop?.onThemesChanged(snapshot => { themeSnapshot = snapshot; applyCustomTheme(); settingsPanel?.refresh(); });
    desktop?.onSettingsChanged(snapshot => {
      // IPC sends the same snapshot before the initiating invocation resolves.
      // Adopt outside the save queue so it cannot race a newer local edit.
      if (snapshot.revision < settingsRevision) return;
      if (snapshot.revision === settingsRevision && snapshot.systemTheme === systemTheme && (!snapshot.systemLocale || snapshot.systemLocale === systemLocale)) return;
      if (composing) { deferSettings(snapshot); return; }
      acceptSettings(snapshot);
    });
    // All CJK subsets total about 2.4 MB. Loading them once during startup
    // avoids a new font request and a long layout stall on the first use of
    // an uncommon Chinese character midway through writing.
    const chineseFonts = [...document.fonts].filter(face => face.family.replace(/["']/g, '') === 'Noto Sans SC');
    await Promise.all(chineseFonts.map(face => face.load()));
    const welcome = desktop ? await desktop.openSample({ name: '欢迎.md' }) : await readSample('欢迎.md');
    editor = new Vditor('editor', {
      cdn, mode: 'ir', lang: 'zh_CN', height: '100%', minHeight: 0, placeholder: '写下你的第一句话…',
      value: welcome.content, cache: { enable: false }, theme: dark ? 'dark' : 'classic',
      undoDelay: 350, tab: ' '.repeat(preferences['editor.tabSize']), typewriterMode: false, link: { isOpen: false }, image: { isPreview: true, preview: showImage },
      outline: { enable: false },
      toolbar: ['headings', '|', 'bold', 'italic', 'strike', 'inline-code', 'link', '|', 'list', 'ordered-list', 'check', 'quote', '|', 'code', 'table', '|', 'undo', 'redo', 'edit-mode'],
      toolbarConfig: { pin: true },
      preview: { delay: 100, mode: 'editor', maxWidth: preferences['appearance.contentWidth'], actions: [],
        theme: { current: dark ? 'dark' : 'light', path: `${cdn}/dist/css/content-theme` },
        markdown: { ...window.MoyeMarkdownConfig.options(preferences), sanitize: true, callout: true, linkBase: welcome.baseUrl },
        math, hljs: { enable: false, style: preferences['code.theme'], lineNumber: preferences['code.lineNumbers'] }
      },
      upload: { handler: async files => { try { await imageFiles(files); return null; } catch(error) { return error.message; } }, accept: 'image/*' },
      input,
      select(value) { $('selection-count').textContent = value ? `已选 ${[...value].length} 字符` : ''; },
      unSelect() { $('selection-count').textContent = ''; },
      after() {
        window.MoyeMarkdownConfig.apply(editor.vditor.lute, editor.vditor.options.preview.markdown, preferences);
        window.MoyeImagePolicy.applyParser(editor.vditor.lute);
        window.MoyeMarkdownConfig.applyView(editor.vditor.ir.element, preferences);
        bindEditor();
        window.moye.reading = window.MoyeReading.install({ editor, getValues: () => ({ ...preferences, ...Object.fromEntries(syntaxKeys.map(key => [key, appliedSyntax[key]])) }), isComposing: () => composing, getDocumentName: () => activeDocument.name, getDocumentKey: () => activeDocument.path || activeDocument.documentId || null, getSource: () => state.text,
          getNextDocument: () => documentNeighbor(1),
          onOpenNext: queueDocumentNeighbor,
          onNextPromptDismiss: () => updatePreferences({ 'reading.nextDocumentPrompt': false }),
          onNotice: toast,
          onModeChange: enabled => {
            if (!enabled && readingReturnMode) { const previous = readingReturnMode; readingReturnMode = null; if (previous !== editor.getCurrentMode()) setMode(previous); }
            $('reading-mode').setAttribute('aria-pressed', String(enabled));
            $('live-mode').setAttribute('aria-pressed', String(!enabled && editor.getCurrentMode() === 'ir'));
            $('source-mode').setAttribute('aria-pressed', String(!enabled && editor.getCurrentMode() === 'sv'));
            for (const id of ['toggle-replace', 'replace-one', 'replace-all']) $(id).disabled = enabled;
            window.moye?.focus?.refresh({ center: false }); window.moye?.tables?.refresh(); updateOutline();
          }, onOpenLink: url => window.open(url, '_blank', 'noopener'), onImage: showImage,
          onRendered: root => { window.moye?.contentExperience?.refresh(root); updateOutline(); } });
        window.moye.readingAnchor = window.MoyeReadingAnchor.install({ editor, isComposing: () => composing,
          getDocumentKey: () => activeDocument.path || activeDocument.documentId || null,
          rememberPositions: () => preferences['reading.rememberPosition'],
          isSuspended: () => loading || reloadingPreferences || preferences['editor.typewriterMode'] || window.moye.reading.isEnabled() });
        for (const root of [editor.vditor.ir.element, editor.vditor.sv.element, window.moye.reading.getRoot()]) i18n.registerAttributes(root);
        window.moye.typography = window.MoyeTypographyView.install({ editor, getValues: () => preferences, isComposing: () => composing, getReadingRoot: () => window.moye.reading.getRoot() });
        window.moye.tables = window.MoyeTablePresentation.install({ editor, getValues: () => preferences, isReading: () => window.moye.reading.isEnabled(), isComposing: () => composing, getReadingRoot: () => window.moye.reading.getRoot() });
        window.moye.tablePresentation = window.moye.tables;
        window.moye.contentExperience = window.MoyeContentExperience.install({ editor, getValues: () => ({ ...preferences, ...Object.fromEntries(syntaxKeys.map(key => [key, appliedSyntax[key]])) }), isComposing: () => composing,
          preserveLayout: callback => window.moye.readingAnchor.preserve(callback), writeClipboard: text => desktop ? desktop.writeClipboard({ text }) : navigator.clipboard.writeText(text) });
        window.moye.sourcePresentation = window.MoyeSourcePresentation.install({ editor, getValues: () => preferences, isComposing: () => composing });
        window.moye.workspace = window.MoyeWorkspace.install({ desktop, onChoose: () => performAction('workspace'), onHide: () => documentFocusTarget()?.focus({ preventScroll: true }), onOpen: queueWorkspaceOpen, onError: error => toast(error.message) });
        window.moye.workspace.hide();
        window.moye.recentFiles = window.MoyeRecentFiles.install({ desktop, onOpen: queueRecentOpen, onShow: rememberRecentView, onClose: restoreRecentView, onError: error => toast(error.message) });
        window.moye.i18n = i18n;
        window.moye.outlineCache = window.MoyeOutlineCache.install(editor);
        window.moye.tableTools = window.MoyeTableTools.install(editor, { sync: syncCurrentEditor, input, toast, getValues: () => preferences, isComposing: () => composing, isReading: () => window.moye.reading.isEnabled(), getReadingRoot: () => window.moye.reading.getRoot(), writeClipboard: payload => desktop ? desktop.writeClipboard(payload) : navigator.clipboard.writeText(payload.text) });
        window.moye.punctuation = window.MoyePunctuation.install({ editor, getValues: () => ({ ...preferences, ...Object.fromEntries(syntaxKeys.map(key => [key, appliedSyntax[key]])) }), isComposing: () => composing, sync: syncCurrentEditor, captureSelection: captureLiveSelection, restoreSelection: restoreLiveSelection });
        window.moye.focus = window.MoyeFocus.create({ editor, isEnabled: () => preferences['editor.focusMode'] && !window.moye.reading.isEnabled(), isTypewriterEnabled: () => preferences['editor.typewriterMode'] && !window.moye.reading.isEnabled(), alwaysCenter: () => preferences['editor.typewriterAlwaysCenter'], isComposing: () => composing });
        window.moye.shortcuts = window.MoyeEditorShortcuts.install({ editor, getValues: () => preferences, isComposing: () => composing, performAction, isBlocked: () => settingsPanel?.isOpen() });
        window.MoyePairing.install({ editor, getValues: () => ({ ...preferences, ...Object.fromEntries(syntaxKeys.map(key => [key, appliedSyntax[key]])) }), isComposing: () => composing, sync: syncCurrentEditor, selectionMarkdown, captureSelection: captureLiveSelection, restoreSelection: restoreLiveSelection });
        window.moye.autoLinks = window.MoyeAutoLinks.create({ element: editor.vditor.ir.element, isEnabled: () => appliedSyntax['markdown.autoLink'], isComposing: () => composing, onOpen: url => window.open(url, '_blank', 'noopener') });
        loadDocument(welcome); applyLivePreferences(); window.moye.ready = true; desktop?.ready().catch(error => toast(error.message));
        if (settings.warnings?.length) toast(settings.warnings[0]);
      }
    });
    window.moye = { ready: false, get editor() { return editor; }, getState: () => { if (pendingEditorChange) syncCurrentEditor(); return { ...activeDocument, content: state.text, dirty: state.dirty || encodingPending, mode: editor.getCurrentMode(), reading: !!window.moye.reading?.isEnabled() }; }, loadDocument, setMode, setReading, performAction,
      settings: { getValues: () => ({ ...preferences }), apply: updatePreferences, reload: reloadPreferences, isReloadPending, panel: settingsPanel, reset: () => settingsPanel ? settingsOperation(async () => desktop ? desktop.resetSettings({ expectedRevision: settingsRevision }) : { values: settingsSchema.defaults, revision: settingsRevision + 1 }) : null }
    };
  }
  function bindEditor() {
    // Vditor's delayed undo checkpoint restores its DOM Range after recording
    // it. Chromium then focuses the editor, even if a menu or settings control
    // has taken focus in the meantime. Keep recording the same history while
    // letting the current application control retain focus.
    const undo = editor.vditor.undo, addCaret = undo.addCaret;
    undo.addCaret = function(kernel, setFocus = false) {
      const focused = document.activeElement;
      const editorOwnsFocus = !window.moye?.reading?.isEnabled() && (focused === document.body || kernel.element.contains(focused));
      return addCaret.call(this, kernel, setFocus && editorOwnsFocus);
    };
    const codeButton = editor.vditor.toolbar.elements.code?.querySelector('button');
    codeButton?.addEventListener('click', event => {
      const language = preferences['code.defaultLanguage'];
      if (!language || composing) return;
      const sel = getSelection(), node = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (editor.getCurrentMode() === 'ir' && node?.closest('[data-type="code-block"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const source = editor.getCurrentMode() === 'sv' ? editor.vditor.sv.element : null;
      const hasSelection = source ? source.selectionStart !== source.selectionEnd : !!sel.rangeCount && !sel.isCollapsed;
      editor.insertMD(`\n\`\`\`${language}\n${hasSelection ? selectionMarkdown() : ''}\n\`\`\`\n`); syncCurrentEditor();
    }, true);
    for (const mode of ['ir', 'sv']) {
      const el = editor.vditor[mode].element;
      el.setAttribute('aria-label', mode === 'ir' ? 'Markdown 书写区' : 'Markdown 源码');
      el.addEventListener('beforeinput', event => { if (documentTransition) event.preventDefault(); }, true);
      el.addEventListener('compositionstart', () => { composing = true; }, true);
      el.addEventListener('compositionend', () => {
        composing = false;
        queueMicrotask(() => {
          input(editor.getValue());
          if (deferredSettingsSnapshot) { const snapshot = deferredSettingsSnapshot; deferredSettingsSnapshot = null; if (snapshot.revision >= settingsRevision) acceptSettings(snapshot); }
        });
      }, true);
      // Mark edits immediately; serialize after the core's debounce. Save,
      // close and mode switching explicitly flush the DOM first. Avoiding a
      // full-document serialization on every keystroke keeps long files fast.
      el.addEventListener('input', () => {
        if (composing) return;
        if (mode === 'sv') syncCurrentEditor();
        else { pendingEditorChange = true; updateMetadata(); }
      });
      el.addEventListener('keydown', event => {
        if (event.isComposing || composing) return;
        if (mode === 'ir' && !event.altKey) {
          const selection = window.getSelection();
          const range = selection.rangeCount ? selection.getRangeAt(0) : null;
          const container = range && (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer);
          const cell = container?.closest('td,th');
          const table = cell?.closest('table');
          const finalRow = table?.rows[table.rows.length - 1];
          const appendAtEnd = event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && cell === finalRow?.cells[finalRow.cells.length - 1];
          if (cell && ((event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) || appendAtEnd)) {
            // Typora's table shortcut inserts a row below the current one;
            // Tab also grows the table after its final cell.
            event.preventDefault(); event.stopImmediatePropagation();
            editor.vditor.undo.addToUndoStack(editor.vditor);
            const sourceRow = cell.parentElement, newRow = document.createElement('tr');
            for (const original of sourceRow.cells) {
              const td = document.createElement('td');
              if (original.hasAttribute('align')) td.setAttribute('align', original.getAttribute('align'));
              td.append(document.createTextNode('\u200b')); newRow.append(td);
            }
            if (sourceRow.parentElement.tagName === 'THEAD') {
              const body = table.tBodies[0] || table.createTBody(); body.prepend(newRow);
            } else sourceRow.after(newRow);
            const next = document.createRange(); next.setStart(newRow.cells[0].firstChild, 1); next.collapse(true);
            selection.removeAllRanges(); selection.addRange(next);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            syncCurrentEditor(); editor.vditor.undo.addToUndoStack(editor.vditor); return;
          }
          if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && cell && cell.contains(range.endContainer)) {
            // A text-node caret after a trailing <br> can be normalized back to
            // the previous visual line by Chromium. Anchor the new line in a
            // real text node before the editor reparses the table.
            event.preventDefault(); event.stopImmediatePropagation();
            editor.vditor.undo.addToUndoStack(editor.vditor);
            const lineRange = selection.getRangeAt(0).cloneRange();
            lineRange.deleteContents();
            const fragment = document.createDocumentFragment();
            fragment.append(document.createElement('br'));
            const anchor = document.createTextNode('\u200b'); fragment.append(anchor);
            lineRange.insertNode(fragment); lineRange.setStart(anchor, 1); lineRange.collapse(true);
            selection.removeAllRanges(); selection.addRange(lineRange);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
            syncCurrentEditor(); editor.vditor.undo.addToUndoStack(editor.vditor); return;
          }
          const item = container?.closest('li');
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.moyeListTab && item && !cell && !container.closest('.vditor-ir__marker--pre,[data-type="code-block"],[data-type="math-block"]')) {
            // The inner kernel only recognizes Tab at the first character.
            // Route arbitrary caret positions through that same operation,
            // then restore both ends and the direction of the user's range.
            event.preventDefault(); event.stopImmediatePropagation();
            syncCurrentEditor();
            const before = state.text, bookmark = captureLiveSelection(), wasCollapsed = range.collapsed;
            editor.vditor.undo.addToUndoStack(editor.vditor);
            if (wasCollapsed) {
              const routed = document.createRange(); routed.setStart(item, 0); routed.collapse(true); selection.removeAllRanges(); selection.addRange(routed);
            } else restoreLiveSelection(bookmark);
            const forwarded = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true, shiftKey: event.shiftKey });
            Object.defineProperty(forwarded, 'moyeListTab', { value: true });
            el.dispatchEvent(forwarded);
            syncCurrentEditor();
            restoreLiveSelection({ start: mapOffset(before, state.text, bookmark.start), end: mapOffset(before, state.text, bookmark.end), direction: bookmark.direction });
            editor.vditor.undo.addToUndoStack(editor.vditor);
            if (bookmark.direction === 'backward' && selection.rangeCount) {
              const restored = selection.getRangeAt(0);
              selection.setBaseAndExtent(restored.endContainer, restored.endOffset, restored.startContainer, restored.startOffset);
            }
            return;
          }
        }
      }, true);
      el.addEventListener('paste', event => {
        // The editor core handles formatted HTML, Markdown and image pastes.
        // Shift+paste is routed by the platform's plain-text paste command.
        if (event.clipboardData?.files.length && !activeDocument.path) { event.preventDefault(); event.stopImmediatePropagation(); toast('请先保存文档，再粘贴图片。'); }
      }, true);
      const copySelection = event => {
        if (mode !== 'ir' || !event.clipboardData || !getSelection().toString()) return;
        const range = getSelection().getRangeAt(0);
        if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return;
        const markdown = selectionMarkdown();
        const html = new DOMParser().parseFromString(editor.vditor.lute.Md2HTML(markdown), 'text/html').body;
        const plain = node => {
          if (node.nodeType === 3) return node.data;
          if (node.nodeType !== 1) return '';
          if (node.tagName === 'BR') return '\n';
          if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
          if (['SCRIPT', 'STYLE'].includes(node.tagName)) return '';
          if (node.tagName === 'PRE') return node.textContent.replace(/\n$/, '');
          if (['UL', 'OL'].includes(node.tagName)) return [...node.children].map(plain).join('\n');
          if (node.tagName === 'TR') return [...node.children].map(plain).join('\t');
          if (['TABLE', 'THEAD', 'TBODY'].includes(node.tagName)) return [...node.children].map(plain).join('\n');
          return [...node.childNodes].map(plain).join('');
        };
        const text = [...html.childNodes].filter(node => node.nodeType !== 3 || node.data.trim()).map(plain).join('\n\n');
        event.clipboardData.setData('text/plain', preferences['editor.copyPlainTextAsMarkdown'] ? markdown : text);
        event.clipboardData.setData('text/html', html.innerHTML);
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === 'cut') {
          editor.vditor.undo.addToUndoStack(editor.vditor);
          document.execCommand('delete'); syncCurrentEditor();
          editor.vditor.undo.addToUndoStack(editor.vditor);
        }
      };
      el.addEventListener('copy', copySelection, true);
      el.addEventListener('cut', copySelection, true);
    }
    // A plain click edits links; only Ctrl/Cmd-click opens them.
    editor.vditor.ir.element.addEventListener('click', event => {
      const footnote = event.target.closest('sup[data-type="footnotes-ref"]');
      if (footnote && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopImmediatePropagation(); syncCurrentEditor();
        const label = footnote.getAttribute('data-footnotes-label');
        const definition = [...editor.vditor.ir.element.querySelectorAll('[data-type="footnotes-def"]')].find(node => node.textContent.trim().startsWith(`[${label}]:`));
        if (definition) {
          const offset = captureLivePoint(footnote, 0);
          footnoteReturn = { source: state.text, start: offset, end: offset, direction: 'forward' };
          $('footnote-back').hidden = false; definition.scrollIntoView({ block: 'center' });
        }
        return;
      }
      const anchor = event.target.closest('a');
      if (anchor && anchor.getAttribute('href')?.startsWith('#')) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
          const target = document.getElementById(id) || renderedHeadings().find(h => h.textContent.trim().replace(/^#+\s*/, '').toLowerCase().replace(/\s+/g, '-') === id);
          target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
      }
    }, true);
    desktop?.onAction(performAction);
    const removeInlineHandlers = () => editor.vditor.element.querySelectorAll('.vditor-copy [onclick],.vditor-copy [onmouseover]').forEach(node => { node.removeAttribute('onclick'); node.removeAttribute('onmouseover'); });
    new MutationObserver(removeInlineHandlers).observe(editor.vditor.element, { childList: true, subtree: true }); removeInlineHandlers();
    if (desktop) desktop.getDraft().then(draft => { if (draft) { restoredDraft = draft; $('recovery-banner').hidden = false; } }).catch(console.error);
  }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => performAction(button.dataset.action)));
  $('more-button').addEventListener('click', event => { event.stopPropagation(); $('more-menu').hidden = !$('more-menu').hidden; $('more-button').setAttribute('aria-expanded', String(!$('more-menu').hidden)); if (!$('more-menu').hidden) $('more-menu').querySelector('button:not([hidden]):not(:disabled)')?.focus(); });
  $('more-menu').addEventListener('keydown', event => {
    const buttons = [...$('more-menu').querySelectorAll('button:not([hidden]):not(:disabled)')], index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenus(); $('more-button').focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !buttons.length) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[target].focus(); buttons[target].scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('focusin', event => { if (!$('more-menu').hidden && !event.target.closest('#more-menu,#more-button')) closeMenus(); });
  document.addEventListener('click', event => { if (!event.target.closest('#more-menu')) closeMenus(); });
  document.addEventListener('click', event => {
    const button = event.target.closest('.vditor-copy > span');
    if (button) { event.preventDefault(); event.stopPropagation(); copyText(button.previousElementSibling?.value || '').then(() => { button.setAttribute('aria-label', '已复制'); }).catch(error => toast(error.message)); }
  }, true);
  $('source-mode').addEventListener('click', () => setMode('sv'));
  $('live-mode').addEventListener('click', () => setMode('ir'));
  $('reading-mode').addEventListener('click', () => setReading(true));
  $('outline-toggle').addEventListener('click', toggleOutline); $('hide-outline').addEventListener('click', toggleOutline);
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('encoding-button').addEventListener('click', showEncodingDialog);
  $('ignore-external').addEventListener('click', () => { $('external-change-banner').hidden = true; });
  $('reload-external').addEventListener('click', () => {
    enqueueAction(() => duringDocumentTransition(async () => {
      if (!await canLeave()) return;
      const mode = editor.getCurrentMode(), wasReading = window.moye.reading.isEnabled(), source = state.text;
      const selection = mode === 'sv' ? { start: activeElement().selectionStart, end: activeElement().selectionEnd, direction: activeElement().selectionDirection } : !wasReading ? captureLiveSelection() : null;
      const workspaceId = activeWorkspaceId;
      const bookmark = wasReading ? window.moye.reading.capturePosition?.() : window.moye.readingAnchor.beforeLayout();
      const doc = await desktop.reloadDocument({ discard: true });
      if (workspaceId && workspaceTabs.has(workspaceId)) doc.workspaceId = workspaceId;
      loadDocument(doc);
      if (mode !== editor.getCurrentMode()) setMode(mode);
      if (selection) {
        const mapped = { start: mapOffset(source, state.text, selection.start), end: mapOffset(source, state.text, selection.end), direction: selection.direction };
        if (mode === 'sv') activeElement().setSelectionRange(mapped.start, mapped.end, mapped.direction); else restoreLiveSelection(mapped);
      }
      if (wasReading) { await window.moye.reading.whenReady(); window.moye.reading.restorePosition?.(bookmark); }
      else if (bookmark) window.moye.readingAnchor.afterLayout({ ...bookmark, ...(mode === 'sv' ? { offset: mapOffset(source, state.text, bookmark.offset) } : {}) });
      if (workspaceId) rememberWorkspaceTab();
    }));
  });
  desktop?.onExternalChange(update => {
    if (update.path !== activeDocument.path) return;
    $('external-change-banner').querySelector('span').textContent = update.missing ? '文件已被外部删除；当前内容仍保留，可另存为。' : '文件已在外部更改；可重新载入或保留当前内容。';
    $('reload-external').disabled = update.missing; $('external-change-banner').hidden = false;
  });
  $('footnote-back').addEventListener('click', () => {
    if (!footnoteReturn) return;
    if (editor.getCurrentMode() === 'sv') setMode('ir');
    syncCurrentEditor();
    restoreLiveSelection({ start: mapOffset(footnoteReturn.source, state.text, footnoteReturn.start), end: mapOffset(footnoteReturn.source, state.text, footnoteReturn.end), direction: 'forward' });
    footnoteReturn = null; $('footnote-back').hidden = true;
  });
  $('zoom-out').addEventListener('click', () => setZoom(zoom - 10)); $('zoom-in').addEventListener('click', () => setZoom(zoom + 10)); $('zoom-reset').addEventListener('click', () => setZoom(100));
  $('find-input').addEventListener('input', () => { findIndex = -1; computeFind(); });
  $('find-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? -1 : 1); } });
  $('find-next').addEventListener('click', () => find()); $('find-prev').addEventListener('click', () => find(-1));
  $('close-find').addEventListener('click', () => { $('find-bar').hidden = true; documentFocusTarget()?.focus({ preventScroll: true }); });
  $('toggle-replace').addEventListener('click', () => { $('replace-row').hidden = !$('replace-row').hidden; });
  $('replace-one').addEventListener('click', replaceOne); $('replace-all').addEventListener('click', replaceAll);
  $('about-dialog').querySelector('.dialog-close').addEventListener('click', () => $('about-dialog').close());
  $('restore-draft').addEventListener('click', () => performAction('restore-draft'));
  $('dismiss-draft').addEventListener('click', () => { $('recovery-banner').hidden = true; desktop.clearDraft().catch(console.error); });
  document.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (settingsPanel?.isOpen()) return;
    if (event.key === 'Escape') { closeMenus(); $('find-bar').hidden = true; if (preferences['editor.focusMode']) quickPreference({ 'editor.focusMode': false }); return; }
  });
  window.addEventListener('beforeunload', event => { if (!desktop && state.dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('settings-reload').addEventListener('click', () => reloadPreferences().catch(error => toast(error.message)));
  initialize().catch(error => { console.error(error); $('editor').textContent = `编辑器启动失败：${error.message}`; });
})();
