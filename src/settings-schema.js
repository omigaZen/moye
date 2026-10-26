(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./shortcut-config.js') : root.MoyeShortcuts, typeof module === 'object' && module.exports ? require('./image-policy.js') : root.MoyeImagePolicy, typeof module === 'object' && module.exports ? require('./typography-config.js') : root.MoyeTypography);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoyeSettingsSchema = api;
})(typeof globalThis === 'object' ? globalThis : this, function (shortcuts, imagePolicy, typography) {
  'use strict';

  // These are Moye defaults, not asserted Typora defaults. Reference-version
  // settings and behavior still require independent, platform-specific checks.
  const option = (value, label) => ({ value, label });
  const bool = (key, category, label, value, description = '') => ({ key, category, label, type: 'boolean', default: value, description });
  const num = (key, category, label, value, min, max, step = 1) => ({ key, category, label, type: 'number', default: value, min, max, step });
  const str = (key, category, label, value, maxLength, description = '') => ({ key, category, label, type: 'string', default: value, maxLength, description });
  const select = (key, category, label, value, options) => ({ key, category, label, type: 'select', default: value, options });
  const definitions = [
    select('ui.language', '通用', '界面语言', 'zh-CN', [option('zh-CN', '简体中文'), option('en-US', 'English'), option('system', '跟随系统')]),
    select('appearance.theme', '外观', '界面主题', 'light', [option('light', '浅色'), option('dark', '深色'), option('system', '跟随系统')]),
    num('appearance.fontSize', '外观', '正文字号', 17, 12, 32),
    num('appearance.contentWidth', '外观', '书写区域宽度', 780, 480, 1600, 10),
    str('appearance.fontFamily', '外观', '正文字体', '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 200, '使用 CSS 字体族列表；缺失字体由系统回退。'),
    str('appearance.monospaceFontFamily', '外观', '等宽字体', 'SFMono-Regular, Consolas, "Liberation Mono", "Noto Sans SC", monospace', 200),
    num('appearance.lineHeight', '外观', '正文行高', 1.85, 1.2, 2.4, 0.05),
    bool('appearance.sidebarVisible', '外观', '显示大纲', true),
    bool('appearance.toolbarVisible', '外观', '显示格式工具栏', true),
    { ...str('typography.activeProfile', '排版', '当前排版方案', 'daily', 80), hidden: true },
    { ...str('typography.savedProfiles', '排版', '保存的排版方案', '[]', 65536), hidden: true },
    str('typography.latinFontFamily', '排版', '西文字体', 'inherit', 200, 'inherit 使用正文字体；仅影响西文显示。'),
    str('typography.cjkFontFamily', '排版', '中日韩字体', 'inherit', 200, 'inherit 使用正文字体；字体缺失时使用系统回退。'),
    bool('typography.cjkSpacing', '排版', '中西文视觉间距', false, '只调整显示间距，不向 Markdown 插入空格。'),
    bool('typography.hangingPunctuation', '排版', '标点悬挂', false),
    bool('typography.punctuationCompression', '排版', '标点压缩', false, '压缩中日韩全角标点的显示空白，不改写原文。'),
    select('typography.paragraphStyle', '排版', '段落样式', 'spaced', [option('spaced', '段间留白'), option('indented', '首行缩进')]),
    select('typography.textAlign', '排版', '正文对齐', 'start', [option('start', '靠起始边'), option('justify', '两端对齐'), option('optimal', '整段优化（阅读模式）')]),
    str('typography.colorTheme', '排版', '配色方案', 'moye', 80, 'moye、mono、solarized、nord 或主题编辑器创建的 custom:名称。'),
    select('table.layout', '表格', '表格显示宽度', 'body', [option('body', '正文宽度'), option('window', '使用窗口宽度'), option('natural', '按内容宽度')]),
    select('table.style', '表格', '表格样式', 'grid', [option('grid', '网格'), option('booktabs', '三线表')]),
    select('table.alignment', '表格', '表格位置', 'start', [option('start', '靠起始边'), option('center', '居中'), option('end', '靠结束边')]),
    bool('reading.immersive', '阅读', '阅读时自动隐藏工具栏', false, '指针靠近顶部时浮现；不会推动正文。'),
    bool('reading.rememberPosition', '阅读', '记住文件阅读位置', true, '只保存位置标记，不保存文档内容。'),
    select('reading.txtMode', '阅读', 'TXT 文件阅读方式', 'auto', [option('auto', '按纯文本阅读'), option('plain', '纯文本'), option('markdown', '按 Markdown 阅读')]),
    select('reading.paragraphRule', '阅读', '纯文本段落识别', 'blankLines', [option('blankLines', '空行分段'), option('lines', '逐行分段')]),
    bool('reading.chapterDetection', '阅读', '识别纯文本章节大纲', true),
    bool('reading.nextDocumentPrompt', '阅读', '读完后提示下一篇', true),
    select('reading.txtPreset', '阅读', '纯文本阅读预设', 'inherit', [option('inherit', '跟随当前排版'), option('book', '书籍'), option('compact', '紧凑')]),
    bool('editor.focusMode', '编辑', '专注模式', false),
    bool('editor.typewriterMode', '编辑', '打字机模式', false),
    bool('editor.typewriterAlwaysCenter', '编辑', '打字机模式下始终居中光标', true, '开启时鼠标选择也居中；关闭时仅输入后居中。'),
    bool('editor.smartQuotes', '编辑', '智能引号（输入时转换）', false, '书写模式输入时转换弯引号；源码、代码、公式和 YAML 保持原样。'),
    bool('editor.smartDashes', '编辑', '智能破折号与省略号（输入时转换）', false, '书写模式将 --、--- 与 ... 转换为 Unicode 标点；可撤销。'),
    { ...str('editor.keyBindings', '快捷键', '自定义快捷键（JSON）', '{}', 16384, '命令 ID 到组合键，例如 {"focus":"F7","bold":"Ctrl+Alt+B"}；空字符串禁用该命令。导入时会检查冲突。'), multiline: true },
    select('editor.tabSize', '编辑', '缩进宽度', 4, [option(2, '2 个空格'), option(4, '4 个空格'), option(8, '8 个空格')]),
    bool('editor.autoPairBrackets', '编辑', '自动配对括号和引号', true),
    bool('editor.autoPairMarkdown', '编辑', '自动配对 Markdown 标记', true),
    bool('editor.copyPlainTextAsMarkdown', '编辑', '复制时将纯文本格式设为 Markdown', false, '富文本格式保持可用；只改变系统剪贴板中的纯文本数据。'),
    bool('general.autoSave', '通用', '自动保存已有文件', false, '仅保存已有路径的文档；未命名文档仍保留恢复草稿。'),
    num('general.autoSaveIntervalMinutes', '通用', '自动保存间隔（分钟）', 5, 1, 30),
    bool('general.spellcheck', '通用', '拼写检查', false, '由操作系统和 Electron 的可用字典提供；不等同于语法或中文校对。'),
    bool('markdown.inlineMath', 'Markdown', '行内数学公式', true),
    bool('markdown.mathBlock', 'Markdown', '块级数学公式', true),
    bool('markdown.sup', 'Markdown', '上标', true),
    bool('markdown.sub', 'Markdown', '下标', true),
    bool('markdown.mark', 'Markdown', '高亮', true),
    bool('markdown.autoLink', 'Markdown', '自动识别链接', true),
    bool('markdown.toc', 'Markdown', '文内目录', true),
    bool('markdown.footnotes', 'Markdown', '脚注', true),
    bool('markdown.diagrams', 'Markdown', '图表', true),
    bool('markdown.preserveWhitespace', 'Markdown', '保留连续空白与单个换行', true, '只影响书写区显示；不改写 Markdown 原文、显式换行或代码。'),
    bool('markdown.codeBlockMath', 'Markdown', '数学代码围栏预览', true, '启用 ```math 围栏的公式预览；与行内和 $$ 块公式开关独立。'),
    bool('code.lineNumbers', '代码', '显示代码行号', false),
    bool('code.highlight', '代码', '代码语法高亮', true),
    bool('code.languageBadge', '代码', '显示代码语言角标', true),
    bool('code.sourceHighlight', '代码', '源码语法着色', true, '显示层着色；输入法组合或超大文本时保留原生文字显示。'),
    bool('code.wrap', '代码', '代码长行自动换行', true),
    str('code.defaultLanguage', '代码', '新建代码块的默认语言', '', 80, '留空时不指定语言。'),
    select('code.theme', '代码', '代码高亮主题', 'github', ['github', 'github-dark', 'atom-one-light', 'atom-one-dark', 'monokai', 'nord', 'vs', 'vs2015'].map(value => option(value, value))),
    select('math.engine', '数学', '公式渲染引擎', 'MathJax', [option('MathJax', 'MathJax'), option('KaTeX', 'KaTeX')]),
    select('math.overflow', '数学', '超宽块公式', 'scroll', [option('scroll', '局部横向滚动'), option('fit', '缩小以适应宽度')]),
    bool('math.autoNumber', '数学', '公式自动编号', false, '仅在 MathJax 引擎下生效，关闭时不自动编号。'),
    select('math.numberingStyle', '数学', '公式编号规则', 'all', [option('all', '所有块公式'), option('ams', 'AMS 环境规则')]),
    bool('math.physics', '数学', '启用 physics 公式包', false, '使用 MathJax 的本地 physics 扩展；KaTeX 不提供相同配置。'),
    str('math.macros', '数学', '公式宏（JSON）', '{}', 16384, 'JSON 对象，宏名为英文字母。定义为文本或 [文本, 参数数, 可选默认值]；带可选参数默认值的宏请使用 MathJax。'),
    select('images.insertAction', '图片', '从文件插入图片时', 'copy', [option('copy', '复制到文档资源目录'), option('reference', '引用原位置')]),
    str('images.assetFolder', '图片', '图片资源目录', '${filename}.assets', 200, '文档相对目录，可使用 ${filename}，例如 assets/${filename}；不允许跳出文档目录。'),
    select('images.pathStyle', '图片', '图片路径形式', 'auto', [option('auto', '默认：复制用相对路径，引用用文件 URL'), option('relative', '相对文档路径'), option('absolute', '绝对文件 URL')]),
    bool('images.relativePrefix', '图片', '相对图片路径添加 ./ 前缀', true),
    bool('images.escapePath', '图片', '转义图片路径空格与非 ASCII 字符', true, '关闭时使用可读路径；Markdown 分隔符仍作必要转义。'),
    bool('images.applyToLocal', '图片', '对本地文件图片应用复制规则', true, '关闭时从文件选择器插图引用原文件；剪贴板位图仍需写入图片文件。'),
  ].map(definition => {
    if (definition.options) { definition.options.forEach(Object.freeze); Object.freeze(definition.options); }
    return Object.freeze({ description: '', ...definition, referenceDefaultVerified: false });
  });
  Object.freeze(definitions);
  const byKey = new Map(definitions.map(definition => [definition.key, definition]));
  const defaults = Object.freeze(Object.fromEntries(definitions.map(definition => [definition.key, definition.default])));

  function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function validateValue(definition, value) {
    const invalid = () => { throw new TypeError(`设置“${definition.label}”的值无效。`); };
    if (definition.type === 'boolean' && typeof value !== 'boolean') invalid();
    if (definition.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < definition.min || value > definition.max || (definition.step >= 1 && !Number.isInteger(value))) invalid();
      const steps = (value - definition.min) / definition.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-7) invalid();
    }
    if (definition.type === 'select' && !definition.options.some(option => Object.is(option.value, value))) invalid();
    if (definition.type === 'string' && (typeof value !== 'string' || value.length > definition.maxLength || value.includes('\0'))) invalid();
    if (definition.key.endsWith('FontFamily') || definition.key === 'appearance.fontFamily') {
      if (!value.trim() || /[;{}<>\r\n]/.test(value)) invalid();
    }
    if (definition.key === 'code.defaultLanguage' && !/^[A-Za-z0-9_+#. -]*$/.test(value)) invalid();
    if (definition.key === 'editor.keyBindings') shortcuts.validateKeyBindings(value);
    if (definition.key.startsWith('typography.')) typography.validateSetting(definition.key, value);
    if (definition.key === 'images.assetFolder' && !imagePolicy.validateFolder(value)) invalid();
    if (definition.key === 'math.macros') {
      let macros;
      try { macros = JSON.parse(value); } catch { invalid(); }
      const validMacro = definition => {
        if (typeof definition === 'string') return definition.length <= 4096;
        return Array.isArray(definition) && (definition.length === 2 || definition.length === 3)
          && typeof definition[0] === 'string' && definition[0].length <= 4096
          && Number.isInteger(definition[1]) && definition[1] >= 0 && definition[1] <= 9
          && (definition.length === 2 || (typeof definition[2] === 'string' && definition[2].length <= 4096));
      };
      if (!plainObject(macros) || Object.keys(macros).length > 200 || Object.entries(macros).some(([key, definition]) => ['__proto__', 'constructor', 'prototype'].includes(key) || !/^[A-Za-z]+$/.test(key) || key.length > 120 || !validMacro(definition))) invalid();
    }
    return value;
  }
  function validatePatch(patch) {
    if (!plainObject(patch)) throw new TypeError('设置必须为键值对象。');
    if (Object.getOwnPropertySymbols(patch).length) throw new TypeError('设置不能包含 Symbol。');
    const result = {};
    for (const key of Object.keys(patch)) {
      const definition = byKey.get(key);
      if (!definition) throw new TypeError(`未知设置：${key}`);
      const property = Object.getOwnPropertyDescriptor(patch, key);
      if (!property || !Object.hasOwn(property, 'value')) throw new TypeError('设置不能包含 getter 或 setter。');
      result[key] = validateValue(definition, property.value);
    }
    return result;
  }
  function normalize(values) { return { ...defaults, ...validatePatch(values) }; }

  return Object.freeze({ schemaVersion: 1, definitions, defaults, validatePatch, normalize });
});
