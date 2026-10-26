/* Independent, view-only typography profiles. No document text is stored here. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeTypography = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({
    'typography.activeProfile': 'daily',
    'typography.savedProfiles': '[]',
    'typography.latinFontFamily': 'inherit',
    'typography.cjkFontFamily': 'inherit',
    'typography.cjkSpacing': false,
    'typography.hangingPunctuation': false,
    'typography.punctuationCompression': false,
    'typography.paragraphStyle': 'spaced',
    'typography.textAlign': 'start',
    'typography.colorTheme': 'moye',
  });
  const base = Object.freeze({
    'appearance.fontSize': 17,
    'appearance.contentWidth': 780,
    'appearance.fontFamily': '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'appearance.monospaceFontFamily': 'SFMono-Regular, Consolas, "Liberation Mono", "Noto Sans SC", monospace',
    'appearance.lineHeight': 1.85,
    'table.layout': 'body',
    'table.style': 'grid',
    'table.alignment': 'start',
    ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !['typography.activeProfile', 'typography.savedProfiles'].includes(key))),
  });
  const profileKeys = Object.freeze(Object.keys(base));
  const profileKeySet = new Set(profileKeys);
  const enums = Object.freeze({
    'typography.paragraphStyle': ['spaced', 'indented'],
    'typography.textAlign': ['start', 'justify', 'optimal'],
    'typography.colorTheme': ['moye', 'mono', 'solarized', 'nord'],
    'table.layout': ['body', 'window', 'natural'],
    'table.style': ['grid', 'booktabs'],
    'table.alignment': ['start', 'center', 'end'],
  });
  const builtin = Object.freeze([
    { id: 'daily', name: '日常书写', values: base },
    { id: 'technical', name: '技术文档', values: { ...base,
      'appearance.contentWidth': 900, 'appearance.lineHeight': 1.7,
      'typography.latinFontFamily': 'Inter, "Segoe UI", Arial, "Liberation Sans", sans-serif',
      'typography.cjkSpacing': true,
      'table.layout': 'window',
    } },
    { id: 'book', name: '中文长文', values: { ...base,
      'appearance.fontSize': 19, 'appearance.contentWidth': 720, 'appearance.lineHeight': 1.95,
      'typography.latinFontFamily': 'Georgia, "Times New Roman", "Liberation Serif", serif',
      'typography.cjkFontFamily': '"Noto Serif CJK SC", "Songti SC", "SimSun", "Noto Sans SC", serif',
      'typography.cjkSpacing': true, 'typography.hangingPunctuation': true, 'typography.punctuationCompression': true,
      'typography.paragraphStyle': 'indented',
      'typography.textAlign': 'optimal', 'table.layout': 'natural', 'table.style': 'booktabs', 'table.alignment': 'center',
    } },
    { id: 'compact', name: '紧凑排版', values: { ...base,
      'appearance.fontSize': 15, 'appearance.contentWidth': 960, 'appearance.lineHeight': 1.55,
    } },
  ].map(profile => Object.freeze({ ...profile, builtin: true, values: Object.freeze({ ...profile.values }) })));
  const builtinIds = new Set(builtin.map(profile => profile.id));
  const maximumProfiles = 32;

  function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function font(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[;{}<>\r\n\0]/.test(value);
  }
  function validateSetting(key, value) {
    let valid = true;
    if (key === 'typography.savedProfiles') { parseProfiles(value); return value; }
    if (key === 'typography.activeProfile') valid = typeof value === 'string' && /^(?:daily|technical|book|compact|user-[1-9][0-9]{0,8})$/.test(value);
    else if (key === 'appearance.fontSize') valid = Number.isInteger(value) && value >= 12 && value <= 32;
    else if (key === 'appearance.contentWidth') valid = Number.isInteger(value) && value >= 480 && value <= 1600 && value % 10 === 0;
    else if (key === 'appearance.lineHeight') valid = typeof value === 'number' && Number.isFinite(value) && value >= 1.2 && value <= 2.4 && Math.abs((value - 1.2) / 0.05 - Math.round((value - 1.2) / 0.05)) < 1e-7;
    else if (key.endsWith('FontFamily') || key === 'appearance.fontFamily') valid = font(value);
    else if (key === 'typography.cjkSpacing' || key === 'typography.hangingPunctuation' || key === 'typography.punctuationCompression') valid = typeof value === 'boolean';
    else if (Object.hasOwn(enums, key)) valid = enums[key].includes(value) || key === 'typography.colorTheme' && typeof value === 'string' && /^custom:[a-zA-Z0-9_-]{1,64}$/.test(value);
    else throw new TypeError(`不是排版方案选项：${key}`);
    if (!valid) throw new TypeError(`排版选项“${key}”的值无效。`);
    return value;
  }
  function profileValues(values) {
    const result = {};
    for (const key of profileKeys) result[key] = validateSetting(key, values?.[key] ?? base[key]);
    return result;
  }
  function parseProfiles(raw) {
    if (typeof raw !== 'string' || raw.length > 65536) throw new TypeError('排版方案数据过长。');
    let profiles;
    try { profiles = JSON.parse(raw); } catch (_) { throw new TypeError('排版方案必须为有效 JSON。'); }
    if (!Array.isArray(profiles) || profiles.length > maximumProfiles) throw new TypeError(`最多保存 ${maximumProfiles} 个自定义排版方案。`);
    const ids = new Set(), names = new Set(builtin.map(profile => profile.name.toLocaleLowerCase()));
    return profiles.map(profile => {
      if (!plain(profile) || Object.keys(profile).sort().join('|') !== 'id|name|values'
        || typeof profile.id !== 'string' || !/^user-[1-9][0-9]{0,8}$/.test(profile.id)
        || ids.has(profile.id) || typeof profile.name !== 'string' || !profile.name.trim()
        || [...profile.name].length > 40 || /[\r\n\0]/.test(profile.name)
        || names.has(profile.name.trim().toLocaleLowerCase()) || !plain(profile.values)) throw new TypeError('自定义排版方案的名称、标识或结构无效。');
      const keys = Object.keys(profile.values);
      if (keys.some(key => !profileKeySet.has(key))) throw new TypeError('排版方案只能包含显示选项。');
      ids.add(profile.id); names.add(profile.name.trim().toLocaleLowerCase());
      const values = profileValues(profile.values);
      return { id: profile.id, name: profile.name.trim(), builtin: false, values };
    });
  }
  function profiles(values = {}) { return [...builtin.map(profile => ({ ...profile, values: { ...profile.values } })), ...parseProfiles(values['typography.savedProfiles'] ?? '[]')]; }
  function getProfile(id, values = {}) { return profiles(values).find(profile => profile.id === id) || null; }
  function baseline(values = {}) { return { ...(getProfile(values['typography.activeProfile'] || 'daily', values) || builtin[0]).values }; }
  function applyProfile(id, values = {}) {
    const profile = getProfile(id, values);
    if (!profile) throw new TypeError('排版方案不存在。');
    return { ...profile.values, 'typography.activeProfile': id };
  }
  function modified(values = {}) {
    const before = baseline(values);
    return profileKeys.some(key => !Object.is(values[key] ?? base[key], before[key]));
  }
  function saveProfile(values, name) {
    if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 40 || /[\r\n\0]/.test(name)) throw new TypeError('方案名称需要 1—40 个字符。');
    const existing = parseProfiles(values?.['typography.savedProfiles'] ?? '[]');
    if (existing.length >= maximumProfiles) throw new TypeError(`最多保存 ${maximumProfiles} 个自定义排版方案。`);
    if (profiles(values).some(profile => profile.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) throw new TypeError('已有同名排版方案，请换一个名称。');
    const id = `user-${Math.max(0, ...existing.map(profile => Number(profile.id.slice(5)))) + 1}`;
    const next = [...existing.map(({ id, name, values }) => ({ id, name, values })), { id, name: name.trim(), values: profileValues(values) }];
    const raw = JSON.stringify(next); parseProfiles(raw);
    return { 'typography.savedProfiles': raw, 'typography.activeProfile': id };
  }
  function removeProfile(id, values = {}) {
    if (builtinIds.has(id)) throw new TypeError('内置方案不能删除。');
    const existing = parseProfiles(values['typography.savedProfiles'] ?? '[]');
    if (!existing.some(profile => profile.id === id)) throw new TypeError('排版方案不存在。');
    const patch = { 'typography.savedProfiles': JSON.stringify(existing.filter(profile => profile.id !== id).map(({ id, name, values }) => ({ id, name, values }))) };
    if (values['typography.activeProfile'] === id) patch['typography.activeProfile'] = 'daily';
    return patch;
  }
  return Object.freeze({ defaults, profileKeys, builtin, maximumProfiles, validateSetting, parseProfiles, profileValues, profiles, getProfile, baseline, applyProfile, saveProfile, removeProfile, modified });
});
