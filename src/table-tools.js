(function (root) {
  'use strict';

  const COMMANDS = [
    ['row-before', '上方加行'], ['row-after', '下方加行'], ['row-delete', '删除行'],
    ['column-before', '左侧加列'], ['column-after', '右侧加列'], ['column-delete', '删除列'],
    ['align-left', '左对齐'], ['align-center', '居中'], ['align-right', '右对齐'],
    ['table-copy', '复制整表'], ['selection-copy', '复制所选格'],
    ['table-delete', '删除表格'],
  ];

  function encodeTsv(rows) {
    return rows.map(row => row.map(value => {
      const text = String(value ?? '');
      return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join('\t')).join('\r\n');
  }
  function cellText(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('wbr,.vditor-ir__marker,.vditor-ir__marker--pre,[data-moye-table-decoration]').forEach(node => node.remove());
    clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    clone.querySelectorAll('img').forEach(node => node.replaceWith(node.getAttribute('alt') || ''));
    // Lute uses a lone space (or a newly created zero-width space) as its
    // empty IR cell placeholder. Do not trim nonempty values or plain HTML.
    const text = clone.textContent || '';
    return cell.closest('pre[contenteditable="true"]') && (text === '\u200b' || text === ' ') ? '' : text;
  }
  function tableGrid(table) {
    const rows = [], positions = new Map();
    for (const [r, row] of [...table.rows].entries()) {
      rows[r] ||= [];
      let c = 0;
      for (const cell of [...row.cells]) {
        while (rows[r][c] !== undefined) c++;
        positions.set(cell, { row: r, column: c });
        for (let rr = r; rr < r + Math.min(cell.rowSpan || 1, table.rows.length - r); rr++) {
          rows[rr] ||= [];
          for (let cc = c; cc < c + Math.min(cell.colSpan || 1, 1000); cc++) rows[rr][cc] = rr === r && cc === c ? cellText(cell) : '';
        }
        c += Math.min(cell.colSpan || 1, 1000);
      }
    }
    const width = Math.max(0, ...rows.map(row => row.length));
    return { rows: rows.map(row => Array.from({ length: width }, (_, c) => row[c] ?? '')), positions };
  }
  function selectedRectangle(table, grid, selection) {
    if (!selection?.rangeCount) return null;
    const at = node => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('td,th');
    const a = grid.positions.get(at(selection.anchorNode)), b = grid.positions.get(at(selection.focusNode));
    if (a && b) return { top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), left: Math.min(a.column, b.column), right: Math.max(a.column, b.column) };
    const range = selection.getRangeAt(0), touched = [];
    for (const [cell, position] of grid.positions) {
      try { if (range.intersectsNode(cell)) touched.push(position); } catch (_) { /* Detached selection. */ }
    }
    if (!touched.length) return null;
    return { top: Math.min(...touched.map(p => p.row)), bottom: Math.max(...touched.map(p => p.row)), left: Math.min(...touched.map(p => p.column)), right: Math.max(...touched.map(p => p.column)) };
  }
  function clipboardPayload(table, { selection = null, selected = false } = {}) {
    const grid = tableGrid(table);
    const bounds = selected ? selectedRectangle(table, grid, selection) : { top: 0, bottom: grid.rows.length - 1, left: 0, right: (grid.rows[0]?.length || 0) - 1 };
    if (!bounds) return null;
    const rows = grid.rows.slice(bounds.top, bounds.bottom + 1).map(row => row.slice(bounds.left, bounds.right + 1));
    const htmlTable = document.createElement('table'), body = document.createElement('tbody');
    htmlTable.append(body);
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const value of row) {
        const td = document.createElement('td'); td.style.whiteSpace = 'pre-wrap';
        value.split('\n').forEach((line, i) => { if (i) td.append(document.createElement('br')); td.append(document.createTextNode(line)); });
        tr.append(td);
      }
      body.append(tr);
    }
    return { text: encodeTsv(rows), html: htmlTable.outerHTML, rows: rows.length, columns: rows[0]?.length || 0 };
  }

  function install(editor, callbacks = {}) {
    const parent = editor.vditor.element.closest('.editor-region') || editor.vditor.element.parentElement;
    const editable = editor.vditor.ir.element;
    const tools = document.createElement('div');
    tools.className = 'moye-table-tools'; tools.hidden = true;
    tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', '表格行列与对齐操作');
    const buttons = new Map();
    for (const [command, label] of COMMANDS) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.command = command; button.textContent = label; button.title = label;
      if (command === 'table-delete') button.className = 'moye-table-tools__delete';
      if (command === 'column-before' || command === 'align-left' || command === 'table-delete') button.classList.add('moye-table-tools__group-start');
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => action(command));
      buttons.set(command, button); tools.append(button);
    }
    parent.append(tools);
    let destroyed = false, composing = false, hoveredTable = null, leaveTimer = null;
    const isReading = () => callbacks.isReading?.() === true;
    const isComposing = () => composing || callbacks.isComposing?.() === true;
    const readingRoot = () => callbacks.getReadingRoot?.() || null;

    function notify(message) { if (callbacks.toast) callbacks.toast(message); }
    function currentCell() {
      if (editor.getCurrentMode() !== 'ir' || editable.getAttribute('contenteditable') === 'false') return null;
      const selection = window.getSelection();
      if (!selection.rangeCount) return null;
      const node = selection.getRangeAt(0).startContainer;
      const element = node.nodeType === 3 ? node.parentElement : node;
      const cell = element?.closest?.('td,th');
      const code = cell?.closest('pre');
      return cell && editable.contains(cell) && !cell.closest('.vditor-ir__preview,mjx-container,.katex,.mermaid,svg,[contenteditable="false"]') && (!code || code === editable) ? cell : null;
    }
    function selectedReadingTable() {
      const root = readingRoot(), selection = getSelection();
      if (!root || !selection.rangeCount || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
      const node = selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode;
      return node.closest?.('table') || null;
    }
    function currentTable() { return isReading() ? selectedReadingTable() || hoveredTable : currentCell()?.closest('table'); }
    function position(cell) {
      tools.style.top = ''; tools.style.bottom = '';
      if (!cell) return;
      const region = parent.getBoundingClientRect(), selected = cell.getBoundingClientRect();
      const toolbar = tools.getBoundingClientRect(), bottomTop = region.bottom - 18 - toolbar.height;
      if (isReading()) {
        const top = selected.top - region.top - toolbar.height - 6;
        tools.style.top = `${Math.max(4, Math.min(region.height - toolbar.height - 4, top < 4 ? selected.bottom - region.top + 6 : top))}px`;
        tools.style.bottom = 'auto';
      } else if (selected.bottom >= bottomTop - 6 && selected.top <= region.bottom - 10) {
        // Retain the stable edit toolbar, but move it away from the current
        // cell when the bottom placement would hide what the user is editing.
        tools.style.top = '6px'; tools.style.bottom = 'auto';
      }
    }
    function update() {
      if (destroyed) return;
      const reading = isReading(), tableAt = reading ? currentTable() : null;
      const cell = reading ? tableAt?.tHead?.rows[0]?.cells[0] || tableAt?.rows[0]?.cells[0] : currentCell();
      tools.hidden = !cell;
      tools.classList.toggle('moye-table-tools--reading', reading);
      for (const [command, button] of buttons) {
        const copy = command.endsWith('-copy');
        button.hidden = reading && !copy;
        button.disabled = isComposing();
      }
      if (!cell) return;
      const isHeader = cell.parentElement.parentElement.tagName === 'THEAD';
      buttons.get('row-before').disabled = isHeader || isComposing();
      buttons.get('row-delete').disabled = isHeader || isComposing();
      const selection = getSelection(), table = cell.closest('table');
      buttons.get('selection-copy').disabled = isComposing() || !selection.rangeCount || !table.contains(selection.anchorNode) || !table.contains(selection.focusNode);
      for (const alignment of ['left', 'center', 'right']) {
        buttons.get(`align-${alignment}`).setAttribute('aria-pressed', String(cell.getAttribute('align') === alignment));
      }
      position(cell);
    }
    function newCell(tag, alignment) {
      const cell = document.createElement(tag);
      if (alignment) cell.setAttribute('align', alignment);
      cell.append(document.createTextNode('\u200b')); return cell;
    }
    function caret(cell) {
      if (!cell.firstChild) cell.append(document.createTextNode('\u200b'));
      const range = document.createRange();
      range.selectNodeContents(cell); range.collapse(true);
      editable.focus(); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    function removeTable(table) {
      const paragraph = document.createElement('p'); paragraph.dataset.block = '0';
      paragraph.append(document.createTextNode('\u200b')); table.replaceWith(paragraph); caret(paragraph);
    }
    function commit() {
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      if (callbacks.sync) callbacks.sync();
      if (callbacks.input) callbacks.input(editor.getValue());
      editor.vditor.undo.addToUndoStack(editor.vditor);
      update();
    }
    function action(command) {
      if (destroyed || !buttons.has(command)) return false;
      if (isComposing()) { notify('请先完成输入法选词。'); return false; }
      if (command.endsWith('-copy')) {
        const table = currentTable();
        if (!table) { notify('请先选择表格。'); return false; }
        const payload = clipboardPayload(table, { selection: getSelection(), selected: command === 'selection-copy' });
        if (!payload) { notify('请先选择需要复制的单元格。'); return false; }
        return Promise.resolve().then(() => callbacks.writeClipboard
          ? callbacks.writeClipboard({ text: payload.text, html: payload.html })
          : navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([payload.text], { type: 'text/plain' }), 'text/html': new Blob([payload.html], { type: 'text/html' }) })]))
          .then(() => { notify(`已复制 ${payload.rows} 行 × ${payload.columns} 列`); return true; }, error => { notify(error?.message || '复制失败，请重试。'); return false; });
      }
      if (isReading()) return false;
      const cell = currentCell();
      if (!cell) { notify('请先将光标放在表格单元格中。'); return false; }
      const table = cell.closest('table'), row = cell.parentElement;
      const isHeader = row.parentElement.tagName === 'THEAD';
      if (isHeader && (command === 'row-before' || command === 'row-delete')) {
        notify(command === 'row-before' ? '表头上方不能添加数据行，请使用下方加行。' : '表头需要保留，可删除数据行或删除整个表格。'); return false;
      }
      if (callbacks.sync) callbacks.sync();
      editor.vditor.undo.addToUndoStack(editor.vditor);
      const column = cell.cellIndex, header = table.tHead?.rows[0] || table.rows[0];
      const alignAt = index => header.cells[index]?.getAttribute('align') || row.cells[index]?.getAttribute('align');

      if (command === 'table-delete' || (command === 'column-delete' && header.cells.length === 1)) {
        removeTable(table);
      } else if (command === 'row-before' || command === 'row-after') {
        const added = document.createElement('tr');
        for (let i = 0; i < header.cells.length; i++) added.append(newCell('td', alignAt(i)));
        if (isHeader) (table.tBodies[0] || table.createTBody()).prepend(added);
        else if (command === 'row-before') row.before(added); else row.after(added);
        caret(added.cells[Math.min(column, added.cells.length - 1)]);
      } else if (command === 'row-delete') {
        const body = row.parentElement, next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        if (next) caret(next.cells[Math.min(column, next.cells.length - 1)]);
        else {
          const blank = document.createElement('tr');
          for (let i = 0; i < header.cells.length; i++) blank.append(newCell('td', alignAt(i)));
          body.append(blank); caret(blank.cells[Math.min(column, blank.cells.length - 1)]);
        }
      } else if (command === 'column-before' || command === 'column-after') {
        const insertion = column + (command === 'column-after' ? 1 : 0), alignment = alignAt(column);
        let target;
        for (const existingRow of [...table.rows]) {
          const added = newCell(existingRow.parentElement.tagName === 'THEAD' ? 'th' : 'td', alignment);
          existingRow.insertBefore(added, existingRow.cells[insertion] || null);
          if (existingRow === row) target = added;
        }
        caret(target);
      } else if (command === 'column-delete') {
        for (const existingRow of [...table.rows]) existingRow.cells[column]?.remove();
        caret(row.cells[Math.min(column, row.cells.length - 1)]);
      } else if (command.startsWith('align-')) {
        const alignment = command.slice(6);
        for (const existingRow of [...table.rows]) existingRow.cells[column]?.setAttribute('align', alignment);
      }
      commit(); return true;
    }

    document.addEventListener('selectionchange', update);
    editable.addEventListener('keyup', update); editable.addEventListener('mouseup', update); editable.addEventListener('input', update);
    const observer = new MutationObserver(update); observer.observe(editable, { childList: true, subtree: true });
    function onComposition(event) { composing = event.type === 'compositionstart'; update(); }
    function onReadingPointer(event) {
      if (!isReading()) return;
      const root = readingRoot(), header = event.target.closest?.('thead');
      if (root && header && root.contains(header)) { clearTimeout(leaveTimer); hoveredTable = header.closest('table'); update(); }
    }
    function onReadingLeave(event) {
      if (!isReading()) return;
      if (tools.contains(event.relatedTarget) || hoveredTable?.tHead?.contains(event.relatedTarget)) return;
      clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { hoveredTable = null; update(); }, 140);
    }
    function holdTools() { clearTimeout(leaveTimer); }
    editable.addEventListener('compositionstart', onComposition); editable.addEventListener('compositionend', onComposition);
    document.addEventListener('pointerover', onReadingPointer); document.addEventListener('pointerout', onReadingLeave);
    tools.addEventListener('pointerenter', holdTools);
    document.addEventListener('moye-reading-rendered', update);
    window.addEventListener('resize', update); editable.addEventListener('scroll', update, { passive: true });
    update();
    return {
      action, element: tools, getCurrentCell: currentCell, refresh: update,
      destroy() {
        destroyed = true; observer.disconnect(); document.removeEventListener('selectionchange', update);
        clearTimeout(leaveTimer); document.removeEventListener('pointerover', onReadingPointer); document.removeEventListener('pointerout', onReadingLeave); tools.removeEventListener('pointerenter', holdTools);
        document.removeEventListener('moye-reading-rendered', update);
        editable.removeEventListener('compositionstart', onComposition); editable.removeEventListener('compositionend', onComposition); window.removeEventListener('resize', update); editable.removeEventListener('scroll', update);
        editable.removeEventListener('keyup', update); editable.removeEventListener('mouseup', update); editable.removeEventListener('input', update); tools.remove();
      },
    };
  }
  root.MoyeTableTools = { install, encodeTsv, tableGrid, clipboardPayload };
})(window);
