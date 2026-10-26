(function (root) {
  'use strict';
  const reasons = Object.freeze({ missing: '已移动或删除', 'changed-target': '链接目标已改变', 'not-file': '不再是文件', 'too-large': '超过 32 MB', permission: '没有读取权限', unavailable: '暂时不可用' });
  function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
  function install(options = {}) {
    if (typeof options.onOpen !== 'function') throw new TypeError('最近文件列表需要受保护的打开操作。');
    const desktop = options.desktop || root.desktop, owned = !options.container;
    const container = options.container || node('dialog', 'moye-recent');
    container.classList.add('moye-recent'); container.dataset.moyeUi = ''; container.setAttribute('aria-label', '最近文件');
    if (owned) document.body.append(container);
    const header = node('header', 'moye-recent__header'), title = node('h2', '', '最近文件');
    const refreshButton = node('button', '', '刷新'), clearButton = node('button', '', '清空记录'), closeButton = node('button', '', '关闭');
    for (const [element, action] of [[refreshButton, 'refresh'], [clearButton, 'clear'], [closeButton, 'close']]) { element.type = 'button'; element.dataset.recentAction = action; }
    clearButton.title = '仅清空列表记录，不删除文件';
    header.append(title, refreshButton, clearButton, closeButton);
    const search = node('input', 'moye-recent__search'); search.type = 'search'; search.placeholder = '搜索文件名或路径'; search.setAttribute('aria-label', '搜索最近文件'); search.maxLength = 200;
    const status = node('p', 'moye-recent__status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const list = node('div', 'moye-recent__list'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', '最近文件列表');
    const hint = node('p', 'moye-recent__hint', '移除或清空记录不会删除文档。');
    container.replaceChildren(header, search, status, list, hint);
    let snapshot = { entries: [], warnings: [] }, requestVersion = 0, opened = false, busy = false, disposed = false, previousFocus = null;
    function bridge(name, argument) { if (typeof desktop?.[name] !== 'function') throw new Error('最近文件管理需要桌面版。'); return desktop[name](argument); }
    function report(error) { status.textContent = error?.message || String(error); options.onError?.(error); options.notify?.(status.textContent); }
    function setBusy(value) {
      busy = value; container.setAttribute('aria-busy', String(value));
      for (const element of container.querySelectorAll('button,input')) element.disabled = value;
      if (!value) clearButton.disabled = !snapshot.entries.length;
    }
    function primaryButtons() { return [...list.querySelectorAll('button[data-recent-open]')]; }
    async function open(entry) {
      if (busy || disposed) return;
      if (!entry.available) { status.textContent = `${reasons[entry.reason] || reasons.unavailable}，可移除此记录或通过“打开”重新选择。`; return; }
      setBusy(true);
      try { const result = await options.onOpen?.({ id: entry.id }); if (result !== false && !disposed) hide(); }
      catch (error) { await refresh(); report(error); }
      finally { if (!disposed) { setBusy(false); if (opened) primaryButtons().find(button => button.dataset.recentOpen === entry.id)?.focus({ preventScroll: true }); } }
    }
    async function remove(entry) {
      if (busy || disposed) return;
      const current = primaryButtons(), index = current.findIndex(button => button.dataset.recentOpen === entry.id);
      setBusy(true); ++requestVersion; let removed = false;
      try {
        const result = await bridge('removeRecentFile', { id: entry.id }); if (disposed) return;
        snapshot = result; render(); setBusy(false); removed = true;
        const next = primaryButtons(); (next[Math.min(index, next.length - 1)] || search).focus({ preventScroll: true });
      } catch (error) { report(error); }
      finally { if (!disposed) { setBusy(false); if (!removed && opened) primaryButtons().find(button => button.dataset.recentOpen === entry.id)?.focus({ preventScroll: true }); } }
    }
    function render() {
      if (disposed) return;
      const focusedId = document.activeElement?.dataset.recentOpen, scrollTop = list.scrollTop;
      const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const entries = snapshot.entries.filter(entry => terms.every(term => `${entry.name}\n${entry.path}`.toLocaleLowerCase().includes(term)));
      list.replaceChildren();
      for (const entry of entries) {
        const row = node('div', 'moye-recent__row'); row.setAttribute('role', 'listitem'); row.classList.toggle('is-unavailable', !entry.available);
        const openButton = node('button', 'moye-recent__open'); openButton.type = 'button'; openButton.dataset.recentOpen = entry.id; openButton.title = entry.path;
        openButton.setAttribute('aria-disabled', String(!entry.available));
        const name = node('strong', 'moye-recent__name', entry.name), filename = node('span', 'moye-recent__path', entry.path);
        name.dataset.moyeUserContent = ''; filename.dataset.moyeUserContent = '';
        openButton.append(name, filename);
        if (!entry.available) openButton.append(node('span', 'moye-recent__availability', reasons[entry.reason] || reasons.unavailable));
        else {
          const time = node('time', 'moye-recent__time');
          if (Number.isFinite(entry.lastOpened)) { const date = new Date(entry.lastOpened); if (!Number.isNaN(date.getTime())) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleString(); } }
          openButton.append(time);
        }
        const removeButton = node('button', 'moye-recent__remove', '移除记录'); removeButton.type = 'button'; removeButton.dataset.recentRemove = entry.id;
        removeButton.title = '仅移除此列表记录，不删除文件'; removeButton.setAttribute('aria-label', `移除记录 ${entry.name}`);
        openButton.addEventListener('click', () => open(entry)); removeButton.addEventListener('click', () => remove(entry));
        row.append(openButton, removeButton); list.append(row);
      }
      status.textContent = snapshot.warnings?.join(' ') || (terms.length ? entries.length ? `找到 ${entries.length} 个文件。` : '没有匹配的最近文件。' : snapshot.entries.length ? `${snapshot.entries.length} 个最近文件，按最近打开顺序排列。` : '还没有最近文件。打开或保存文档后会在这里显示。');
      clearButton.disabled = busy || !snapshot.entries.length;
      if (focusedId) primaryButtons().find(button => button.dataset.recentOpen === focusedId)?.focus({ preventScroll: true });
      list.scrollTop = scrollTop;
      if (busy) setBusy(true);
    }
    async function refresh() {
      const version = ++requestVersion;
      try { const result = await bridge('listRecentFiles'); if (disposed || version !== requestVersion) return false; snapshot = result; render(); return true; }
      catch (error) { if (!disposed && version === requestVersion) report(error); return false; }
    }
    async function show() {
      if (disposed) return false;
      if (!opened) { previousFocus = document.activeElement; options.onShow?.(); opened = true; if (typeof container.showModal === 'function') container.showModal(); else { container.hidden = false; container.setAttribute('role', 'dialog'); container.setAttribute('aria-modal', 'true'); } }
      await refresh(); if (!disposed && opened && !busy) search.focus(); return true;
    }
    function hide() {
      if (!opened || disposed) return;
      opened = false; ++requestVersion;
      if (typeof container.close === 'function') { if (container.open) container.close(); } else container.hidden = true;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); options.onClose?.();
    }
    list.addEventListener('keydown', event => {
      if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = primaryButtons(), index = buttons.indexOf(document.activeElement); if (index < 0) return;
      event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    search.addEventListener('input', render);
    search.addEventListener('keydown', event => { if (!busy && event.key === 'ArrowDown') { event.preventDefault(); primaryButtons()[0]?.focus(); } });
    refreshButton.addEventListener('click', refresh);
    clearButton.addEventListener('click', async () => {
      if (busy || disposed) return; setBusy(true); ++requestVersion;
      try { snapshot = await bridge('clearRecentFiles'); if (!disposed) { render(); setBusy(false); search.focus(); } }
      catch (error) { report(error); }
      finally { if (!disposed) setBusy(false); }
    });
    closeButton.addEventListener('click', () => { if (!busy) hide(); });
    container.addEventListener('cancel', event => { event.preventDefault(); if (!busy) hide(); });
    container.addEventListener('close', () => { if (opened) hide(); });
    if (!container.matches('dialog')) container.hidden = true;
    return { container, show, hide, refresh, isOpen: () => opened, destroy() { if (disposed) return; if (opened) hide(); disposed = true; ++requestVersion; if (owned) container.remove(); else container.replaceChildren(); } };
  }
  root.MoyeRecentFiles = Object.freeze({ install });
})(typeof window === 'object' ? window : globalThis);
