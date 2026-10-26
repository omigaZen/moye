'use strict';
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

(async()=>{
  const project=path.resolve(__dirname,'..'),work=await fs.mkdtemp(path.join(os.tmpdir(),'moye-file-ui-'));
  const app=await _electron.launch({executablePath:require('electron'),args:[...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[]),path.join(project,'electron/main.cjs')],env:{...process.env,MOYE_TEST:'1',MOYE_TEST_USER_DATA:path.join(work,'profile')}});
  const results=[],errors=[];const page=await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 860 });page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.moye?.ready);
  async function probe(name,run){try{results.push({name,status:'pass',details:await run()});}catch(e){results.push({name,status:'fail',error:e.message});}}
  async function chooseOpen(file){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},file);await page.evaluate(()=>moye.performAction('open'));}
  async function chooseSave(file){await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);}
  try{
    await probe('native no-op save preserves BOM and mixed newlines at Chinese-space filename',async()=>{
      const file=path.join(work,'中文 文件.md'),bytes=Buffer.from('\ufeff# 标题\r\n\r\n第一段\n\n- a\r\n');await fs.writeFile(file,bytes);await chooseOpen(file);await page.evaluate(()=>moye.performAction('save'));assert.deepEqual(await fs.readFile(file),bytes);assert.equal(await page.evaluate(()=>moye.getState().dirty),false);return{bytes:bytes.length};
    });
    await probe('Save As copies local relative images and reopens with working image',async()=>{
      const old=path.join(work,'old'),target=path.join(work,'new');await fs.mkdir(path.join(old,'assets'),{recursive:true});await fs.mkdir(target);
      await fs.copyFile(path.join(project,'samples/assets/书写 测试.svg'),path.join(old,'assets/书写 测试.svg'));
      const original=path.join(old,'文档.md'),saved=path.join(target,'另存.md'),text='# 图片\n\n![图](<assets/书写 测试.svg>)\n';await fs.writeFile(original,text);
      await chooseOpen(original);await chooseSave(saved);await page.evaluate(()=>moye.performAction('save-as'));assert.equal(await fs.readFile(saved,'utf8'),text);await fs.access(path.join(target,'assets/书写 测试.svg'));await chooseOpen(saved);
      await page.waitForFunction(()=>[...document.querySelectorAll('.vditor-ir img')].every(i=>i.complete&&i.naturalWidth===640));return{images:await page.locator('.vditor-ir img').count()};
    });
    await probe('Save As rebases parent-directory image references and syncs editor saved state',async()=>{
      const old=path.join(work,'parent-source'),target=path.join(work,'parent-target');await fs.mkdir(old);await fs.mkdir(target);await fs.copyFile(path.join(project,'samples/assets/书写 测试.svg'),path.join(work,'outside.svg'));
      const original=path.join(old,'source.md'),saved=path.join(target,'saved.md');await fs.writeFile(original,'# 外部图片\n\n![图](../outside.svg)\n');await chooseOpen(original);await chooseSave(saved);await page.evaluate(()=>moye.performAction('save-as'));
      const disk=await fs.readFile(saved,'utf8'),state=await page.evaluate(()=>moye.getState());assert.match(disk,/file:/);assert.equal(state.content,disk);assert.equal(state.dirty,false);await chooseOpen(saved);await page.waitForFunction(()=>document.querySelector('.vditor-ir img')?.naturalWidth===640);return{rebased:true};
    });
    await probe('bundled syntax example saves as a standalone document with its local images',async()=>{
      await page.evaluate(()=>moye.performAction('syntax'));const dir=path.join(work,'example-copy');await fs.mkdir(dir);const saved=path.join(dir,'语法示例.md');await chooseSave(saved);await page.evaluate(()=>moye.performAction('save-as'));await fs.access(path.join(dir,'assets/书写 测试.svg'));await chooseOpen(saved);
      await page.waitForFunction(()=>document.querySelectorAll('.language-mermaid svg').length===8);await page.waitForFunction(()=>[...document.querySelectorAll('.vditor-ir img')].every(i=>i.naturalWidth===640));return{diagrams:8};
    });
    await probe('external edit cancellation preserves disk file and keeps editor editable and dirty',async()=>{
      const file=path.join(work,'conflict.md');await fs.writeFile(file,'original\n');await chooseOpen(file);await page.evaluate(()=>{moye.setMode('sv');const e=moye.editor.vditor.sv.element;e.focus();e.setSelectionRange(e.value.length,e.value.length);document.execCommand('insertText',false,'local');});await fs.writeFile(file,'external\n');
      await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:2});});await page.evaluate(()=>moye.performAction('save'));assert.equal(await fs.readFile(file,'utf8'),'external\n');const state=await page.evaluate(()=>({dirty:moye.getState().dirty,disabled:moye.editor.vditor.sv.element.disabled}));assert.equal(state.dirty,true);assert.equal(state.disabled,false);return state;
    });
  }finally{
    const proc=app.process(),exit=proc.exitCode===null?new Promise(r=>proc.once('exit',r)):Promise.resolve();await app.evaluate(({app})=>app.exit(0));await exit;
    await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    const report={platform:process.platform,results,pageErrors:errors};await fs.writeFile(path.join(project,'tests/files-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
    if(results.some(r=>r.status==='fail')||errors.length)process.exitCode=1;
  }
})().catch(e=>{console.error(e);process.exit(1)});
