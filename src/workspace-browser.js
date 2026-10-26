(function (root) {
  'use strict';
  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function install(options = {}) {
    const desktop = options.desktop || root.desktop;
    const owned = !options.container;
    const container = options.container || el('aside', 'moye-workspace');
    container.classList.add('moye-workspace'); container.setAttribute('aria-label', '工作区文件');
    if (owned) document.querySelector('.workspace')?.prepend(container);
    let snapshot = null, activeId = null, requestVersion = 0, disposed = false, searchTimer;
    const expanded = new Set(), children = new Map();
    const heading = el('header', 'moye-workspace__heading');
    const title = el('strong', '', '工作区');
    const open = el('button', '', '打开文件夹'); open.type = 'button'; open.dataset.workspaceAction = 'choose';
    const refreshButton = el('button', '', '↻'); refreshButton.type = 'button'; refreshButton.title = '刷新工作区'; refreshButton.setAttribute('aria-label', '刷新工作区');
    const closeButton = el('button', '', '×'); closeButton.type = 'button'; closeButton.title = '收起工作区'; closeButton.setAttribute('aria-label', '收起工作区'); closeButton.dataset.workspaceAction = 'hide';
    heading.append(title, open, refreshButton, closeButton);
    const filter = el('input', 'moye-workspace__filter'); filter.type = 'search'; filter.placeholder = '筛选文件名或扩展名'; filter.setAttribute('aria-label', '筛选工作区文件');
    const navigation = el('div', 'moye-workspace__navigation');
    const previous = el('button', '', '← 上一篇'), next = el('button', '', '下一篇 →');
    previous.type = next.type = 'button'; previous.disabled = next.disabled = true; navigation.append(previous, next);
    const tree = el('div', 'moye-workspace__tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', '文档文件树');
    const message = el('p', 'moye-workspace__message', '选择文件夹，浏览本地 Markdown 和 TXT。'); message.setAttribute('role', 'status');
    container.replaceChildren(heading, filter, navigation, tree, message);
    function error(err) { message.textContent = err?.message || String(err); options.onError?.(err); }
    function bridge(name, value) { if (!desktop || typeof desktop[name] !== 'function') throw new Error('工作区文件浏览需要桌面版。'); return desktop[name](value); }
    function matches(entry) { const words = filter.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean); return words.every(word => entry.name.toLocaleLowerCase().includes(word.replace(/^\./, '')) || entry.relativePath.toLocaleLowerCase().includes(word)); }
    function buttons() { return [...tree.querySelectorAll('button[data-workspace-id]')]; }
    function refreshSelection() { const list = buttons(); list.forEach((button,index) => { if (button.dataset.kind === 'file') button.setAttribute('aria-selected', String(button.dataset.workspaceId === activeId)); button.tabIndex = button.dataset.workspaceId === activeId || !activeId && index === 0 ? 0 : -1; }); }
    async function activate(entry, preview) {
      if (disposed) return;
      try {
        const result = await options.onOpen?.({ id: entry.id, preview, name: entry.name, relativePath: entry.relativePath, fileKind: entry.fileKind });
        if (result === false || disposed) return;
        activeId = entry.id; refreshSelection(); await updateNeighbors();
      } catch (err) { error(err); }
    }
    async function toggleDirectory(entry) {
      if (expanded.has(entry.id)) { expanded.delete(entry.id); render(); return; }
      const rootId = snapshot?.rootId;
      try { const result = await bridge('listWorkspace', { id: entry.id }); if (disposed || rootId !== snapshot?.rootId) return; children.set(entry.id, result.entries || []); expanded.add(entry.id); render(); }
      catch (err) { error(err); }
    }
    function entryNode(entry, level) {
      const row = el('div', 'moye-workspace__entry'); row.setAttribute('role', 'none');
      const button = el('button', 'moye-workspace__item'); button.type = 'button'; button.dataset.workspaceId = entry.id;
      button.dataset.kind = entry.kind; button.title = entry.relativePath || entry.name; button.style.setProperty('--workspace-depth', level);
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', level + 1);
      if (entry.kind === 'directory') button.setAttribute('aria-expanded', String(expanded.has(entry.id)));
      else button.setAttribute('aria-selected', String(entry.id === activeId));
      button.append(el('span', 'moye-workspace__icon', entry.kind === 'directory' ? expanded.has(entry.id) ? '▾' : '▸' : entry.fileKind === 'text' ? 'T' : 'M'), el('span', 'moye-workspace__name', entry.name));
      button.addEventListener('click', () => entry.kind === 'directory' ? toggleDirectory(entry) : activate(entry, true));
      button.addEventListener('dblclick', event => { if (entry.kind === 'file') { event.preventDefault(); activate(entry, false); } });
      button.addEventListener('keydown', event => {
        const list = buttons(), index = list.indexOf(button);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); list[Math.max(0, Math.min(list.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus(); }
        else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); list[event.key === 'Home' ? 0 : list.length - 1]?.focus(); }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.kind === 'directory' ? toggleDirectory(entry) : activate(entry, event.key === ' '); }
        else if (event.key === 'ArrowRight' && entry.kind === 'directory' && !expanded.has(entry.id)) { event.preventDefault(); toggleDirectory(entry); }
        else if (event.key === 'ArrowLeft' && entry.kind === 'directory' && expanded.has(entry.id)) { event.preventDefault(); toggleDirectory(entry); }
      });
      row.append(button);
      if (entry.kind === 'directory' && expanded.has(entry.id)) { const group = el('div'); group.setAttribute('role', 'group'); for (const child of children.get(entry.id) || []) if (child.kind === 'directory' || matches(child)) group.append(entryNode(child, level + 1)); row.append(group); }
      return row;
    }
    function render() {
      if (disposed) return;
      const focusId = document.activeElement?.dataset.workspaceId;
      title.toggleAttribute('data-moye-user-content', Boolean(snapshot));
      title.textContent = snapshot?.name || '工作区'; title.title = snapshot?.relativePath || '';
      tree.replaceChildren();
      for (const entry of snapshot?.entries || []) if (entry.kind === 'directory' || matches(entry)) tree.append(entryNode(entry, 0));
      const list = buttons(); list.forEach((button, index) => { button.tabIndex = button.dataset.workspaceId === activeId || !activeId && index === 0 ? 0 : -1; });
      if (focusId) list.find(button => button.dataset.workspaceId === focusId)?.focus({ preventScroll: true });
      message.textContent = !snapshot ? '选择文件夹，浏览本地 Markdown 和 TXT。' : snapshot.truncated ? '条目过多，仅显示部分。请选择更小的目录。' : filter.value && !list.length ? '工作区中没有匹配文件。' : !list.length && !snapshot.skipped?.length ? '这个文件夹中没有 Markdown 或 TXT 文档。' : snapshot.skipped?.length ? `${snapshot.skipped.length} 个不可用或越界链接已跳过。` : '单击预览 · 双击或 Enter 保留';
    }
    async function updateNeighbors() {
      previous.disabled = next.disabled = true;
      if (!activeId || !desktop?.workspaceNeighbor) return;
      const currentId = activeId;
      try { const [before, after] = await Promise.all([bridge('workspaceNeighbor', { id: activeId, direction: -1 }), bridge('workspaceNeighbor', { id: activeId, direction: 1 })]); if (currentId !== activeId) return; previous.disabled = !before; next.disabled = !after; previous.title = before?.name || '已到首篇'; next.title = after?.name || '已到末篇'; }
      catch { /* Active document may have left the workspace. */ }
    }
    async function neighbor(direction) { if (!activeId) return; try { const entry = await bridge('workspaceNeighbor', { id: activeId, direction }); if (entry) await activate(entry, true); } catch (err) { error(err); } }
    async function refresh(nextSnapshot, { reloadExpanded = false } = {}) {
      const version = ++requestVersion;
      try {
        const result = nextSnapshot || (snapshot && await bridge('listWorkspace', { id: snapshot.rootId, ...(filter.value.trim() ? { query: filter.value.trim() } : {}) }));
        if (disposed || version !== requestVersion || !result) return;
        if (snapshot?.rootId !== result.rootId) { expanded.clear(); children.clear(); activeId = null; }
        if (reloadExpanded && expanded.size) {
          const ids = [...expanded];
          const updates = await Promise.allSettled(ids.map(async id => ({ id, result: await bridge('listWorkspace', { id }) })));
          if (disposed || version !== requestVersion) return;
          for (let index = 0; index < updates.length; index++) {
            const update = updates[index];
            if (update.status === 'fulfilled') children.set(update.value.id, update.value.result.entries || []);
            else { children.delete(ids[index]); expanded.delete(ids[index]); }
          }
        }
        snapshot = result; render(); await updateNeighbors();
      } catch (err) { error(err); }
    }
    open.addEventListener('click', async () => { open.disabled = true; try { if (options.onChoose) await options.onChoose(); else { const result = await bridge('chooseWorkspace'); if (result) await refresh(result); } } catch (err) { error(err); } finally { open.disabled = false; } });
    refreshButton.addEventListener('click', () => { children.clear(); expanded.clear(); refresh(); });
    filter.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => refresh(), 180); });
    previous.addEventListener('click', () => neighbor(-1)); next.addEventListener('click', () => neighbor(1));
    function hide() { container.hidden = true; options.onHide?.(); }
    closeButton.addEventListener('click', hide);
    const removeChanged = desktop?.onWorkspaceChanged?.(() => refresh(undefined, { reloadExpanded: true }));
    return { container, refresh, setSnapshot: refresh, setActive(value) { activeId = typeof value === 'string' ? value : value?.id || null; refreshSelection(); updateNeighbors(); }, show() { container.hidden = false; }, hide, getActiveId: () => activeId, next: () => neighbor(1), previous: () => neighbor(-1), destroy() { disposed = true; clearTimeout(searchTimer); removeChanged?.(); if (owned) container.remove(); else container.replaceChildren(); } };
  }
  root.MoyeWorkspace = Object.freeze({ install });
})(typeof window === 'object' ? window : globalThis);
