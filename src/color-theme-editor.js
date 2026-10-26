(function (root) {
  'use strict';
  const config = () => root.MoyeColorThemes;
  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function create(options) {
    if (!options || typeof options.getSnapshot !== 'function' || typeof options.onSave !== 'function' || typeof options.getValues !== 'function') throw new TypeError('Colour theme editor requires snapshots, values and save callbacks.');
    const element = node('details', 'moye-theme-editor');
    const summary = node('summary', '', '自定义颜色主题');
    const body = node('div', 'moye-theme-editor__body');
    const intro = node('p', 'moye-settings__description', '复制当前配色后编辑。保存与外部修改会实时更新；未知颜色键保留继承值，文件错误会在这里显示。');
    const fileRow = node('div', 'moye-theme-editor__row');
    const select = node('select', 'moye-settings__select'); select.dataset.colorThemeFile = ''; select.setAttribute('aria-label', '编辑颜色主题文件');
    const copy = node('button', 'moye-settings__secondary', '复制当前主题'); copy.type = 'button'; copy.dataset.colorThemeAction = 'copy';
    const folder = node('button', 'moye-settings__secondary', '打开主题文件夹'); folder.type = 'button'; folder.dataset.colorThemeAction = 'folder'; folder.hidden = typeof options.onOpenFolder !== 'function';
    fileRow.append(select, copy, folder);
    const nameRow = node('label', 'moye-theme-editor__file-label', '文件名');
    const filename = node('input', 'moye-settings__input'); filename.type = 'text'; filename.maxLength = 69; filename.autocomplete = 'off'; filename.spellcheck = false; filename.dataset.colorThemeFilename = ''; filename.setAttribute('aria-label', '主题文件名');
    nameRow.append(filename);
    const text = node('textarea', 'moye-settings__textarea moye-theme-editor__source'); text.rows = 12; text.maxLength = config().maximumBytes; text.spellcheck = false; text.dataset.colorThemeSource = ''; text.setAttribute('aria-label', '颜色主题 TOML');
    const actions = node('div', 'moye-theme-editor__row');
    const save = node('button', 'moye-settings__primary', '保存主题');
    const apply = node('button', 'moye-settings__secondary', '应用主题');
    const remove = node('button', 'moye-settings__secondary', '删除文件');
    const reload = node('button', 'moye-settings__secondary', '载入外部版本');
    for (const [button, action] of [[save, 'save'], [apply, 'apply'], [remove, 'delete'], [reload, 'reload']]) { button.type = 'button'; button.dataset.colorThemeAction = action; }
    actions.append(save, apply, remove, reload);
    const status = node('p', 'moye-theme-editor__status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const sample = node('div', 'moye-theme-editor__sample'); sample.dataset.colorThemePreview = '';
    const sampleTitle = node('strong', '', '颜色预览');
    const sampleText = node('p', '', '中文 English 2026，与文字一起安静阅读。');
    const sampleLink = node('span', 'moye-theme-editor__sample-link', '链接与强调');
    const sampleCode = node('code', '', 'const note = "Hello";');
    sample.append(sampleTitle, sampleText, sampleLink, sampleCode);
    const help = node('details', 'moye-theme-editor__help');
    help.append(node('summary', '', '主题格式与继承规则'));
    help.append(node('p', 'moye-settings__description', '这是受限 TOML：只支持 [meta]、[colors]、[chrome] 与带引号的单行字符串。颜色为十六进制；appearance 为 light 或 dark。based_on 可填 moye、mono、solarized、nord 或 custom:另一个文件名（不含 .toml）。不执行 CSS、脚本或网络内容。'));
    const diagnostics = node('div', 'moye-theme-editor__diagnostics'); diagnostics.setAttribute('aria-label', '主题目录诊断');
    body.append(intro, fileRow, nameRow, text, actions, status, sample, help, diagnostics); element.append(summary, body);
    let selectedFile = '', loadedHash = null, dirty = false, busy = false, composing = false, externalChanged = false, deleteRequested = false, disposed = false;
    let lastList = '', currentSnapshot = { themes: [], errors: [] };
    const drafts = new Map();
    function appearance() {
      const value = options.getValues()['appearance.theme'];
      return value === 'dark' || value === 'system' && document.body.classList.contains('dark') ? 'dark' : 'light';
    }
    function message(value, kind = '') {
      // Keep application messages separate and canonical. A joined Chinese
      // prefix plus several warnings is not a single translation key; each
      // span can now switch locale reversibly without touching theme source.
      const parts = Array.isArray(value) ? value : [value];
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        if (index) fragment.append(document.createTextNode(' '));
        fragment.append(node('span', 'moye-theme-editor__status-part', String(part ?? '')));
      });
      status.replaceChildren(fragment); status.dataset.state = kind;
    }
    function records() { return [...(currentSnapshot.themes || []), ...(currentSnapshot.errors || []).filter(item => typeof item.content === 'string')]; }
    function currentRecord() { return records().find(item => item.fileName === selectedFile); }
    function validate() {
      try { return config().parse(text.value, filename.value); } catch (error) { return { error: error.message }; }
    }
    function updatePreview(writeMessage = true) {
      const theme = validate();
      if (!theme.error) {
        const all = (currentSnapshot.themes || []).filter(item => item.id !== theme.id).concat(theme);
        const resolved = config().resolve(all, theme.id, theme.appearance);
        for (const key of config().variableKeys) sample.style.removeProperty(key);
        for (const [key, value] of Object.entries(resolved.variables)) sample.style.setProperty(key, value);
        sample.dataset.appearance = theme.appearance;
        if (!busy && writeMessage) message([dirty ? '草稿预览，保存后才应用。' : '已载入。', ...resolved.warnings], resolved.warnings.length ? 'warning' : '');
      } else if (!busy && writeMessage) message(filename.value || text.value ? theme.error : '复制当前主题，或从列表选择一个文件开始编辑。', filename.value || text.value ? 'error' : '');
      for (const control of [filename, text]) control.disabled = busy;
      for (const control of [select, copy, folder]) control.disabled = busy || composing;
      save.disabled = busy || composing || !dirty || Boolean(theme.error);
      const record = currentRecord();
      apply.disabled = busy || composing || dirty || !record?.id || record.appearance !== appearance() || typeof options.onApply !== 'function';
      apply.title = record?.appearance && record.appearance !== appearance() ? `此主题用于${record.appearance === 'dark' ? '深' : '浅'}色外观，请先切换外观。` : '';
      remove.disabled = busy || composing || !record || typeof options.onRemove !== 'function';
      remove.textContent = deleteRequested ? '确认删除文件' : '删除文件';
      reload.hidden = !externalChanged; reload.disabled = busy || composing;
    }
    function rememberDraft() {
      if (!dirty || !text.value) return;
      drafts.set(selectedFile, { fileName: filename.value, content: text.value, hash: loadedHash, externalChanged });
      if (drafts.size > 32) drafts.delete(drafts.keys().next().value);
    }
    function load(record, { force = false } = {}) {
      if (composing) return;
      selectedFile = record?.fileName || '';
      if (force) drafts.delete(selectedFile);
      const draft = drafts.get(selectedFile);
      if (draft) {
        filename.value = draft.fileName; text.value = draft.content; loadedHash = draft.hash; dirty = true;
        externalChanged = draft.externalChanged || Boolean(record && record.hash !== loadedHash); deleteRequested = false;
        select.value = selectedFile; updatePreview();
        if (externalChanged) message('文件已在外部更新，当前草稿已保留。可载入外部版本后继续编辑。', 'warning');
        return;
      }
      filename.value = selectedFile; text.value = record?.content || '';
      loadedHash = record?.hash || null; dirty = false; externalChanged = false; deleteRequested = false;
      select.value = selectedFile;
      updatePreview();
    }
    function newDraft() {
      const list = new Set(records().map(item => item.fileName)); let number = 1;
      while (list.has(`my-theme-${number}.toml`)) number++;
      const values = options.getValues(), id = values['typography.colorTheme'] || 'moye';
      const resolved = config().resolve(currentSnapshot.themes, id, appearance());
      selectedFile = ''; loadedHash = null; externalChanged = false; deleteRequested = false;
      filename.value = `my-theme-${number}.toml`;
      text.value = config().toTOML({ name: `我的主题 ${number}`, appearance: appearance(), basedOn: config().builtins.includes(id) ? id : 'moye', variables: resolved.variables });
      select.value = ''; dirty = true; updatePreview();
    }
    function refresh(snapshot = options.getSnapshot()) {
      if (disposed) return;
      currentSnapshot = snapshot || { themes: [], errors: [] };
      const available = records();
      const signature = JSON.stringify(available.map(item => [item.fileName, item.name, item.message]));
      if (signature !== lastList) {
        const list = document.createDocumentFragment();
        const placeholder = node('option', '', '新主题草稿'); placeholder.value = ''; list.append(placeholder);
        available.forEach(item => { const option = node('option', '', `${item.name || item.fileName}${item.id ? '' : ' · 文件有误'}`); option.value = item.fileName; list.append(option); });
        select.replaceChildren(list); lastList = signature; select.value = selectedFile;
      }
      const record = currentRecord();
      if (selectedFile && record?.hash !== loadedHash) {
        if (dirty || composing) externalChanged = true;
        else load(record);
      }
      if (!selectedFile && !text.value && available.length) {
        const active = available.find(item => item.id === options.getValues()['typography.colorTheme']) || available[0]; load(active);
      }
      diagnostics.replaceChildren();
      for (const error of currentSnapshot.errors || []) {
        const line = node('p');
        const identity = node('span', 'moye-theme-editor__diagnostic-name', error.fileName || '主题目录');
        // A file name is data even when it contains a full-width colon or an
        // application word such as 保存. Only the separator and error are UI.
        if (error.fileName) identity.dataset.moyeUserContent = '';
        line.append(identity, node('span', 'moye-theme-editor__diagnostic-separator', '：'), node('span', 'moye-theme-editor__diagnostic-message', error.message));
        diagnostics.append(line);
      }
      updatePreview();
      if (externalChanged) message('文件已在外部更新，当前草稿已保留。可载入外部版本后继续编辑。', 'warning');
    }
    async function operation(action, success) {
      if (busy || composing || disposed) return;
      busy = true; updatePreview(); message('正在处理…');
      try {
        const snapshot = await action();
        if (snapshot?.themes) currentSnapshot = snapshot;
        message(success, 'saved'); return snapshot;
      } catch (error) { message(error?.message || '主题操作失败。', 'error'); return null; }
      finally { busy = false; updatePreview(false); }
    }
    select.addEventListener('change', () => {
      const target = select.value; rememberDraft();
      if (!target && !drafts.has('')) newDraft();
      else load(records().find(item => item.fileName === target));
    });
    copy.addEventListener('click', () => { rememberDraft(); newDraft(); filename.focus(); filename.select(); });
    folder.addEventListener('click', () => operation(options.onOpenFolder, '主题文件夹已打开'));
    for (const control of [filename, text]) {
      control.addEventListener('compositionstart', () => { composing = true; updatePreview(); });
      control.addEventListener('compositionend', () => { composing = false; dirty = true; deleteRequested = false; updatePreview(); });
      control.addEventListener('input', event => { if (event.isComposing || composing) return; dirty = true; deleteRequested = false; updatePreview(); });
    }
    text.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); save.click(); }
    });
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      const previousFile = selectedFile, fileName = filename.value, content = text.value, expectedHash = fileName === selectedFile ? loadedHash : null;
      const result = await operation(() => options.onSave({ fileName, content, expectedHash }), '主题已保存');
      if (result) { drafts.delete(previousFile); drafts.delete(fileName); selectedFile = fileName; dirty = false; externalChanged = false; refresh(result); load(currentRecord()); message('主题已保存，外部修改会自动更新。', 'saved'); }
    });
    apply.addEventListener('click', () => { const record = currentRecord(); if (!apply.disabled) operation(() => options.onApply({ 'typography.colorTheme': record.id }), '主题已应用'); });
    remove.addEventListener('click', async () => {
      if (remove.disabled) return;
      if (!deleteRequested) { deleteRequested = true; updatePreview(); return; }
      const record = currentRecord();
      const result = await operation(() => options.onRemove({ fileName: selectedFile, expectedHash: record.hash }), '主题文件已删除');
      if (result) { drafts.delete(selectedFile); selectedFile = ''; text.value = ''; filename.value = ''; dirty = false; loadedHash = null; refresh(result); message('主题文件已删除。', 'saved'); }
    });
    reload.addEventListener('click', () => load(currentRecord(), { force: true }));
    summary.addEventListener('click', () => { if (!element.open && !text.value) newDraft(); });
    refresh();
    return Object.freeze({ element, refresh, isComposing: () => composing, isBusy: () => busy, dispose() { disposed = true; element.remove(); } });
  }
  root.MoyeColorThemeEditor = Object.freeze({ create });
})(window);
