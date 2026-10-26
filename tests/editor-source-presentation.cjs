'use strict';
const { _electron: electron } = require('playwright');
const { PNG } = require('playwright-core/lib/utilsBundle');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function inkDifference(native, overlay) {
  const a=PNG.sync.read(native),b=PNG.sync.read(overlay);assert.equal(a.width,b.width);assert.equal(a.height,b.height);
  const paper=[a.data[0],a.data[1],a.data[2]];let referenceInk=0,differentInk=0;
  for(let i=0;i<a.data.length;i+=4){const x=paper.some((p,c)=>Math.abs(a.data[i+c]-p)>24),y=paper.some((p,c)=>Math.abs(b.data[i+c]-p)>24);if(x)referenceInk++;if(x!==y)differentInk++;}
  return {width:a.width,height:a.height,referenceInk,differentInk,mismatchRatio:differentInk/Math.max(1,referenceInk)};
}
async function main() {
  const root=path.resolve(__dirname,'..'),work=await fs.mkdtemp(path.join(os.tmpdir(),'moye-source-presentation-'));
  const screenshots=path.resolve(process.env.MOYE_SOURCE_PRESENTATION_SCREENSHOT_DIR||path.join(root,'artifacts/source-presentation'));
  const report={generatedAt:new Date().toISOString(),platform:`${process.platform}/${process.arch}`,purpose:'Native textarea syntax-paint regression, including independent native-vs-overlay glyph screenshots; not Telari runtime differential acceptance',results:[],pageErrors:[],remoteRequests:[]};
  let app,page,number=0;
  async function probe(name,operation){const started=Date.now();try{const details=await operation();report.results.push({name,status:'pass',elapsedMs:Date.now()-started,details});}catch(error){report.results.push({name,status:'fail',elapsedMs:Date.now()-started,error:error.stack||error.message});}}
  try{
    app=await electron.launch({executablePath:process.env.MOYE_SOURCE_PRESENTATION_EXECUTABLE||require('electron'),args:[...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[]),...(process.env.MOYE_SOURCE_PRESENTATION_EXECUTABLE?[]:[root])],env:{...process.env,MOYE_TEST:'1',MOYE_TEST_USER_DATA:path.join(work,'profile')}});
    await app.evaluate(({app,session})=>{app.moyeSourceRequests=[];session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url))app.moyeSourceRequests.push(details.url);callback({cancel:/^https?:/.test(details.url)});});});
    page=await app.firstWindow();page.on('pageerror',error=>report.pageErrors.push(error.message));await page.route(/^https?:/,route=>route.abort());await page.setViewportSize({width:1280,height:860});
    await page.waitForFunction(()=>window.moye?.ready&&moye.sourcePresentation,null,{timeout:30000});
    report.application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath(),executable:app.getPath('exe')}));if(process.env.MOYE_SOURCE_PRESENTATION_EXECUTABLE)assert.equal(report.application.isPackaged,true);
    await fs.mkdir(screenshots,{recursive:true});
    const sample='# 标题 **强调**\n\n普通中文与 English 😀 混排。\n\n*斜体* [链接](https://example.test/a) 和 `const value = 1`。\n\n```js\n\tconst x = "literal **code**";\n```\n';
    async function frames(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
    async function active(){await page.waitForFunction(()=>moye.sourcePresentation.stats().active,null,{timeout:10000});await frames();}
    async function apply(patch){await page.evaluate(async patch=>{await moye.settings.apply(patch);moye.sourcePresentation.refresh();},patch);await frames();}
    async function open(content=sample){const filename=path.join(work,`source-${++number}.md`);await fs.writeFile(filename,content);await app.evaluate(({dialog},filename)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filename]});dialog.showMessageBox=async()=>({response:1});},filename);await page.evaluate(async()=>{if(moye.reading?.isEnabled())moye.reading.setEnabled(false);await moye.settings.apply({'code.sourceHighlight':true,'editor.focusMode':false,'editor.typewriterMode':false});await moye.performAction('open');moye.setMode('sv');moye.sourcePresentation.refresh();});await frames();return filename;}
    async function snapshot(){return page.evaluate(()=>{const s=moye.editor.vditor.sv.element,o=document.querySelector('.moye-source-presentation'),p=o.querySelector('.moye-source-paint');return {value:s.value,state:moye.getState(),selection:[s.selectionStart,s.selectionEnd,s.selectionDirection],active:moye.sourcePresentation.stats().active,stats:moye.sourcePresentation.stats(),paint:p.textContent,sourceColor:getComputedStyle(s).color,caretColor:getComputedStyle(s).caretColor,overlay:{hidden:o.hidden,ariaHidden:o.getAttribute('aria-hidden'),pointer:getComputedStyle(o).pointerEvents,transform:p.style.transform}};});}
    await probe('source syntax coloring preserves exact native text, reverse selection and a visible caret',async()=>{
      const filename=await open();await active();await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.focus();s.setSelectionRange(2,15,'backward');});const r=await snapshot();
      assert.equal(r.state.content,await fs.readFile(filename,'utf8'));assert.equal(r.value,r.paint.slice(0,-1));assert.equal(r.state.dirty,false);assert.deepEqual(r.selection,[2,15,'backward']);assert.equal(r.overlay.ariaHidden,'true');assert.equal(r.overlay.pointer,'none');assert.notEqual(r.caretColor,'rgba(0, 0, 0, 0)');
      const types=await page.evaluate(()=>[...document.querySelectorAll('.moye-source-token')].map(n=>n.className));for(const type of ['heading','strong','emphasis','link','code','fence'])assert.ok(types.some(x=>x.endsWith(`--${type}`)),type);
      await page.screenshot({path:path.join(screenshots,'source-colored.png')});return {selection:r.selection,tokenCount:r.stats.tokenCount,exactSource:true,caretColor:r.caretColor};
    });
    await probe('a real source edit remains one undo step with syntax paint enabled',async()=>{
      await open();await active();await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.focus();s.setSelectionRange(s.value.length,s.value.length);});await page.keyboard.insertText('追加中文😀');await page.waitForTimeout(420);await active();assert.match((await snapshot()).value,/追加中文😀$/);await page.evaluate(()=>moye.performAction('undo'));await active();assert.equal((await snapshot()).value,sample);return {nativeUndoRestored:true};
    });
    await probe('source coloring can be disabled and restored without changing text, selection or dirty state',async()=>{
      await open();await active();await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.setSelectionRange(4,20,'backward');});const before=await snapshot();await apply({'code.sourceHighlight':false});let r=await snapshot();assert.equal(r.active,false);assert.equal(r.overlay.hidden,true);assert.notEqual(r.sourceColor,'rgba(0, 0, 0, 0)');assert.deepEqual(r.selection,before.selection);assert.equal(r.state.content,before.state.content);await apply({'code.sourceHighlight':true});await active();r=await snapshot();assert.deepEqual(r.selection,before.selection);assert.equal(r.state.dirty,false);return {nativeFallbackReadable:true,reEnabled:true};
    });
    await probe('vertical and horizontal native scrolling keep the paint at the same offsets',async()=>{
      const text='# Scroll\n\n'+Array.from({length:80},(_,i)=>`${i}\t**中文** ${'long_value_'.repeat(25)}`).join('\n')+'\n';await open(text);await active();
      const r=await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.wrap='off';s.style.whiteSpace='pre';moye.sourcePresentation.refresh();return true;});await active();await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.scrollTop=380;s.scrollLeft=140;s.dispatchEvent(new Event('scroll'));});
      const d=await snapshot();assert.ok(d.stats.scrollTop>100);assert.ok(d.stats.scrollLeft>0);const position=await page.evaluate(()=>{const p=document.querySelector('.moye-source-paint');return {top:parseFloat(p.style.top),left:parseFloat(p.style.left)};});assert.equal(position.top,-d.stats.scrollTop);assert.equal(position.left,-d.stats.scrollLeft);assert.equal(d.paint.slice(0,-1),d.value);await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.wrap='soft';s.style.removeProperty('white-space');moye.sourcePresentation.refresh();});return {top:d.stats.scrollTop,left:d.stats.scrollLeft,paintPosition:position};
    });
    await probe('overlay glyph positions match the real native textarea across Chinese wrap, tabs and width changes',async()=>{
      const text='# Native alignment\n\n'+('中文 English 😀 mixed words\t字段\tvalue **bold** [link](dest) '.repeat(8))+'\n\n```js\n\tconst wide = 123;\n\t\treturn "中文";\n```\n'+Array.from({length:20},(_,i)=>`第${i}行 普通文本 与 English **强调**。`).join('\n')+'\n';
      await open(text);await active();const forced=await page.addStyleTag({content:'.moye-source-paint,.moye-source-paint *{color:rgb(40,50,45)!important;text-decoration:none!important;opacity:1!important}#editor textarea.vditor-sv:not(.moye-source-colorized){color:rgb(40,50,45)!important;-webkit-text-fill-color:rgb(40,50,45)!important;caret-color:transparent!important}'});const comparisons=[];
      try{for(const [index,width]of[1280,720,840].entries()){
        await page.setViewportSize({width,height:860});await apply({'appearance.monospaceFontFamily':'"Liberation Mono", "Noto Sans SC", monospace','editor.tabSize':index?8:2});await page.evaluate(horizontal=>{const s=moye.editor.vditor.sv.element;s.wrap=horizontal?'off':'soft';if(horizontal)s.style.whiteSpace='pre';else s.style.removeProperty('white-space');moye.sourcePresentation.refresh();},index===2);await active();await page.evaluate(horizontal=>{const s=moye.editor.vditor.sv.element;s.setSelectionRange(0,0);s.blur();s.scrollTop=80;s.scrollLeft=horizontal?120:0;s.dispatchEvent(new Event('scroll'));},index===2);
        const clip=await page.evaluate(()=>{const s=moye.editor.vditor.sv.element,r=s.getBoundingClientRect();return {x:r.left+s.clientLeft,y:r.top+s.clientTop,width:s.clientWidth,height:s.clientHeight};});
        await apply({'code.sourceHighlight':false});await page.evaluate(()=>moye.editor.vditor.sv.element.blur());const native=await page.screenshot({clip});
        await apply({'code.sourceHighlight':true});await active();await page.evaluate(()=>moye.editor.vditor.sv.element.blur());const colored=await page.screenshot({clip});const comparison=inkDifference(native,colored);
        await fs.writeFile(path.join(screenshots,`source-native-${width}.png`),native);await fs.writeFile(path.join(screenshots,`source-overlay-${width}.png`),colored);
        assert.ok(comparison.referenceInk>1000);assert.ok(comparison.mismatchRatio<=0.05,JSON.stringify(comparison));comparisons.push({width,...comparison});
      }}finally{await forced.evaluate(n=>n.remove());await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.wrap='soft';s.style.removeProperty('white-space');moye.sourcePresentation.refresh();});await page.setViewportSize({width:1280,height:860});}return comparisons;
    });
    await probe('focus line masks and typewriter padding remain aligned above source coloring',async()=>{
      await open(sample.repeat(8));await active();await apply({'editor.focusMode':true,'editor.typewriterMode':true});await page.evaluate(()=>{const s=moye.editor.vditor.sv.element;s.focus();s.setSelectionRange(50,50);moye.focus.refresh();});await active();await frames();
      const d=await page.evaluate(()=>{const s=moye.editor.vditor.sv.element,p=document.querySelector('.moye-source-paint'),m=document.querySelector('.moye-focus-source-mask'),o=document.querySelector('.moye-source-presentation');return {sourcePadding:getComputedStyle(s).paddingTop,paintPadding:getComputedStyle(p).paddingTop,maskVisible:!m.hidden,maskZ:Number(getComputedStyle(m).zIndex),paintZ:Number(getComputedStyle(o).zIndex),sourceValue:s.value,paintValue:p.textContent};});assert.equal(d.sourcePadding,d.paintPadding);assert.equal(d.maskVisible,true);assert.ok(d.maskZ>d.paintZ);assert.equal(d.sourceValue,d.paintValue.slice(0,-1));await page.screenshot({path:path.join(screenshots,'source-focus-typewriter.png')});await apply({'editor.focusMode':false,'editor.typewriterMode':false});return {padding:d.sourcePadding,maskAboveColoring:true};
    });
    await probe('active composition shows native text and does not replace the paint tree',async()=>{
      await open();await active();const r=await page.evaluate(()=>{const s=moye.editor.vditor.sv.element,p=document.querySelector('.moye-source-paint'),before=p.firstChild;s.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));moye.sourcePresentation.refresh();return {sameNode:p.firstChild===before,active:moye.sourcePresentation.stats().active,color:getComputedStyle(s).color,value:s.value};});assert.equal(r.sameNode,true);assert.equal(r.active,false);assert.notEqual(r.color,'rgba(0, 0, 0, 0)');await page.evaluate(()=>moye.editor.vditor.sv.element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'})));await active();assert.equal((await snapshot()).value,r.value);return {syntheticCompositionGuard:true,realOperatingSystemIMEUntested:true};
    });
    await probe('mode changes hide source paint and discard stale document jobs',async()=>{
      await open();await active();await page.evaluate(()=>moye.reading.setEnabled(true));assert.equal((await snapshot()).active,false);await page.evaluate(()=>moye.reading.setEnabled(false));await active();await page.evaluate(()=>moye.setMode('ir'));assert.equal((await snapshot()).active,false);
      await page.evaluate(()=>{moye.setMode('sv');const s=moye.editor.vditor.sv.element;s.value='# Old document\n'+('**old** line\n'.repeat(5000));s.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));moye.loadDocument({content:'# Latest\n\n新文档\n',name:'latest.md',documentId:'source-latest'});moye.setMode('sv');moye.sourcePresentation.refresh();});await active();await page.waitForTimeout(100);const d=await snapshot();assert.equal(d.value,'# Latest\n\n新文档\n');assert.equal(d.paint.slice(0,-1),d.value);assert.doesNotMatch(d.paint,/Old document/);return {latestDocumentOnly:true,stats:d.stats};
    });
    await probe('large source files and extreme lines fall back to readable native text',async()=>{
      for(const [content,reason]of[['# Large\n'+('plain text\n'.repeat(19000)),'large-document'],['# Heading\n'+('x'.repeat(21000)),'long-line']]){await open(content);await page.waitForTimeout(120);const d=await snapshot();assert.equal(d.active,false);assert.equal(d.stats.fallback,reason);assert.notEqual(d.sourceColor,'rgba(0, 0, 0, 0)');assert.equal(d.value,content);}return {largeAndLongLineReadable:true,sourceUnchanged:true};
    });
    await probe('source markup stays literal and overlay spans do not create executable DOM',async()=>{
      const content='# Safe\n\n`<script>alert(1)</script>` **<img onerror=alert(1)>** [label](javascript:alert(1))\n';await open(content);await active();const d=await page.evaluate(()=>({value:moye.editor.vditor.sv.element.value,paint:document.querySelector('.moye-source-paint').textContent,dangerous:document.querySelector('.moye-source-paint').querySelectorAll('script,img,[onerror]').length}));assert.equal(d.value,content);assert.equal(d.paint.slice(0,-1),content);assert.equal(d.dangerous,0);return {literalOnly:true};
    });
    await probe('forced-colors accessibility keeps native text visible',async()=>{
      await open();await active();await page.emulateMedia({forcedColors:'active'});await frames();const d=await snapshot();assert.equal(d.active,false);assert.equal(d.stats.fallback,'forced-colors');assert.notEqual(d.sourceColor,'rgba(0, 0, 0, 0)');await page.emulateMedia({forcedColors:'none'});await active();return {nativeForcedColors:true};
    });
    report.remoteRequests=await app.evaluate(({app})=>app.moyeSourceRequests);report.pass=report.results.every(x=>x.status==='pass')&&!report.pageErrors.length&&!report.remoteRequests.length;
  }catch(error){report.pass=false;report.fatalError=error.stack||error.message;}
  finally{if(app){const child=app.process(),exited=child.exitCode===null?new Promise(resolve=>child.once('exit',resolve)):Promise.resolve();await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await exited;}await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100});await fs.writeFile(path.resolve(process.env.MOYE_SOURCE_PRESENTATION_OUTPUT||path.join(root,'tests/source-presentation-report.json')),JSON.stringify(report,null,2));}
  console.log(JSON.stringify(report,null,2));if(!report.pass)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1});
