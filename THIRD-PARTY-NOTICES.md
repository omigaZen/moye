# Third-party software

Moye is an independent editor. Typora is the interaction reference; no Typora
source code, logo, commercial theme, or other proprietary asset is included.

The following open-source software is used. Original notices included in their
distributions remain in the packaged application.

| Component | Version | License | Source |
|---|---|---|---|
| Vditor | 4.0.1 | MIT | https://github.com/Vanessa219/vditor |
| Electron | 45.0.0 | MIT, bundled Chromium/Node notices | https://github.com/electron/electron |
| KaTeX | bundled with Vditor | MIT | https://github.com/KaTeX/KaTeX |
| MathJax | 4.1.3 | Apache-2.0 | https://github.com/mathjax/MathJax |
| MathJax New Computer Modern SVG font data | 4.1.3 | Apache-2.0 (npm package declaration) | https://github.com/mathjax/MathJax-fonts |
| MathJax bboldx and mhchem SVG font extensions | 4.1.3 | Apache-2.0 (npm package declarations) | https://github.com/mathjax/MathJax-fonts |
| Mermaid | bundled with Vditor | MIT | https://github.com/mermaid-js/mermaid |
| highlight.js | bundled with Vditor | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| Lute | bundled with Vditor | Mulan PSL v2 | https://github.com/88250/lute |
| Noto Sans SC via Fontsource | 5.3.1 | SIL Open Font License 1.1 | https://fontsource.org/fonts/noto-sans-sc |

Vditor ships additional optional offline rendering engines and font assets.
Their files and available license notices are retained verbatim under
`src/vendor/vditor/dist/`. Electron's `LICENSE` and `LICENSES.chromium.html`
are retained alongside the executable in binary distributions.

Build tools, including @electron/packager, are development dependencies and
are not included as runtime Node modules.

## Local configuration patch

During `prepare-assets`, Moye changes Vditor's Mermaid initialization from
`securityLevel: "loose"` to `securityLevel: "strict"` and sets its
`fontFamily`/`altFontFamily` to `"Noto Sans SC", sans-serif` in the vendored
`dist/index.js` and `dist/index.min.js`. Each file must contain exactly one
matching upstream configuration block; the build fails if that assumption changes.
The installed upstream Vditor package and its other bundled code are unchanged.
Ordinary inline SVG diagrams remain supported; Mermaid handles document
labels and diagram interactions under its strict policy.

One dispatch guard is also inserted into Vditor's generated `processCodeRender`
in both JavaScript builds. When Moye's `preview.markdown.moyeDiagrams` option is
false, it leaves diagram fences as code and skips their engines, while ordinary
code fences retain highlighting and code previews. The build verifies exactly
one insertion point in each pinned upstream file. The same dispatch also
checks Moye's `moyeCodeBlockMath` flag to keep disabled math fences as editable
code without affecting `$$` block formulas.

The generated `highlightRender` language lookup is patched to read the
`language-` class token instead of the entire class string. This preserves
syntax highlighting when themes or line numbers are changed after a block
already has `hljs` classes. Each pinned JavaScript build must contain exactly
one matching lookup; the build fails if that assumption changes.

The generated Vditor MathJax 3 resource directory is replaced by the pinned
official MathJax 4.1.3 npm distribution, complete MathJax-NewCM SVG dynamic
font data and bboldx/mhchem SVG font extensions. The npm lockfile pins their
dependencies to 4.1.3. MathJax's license
and the font package metadata are retained alongside the resources. Moye's
`math-config.js` points component and font loading to those local files and
loads the external script before Vditor uses it. The optional physics TeX
package is loaded from the same pinned local distribution; no inline-script exception is
added to the Content Security Policy. Vditor's upstream MathJax renderer is not
modified. MathJax 4 compatibility is an implementation step, not a claim of
complete equivalence to Typora's mathematical input and editing behavior.

Noto Sans SC's original 400-normal WOFF2 subsets and license are packaged
under `src/vendor/fonts/noto-sans-sc/`. Its `400.css` is copied with unused
legacy WOFF fallback URLs removed; font binaries and Unicode ranges remain
unchanged. Other font weights can be synthesized by the browser.

## Additional offline encoding components (0.4.0)

- iconv-lite 0.6.3, MIT, copyright Alexander Shtuchkin; bundled under `electron/vendor/iconv-lite` with its LICENSE.
- safer-buffer 2.1.2, MIT, copyright Nikita Vavilov; bundled under `electron/vendor/safer-buffer` with its LICENSE.
- The only integration change is iconv-lite's safer-buffer import using the bundled relative path. Original package/file hashes and provenance are preserved in `electron/vendor/encoding-provenance.json` and its README.

## Editor resource adaptations (0.4.0)

The locked Vditor preparation script routes ordinary code and bounded Mermaid previews to Moye's asynchronous content controller. Ordinary syntax highlighting uses the bundled highlight.js in a dedicated Worker. Other formula and diagram rendering paths retain their existing offline engines. Display-only language labels, source syntax colours, reading pagination, typography, and paragraph optimisation are Moye code. These are independent implementations of publicly described behaviour; no Telari application code or assets are bundled.
