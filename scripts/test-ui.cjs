'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const failures=[];
for(const file of ['editor-edge.cjs','editor-extras.cjs','editor-files.cjs','editor-navigation.cjs','editor-table-tools.cjs','editor-settings-native.cjs','mathjax-offline.cjs','editor-settings.cjs','editor-math-settings.cjs','editor-pairing.cjs','editor-autolinks.cjs','editor-math-layout.cjs','editor-focus.cjs','editor-shortcuts.cjs','editor-punctuation.cjs','editor-markdown-settings.cjs','editor-image-settings.cjs','editor-outline-cache.cjs','editor-reading-anchor.cjs','editor-settings-experience.cjs','editor-table-experience.cjs','editor-typography.cjs','editor-reading-experience.cjs','editor-content-experience.cjs','editor-source-presentation.cjs','editor-workspace-experience.cjs','editor-export-experience.cjs','editor-color-themes.cjs','editor-settings-live.cjs','editor-math-reading.cjs','editor-recent-files.cjs','editor-reading-longform.cjs','editor-typography-rich.cjs','editor-export-pagination.cjs','editor-i18n.cjs','editor-system-preview.cjs','editor-file-refresh.cjs','editor-tab-close.cjs']){
  const result=spawnSync(process.execPath,[path.join(__dirname,'..','tests',file)],{stdio:'inherit',env:{...process.env,MOYE_EDGE_OUTPUT:path.join(__dirname,'..','tests','edge-report.json'),MOYE_EXTRAS_OUTPUT:path.join(__dirname,'..','tests','extras-report.json'),MOYE_TABLE_OUTPUT:path.join(__dirname,'..','tests','table-tools-report.json')}});
  if(result.error||result.status!==0)failures.push({file,status:result.status,error:result.error?.message});
}
console.log(JSON.stringify({suiteFailures:failures}));
if(failures.length)process.exitCode=1;
