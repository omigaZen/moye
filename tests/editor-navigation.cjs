'use strict';
const {_electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
(async()=>{
  const project=path.resolve(__dirname,'..'),work=await fs.mkdtemp(path.join(os.tmpdir(),'moye-navigation-'));
  const app=await _electron.launch({executablePath:require('electron'),args:[...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[]),path.join(project,'electron/main.cjs')],env:{...process.env,MOYE_TEST:'1',MOYE_TEST_USER_DATA:path.join(work,'profile')}});
  const results=[],errors=[],page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.moye?.ready);await page.setViewportSize({width:1280,height:860});
  const text='# 导航测试\n\n[toc]\n\n## 第一部分\n\n这里有脚注[^note]。\n\n'+Array.from({length:35},(_,i)=>`段落 ${i}：这是用于检查滚动跳转的正文。\n\n`).join('')+'## 第二部分\n\n第二部分内容。\n\n[^note]: 脚注定义内容。\n';
  const file=path.join(work,'navigation.md');await fs.writeFile(file,text);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.evaluate(()=>moye.performAction('open'));
  async function probe(name,run){try{results.push({name,status:'pass',details:await run()});}catch(e){results.push({name,status:'fail',error:e.message});}}
  try{
    await probe('TOC immediately after native open resolves actual unique heading IDs and scrolls',async()=>{
      const result=await page.evaluate(()=>{const toc=[...document.querySelectorAll('.vditor-ir .vditor-toc [data-target-id]')].find(n=>n.textContent.trim()==='第二部分');const target=document.getElementById(toc.dataset.targetId);if(!target)return{resolved:false};toc.click();return{resolved:true,top:target.getBoundingClientRect().top,viewport:innerHeight};});assert.equal(result.resolved,true);assert.ok(result.top>=95&&result.top<result.viewport);return result;
    });
    await probe('Ctrl-click footnote jumps to definition and return restores reference without editing',async()=>{
      const result=await page.evaluate(()=>{const ref=document.querySelector('.vditor-ir sup[data-type="footnotes-ref"]');ref.scrollIntoView({block:'center'});ref.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true}));const def=document.querySelector('.vditor-ir [data-type="footnotes-def"]'),top=def.getBoundingClientRect().top;const visible=!document.getElementById('footnote-back').hidden;document.getElementById('footnote-back').click();return{definitionTop:top,returnShown:visible,referenceTop:ref.getBoundingClientRect().top,dirty:moye.getState().dirty,text:moye.getState().content};});assert.equal(result.returnShown,true);assert.ok(result.definitionTop>=90&&result.definitionTop<860);assert.ok(result.referenceTop>=90&&result.referenceTop<860);assert.equal(result.dirty,false);assert.equal(result.text,text);return{definitionTop:result.definitionTop,referenceTop:result.referenceTop};
    });
    await probe('live-to-source mode switch keeps the current caret inside the viewport',async()=>{
      const source=Array.from({length:100},(_,i)=>`第${String(i).padStart(3,'0')}行 abcdefghij\n\n`).join(''),file=path.join(work,'source-scroll.md');await fs.writeFile(file,source);
      await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.evaluate(()=>moye.performAction('open'));
      const result=await page.evaluate(()=>{const root=moye.editor.vditor.ir.element,p=root.querySelectorAll('p')[20];root.focus();const r=document.createRange();r.selectNodeContents(p);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);moye.setMode('sv');const e=moye.editor.vditor.sv.element,s=getComputedStyle(e),line=e.value.slice(0,e.selectionStart).split('\n').length-1,caretTop=parseFloat(s.paddingTop)+line*parseFloat(s.lineHeight);return{scrollTop:e.scrollTop,caretTop,height:e.clientHeight,start:e.selectionStart,fontSize:s.fontSize};});
      assert.ok(result.caretTop>=result.scrollTop);assert.ok(result.caretTop<result.scrollTop+result.height);assert.equal(result.fontSize,'14px');return result;
    });
    await probe('source find scrolls an offscreen match into view',async()=>{
      await page.evaluate(()=>{const e=moye.editor.vditor.sv.element;e.scrollTop=e.scrollHeight;moye.performAction('find');});await page.locator('#find-input').fill('第005行');await page.locator('#find-next').click();
      const result=await page.evaluate(()=>{const e=moye.editor.vditor.sv.element,s=getComputedStyle(e),line=e.value.slice(0,e.selectionStart).split('\n').length-1;return{selected:e.value.slice(e.selectionStart,e.selectionEnd),caretTop:parseFloat(s.paddingTop)+line*parseFloat(s.lineHeight),scrollTop:e.scrollTop,height:e.clientHeight};});
      assert.equal(result.selected,'第005行');assert.ok(result.caretTop>=result.scrollTop);assert.ok(result.caretTop<result.scrollTop+result.height);return result;
    });
  }finally{
    const proc=app.process(),exit=proc.exitCode===null?new Promise(r=>proc.once('exit',r)):Promise.resolve();await app.evaluate(({app})=>app.exit(0));await exit;await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    const report={platform:process.platform,results,pageErrors:errors};await fs.writeFile(path.join(project,'tests/navigation-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(results.some(r=>r.status==='fail')||errors.length)process.exitCode=1;
  }
})().catch(e=>{console.error(e);process.exit(1)});
