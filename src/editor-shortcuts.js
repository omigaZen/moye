/* DOM keyboard ownership is shared by browser and Electron. Native menus show
 * the same bindings; Electron passes managed accelerators through to this one
 * capture listener so focus, composition and undo are decided in one place. */
(function (root) {
  'use strict';
  function install({ editor, getValues, isComposing, performAction, isBlocked = () => false, platform }) {
    const shortcuts = root.MoyeShortcuts;
    let bindings, retired = new Set(), destroyed = false;
    const elements = ['ir', 'sv'].map(mode => editor.vditor[mode].element);
    const editorTarget = target => target && elements.some(element => element === target || element.contains(target));
    const toolbarItems = items => items.flatMap(item => item && typeof item === 'object' ? [item, ...toolbarItems(item.toolbar || [])] : []);
    // Save old toolbar bindings only to retire them. They never dispatch actions
    // after installation, including when a command is explicitly disabled.
    const original = toolbarItems(editor.vditor.options.toolbar).map(item => item.hotkey).filter(Boolean);
    const vditorAccelerator = value => value.replace(/⌘/g, 'CmdOrCtrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+');
    for (const value of original) {
      try { retired.add(shortcuts.normalizeAccelerator(vditorAccelerator(value), platform).signature); } catch { /* Non-command editor navigation stays in the core. */ }
    }
    for (let digit = 1; digit <= 9; digit++) retired.add(shortcuts.normalizeAccelerator(`CmdOrCtrl+Alt+${digit}`, platform).signature);
    for (const value of Object.values(shortcuts.defaultsFor(platform))) if (value) retired.add(shortcuts.normalizeAccelerator(value, platform).signature);
    function refresh() {
      bindings = shortcuts.resolve(getValues()['editor.keyBindings'] || '{}', platform);
      for (const item of toolbarItems(editor.vditor.options.toolbar)) item.hotkey = '';
      for (const command of shortcuts.commands) {
        const hint = bindings[command.id], tooltip = `${command.label}${hint ? ` <${hint}>` : ''}`;
        const button = command.toolbar && editor.vditor.toolbar.elements[command.toolbar]?.querySelector('button');
        if (button) { button.setAttribute('aria-label', tooltip); button.setAttribute('title', tooltip); }
        document.querySelectorAll(`[data-action="${command.id}"]`).forEach(control => {
          const kbd = control.querySelector('kbd');
          if (kbd) { kbd.textContent = hint; kbd.hidden = !hint; }
          if (control.hasAttribute('title')) control.setAttribute('title', tooltip);
        });
      }
    }
    function keydown(event) {
      if (destroyed || event.isComposing || event.keyCode === 229 || isComposing() || event.getModifierState?.('AltGraph') || isBlocked()) return;
      const target = event.target, inside = editorTarget(target);
      // Search, preferences and native text controls retain their own editing
      // keys. A visible editor selection must never redirect their keystrokes.
      if (!inside && (target?.closest?.('input,textarea,[contenteditable="true"],dialog[open]') || document.activeElement?.closest?.('input,textarea,[contenteditable="true"],dialog[open]'))) return;
      const id = shortcuts.matchEvent(event, bindings, platform), command = shortcuts.commands.find(command => command.id === id);
      if (command && (command.scope !== 'editor' || inside)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) Promise.resolve(performAction(id)).catch(error => console.error(error));
      } else if (inside && retired.has(shortcuts.eventSignature(event))) {
        // Chromium has its own Ctrl+B/I/U formatting, and Vditor also contains
        // fixed mode shortcuts. Prevent both from resurrecting removed bindings.
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }
    refresh();
    document.addEventListener('keydown', keydown, true);
    return Object.freeze({ refresh, getBindings: () => ({ ...bindings }), destroy() { destroyed = true; document.removeEventListener('keydown', keydown, true); } });
  }
  root.MoyeEditorShortcuts = Object.freeze({ install });
})(window);
