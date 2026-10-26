(function (root) {
  'use strict';

  let instanceNumber = 0;
  const categoryNames = {
    general: '通用', appearance: '外观', editor: '编辑器', markdown: 'Markdown',
    code: '代码块', math: '数学公式', images: '图像', image: '图像',
    files: '文件', export: '导出', advanced: '高级', typography: '排版',
  };

  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function create(options) {
    if (!options || !Array.isArray(options.definitions) || typeof options.getValues !== 'function' || typeof options.onApply !== 'function') {
      throw new TypeError('Settings panel needs definitions, getValues and onApply.');
    }
    const definitions = options.definitions.filter(definition => definition.hidden !== true && definition.implemented !== false && definition.supported !== false);
    const instance = `moye-preferences-${++instanceNumber}`;
    const rows = new Map(), categoryButtons = new Map(), categories = [];
    let currentCategory = null, queue = Promise.resolve(), pending = new Set();
    let previousFocus = null, previousSelection = null, previousInputSelection = null;
    let disposed = false, closing = false, auxiliaryBusy = false;
    let openingValues = null, deleteRequested = false, previewCollapsed = innerWidth < 1000;
    const dialog = element('dialog', 'moye-settings');
    dialog.id = options.id || 'settings-dialog';
    dialog.setAttribute('aria-labelledby', `${instance}-title`);
    dialog.setAttribute('aria-describedby', `${instance}-scope`);
    const heading = element('header', 'moye-settings__header');
    const titleGroup = element('div');
    const title = element('h2', '', '偏好设置');
    title.id = `${instance}-title`;
    titleGroup.append(title, element('p', '', '调整你的书写空间'));
    const closeButton = element('button', 'moye-settings__close', '×');
    closeButton.type = 'button';
    closeButton.dataset.settingsAction = 'close';
    closeButton.setAttribute('aria-label', '关闭偏好设置');
    closeButton.title = '关闭 · Esc';
    heading.append(titleGroup, closeButton);

    const layout = element('div', 'moye-settings__layout');
    const sidebar = element('aside', 'moye-settings__sidebar');
    const searchWrap = element('div', 'moye-settings__search');
    const search = element('input');
    search.type = 'search'; search.placeholder = '搜索设置'; search.autocomplete = 'off';
    search.setAttribute('aria-label', '搜索偏好设置');
    search.id = 'settings-search';
    const clearSearch = element('button', 'moye-settings__clear-search', '×');
    clearSearch.type = 'button'; clearSearch.hidden = true;
    clearSearch.setAttribute('aria-label', '清空设置搜索');
    searchWrap.append(search, clearSearch);
    const nav = element('nav', 'moye-settings__nav');
    nav.setAttribute('aria-label', '设置分类');
    sidebar.append(searchWrap, nav);
    const main = element('section', 'moye-settings__main');
    main.setAttribute('aria-label', '设置选项');
    const sectionHeading = element('div', 'moye-settings__section-heading');
    const sectionTitle = element('h3');
    const resultCount = element('span', 'moye-settings__result-count');
    sectionHeading.append(sectionTitle, resultCount);
    const fields = element('div', 'moye-settings__fields');
    const noResults = element('p', 'moye-settings__empty', '没有找到匹配的设置。试试“公式”“配对”或“字体”。');
    noResults.hidden = true;
    const profileCard = element('section', 'moye-settings__profile-card');
    profileCard.setAttribute('aria-label', '排版方案');
    const profileHeading = element('div', 'moye-settings__profile-heading');
    const profileTitle = element('h4', '', '排版方案');
    const profileState = element('span', 'moye-settings__profile-state');
    profileState.setAttribute('aria-live', 'polite');
    profileHeading.append(profileTitle, profileState);
    const profileSelect = element('select', 'moye-settings__select');
    profileSelect.dataset.typographyProfile = '';
    profileSelect.setAttribute('aria-label', '选择排版方案');
    const profileDescription = element('p', 'moye-settings__description', '一套方案组合字体、行距、列宽与排版。切换只调整显示，文档内容保持原样。');
    const profileActions = element('div', 'moye-settings__profile-actions');
    const profileName = element('input', 'moye-settings__input');
    profileName.type = 'text'; profileName.maxLength = 80; profileName.autocomplete = 'off';
    profileName.placeholder = '给当前排版起个名字'; profileName.setAttribute('aria-label', '新排版方案名称');
    profileName.dataset.typographyName = '';
    const saveProfile = element('button', 'moye-settings__secondary', '保存为新方案');
    const copyProfile = element('button', 'moye-settings__secondary', '复制当前');
    const deleteProfile = element('button', 'moye-settings__secondary', '删除方案');
    const cancelDelete = element('button', 'moye-settings__secondary', '取消删除');
    for (const [button, action] of [[saveProfile, 'save'], [copyProfile, 'copy'], [deleteProfile, 'delete'], [cancelDelete, 'delete-cancel']]) {
      button.type = 'button'; button.dataset.typographyAction = action;
    }
    cancelDelete.hidden = true;
    profileActions.append(profileName, saveProfile, copyProfile, deleteProfile, cancelDelete);
    profileCard.append(profileHeading, profileSelect, profileDescription, profileActions);
    const colorEditor = options.colorThemes && root.MoyeColorThemeEditor ? root.MoyeColorThemeEditor.create({
      ...options.colorThemes, getValues, onApply: options.colorThemes.onApply || options.onApply,
    }) : null;
    if (colorEditor) profileCard.append(colorEditor.element);

    const previewCard = element('section', 'moye-settings__preview-card');
    previewCard.setAttribute('aria-label', '排版样例预览');
    const previewHeading = element('div', 'moye-settings__profile-heading');
    const previewTitle = element('h4', '', '排版样例');
    const previewToggle = element('button', 'moye-settings__preview-toggle');
    previewToggle.type = 'button'; previewToggle.dataset.typographyAction = 'preview-toggle';
    const compareLabel = element('label', 'moye-settings__compare-label');
    const compare = element('input'); compare.type = 'checkbox'; compare.dataset.typographyAction = 'compare';
    compareLabel.append(compare, document.createTextNode('对照打开前'));
    previewHeading.append(previewTitle, compareLabel, previewToggle);
    const previewColumns = element('div', 'moye-settings__preview-columns');
    function makePreview(kind, title) {
      const column = element('div', 'moye-settings__preview-column');
      column.dataset.settingsPreviewColumn = kind;
      const caption = element('p', 'moye-settings__preview-caption', title);
      const paper = element('article', 'moye-settings__preview-paper');
      paper.dataset.settingsPreview = kind;
      paper.setAttribute('aria-label', `${title}排版样例`);
      const h = element('h5', '', '让文字自然成形');
      const paragraph = element('p', '', '用 Markdown 记录想法，让中文与 English、数字 2026 自然相处。');
      const second = element('p');
      second.append(document.createTextNode('技术笔记也有呼吸感：'), element('code', '', 'Update()'), document.createTextNode(' 与公式 '));
      const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
      math.setAttribute('aria-label', 'E 等于 m c 的平方');
      const equation = document.createElementNS(math.namespaceURI, 'mrow');
      for (const [tag, value] of [['mi', 'E'], ['mo', '='], ['mi', 'm']]) {
        const item = document.createElementNS(math.namespaceURI, tag); item.textContent = value; equation.append(item);
      }
      const sup = document.createElementNS(math.namespaceURI, 'msup');
      for (const [tag, value] of [['mi', 'c'], ['mn', '2']]) {
        const item = document.createElementNS(math.namespaceURI, tag); item.textContent = value; sup.append(item);
      }
      equation.append(sup); math.append(equation); second.append(math, document.createTextNode('。'));
      const pre = element('pre'); pre.append(element('code', '', 'const note = "你好，world";'));
      paper.append(h, paragraph, second, pre);
      column.append(caption, paper); previewColumns.append(column);
      return { column, paper };
    }
    const beforePreview = makePreview('before', '打开前');
    const currentPreview = makePreview('current', '当前');
    beforePreview.column.hidden = true;
    const previewNote = element('p', 'moye-settings__description', '这里可预览尚未保存的输入；对照只作用于样例。公式为 MathML 排版示意。');
    previewCard.append(previewHeading, previewColumns, previewNote);
    main.append(sectionHeading, profileCard, previewCard, fields, noResults);
    layout.append(sidebar, main);

    const footer = element('footer', 'moye-settings__footer');
    const operationRow = element('div', 'moye-settings__operations');
    const importButton = element('button', 'moye-settings__secondary', '导入设置…');
    const exportButton = element('button', 'moye-settings__secondary', '导出设置…');
    const resetButton = element('button', 'moye-settings__secondary', '恢复默认…');
    const openConfiguration = element('button', 'moye-settings__secondary', '配置文件…');
    const reloadConfiguration = element('button', 'moye-settings__secondary', '重读配置');
    importButton.dataset.settingsAction = 'import';
    exportButton.dataset.settingsAction = 'export';
    resetButton.dataset.settingsAction = 'reset';
    openConfiguration.dataset.settingsAction = 'open-configuration';
    reloadConfiguration.dataset.settingsAction = 'reload-configuration';
    for (const button of [importButton, exportButton, resetButton, openConfiguration, reloadConfiguration]) button.type = 'button';
    importButton.hidden = typeof options.onImport !== 'function';
    exportButton.hidden = typeof options.onExport !== 'function';
    resetButton.hidden = typeof options.onReset !== 'function';
    openConfiguration.hidden = typeof options.onOpenConfiguration !== 'function';
    reloadConfiguration.hidden = typeof options.onReloadConfiguration !== 'function';
    resetButton.setAttribute('aria-expanded', 'false');
    const status = element('p', 'moye-settings__status', '更改会自动保存');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    operationRow.append(importButton, exportButton, resetButton, openConfiguration, reloadConfiguration, status);
    const resetConfirmation = element('div', 'moye-settings__reset-confirmation');
    resetConfirmation.hidden = true;
    resetConfirmation.setAttribute('role', 'group');
    resetConfirmation.setAttribute('aria-label', '确认恢复默认设置');
    const resetText = element('p', '', '将恢复这里的全部设置。文档内容不会改变。');
    const resetCancel = element('button', 'moye-settings__secondary', '取消');
    const resetConfirm = element('button', 'moye-settings__primary', '恢复默认设置');
    resetCancel.type = resetConfirm.type = 'button';
    resetCancel.dataset.settingsAction = 'reset-cancel';
    resetConfirm.dataset.settingsAction = 'reset-confirm';
    resetConfirmation.append(resetText, resetCancel, resetConfirm);
    const reloadNotice = element('div', 'moye-settings__reload-notice');
    reloadNotice.hidden = true;
    const reloadDescription = element('p', '', '语法设置已保存，重新载入后生效。文档内容会保留，撤销记录将重新开始。');
    const reloadButton = element('button', 'moye-settings__secondary', '重新载入');
    reloadButton.type = 'button';
    reloadButton.dataset.settingsAction = 'reload';
    reloadButton.hidden = typeof options.onReload !== 'function';
    reloadNotice.append(reloadDescription, reloadButton);
    const scope = element('p', 'moye-settings__scope', 'Typora 1.14.10 全设置兼容仍在完善；这里列出已接入选项，默认值尚未逐项对照原版。');
    scope.id = `${instance}-scope`;
    footer.append(resetConfirmation, reloadNotice, operationRow, scope);
    dialog.append(heading, layout, footer);

    function getValues() { return options.getValues() || {}; }
    function categoryName(category) { return categoryNames[category] || category || '其他'; }
    function typography() { return options.typography || root.MoyeTypography; }
    function baselineValues(values = getValues()) {
      let profile = {};
      try { profile = typography()?.baseline(values) || {}; } catch (_) { /* Invalid imported profiles retain the ordinary defaults. */ }
      return { ...Object.fromEntries(definitions.map(definition => [definition.key, definition.default])), ...profile };
    }
    function fieldDisabled(row) {
      const values = getValues();
      return auxiliaryBusy || (typeof options.isDisabled === 'function' && options.isDisabled(row.definition.key, values))
        || (['math.autoNumber', 'math.numberingStyle', 'math.physics'].includes(row.definition.key) && values['math.engine'] !== 'MathJax');
    }
    function draftValues() {
      const result = { ...getValues() };
      rows.forEach(row => {
        if (!row.dirty || row.composing) return;
        const read = readControl(row);
        if (!read.error) result[row.definition.key] = read.value;
      });
      return result;
    }
    function applyPreview(preview, values, caption) {
      const api = root.MoyeTypographyView;
      let capabilities = null;
      if (typeof api?.applyTo === 'function') capabilities = api.applyTo(preview.paper, values);
      else {
        preview.paper.style.fontFamily = values['appearance.fontFamily'] || '';
        preview.paper.style.fontSize = `${Number(values['appearance.fontSize']) || 17}px`;
        preview.paper.style.lineHeight = String(Number(values['appearance.lineHeight']) || 1.85);
      }
      preview.column.querySelector('.moye-settings__preview-caption').textContent = `${caption} · ${values['appearance.fontSize'] || 17}px / ${values['appearance.lineHeight'] || 1.85} / ${values['appearance.contentWidth'] || 780}px`;
      preview.paper.style.setProperty('--settings-sample-mono', values['appearance.monospaceFontFamily'] || 'monospace');
      if (root.MoyeColorThemes && options.colorThemes?.getSnapshot) {
        const currentAppearance = values['appearance.theme'] === 'dark' || values['appearance.theme'] === 'system' && document.body.classList.contains('dark') ? 'dark' : 'light';
        const resolved = root.MoyeColorThemes.resolve(options.colorThemes.getSnapshot()?.themes, values['typography.colorTheme'], currentAppearance);
        for (const key of root.MoyeColorThemes.variableKeys) preview.paper.style.removeProperty(key);
        for (const [key, value] of Object.entries(resolved.variables)) preview.paper.style.setProperty(key, value);
      }
      return capabilities;
    }
    function refreshExperience() {
      const values = getValues(), api = typography();
      const show = !search.value.trim() ? ['外观', '排版', 'appearance', 'typography'].includes(currentCategory)
        : /排版|方案|预设|样例|字体|字号|行高|列宽|typography|appearance|font|size|line.?height|width|preset|sample|profile|spacing|layout/i.test(search.value);
      profileCard.hidden = !api || !show;
      previewCard.hidden = !show;
      if (api) {
        try {
          const profiles = api.profiles(values), selected = values['typography.activeProfile'] || 'daily';
          if (JSON.stringify(profiles.map(profile => [profile.id, profile.name])) !== profileSelect.dataset.list) {
            const list = document.createDocumentFragment();
            profiles.forEach(profile => {
              const option = element('option', '', `${profile.name}${profile.builtin ? '' : ' · 自定义'}`);
              option.value = profile.id; list.append(option);
            });
            profileSelect.replaceChildren(list);
            profileSelect.dataset.list = JSON.stringify(profiles.map(profile => [profile.id, profile.name]));
          }
          profileSelect.value = selected;
          const active = api.getProfile(selected, values);
          profileState.textContent = api.modified(values) ? '已调整' : '与方案一致';
          profileState.dataset.modified = String(api.modified(values));
          deleteProfile.hidden = !active || active.builtin;
          if (deleteProfile.hidden) deleteRequested = false;
        } catch (error) { profileState.textContent = '方案不可用'; deleteProfile.hidden = true; }
      }
      deleteProfile.textContent = deleteRequested ? '确认删除' : '删除方案';
      deleteProfile.setAttribute('aria-expanded', String(deleteRequested));
      cancelDelete.hidden = !deleteRequested;
      for (const control of [profileSelect, profileName, saveProfile, copyProfile, deleteProfile, cancelDelete]) control.disabled = auxiliaryBusy;
      const baseline = baselineValues(values);
      rows.forEach(row => {
        row.control.disabled = fieldDisabled(row);
        row.reset.disabled = fieldDisabled(row) || row.pendingCount > 0 || row.composing || (!row.dirty && sameValue(values[row.definition.key] ?? row.definition.default, baseline[row.definition.key]));
        row.reset.textContent = typography()?.profileKeys?.includes(row.definition.key) ? '恢复方案值' : '恢复默认';
      });
      const colorRow = rows.get('typography.colorTheme');
      if (colorRow?.control.tagName === 'SELECT') {
        const selected = colorRow.dirty || colorRow.pendingCount > 0 ? colorRow.control.value : values['typography.colorTheme'];
        const currentAppearance = values['appearance.theme'] === 'dark' || values['appearance.theme'] === 'system' && document.body.classList.contains('dark') ? 'dark' : 'light';
        const choices = [['moye', '墨页'], ['mono', '黑白'], ['solarized', 'Solarized'], ['nord', 'Nord']].map(([value, label]) => ({ value, label }));
        for (const theme of options.colorThemes?.getSnapshot?.()?.themes || []) choices.push({ value: theme.id, label: `${theme.name} · ${theme.appearance === 'dark' ? '深色' : '浅色'}${theme.appearance !== currentAppearance ? '（外观不匹配）' : ''}`, disabled: theme.appearance !== currentAppearance });
        if (selected && !choices.some(item => item.value === selected)) choices.push({ value: selected, label: `主题不可用：${selected}`, disabled: true });
        const signature = JSON.stringify(choices);
        if (colorRow.control.dataset.colorThemeChoices !== signature) {
          const list = document.createDocumentFragment();
          choices.forEach(choice => { const item = element('option', '', choice.label); item.value = choice.value; item.disabled = Boolean(choice.disabled); list.append(item); });
          colorRow.control.replaceChildren(list); colorRow.control.dataset.colorThemeChoices = signature;
        }
        colorRow.control.value = selected || 'moye';
      }
      beforePreview.column.hidden = !compare.checked;
      previewColumns.hidden = previewCollapsed;
      previewNote.hidden = previewCollapsed;
      previewToggle.textContent = previewCollapsed ? '展开样例' : '收起样例';
      previewToggle.setAttribute('aria-expanded', String(!previewCollapsed));
      previewColumns.classList.toggle('moye-settings__preview-columns--compare', compare.checked);
      const draft = draftValues(), capabilities = applyPreview(currentPreview, draft, '当前');
      if (compare.checked) applyPreview(beforePreview, openingValues || values, '打开前');
      const notes = ['这里可预览尚未保存的输入；对照只作用于样例。公式为 MathML 排版示意。'];
      if (draft['typography.textAlign'] === 'optimal') notes.push('整段优化在阅读模式中呈现；这里展示常规段落。');
      if (draft['typography.hangingPunctuation'] && capabilities?.hangingPunctuation === false) notes.push('当前编辑引擎不支持标点悬挂，采用常规标点位置。');
      if (draft['typography.cjkSpacing'] && capabilities?.textAutospace === false) notes.push('当前编辑引擎不支持自动混排间距，保留字体原有间距。');
      previewNote.textContent = notes.join(' ');
      colorEditor?.refresh();
    }
    function setStatus(message, kind = '') {
      if (disposed) return;
      status.textContent = message;
      status.dataset.state = kind;
    }
    function setRowError(row, message) {
      row.error.textContent = message || '';
      row.error.hidden = !message;
      row.control.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
    function signature(row) { return row.control.type === 'checkbox' ? String(row.control.checked) : row.control.value; }
    function writeControl(row, value) {
      const { control, definition } = row;
      if (control.type === 'checkbox') control.checked = value === true;
      else if (definition.type === 'json' || definition.key === 'math.macros') {
        control.value = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
      } else control.value = value === undefined || value === null ? '' : String(value);
      row.lastSignature = signature(row);
    }
    function readControl(row) {
      const { definition, control } = row;
      if (control.type === 'checkbox') return { value: control.checked };
      if (definition.type === 'number' || definition.type === 'integer' || typeof definition.default === 'number') {
        const raw = control.value.trim(), value = Number(raw);
        if (!raw || !Number.isFinite(value)) return { error: '请输入有效数字。' };
        if (definition.type === 'integer' && !Number.isInteger(value)) return { error: '请输入整数。' };
        if (definition.min !== undefined && value < definition.min) return { error: `不能小于 ${definition.min}。` };
        if (definition.max !== undefined && value > definition.max) return { error: `不能大于 ${definition.max}。` };
        return { value };
      }
      if (definition.type === 'json' || definition.key === 'math.macros') {
        try {
          const value = JSON.parse(control.value);
          if (!value || Array.isArray(value) || typeof value !== 'object') return { error: '请输入 JSON 对象，例如 {}。' };
          return { value: typeof definition.default === 'string' ? control.value : value };
        } catch (_) { return { error: 'JSON 格式有误，请检查引号、逗号和括号。' }; }
      }
      return { value: control.value };
    }
    function refresh() {
      if (disposed) return;
      const values = getValues();
      rows.forEach(row => {
        if (!row.dirty && row.pendingCount === 0) writeControl(row, values[row.definition.key] ?? row.definition.default);
      });
      refreshReloadState();
      refreshExperience();
    }
    function refreshReloadState() {
      reloadNotice.hidden = typeof options.isReloadPending !== 'function' || !options.isReloadPending();
    }
    function serial(task) {
      const result = queue.catch(() => {}).then(task);
      queue = result.catch(() => {});
      pending.add(result);
      result.finally(() => pending.delete(result)).catch(() => {});
      return result;
    }
    function commit(row) {
      clearTimeout(row.timer); row.timer = null;
      if (row.composing) return Promise.resolve(false);
      if (!row.dirty || row.queuedVersion === row.version) return row.lastTask || Promise.resolve(true);
      const read = readControl(row);
      if (read.error) {
        setRowError(row, read.error);
        setStatus('有设置尚未保存，请检查标出的选项。', 'error');
        return Promise.resolve(false);
      }
      const version = row.version, value = read.value;
      row.queuedVersion = version;
      row.pendingCount++;
      setStatus('正在保存…', 'saving');
      row.lastTask = serial(async () => {
        try {
          await options.onApply({ [row.definition.key]: value });
          refreshReloadState();
          if (row.version === version) {
            row.dirty = false;
            setRowError(row, '');
            writeControl(row, getValues()[row.definition.key] ?? row.definition.default);
          }
          if ([...rows.values()].some(item => item.control.getAttribute('aria-invalid') === 'true')) setStatus('有设置尚未保存，请检查标出的选项。', 'error');
          else if ([...rows.values()].some(item => item.dirty || (item !== row && item.pendingCount > 0))) setStatus('正在保存…', 'saving');
          else setStatus('已保存', 'saved');
          return true;
        } catch (error) {
          if (row.version === version) {
            row.dirty = false;
            writeControl(row, getValues()[row.definition.key] ?? row.definition.default);
            setRowError(row, error?.message || '保存失败，已恢复上次保存的值。');
          }
          setStatus(error?.message || '保存失败，请重试。', 'error');
          return false;
        } finally {
          row.pendingCount--;
          row.wrapper.classList.toggle('moye-settings__row--pending', row.pendingCount > 0);
          refreshExperience();
        }
      });
      row.wrapper.classList.add('moye-settings__row--pending');
      return row.lastTask;
    }
    function edited(row, immediate) {
      if (auxiliaryBusy || row.composing) return;
      const nextSignature = signature(row);
      if (nextSignature !== row.lastSignature) {
        row.lastSignature = nextSignature;
        row.version++;
        row.dirty = true;
        setRowError(row, '');
      }
      if (!row.dirty) return;
      refreshExperience();
      clearTimeout(row.timer); row.timer = null;
      if (immediate) commit(row);
      else {
        setStatus('正在保存…', 'saving');
        row.timer = setTimeout(() => commit(row), 400);
      }
    }

    definitions.forEach((definition, index) => {
      const category = definition.category || definition.key.split('.')[0] || '其他';
      if (!categories.includes(category)) categories.push(category);
      const wrapper = element('div', 'moye-settings__row');
      wrapper.dataset.setting = definition.key;
      wrapper.dataset.settingKey = definition.key;
      const labelGroup = element('div', 'moye-settings__label-group');
      const label = element('label', 'moye-settings__label', definition.label || definition.key);
      const id = `${instance}-field-${index}`;
      label.htmlFor = id;
      const categoryBadge = element('span', 'moye-settings__category-badge', categoryName(category));
      categoryBadge.hidden = true;
      labelGroup.append(categoryBadge, label);
      const descriptionText = definition.key === 'typography.colorTheme' ? '调整显示配色。自定义主题可在上方编辑，浅色和深色主题须匹配当前外观。' : definition.description || '';
      const description = element('p', 'moye-settings__description', descriptionText);
      description.id = `${id}-description`;
      if (descriptionText) labelGroup.append(description);
      const error = element('p', 'moye-settings__field-error');
      error.id = `${id}-error`; error.hidden = true; error.setAttribute('aria-live', 'polite');
      error.dataset.settingKey = definition.key;
      let control;
      const optionsList = definition.key === 'typography.colorTheme' ? [{ value: 'moye', label: '墨页' }, { value: 'mono', label: '黑白' }, { value: 'solarized', label: 'Solarized' }, { value: 'nord', label: 'Nord' }] : definition.options;
      if (definition.type === 'boolean' || definition.type === 'bool') {
        control = element('input', 'moye-settings__checkbox');
        control.type = 'checkbox';
      } else if (Array.isArray(optionsList) && optionsList.length) {
        control = element('select', 'moye-settings__select');
        optionsList.forEach(option => {
          const item = element('option', '', typeof option === 'object' ? option.label ?? String(option.value) : String(option));
          item.value = String(typeof option === 'object' ? option.value : option);
          control.append(item);
        });
      } else if (definition.type === 'json' || definition.key === 'math.macros' || definition.multiline) {
        control = element('textarea', 'moye-settings__textarea');
        control.rows = definition.rows || 4;
        control.spellcheck = false;
      } else {
        control = element('input', 'moye-settings__input');
        control.type = definition.type === 'number' || definition.type === 'integer' ? 'number' : 'text';
        if (control.type === 'number') {
          if (definition.min !== undefined) control.min = definition.min;
          if (definition.max !== undefined) control.max = definition.max;
          control.step = definition.step ?? (definition.type === 'integer' ? 1 : 'any');
        }
        if (definition.maxLength !== undefined) control.maxLength = definition.maxLength;
        if (definition.placeholder) control.placeholder = definition.placeholder;
        control.autocomplete = 'off';
        control.spellcheck = false;
      }
      control.id = id;
      control.dataset.setting = definition.key;
      control.dataset.settingKey = definition.key;
      control.setAttribute('aria-describedby', [descriptionText ? description.id : '', error.id].filter(Boolean).join(' '));
      control.setAttribute('aria-invalid', 'false');
      const controlGroup = element('div', 'moye-settings__control-group');
      const reset = element('button', 'moye-settings__field-reset', '恢复默认');
      reset.type = 'button'; reset.dataset.resetSetting = definition.key;
      reset.setAttribute('aria-label', `恢复${definition.label || definition.key}`);
      controlGroup.append(control, error, reset);
      wrapper.append(labelGroup, controlGroup);
      const row = { definition, wrapper, control, error, reset, category, categoryBadge, dirty: false, composing: false, version: 0, queuedVersion: -1, pendingCount: 0, timer: null, lastTask: null };
      const searchLabels = [definition.label, definition.key, definition.description, categoryName(category), ...(optionsList || []).map(option => typeof option === 'object' ? `${option.label} ${option.value}` : String(option))];
      row.searchText = [...searchLabels, ...searchLabels.map(text => window.MoyeI18n?.t(String(text || ''), 'en-US') || text)].join(' ').toLocaleLowerCase();
      rows.set(definition.key, row);
      writeControl(row, getValues()[definition.key] ?? definition.default);
      control.addEventListener('compositionstart', () => { clearTimeout(row.timer); row.timer = null; row.composing = true; });
      control.addEventListener('compositionend', () => { row.composing = false; edited(row, false); refreshExperience(); });
      control.addEventListener('input', event => { if (!event.isComposing) edited(row, control.type === 'checkbox' || control.tagName === 'SELECT'); });
      control.addEventListener('change', () => edited(row, true));
      control.addEventListener('blur', () => { if (row.dirty) commit(row); });
      reset.addEventListener('click', () => {
        if (fieldDisabled(row) || row.composing) return;
        writeControl(row, baselineValues()[definition.key]);
        row.version++; row.dirty = true; row.queuedVersion = -1; setRowError(row, ''); commit(row);
      });
      fields.append(wrapper);
    });

    function applyFilter() {
      const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const searching = words.length > 0;
      clearSearch.hidden = !search.value;
      sectionTitle.textContent = searching ? '搜索结果' : categoryName(currentCategory);
      let count = 0;
      rows.forEach(row => {
        const visible = searching ? words.every(word => row.searchText.includes(word)) : row.category === currentCategory;
        row.wrapper.hidden = !visible;
        row.categoryBadge.hidden = !searching;
        if (visible) count++;
      });
      noResults.hidden = count !== 0;
      resultCount.textContent = `${count} 项`;
      categoryButtons.forEach((button, category) => button.setAttribute('aria-pressed', String(!searching && category === currentCategory)));
      refreshExperience();
      if (!profileCard.hidden || !previewCard.hidden) {
        noResults.hidden = true;
        if (count === 0) resultCount.textContent = '排版工具';
      }
      main.scrollTop = 0;
    }
    categories.forEach(category => {
      const button = element('button', 'moye-settings__category');
      button.type = 'button';
      button.dataset.settingsCategory = category;
      const label = element('span', '', categoryName(category));
      const count = element('span', '', String([...rows.values()].filter(row => row.category === category).length));
      button.append(label, count);
      button.addEventListener('click', () => {
        currentCategory = category;
        search.value = '';
        applyFilter();
      });
      categoryButtons.set(category, button); nav.append(button);
    });
    currentCategory = categories[0] || '通用';
    applyFilter();

    nav.addEventListener('keydown', event => {
      const buttons = [...categoryButtons.values()];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let target;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length];
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = buttons[(index + buttons.length - 1) % buttons.length];
      if (event.key === 'Home') target = buttons[0];
      if (event.key === 'End') target = buttons.at(-1);
      if (target) { event.preventDefault(); target.focus(); target.click(); }
    });
    search.addEventListener('input', applyFilter);
    clearSearch.addEventListener('click', () => { search.value = ''; applyFilter(); search.focus(); });
    function hideResetConfirmation() {
      resetConfirmation.hidden = true;
      resetButton.setAttribute('aria-expanded', 'false');
    }
    function setAuxiliaryBusy(value) {
      auxiliaryBusy = value;
      for (const button of [resetButton, importButton, exportButton, openConfiguration, reloadConfiguration, resetConfirm, resetCancel, reloadButton]) button.disabled = value;
      rows.forEach(row => { row.control.disabled = fieldDisabled(row); });
      dialog.setAttribute('aria-busy', String(value));
      refreshExperience();
    }
    async function flush() {
      if (disposed) return true;
      if (colorEditor?.isBusy()) { setStatus('正在处理颜色主题，请稍候。', 'saving'); return false; }
      if ([...rows.values()].some(row => row.composing) || colorEditor?.isComposing()) {
        setStatus('请先完成当前输入法选词。', 'error');
        return false;
      }
      const outstanding = [...pending];
      rows.forEach(row => {
        clearTimeout(row.timer); row.timer = null;
        if (row.dirty) outstanding.push(commit(row));
      });
      const results = await Promise.all(outstanding.map(task => Promise.resolve(task).catch(() => false)));
      await queue;
      return results.every(result => result !== false);
    }
    function restoreFocus() {
      if (!previousFocus?.isConnected) return;
      previousFocus.focus({ preventScroll: true });
      try {
        if (previousInputSelection && typeof previousFocus.setSelectionRange === 'function') {
          previousFocus.setSelectionRange(...previousInputSelection);
        } else if (previousSelection?.anchorNode?.isConnected && previousSelection?.focusNode?.isConnected) {
          getSelection().setBaseAndExtent(previousSelection.anchorNode, previousSelection.anchorOffset, previousSelection.focusNode, previousSelection.focusOffset);
        }
      } catch (_) { /* Re-rendering may have replaced a previous selection node. */ }
      previousFocus = previousSelection = previousInputSelection = null;
    }
    async function close() {
      if (!dialog.open || disposed) return true;
      if (closing || auxiliaryBusy) return false;
      closing = true;
      try {
        if (!await flush()) {
          const invalid = [...rows.values()].find(row => row.control.getAttribute('aria-invalid') === 'true');
          if (invalid) {
            currentCategory = invalid.category; search.value = ''; applyFilter();
            invalid.control.focus(); invalid.wrapper.scrollIntoView({ block: 'nearest' });
          }
          return false;
        }
        hideResetConfirmation();
        dialog.close(); restoreFocus();
        return true;
      } finally { closing = false; }
    }
    closeButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      // Modal shortcuts must not format or save the document behind this panel.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (event.isComposing || [...rows.values()].some(row => row.composing)) return;
        event.preventDefault(); search.focus(); search.select();
      }
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    });
    resetButton.addEventListener('click', () => {
      resetConfirmation.hidden = false;
      resetButton.setAttribute('aria-expanded', 'true');
      resetCancel.focus();
    });
    resetCancel.addEventListener('click', () => { hideResetConfirmation(); resetButton.focus(); });
    resetConfirm.addEventListener('click', async () => {
      if (auxiliaryBusy) return;
      rows.forEach(row => { clearTimeout(row.timer); row.timer = null; row.dirty = false; });
      setAuxiliaryBusy(true);
      setStatus('正在恢复默认设置…', 'saving');
      const success = await serial(async () => {
        try { await options.onReset(); return true; }
        catch (error) { setStatus(error?.message || '恢复默认失败。', 'error'); return false; }
      });
      setAuxiliaryBusy(false);
      if (success) {
        rows.forEach(row => setRowError(row, ''));
        hideResetConfirmation(); refresh(); setStatus('已恢复默认设置', 'saved'); resetButton.focus();
      } else refresh();
    });
    async function auxiliary(action, successMessage) {
      if (auxiliaryBusy) return;
      if (!await flush()) return;
      setAuxiliaryBusy(true);
      setStatus('正在处理…', 'saving');
      try {
        const result = await serial(action);
        if (result === null || result?.canceled === true || result?.cancelled === true) setStatus('已取消');
        else { refresh(); setStatus(successMessage, 'saved'); }
      } catch (error) { setStatus(error?.message || '操作失败，请重试。', 'error'); }
      finally { setAuxiliaryBusy(false); }
    }
    importButton.addEventListener('click', () => auxiliary(options.onImport, '设置已导入'));
    exportButton.addEventListener('click', () => auxiliary(options.onExport, '设置已导出'));
    openConfiguration.addEventListener('click', () => auxiliary(options.onOpenConfiguration, '配置文件已打开，保存后的修改会自动载入'));
    reloadConfiguration.addEventListener('click', () => auxiliary(options.onReloadConfiguration, '配置已重新载入'));
    profileSelect.addEventListener('change', () => {
      const id = profileSelect.value;
      deleteRequested = false;
      auxiliary(async () => options.onApply(typography().applyProfile(id, getValues())), '排版方案已应用');
    });
    function saveCurrentProfile(name) {
      return auxiliary(async () => {
        const patch = typography().saveProfile(getValues(), name);
        await options.onApply(patch); profileName.value = '';
      }, '排版方案已保存');
    }
    saveProfile.addEventListener('click', () => {
      if (!profileName.value.trim()) { setStatus('请先给排版方案起个名字。', 'error'); profileName.focus(); return; }
      saveCurrentProfile(profileName.value);
    });
    profileName.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); saveProfile.click(); }
    });
    copyProfile.addEventListener('click', () => {
      const api = typography(), values = getValues();
      const existing = new Set(api.profiles(values).map(profile => profile.name.toLocaleLowerCase()));
      const original = api.getProfile(values['typography.activeProfile'] || 'daily', values)?.name || '排版';
      let suffix = 1, name;
      do { name = `${[...original].slice(0, 27).join('')} 副本${suffix === 1 ? '' : suffix}`; suffix++; } while (existing.has(name.toLocaleLowerCase()));
      saveCurrentProfile(name);
    });
    deleteProfile.addEventListener('click', () => {
      if (!deleteRequested) { deleteRequested = true; refreshExperience(); return; }
      auxiliary(async () => {
        await options.onApply(typography().removeProfile(getValues()['typography.activeProfile'], getValues()));
        deleteRequested = false;
      }, '方案已删除，当前显示已保留');
    });
    cancelDelete.addEventListener('click', () => { deleteRequested = false; refreshExperience(); deleteProfile.focus(); });
    compare.addEventListener('change', () => { if (compare.checked) previewCollapsed = false; refreshExperience(); });
    previewToggle.addEventListener('click', () => { previewCollapsed = !previewCollapsed; refreshExperience(); });
    reloadButton.addEventListener('click', async () => {
      if (auxiliaryBusy || !await flush()) return;
      setAuxiliaryBusy(true);
      setStatus('正在重新载入…', 'saving');
      try {
        await options.onReload();
        refresh();
        setStatus('语法设置已生效', 'saved');
      } catch (error) { setStatus(error?.message || '重新载入失败，请重试。', 'error'); }
      finally { setAuxiliaryBusy(false); }
    });
    document.body.append(dialog);

    return Object.freeze({
      open(key) {
        if (disposed) return;
        if (!dialog.open) {
          previousFocus = document.activeElement;
          previousInputSelection = null; previousSelection = null;
          if (typeof previousFocus?.selectionStart === 'number') previousInputSelection = [previousFocus.selectionStart, previousFocus.selectionEnd, previousFocus.selectionDirection];
          const selection = getSelection();
          if (selection?.rangeCount) previousSelection = { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset, focusNode: selection.focusNode, focusOffset: selection.focusOffset };
          openingValues = { ...getValues() }; compare.checked = false; deleteRequested = false;
          refresh(); hideResetConfirmation(); dialog.showModal();
        }
        const target = typeof key === 'string' ? rows.get(key) : null;
        if (target) {
          currentCategory = target.category; search.value = ''; applyFilter(); target.control.focus();
          target.wrapper.scrollIntoView({ block: 'nearest' });
        } else { search.focus(); search.select(); }
      },
      close, flush, refresh,
      isOpen: () => dialog.open,
      async destroy() {
        if (disposed) return true;
        if (!await close()) return false;
        disposed = true;
        rows.forEach(row => clearTimeout(row.timer));
        colorEditor?.dispose();
        dialog.remove();
        return true;
      },
    });
  }

  root.MoyeSettingsPanel = Object.freeze({ create });
})(window);
