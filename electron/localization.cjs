'use strict';
// Pure native UI adapters. Never translate default paths, text field values,
// file names, spelling suggestions, or menu entries marked as user content.
const i18n = require('../src/i18n.js');
const roleLabels = Object.freeze({ services: '服务', hideOthers: '隐藏其他', unhide: '显示全部', about: '关于墨页', quit: '退出', hide: '隐藏墨页', close: '关闭窗口', cut: '剪切', copy: '复制', paste: '粘贴', pasteAndMatchStyle: '粘贴为纯文本', selectAll: '全选', undo: '撤销', redo: '重做', resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', togglefullscreen: '全屏' });
function localizeMenuTemplate(template, locale, systemLocale) {
  if (!Array.isArray(template)) return template;
  return template.map(item => {
    if (!item || typeof item !== 'object') return item;
    const { i18nUserContent, ...result } = item;
    if (!i18nUserContent) {
      if (typeof result.label === 'string') result.label = i18n.t(result.label, locale, systemLocale);
      else if (roleLabels[result.role]) result.label = i18n.t(roleLabels[result.role], locale, systemLocale);
      for (const key of ['sublabel', 'toolTip']) if (typeof result[key] === 'string') result[key] = i18n.t(result[key], locale, systemLocale);
    }
    if (Array.isArray(result.submenu)) result.submenu = localizeMenuTemplate(result.submenu, locale, systemLocale);
    return result;
  });
}
function localizeDialogOptions(options, locale, systemLocale, kind) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const result = { ...options };
  for (const key of ['title', 'message', 'detail', 'checkboxLabel', 'buttonLabel']) if (typeof result[key] === 'string') result[key] = i18n.t(result[key], locale, systemLocale);
  if (Array.isArray(result.buttons)) result.buttons = result.buttons.map(button => i18n.t(button, locale, systemLocale));
  if (Array.isArray(result.filters)) result.filters = result.filters.map(filter => ({ ...filter, name: i18n.t(filter.name, locale, systemLocale), ...(Array.isArray(filter.extensions) ? { extensions: [...filter.extensions] } : {}) }));
  if (!result.buttonLabel && ['open', 'save'].includes(kind)) result.buttonLabel = i18n.t(kind === 'open' ? '打开' : '保存', locale, systemLocale);
  return result;
}
function localizeError(error, locale, systemLocale) { return i18n.t(error?.message || String(error), locale, systemLocale); }
module.exports = Object.freeze({ ...i18n, localizeMenuTemplate, localizeDialogOptions, localizeError });
