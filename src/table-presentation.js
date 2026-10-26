(function (root) {
  'use strict';
  let serial = 0;
  function install({ editor, getValues = () => ({}), getReadingRoot = () => null, isComposing = () => false } = {}) {
    if (!editor?.vditor?.ir?.element) throw new TypeError('Table presentation needs an editor.');
    const editable = editor.vditor.ir.element;
    const style = document.createElement('style'); style.dataset.moyeTablePresentation = String(++serial); document.head.append(style);
    const ownedRoots = new Map(), counters = { refreshes: 0, tables: 0 };
    let destroyed = false, frame = 0, composing = false;
    function rootScope(element) {
      if (!ownedRoots.has(element)) {
        const name = `moye-table-root-${serial}-${ownedRoots.size}`;
        element.classList.add(name); ownedRoots.set(element, name);
      }
      return `.${ownedRoots.get(element)}`;
    }
    function pathFor(table, element) {
      const steps = []; let node = table;
      while (node && node !== element) {
        const index = [...node.parentElement.children].indexOf(node) + 1;
        steps.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`); node = node.parentElement;
      }
      return node === element ? `${rootScope(element)} > ${steps.join(' > ')}` : null;
    }
    function refresh() {
      if (destroyed) return;
      if (composing || isComposing()) return;
      const values = getValues(), layout = ['body', 'window', 'natural'].includes(values['table.layout']) ? values['table.layout'] : 'body';
      const appearance = values['table.style'] === 'booktabs' ? 'booktabs' : 'grid';
      const alignment = ['start', 'center', 'end'].includes(values['table.alignment']) ? values['table.alignment'] : 'start';
      const roots = [...new Set([editable, getReadingRoot()].filter(Boolean))];
      const rules = [], tables = [];
      for (const element of roots) {
        if (element !== editable && element.closest('[hidden]')) continue;
        const candidates = [...element.querySelectorAll('table')].filter(table => {
          const code = table.closest('pre');
          return !table.closest('.vditor-ir__preview,mjx-container,.katex,.mermaid,svg') && (!code || code === element);
        });
        // The common prose/code-only editing path needs no geometry or style
        // invalidation at all. Do not add a forced layout to every keypress.
        if (!candidates.length) continue;
        const scope = rootScope(element);
        element.classList.toggle('moye-tables-booktabs', appearance === 'booktabs');
        element.classList.toggle('moye-tables-grid', appearance === 'grid');
        const bounds = element.getBoundingClientRect(), computed = getComputedStyle(element);
        const left = parseFloat(computed.paddingLeft) || 0, right = parseFloat(computed.paddingRight) || 0;
        const bodyWidth = Math.max(1, element.clientWidth - left - right);
        const region = element.closest('.editor-region')?.getBoundingClientRect() || element.parentElement.getBoundingClientRect();
        const room = Math.max(0, Math.min(bounds.left + left - region.left - 24, region.right - 24 - (bounds.right - right)));
        for (const table of candidates) {
          // Nested tables remain inside their list/quote/cell content column.
          const topLevel = table.parentElement === element;
          const limit = Math.max(1, topLevel ? bodyWidth + (layout === 'window' ? room * 2 : 0) : Math.min(bodyWidth, table.parentElement.clientWidth));
          const selector = pathFor(table, element);
          if (!selector) continue;
          const base = layout === 'body'
            ? 'display:table!important;width:100%!important;max-width:none!important;'
            : `display:block!important;width:max-content!important;max-width:${limit}px!important;overflow-x:auto!important;`;
          rules.push(`${selector}{${base}margin-left:0!important;margin-right:0!important;overscroll-behavior-x:contain;}`);
          if (appearance === 'booktabs') {
            // Preserve the transparent grid's dimensions, drawing only the
            // top/header/bottom rules. The selectors exclude preview tables.
            rules.push(`${selector} th,${selector} td{border-color:transparent!important;background:transparent!important;}`);
            rules.push(`${selector} tr{border-color:transparent!important;background:transparent!important;}`);
            rules.push(`${selector} th{color:var(--ink);}`);
            rules.push(`${selector}>thead>tr:first-child>th,${selector}>tbody:first-child>tr:first-child>td{border-top-color:var(--ink)!important;}`);
            rules.push(`${selector}>thead>tr:last-child>th,${selector}>tbody:last-child>tr:last-child>td{border-bottom-color:var(--ink)!important;}`);
          }
          tables.push({ table, selector, limit, bodyWidth: topLevel ? bodyWidth : limit });
        }
      }
      // Geometry is read after one stylesheet update. No wrappers, markers or
      // inline attributes are inserted into editable table content.
      const initialText = rules.join('\n');
      if (style.textContent !== initialText) style.textContent = initialText;
      const finalRules = [...rules];
      for (const { table, selector, limit, bodyWidth } of tables) {
        if (!table.isConnected || table.getBoundingClientRect().width === 0) continue;
        const overflow = table.scrollWidth > limit + 1 || table.getBoundingClientRect().width > limit + 1;
        if (layout === 'body' && overflow) finalRules.push(`${selector}{display:block!important;width:${limit}px!important;max-width:${limit}px!important;overflow-x:auto!important;}`);
        const width = layout === 'body' ? Math.min(table.getBoundingClientRect().width, limit) : table.getBoundingClientRect().width;
        let margin = 0;
        if (width > bodyWidth) margin = -(width - bodyWidth) / 2;
        else if (alignment === 'center') margin = (bodyWidth - width) / 2;
        else if (alignment === 'end') margin = bodyWidth - width;
        finalRules.push(`${selector}{margin-left:${margin}px!important;margin-right:${width > bodyWidth ? margin : 0}px!important;}`);
      }
      const finalText = finalRules.join('\n');
      if (style.textContent !== finalText) style.textContent = finalText;
      counters.refreshes++; counters.tables = tables.length;
    }
    function schedule() {
      if (destroyed || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    }
    function composition(event) { composing = event.type === 'compositionstart'; if (!composing) schedule(); }
    const observer = new MutationObserver(schedule); observer.observe(editable, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule); resize.observe(editable);
    editable.addEventListener('compositionstart', composition); editable.addEventListener('compositionend', composition);
    window.addEventListener('resize', schedule);
    document.addEventListener('moye-reading-rendered', schedule);
    refresh();
    return {
      refresh,
      stats: () => ({ ...counters }),
      destroy() {
        destroyed = true; observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
        editable.removeEventListener('compositionstart', composition); editable.removeEventListener('compositionend', composition); window.removeEventListener('resize', schedule);
        document.removeEventListener('moye-reading-rendered', schedule);
        for (const [element, name] of ownedRoots) { element.classList.remove(name, 'moye-tables-booktabs', 'moye-tables-grid'); }
        style.remove();
      },
    };
  }
  root.MoyeTablePresentation = { install };
})(window);
