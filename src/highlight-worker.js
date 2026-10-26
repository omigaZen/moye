/* Dedicated worker: grammars and highlighting never run on the editor thread. */
'use strict';
let initializationError = null;
try {
  importScripts('vendor/vditor/dist/js/highlight.js/highlight.min.js');
  importScripts('vendor/vditor/dist/js/highlight.js/third-languages.js');
} catch (error) { initializationError = String(error?.message || error); }
self.onmessage = event => {
  const { id, source, language } = event.data || {};
  if (!Number.isInteger(id) || typeof source !== 'string' || typeof language !== 'string') return;
  if (initializationError) { self.postMessage({ id, error: initializationError }); return; }
  try {
    const resolvedLanguage = hljs.getLanguage(language) ? language : 'plaintext';
    const started = performance.now();
    const result = hljs.highlight(source, { language: resolvedLanguage, ignoreIllegals: true });
    self.postMessage({ id, html: result.value, resolvedLanguage, durationMs: performance.now() - started, worker: true });
  } catch (error) { self.postMessage({ id, error: String(error?.message || error) }); }
};
