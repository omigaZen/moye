/* Independent restricted TOML colour themes. No application CSS or document text. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeColorThemes = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const maximumBytes = 65536;
  const filePattern = /^[a-z0-9][a-z0-9_-]{0,63}\.toml$/;
  const customPattern = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/;
  const builtins = ['moye', 'mono', 'solarized', 'nord'];
  const variableKeys = Object.freeze(['--paper', '--chrome', '--sidebar', '--ink', '--muted', '--line', '--accent', '--accent-bg', '--code', '--theme-heading', '--theme-link', '--theme-inline-code', '--theme-table-rule', '--chrome-ink']);
  const colors = Object.freeze({ paper: '--paper', body: '--ink', muted: '--muted', line: '--line', accent: '--accent', accent_bg: '--accent-bg', code: '--code', heading: '--theme-heading', link: '--theme-link', inline_code: '--theme-inline-code', table_rule: '--theme-table-rule' });
  const chrome = Object.freeze({ background: '--chrome', sidebar_background: '--sidebar', text: '--chrome-ink', active_tab: '--accent-bg', divider: '--line' });
  const palettes = {
    moye: {
      light: ['#ffffff', '#fafaf8', '#f6f7f5', '#303833', '#8b938d', '#e9ece7', '#47705b', '#eaf0eb', '#f5f6f3'],
      dark: ['#242925', '#202521', '#202521', '#d5ddd5', '#859188', '#333d35', '#a6c4ab', '#303e33', '#1e241f'],
    },
    mono: { light: ['#fafaf8', '#f3f3f1', '#f0f0ee', '#333333', '#777777', '#dededb', '#111111', '#e9e9e5', '#efefeb'], dark: ['#262626', '#222222', '#222222', '#dddddd', '#999999', '#404040', '#ffffff', '#383838', '#202020'] },
    solarized: { light: ['#fdf6e3', '#f5edd8', '#eee8d5', '#586e75', '#657b83', '#d9d2c0', '#007f85', '#e6e7cf', '#eee8d5'], dark: ['#002b36', '#002731', '#073642', '#93a1a1', '#839496', '#1a4650', '#5dc2c0', '#12444b', '#073642'] },
    nord: { light: ['#eceff4', '#e5e9f0', '#e5e9f0', '#2e3440', '#58657a', '#d0d6e0', '#456d87', '#dbe4ee', '#e1e6ee'], dark: ['#2e3440', '#292e39', '#3b4252', '#eceff4', '#b4becf', '#4c566a', '#88c0d0', '#414e61', '#282e39'] },
  };
  const ordinaryVariables = variableKeys.slice(0, 9);
  function palette(id, appearance) {
    const values = palettes[id]?.[appearance] || palettes.moye[appearance];
    const result = Object.fromEntries(ordinaryVariables.map((key, index) => [key, values[index]]));
    result['--theme-heading'] = result['--ink']; result['--theme-link'] = result['--accent'];
    result['--theme-inline-code'] = result['--ink']; result['--theme-table-rule'] = result['--line']; result['--chrome-ink'] = result['--ink'];
    return result;
  }
  function fileName(value) {
    if (typeof value !== 'string' || !filePattern.test(value)) throw new TypeError('主题文件名应为 1—64 位小写字母、数字、短横线或下划线，并以 .toml 结尾。');
    return value;
  }
  function stripComment(line) {
    let quote = '', escape = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (escape) { escape = false; continue; }
      if (quote === '"' && character === '\\') { escape = true; continue; }
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '#') return line.slice(0, index).trim();
    }
    if (quote) throw new TypeError('引号未闭合。');
    return line.trim();
  }
  function stringValue(raw) {
    if (raw.startsWith('"')) {
      const value = JSON.parse(raw);
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new TypeError('只支持单行字符串。');
      return value;
    }
    if (/^'[^'\r\n\0]*'$/.test(raw)) return raw.slice(1, -1);
    throw new TypeError('此处应为带引号的单行字符串。');
  }
  function parse(raw, filename) {
    fileName(filename);
    if (typeof raw !== 'string' || raw.length > maximumBytes || new TextEncoder().encode(raw).length > maximumBytes || raw.includes('\0')) throw new TypeError('主题文件必须为不超过 64 KiB 的文本。');
    let section = '';
    const meta = {}, variables = {}, warnings = [], seen = new Set();
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
    lines.forEach((original, offset) => {
      const number = offset + 1;
      let line;
      try { line = stripComment(original); } catch (error) { throw new TypeError(`第 ${number} 行：${error.message}`); }
      if (!line) return;
      const header = line.match(/^\[([A-Za-z_][A-Za-z0-9_-]*)\]$/);
      if (header) {
        section = header[1];
        if (!['meta', 'colors', 'chrome'].includes(section)) warnings.push(`第 ${number} 行：忽略未知分组 [${section}]。`);
        return;
      }
      const pair = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/);
      if (!pair || !section) throw new TypeError(`第 ${number} 行：使用 [meta]、[colors] 或 [chrome] 中的 key = "value"。`);
      const key = pair[1], identity = `${section}.${key}`;
      if (seen.has(identity)) throw new TypeError(`第 ${number} 行：${identity} 重复。`);
      seen.add(identity);
      const knownMeta = section === 'meta' && ['name', 'appearance', 'based_on'].includes(key);
      const variable = section === 'colors' ? colors[key] : section === 'chrome' ? chrome[key] : null;
      if (!knownMeta && !variable) { warnings.push(`第 ${number} 行：忽略未知选项 ${identity}。`); return; }
      let value;
      try { value = stringValue(pair[2]); }
      catch (error) {
        if (knownMeta) throw new TypeError(`第 ${number} 行：${identity} ${error.message}`);
        warnings.push(`第 ${number} 行：忽略 ${identity}，需要带引号的十六进制颜色。`); return;
      }
      if (knownMeta) meta[key] = value;
      else if (/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(value)) variables[variable] = value;
      else warnings.push(`第 ${number} 行：忽略 ${identity}，只支持 #RGB、#RGBA、#RRGGBB 或 #RRGGBBAA。`);
    });
    if (!meta.name?.trim() || [...meta.name.trim()].length > 40) throw new TypeError('[meta] name 需要 1—40 个字符。');
    if (!['light', 'dark'].includes(meta.appearance)) throw new TypeError('[meta] appearance 必须为 "light" 或 "dark"。');
    const basedOn = meta.based_on || 'moye';
    if (!builtins.includes(basedOn) && !customPattern.test(basedOn)) throw new TypeError('[meta] based_on 必须为内置主题名或 custom:文件名。');
    return { id: `custom:${filename.slice(0, -5)}`, name: meta.name.trim(), appearance: meta.appearance, basedOn, variables, fileName: filename, content: raw, warnings };
  }
  function resolve(themes, id, appearance) {
    appearance = appearance === 'dark' ? 'dark' : 'light';
    const all = Array.isArray(themes) ? themes : [];
    const byId = new Map(all.map(theme => [theme.id, theme]));
    const warnings = [], visiting = new Set();
    let valid = true;
    function walk(selected, depth) {
      if (builtins.includes(selected)) return palette(selected, appearance);
      if (depth > 32 || visiting.has(selected)) { valid = false; warnings.push('主题继承存在循环或层数过多，无法继承的部分使用墨页颜色。'); return palette('moye', appearance); }
      const theme = byId.get(selected);
      if (!theme) { valid = false; warnings.push(`找不到主题 ${selected}，已回退到墨页颜色。`); return palette('moye', appearance); }
      if (theme.appearance !== appearance) { valid = false; warnings.push(`“${theme.name}”仅用于${theme.appearance === 'dark' ? '深' : '浅'}色外观，当前外观不匹配。`); return palette('moye', appearance); }
      visiting.add(selected);
      const result = walk(theme.basedOn, depth + 1);
      visiting.delete(selected);
      for (const [key, value] of Object.entries(theme.variables || {})) {
        if (variableKeys.includes(key) && /^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(value)) result[key] = value;
      }
      warnings.push(...(theme.warnings || []));
      return result;
    }
    const variables = walk(id || 'moye', 0);
    return { id: id || 'moye', name: byId.get(id)?.name || id || 'moye', valid, variables, warnings: [...new Set(warnings)] };
  }
  function toTOML({ name, appearance = 'light', basedOn = 'moye', variables = {} }) {
    const quote = value => JSON.stringify(String(value));
    const output = [`# 墨页颜色主题：支持 [meta] / [colors] / [chrome] 与单行字符串。`, '[meta]', `name = ${quote(name || '我的主题')}`, `appearance = ${quote(appearance)}`, `based_on = ${quote(basedOn)}`, '', '[colors]'];
    Object.entries(colors).forEach(([key, variable]) => { if (variables[variable]) output.push(`${key} = ${quote(variables[variable])}`); });
    output.push('', '[chrome]');
    Object.entries(chrome).forEach(([key, variable]) => { if (variables[variable]) output.push(`${key} = ${quote(variables[variable])}`); });
    return output.join('\n') + '\n';
  }
  return Object.freeze({ maximumBytes, builtins: Object.freeze(builtins), variableKeys, fileName, parse, resolve, toTOML, palette, customPattern });
});
