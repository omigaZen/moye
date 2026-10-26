/* Pinned local MathJax component loader; Vditor rendering stays promise-based. */
(function (root) {
  'use strict';
  let loading = null;
  let loadError = null;
  let configurationKey = null;
  const scriptId = 'protyleMathJaxScript';

  function macrosFrom(value) {
    const macros = typeof value === 'string' ? JSON.parse(value) : (value || {});
    if (!macros || typeof macros !== 'object' || Array.isArray(macros)) throw new TypeError('公式宏必须是 JSON 对象。');
    const result = {};
    for (const [key, definition] of Object.entries(macros)) {
      if (!/^[A-Za-z]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('公式宏名称应为英文字母，不包含反斜杠。');
      if (typeof definition === 'string') result[key] = definition;
      else if (Array.isArray(definition) && definition.length >= 2 && definition.length <= 3 && typeof definition[0] === 'string' && Number.isInteger(definition[1]) && definition[1] >= 0 && definition[1] <= 9 && (definition.length === 2 || typeof definition[2] === 'string')) result[key] = [...definition];
      else throw new TypeError('公式宏应为字符串，或 [替换内容, 参数数, 可选默认值]。');
    }
    return result;
  }

  function optionsFor({ cdn, macros = {}, autoNumber = false, numberingStyle = 'all', physics = false } = {}) {
    if (typeof cdn !== 'string' || !cdn) throw new TypeError('缺少本地公式资源路径。');
    if (!['all', 'ams'].includes(numberingStyle)) throw new TypeError('公式编号规则无效。');
    if (typeof physics !== 'boolean') throw new TypeError('Physics 扩展开关必须为布尔值。');
    const local = cdn.replace(/\/$/, '') + '/dist/js/mathjax';
    const packages = ['begingroup', 'bboldx', 'mhchem', ...(physics ? ['physics'] : [])];
    return {
      loader: {
        paths: { mathjax: local, fonts: local + '/fonts', 'mathjax-newcm': local + '/fonts/mathjax-newcm-font', sre: local + '/sre' },
        load: [...packages.map(name => '[tex]/' + name), 'ui/safe'],
      },
      startup: { typeset: false },
      tex: { macros: macrosFrom(macros), tags: autoNumber ? numberingStyle : 'none', packages: { '[+]': packages } },
      output: { font: 'mathjax-newcm', fontPath: local + '/fonts/%%FONT%%-font' },
      svg: { fontCache: 'local' },
      options: { enableMenu: false, enableExplorer: false, enableEnrichment: false, enableSpeech: false, enableBraille: false },
    };
  }

  async function configure(options = {}) {
    const configuration = optionsFor(options);
    const key = JSON.stringify({ cdn: options.cdn, macros: configuration.tex.macros, tags: configuration.tex.tags, physics: options.physics === true });
    if (options.engine === 'KaTeX') return previewOptions(options);
    if (loadError) throw loadError;
    if (loading) await loading;
    if (root.MathJax?.version) {
      if (!String(root.MathJax.version).startsWith('4.')) throw new Error('公式资源版本不匹配，需重新启动程序。');
      await root.MathJax.startup.promise;
      if (configurationKey !== key) {
        // Extension registration and activating it in a TeX input jax are
        // separate operations. Loading once is sufficient; rebuilding with
        // physics absent from packages also makes an ON -> OFF change real.
        if (options.physics) await root.MathJax.loader.load('[tex]/physics');
        // Merely assigning MathJax.config does not update instantiated jax.
        // Recreate them using the documented API, with local SVG font caches.
        root.MathJax.config.tex.macros = configuration.tex.macros;
        root.MathJax.config.tex.tags = configuration.tex.tags;
        const packages = root.MathJax.config.tex.packages.filter(name => name !== 'physics');
        root.MathJax.config.tex.packages = options.physics ? [...packages, 'physics'] : packages;
        root.MathJax.startup.getComponents();
        root.MathJax.startup.makeMethods();
        root.MathJax.texReset();
        configurationKey = key;
      }
      return previewOptions(options);
    }
    loading = (async () => {
      root.MathJax = configuration;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = scriptId;
        script.src = configuration.loader.paths.mathjax + '/tex-svg.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('本地公式资源加载失败。'));
        document.head.appendChild(script);
      });
      await root.MathJax.startup.promise;
      if (root.MathJax.version !== '4.1.3') throw new Error('本地公式资源版本不匹配。');
      configurationKey = key;
    })();
    let timer;
    try {
      await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('本地公式资源加载超时，请重新启动后重试。')), 15000);
      })]);
    } catch (error) { loadError = error; throw error; }
    finally { clearTimeout(timer); loading = null; }
    return previewOptions(options);
  }

  function previewOptions(options = {}) {
    const macros = macrosFrom(options.macros);
    if (options.engine === 'KaTeX') {
      const legacy = {};
      for (const [key, definition] of Object.entries(macros)) legacy['\\' + key] = Array.isArray(definition) ? definition[0] : definition;
      return { engine: 'KaTeX', macros: legacy };
    }
    return { engine: 'MathJax', macros, mathJaxOptions: optionsFor(options) };
  }

  function resetDocument() {
    if (root.MathJax?.texReset) root.MathJax.texReset();
  }

  root.MoyeMath = Object.freeze({ configure, previewOptions, resetDocument, macrosFrom });
})(window);
