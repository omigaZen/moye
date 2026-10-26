#!/usr/bin/env node
'use strict';

// Copy the complete distribution, including formula fonts and diagram engines.
// No resource is fetched from a CDN by this build step or at application runtime.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'vditor', 'dist');
const destination = path.join(root, 'src', 'vendor', 'vditor', 'dist');

function prepareAssets() {
  if (!fs.existsSync(path.join(source, 'index.min.js'))) {
    throw new Error('Vditor is not installed. Run npm ci before preparing assets.');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  const required = [
    'index.min.js', 'index.css', 'js/lute/lute.min.js',
    'js/katex/katex.min.js', 'js/katex/katex.min.css',
    'js/mermaid/mermaid.min.js', 'js/i18n/zh_CN.js',
  ];
  for (const name of required) {
    if (!fs.existsSync(path.join(destination, name))) {
      throw new Error(`Required offline asset is missing: ${name}`);
    }
  }
  // Vditor enables Mermaid's "loose" mode upstream. Keep document diagrams
  // in strict mode while retaining upstream sources and their license notices.
  for (const name of ['index.js', 'index.min.js']) {
    const target = path.join(destination, name);
    const input = fs.readFileSync(target, 'utf8');
    const pattern = /securityLevel\s*:\s*["']loose["']/g;
    const matches = input.match(pattern) || [];
    if (matches.length !== 1) {
      throw new Error(`Unexpected Mermaid configuration in ${name}: expected 1 loose setting, found ${matches.length}`);
    }
    let patched = input.replace(pattern, 'securityLevel:"strict"');
    const fontPattern = /(securityLevel:"strict",\s*altFontFamily:\s*)["']sans-serif["'](,\s*fontFamily:\s*)["']sans-serif["']/g;
    const fontMatches = patched.match(fontPattern) || [];
    if (fontMatches.length !== 1) {
      throw new Error(`Unexpected Mermaid font configuration in ${name}: expected 1 block, found ${fontMatches.length}`);
    }
    const fontFamily = JSON.stringify('"Noto Sans SC", sans-serif');
    patched = patched.replace(fontPattern, (_, before, between) => before + fontFamily + between + fontFamily);
    // Disable diagram engines independently of normal highlighted code previews.
    // These exact insertion points belong to the locked Vditor 4.0.1 build.
    const diagramLanguages = JSON.stringify(['mermaid', 'flowchart', 'echarts', 'mindmap', 'plantuml', 'graphviz', 'wavedrom', 'markmap', 'abc', 'smiles']);
    const diagramPoint = name === 'index.js'
      ? 'var language = previewPanel.firstElementChild.className.replace("language-", "");'
      : 'var n=e.firstElementChild.className.replace("language-","");';
    if (patched.split(diagramPoint).length !== 2) throw new Error(`Unexpected diagram dispatch in ${name}`);
    const diagramGuard = name === 'index.js'
      ? `\n    if (vditor.options.preview.markdown.moyeDiagrams === false && ${diagramLanguages}.includes(language)) { previewPanel.setAttribute("data-render", "1"); return; }`
      : `if(t.options.preview.markdown.moyeDiagrams===false&&${diagramLanguages}.includes(n)){e.setAttribute("data-render","1");return;}`;
    const mathFenceGuard = name === 'index.js'
      ? '\n    if (vditor.options.preview.markdown.moyeCodeBlockMath === false && language === "math" && previewPanel.parentElement.getAttribute("data-type") === "code-block") { previewPanel.setAttribute("data-render", "1"); return; }'
      : 'if(t.options.preview.markdown.moyeCodeBlockMath===false&&n==="math"&&e.parentElement.getAttribute("data-type")==="code-block"){e.setAttribute("data-render","1");return;}';
    const contentDispatch = name === 'index.js'
      ? '\n    if (window.MoyeContentExperience && window.MoyeContentExperience.dispatch(previewPanel, vditor, language)) { previewPanel.setAttribute("data-render", "1"); return; }'
      : 'if(window.MoyeContentExperience&&window.MoyeContentExperience.dispatch(e,t,n)){e.setAttribute("data-render","1");return;}';
    patched = patched.replace(diagramPoint, diagramPoint + diagramGuard + mathFenceGuard + contentDispatch);
    // Re-highlighting a block must read its language token, not the complete
    // className which already contains hljs and optional line-number classes.
    const highlightPoint = name === 'index.js'
      ? 'var language = block.className.replace("language-", "");'
      : 'var n=t.className.replace("language-","");';
    const highlightLanguage = name === 'index.js'
      ? 'var language = Array.from(block.classList).find(function (value) { return value.indexOf("language-") === 0; }); language = language ? language.slice(9) : "";'
      : 'var n=Array.from(t.classList).find(function(e){return e.indexOf("language-")===0});n=n?n.slice(9):"";';
    if (patched.split(highlightPoint).length !== 2) throw new Error(`Unexpected highlight language dispatch in ${name}`);
    patched = patched.replace(highlightPoint, highlightLanguage);
    fs.writeFileSync(target, patched);
    console.log(`Mermaid strict configuration: patched ${name} (${matches.length} replacement)`);
    console.log(`Mermaid Chinese font configuration: patched ${name} (2 font properties)`);
    console.log(`Independent diagram preference: patched ${name} (1 dispatch guard)`);
    console.log(`Repeatable code highlighting: patched ${name} (1 language-token lookup)`);
  }
  // Vditor bundles MathJax 3. Replace that generated resource directory with
  // the pinned official MathJax 4 distribution and the complete SVG font data.
  // MoyeMath loads tex-svg.js through an external script before Vditor renders,
  // so Vditor's legacy synchronous/inline script loader is never used.
  const mathSource = path.join(root, 'node_modules', 'mathjax');
  const mathFontSource = path.join(root, 'node_modules', '@mathjax', 'mathjax-newcm-font');
  const mathDestination = path.join(destination, 'js', 'mathjax');
  const mathVersion = JSON.parse(fs.readFileSync(path.join(mathSource, 'package.json'), 'utf8')).version;
  const mathFontVersion = JSON.parse(fs.readFileSync(path.join(mathFontSource, 'package.json'), 'utf8')).version;
  if (mathVersion !== '4.1.3' || mathFontVersion !== '4.1.3') {
    throw new Error(`Unexpected MathJax resource version: ${mathVersion}/${mathFontVersion}`);
  }
  fs.rmSync(mathDestination, { recursive: true, force: true });
  fs.cpSync(mathSource, mathDestination, { recursive: true });
  const mathFontDestination = path.join(mathDestination, 'fonts', 'mathjax-newcm-font');
  fs.mkdirSync(mathFontDestination, { recursive: true });
  fs.cpSync(path.join(mathFontSource, 'svg'), path.join(mathFontDestination, 'svg'), { recursive: true });
  for (const name of ['svg.js', 'package.json']) {
    fs.copyFileSync(path.join(mathFontSource, name), path.join(mathFontDestination, name));
  }
  // The npm font package declares Apache-2.0 but does not include its own copy.
  fs.copyFileSync(path.join(mathSource, 'LICENSE'), path.join(mathFontDestination, 'LICENSE'));
  for (const fontName of ['mathjax-bboldx-font-extension', 'mathjax-mhchem-font-extension']) {
    const extensionSource = path.join(root, 'node_modules', '@mathjax', fontName);
    const extensionVersion = JSON.parse(fs.readFileSync(path.join(extensionSource, 'package.json'), 'utf8')).version;
    if (extensionVersion !== '4.1.3') throw new Error(`Unexpected MathJax font extension: ${fontName}/${extensionVersion}`);
    const extensionDestination = path.join(mathDestination, 'fonts', fontName);
    fs.mkdirSync(extensionDestination, { recursive: true });
    for (const name of ['svg.js', 'package.json']) {
      fs.copyFileSync(path.join(extensionSource, name), path.join(extensionDestination, name));
    }
    fs.copyFileSync(path.join(mathSource, 'LICENSE'), path.join(extensionDestination, 'LICENSE'));
  }
  for (const name of ['tex-svg.js', 'input/tex/extensions/begingroup.js', 'input/tex/extensions/physics.js', 'input/tex/extensions/bboldx.js', 'input/tex/extensions/mhchem.js', 'ui/safe.js', 'fonts/mathjax-newcm-font/svg/dynamic/double-struck.js', 'fonts/mathjax-bboldx-font-extension/svg.js', 'fonts/mathjax-mhchem-font-extension/svg.js']) {
    if (!fs.existsSync(path.join(mathDestination, name))) {
      throw new Error(`Required offline MathJax asset is missing: ${name}`);
    }
  }
  console.log(`Offline MathJax ${mathVersion} and SVG font ${mathFontVersion} ready`);
  const samples = path.join(root, 'samples');
  if (fs.existsSync(samples)) {
    fs.cpSync(samples, path.join(root, 'src', 'samples'), { recursive: true, force: true });
  }
  const fontSource = path.join(root, 'node_modules', '@fontsource', 'noto-sans-sc');
  const fontDestination = path.join(root, 'src', 'vendor', 'fonts', 'noto-sans-sc');
  const originalCss = fs.readFileSync(path.join(fontSource, '400.css'), 'utf8');
  const fontFiles = [...originalCss.matchAll(/url\(\.\/files\/([^)]*\.woff2)\)/g)].map((match) => match[1]);
  if (!fontFiles.length) throw new Error('No Noto Sans SC WOFF2 fonts were found.');
  fs.mkdirSync(path.join(fontDestination, 'files'), { recursive: true });
  // Electron's Chromium supports WOFF2; omit unused legacy WOFF fallbacks.
  const fontCss = originalCss.replace(/,\s*url\(\.\/files\/[^)]*\.woff\)\s*format\('woff'\)/g, '');
  fs.writeFileSync(path.join(fontDestination, '400.css'), fontCss);
  for (const name of fontFiles) {
    if (!name.endsWith('-400-normal.woff2') || name.includes('/') || name.includes('\\')) {
      throw new Error(`Unexpected font resource: ${name}`);
    }
    fs.copyFileSync(path.join(fontSource, 'files', name), path.join(fontDestination, 'files', name));
  }
  fs.copyFileSync(path.join(fontSource, 'LICENSE'), path.join(fontDestination, 'LICENSE'));
  console.log(`Offline Chinese font ready: ${fontFiles.length} WOFF2 subsets (400 normal)`);
  console.log(`Offline editor assets ready: ${destination}`);
  return destination;
}

if (require.main === module) prepareAssets();
module.exports = { prepareAssets };
