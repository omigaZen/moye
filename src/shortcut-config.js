/* Shared shortcut vocabulary. This is Moye code, based on public shortcut
 * documentation, not Typora application code. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeShortcuts = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const command = (id, label, shortcut, scope = 'application', macShortcut = shortcut, toolbar) =>
    Object.freeze({ id, label, default: shortcut, macDefault: macShortcut, scope, ...(toolbar ? { toolbar } : {}) });
  const commands = Object.freeze([
    command('new', '新建', 'CmdOrCtrl+N'), command('open', '打开…', 'CmdOrCtrl+O'),
    command('save', '保存', 'CmdOrCtrl+S'), command('save-as', '另存为…', 'CmdOrCtrl+Shift+S'),
    command('close', '关闭当前文档', 'CmdOrCtrl+W'), command('close-window', '关闭窗口', ''), command('preferences', '设置…', 'CmdOrCtrl+,'),
    command('undo', '撤销', 'CmdOrCtrl+Z', 'editor'), command('redo', '重做', 'CmdOrCtrl+Shift+Z', 'editor'),
    command('find', '查找与替换', 'CmdOrCtrl+F'),
    command('copy-markdown', '复制为 Markdown', 'CmdOrCtrl+Shift+C', 'editor'),
    command('source', '切换源码模式', 'CmdOrCtrl+/'), command('outline', '显示／隐藏大纲', 'CmdOrCtrl+Shift+L'),
    command('reading', '切换阅读模式', ''),
    command('recent', '最近文件', ''),
    command('system-preview', '系统缩略图', ''),
    command('workspace', '打开文件夹', ''), command('previous-file', '同目录上一个文件', ''), command('next-file', '同目录下一个文件', ''),
    command('export-pdf', '导出 PDF', ''), command('export-image', '导出图片', ''),
    command('theme', '切换明暗主题', 'CmdOrCtrl+Shift+D'), command('focus', '专注模式', 'F8'),
    command('typewriter', '打字机模式', 'F9'), command('toolbar', '显示／隐藏格式栏', ''),
    command('bold', '加粗', 'CmdOrCtrl+B', 'editor', 'CmdOrCtrl+B', 'bold'),
    command('italic', '斜体', 'CmdOrCtrl+I', 'editor', 'CmdOrCtrl+I', 'italic'),
    command('strike', '删除线', 'Alt+Shift+5', 'editor', 'Ctrl+Shift+`', 'strike'),
    command('inline-code', '行内代码', 'CmdOrCtrl+Shift+`', 'editor', 'CmdOrCtrl+Shift+`', 'inline-code'),
    command('link', '链接', 'CmdOrCtrl+K', 'editor', 'CmdOrCtrl+K', 'link'),
    command('image', '插入本地图片…', 'CmdOrCtrl+Shift+I', 'editor', 'Command+Ctrl+I'),
    command('code', '代码块', 'CmdOrCtrl+Shift+K', 'editor', 'Command+Alt+C', 'code'),
    command('quote', '引用', 'CmdOrCtrl+Shift+Q', 'editor', 'Command+Alt+Q', 'quote'),
    command('list', '无序列表', 'CmdOrCtrl+Shift+]', 'editor', 'Command+Alt+U', 'list'),
    command('ordered-list', '有序列表', 'CmdOrCtrl+Shift+[', 'editor', 'Command+Alt+O', 'ordered-list'),
    command('table', '表格', 'CmdOrCtrl+T', 'editor', 'Command+Alt+T', 'table'),
  ]);
  const byId = new Map(commands.map(value => [value.id, value]));
  const modifierAliases = Object.freeze({
    ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Meta', command: 'Meta', meta: 'Meta', super: 'Meta',
    win: 'Meta', windows: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift',
    cmdorctrl: 'Primary', commandorcontrol: 'Primary', commandorctrl: 'Primary', mod: 'Primary',
  });
  const keyAliases = Object.freeze({
    esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', space: 'Space',
    spacebar: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
    plus: '+', minus: '-', comma: ',', period: '.', slash: '/', backslash: '\\', backquote: '`', equal: '=',
  });
  const shifted = Object.freeze({ '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' });
  const fixedEditingKeys = new Set(['Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Escape', 'Space']);
  function platformName(platform) {
    if (platform === undefined) {
      if (typeof process === 'object' && process.platform) platform = process.platform;
      else if (typeof navigator === 'object') platform = navigator.platform;
    }
    if (/^(?:darwin|mac|macos|macintel|macppc)/i.test(platform || '')) return 'darwin';
    if (/^(?:win|windows)/i.test(platform || '')) return 'win32';
    return 'linux';
  }
  function signature(key, modifiers) {
    return ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(value => modifiers.has(value)).concat(key).join('+');
  }
  function normalizeAccelerator(value, platform) {
    if (typeof value !== 'string' || value.length > 100 || /[\r\n\0]/.test(value)) throw new TypeError('快捷键必须是单个有效组合键。');
    if (value === '') return Object.freeze({ accelerator: '', signature: '', key: '', modifiers: Object.freeze([]) });
    const tokens = value.split('+').map(token => token.trim());
    if (tokens.some(token => !token)) throw new TypeError('快捷键中的加号请写为 Plus，例如 Ctrl+Plus。');
    const platformValue = platformName(platform), modifiers = new Set();
    let key = null;
    for (const token of tokens) {
      let modifier = modifierAliases[token.toLowerCase()];
      if (modifier) {
        if (key) throw new TypeError('快捷键修饰键必须放在按键之前。');
        if (modifier === 'Primary') modifier = platformValue === 'darwin' ? 'Meta' : 'Ctrl';
        if (modifiers.has(modifier)) throw new TypeError('快捷键不能包含重复的修饰键。');
        modifiers.add(modifier); continue;
      }
      if (key) throw new TypeError('快捷键只能包含一个按键。');
      key = keyAliases[token.toLowerCase()] || (/^f(?:[1-9]|1\d|2[0-4])$/i.test(token) ? token.toUpperCase() : token);
      if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
      if (!(key.length === 1 && /^[A-Z0-9,./;'\[\]\\`=\-!@#$%^&*()_+{}|:"<>?~]$/.test(key)) && !Object.values(keyAliases).includes(key) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) throw new TypeError(`不支持的快捷键按键：${token}`);
    }
    if (!key) throw new TypeError('快捷键缺少按键。');
    if (shifted[key]) { key = shifted[key]; modifiers.add('Shift'); }
    if (!['Ctrl', 'Alt', 'Meta'].some(modifier => modifiers.has(modifier)) && !/^F\d+$/.test(key)) throw new TypeError('文字和编辑按键的快捷键需要 Ctrl、Command 或 Alt 修饰键。');
    const ordered = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(modifier => modifiers.has(modifier));
    const accelerator = ordered.map(modifier => modifier === 'Meta' ? (platformValue === 'darwin' ? 'Command' : 'Super') : modifier).concat(key).join('+');
    return Object.freeze({ accelerator, signature: signature(key, modifiers), key, modifiers: Object.freeze(ordered) });
  }
  function defaultsFor(platform) {
    const mac = platformName(platform) === 'darwin';
    return Object.fromEntries(commands.map(value => [value.id, normalizeAccelerator(mac ? value.macDefault : value.default, platform).accelerator]));
  }
  function reservedFor(platform) {
    const primary = platformName(platform) === 'darwin' ? 'Command' : 'Ctrl';
    const values = [
      `${primary}+X`, `${primary}+C`, `${primary}+V`, `${primary}+Shift+V`, `${primary}+A`,
      `${primary}+Enter`, `${primary}+Shift+Backspace`, `${primary}+0`, `${primary}+Plus`, `${primary}+-`,
      `${primary}+Shift+0`, `${primary}+Shift+-`, 'F11', 'Alt+F4',
      ...(platformName(platform) === 'darwin' ? ['Command+Q', 'Command+H', 'Command+Alt+H', 'Command+Alt+F'] : ['Ctrl+Q']),
    ];
    return new Set(values.map(value => normalizeAccelerator(value, platform).signature));
  }
  function readOverrides(raw, platform) {
    if (typeof raw !== 'string' || raw.length > 16384 || raw.includes('\0')) throw new TypeError('自定义快捷键必须是不超过 16 KB 的 JSON 对象。');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new TypeError('自定义快捷键不是有效 JSON。'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('自定义快捷键必须是命令 ID 到组合键的 JSON 对象。');
    const result = Object.create(null);
    for (const [id, value] of Object.entries(parsed)) {
      if (!byId.has(id)) throw new TypeError(`未知快捷键命令：${id}`);
      result[id] = normalizeAccelerator(value, platform).accelerator;
    }
    return result;
  }
  function validateKeyBindings(raw, platform) {
    const overrides = readOverrides(raw, platform), effective = { ...defaultsFor(platform), ...overrides };
    const used = new Map(), reserved = reservedFor(platform);
    for (const [id, value] of Object.entries(effective)) {
      if (!value) continue;
      const normalized = normalizeAccelerator(value, platform);
      if (reserved.has(normalized.signature) || fixedEditingKeys.has(normalized.key)) throw new TypeError(`快捷键 ${normalized.accelerator} 与固定的系统或编辑快捷键冲突。`);
      if (used.has(normalized.signature)) throw new TypeError(`快捷键 ${normalized.accelerator} 同时分配给“${byId.get(used.get(normalized.signature)).label}”和“${byId.get(id).label}”。`);
      used.set(normalized.signature, id);
    }
    return Object.freeze({ ...overrides });
  }
  function resolve(raw = '{}', platform) { return Object.freeze({ ...defaultsFor(platform), ...validateKeyBindings(raw, platform) }); }
  function eventSignature(event) {
    if (!event || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return '';
    let key = event.key;
    if (typeof key !== 'string' || key === 'Dead' || key === 'Unidentified') return '';
    key = keyAliases[key.toLowerCase()] || key;
    if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
    const modifiers = new Set();
    if (event.ctrlKey || event.control) modifiers.add('Ctrl');
    if (event.altKey || event.alt) modifiers.add('Alt');
    if (event.shiftKey || event.shift) modifiers.add('Shift');
    if (event.metaKey || event.meta) modifiers.add('Meta');
    if (shifted[key]) { key = shifted[key]; modifiers.add('Shift'); }
    return signature(key, modifiers);
  }
  function matchEvent(event, effective, platform) {
    const pressed = eventSignature(event);
    if (!pressed) return null;
    for (const [id, value] of Object.entries(effective)) if (value && normalizeAccelerator(value, platform).signature === pressed) return id;
    return null;
  }
  return Object.freeze({ commands, defaultsFor, platformName, normalizeAccelerator, validateKeyBindings, resolve, eventSignature, matchEvent });
});
