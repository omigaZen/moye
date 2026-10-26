'use strict';
// Actual Electron range/highlight regressions; not a Typora-equivalence claim.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
async function main() {
  const root = path.resolve(__dirname, '..'), work = await fs.mkdtemp(path.join(os.tmpdir(), 'moye-autolinks-'));
  const results = [], pageErrors = []; let app, page;
  async function probe(name, fn) { try { const details = await fn(); results.push({name,status:'pass',details}); } catch(error) { results.push({name,status:'fail',error:error.stack||error.message}); } }
  try {
    app = await electron.launch({executablePath:require('electron'),args:[...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless']:[]),path.join(root,'electron/main.cjs')],env:{...process.env,MOYE_TEST:'1',MOYE_TEST_USER_DATA:path.join(work,'profile')}});
    page = await app.firstWindow(); page.on('pageerror', e => pageErrors.push(e.message));
    await page.route(/^https?:/, r => r.abort()); await page.setViewportSize({width:1280,height:860});
    await page.waitForFunction(() => window.moye?.ready && window.MoyeAutoLinks, null, {timeout:25000}); await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.moye.autoLinks?.destroy();
      window.moye.autoLinks?.destroy();
      const host=document.createElement('div'); host.id='autolink-fixture'; host.contentEditable='true';
      Object.assign(host.style,{position:'fixed',left:'30px',top:'90px',width:'1100px',height:'300px',background:'white',color:'black',zIndex:99999,fontSize:'18px'});
      host.innerHTML='<p>Visit https://example.com/a_(b). Mail x@example.com and www.example.com</p><p><a href="https://explicit.example.com">https://explicit.example.com</a> <span data-type="a">https://span.example.com</span> <code>https://code.example.com</code> <span data-type="inline-math">https://math.example.com</span> <span class="vditor-ir__marker">https://marker.example.com</span></p>';
      document.body.append(host); host.focus(); const first=host.querySelector('p').firstChild, r=document.createRange();r.setStart(first,0);r.setEnd(first,5);getSelection().removeAllRanges();getSelection().addRange(r);
      const probe=window.__autolink={host,enabled:true,composing:false,opened:[],before:host.innerHTML,selection:getSelection().toString(),parseCalls:0};
      probe.controller=MoyeAutoLinks.create({element:host,isEnabled:()=>probe.enabled,isComposing:()=>probe.composing,onOpen:url=>probe.opened.push(url),lute:{New(){const lute=Lute.New(), original=lute.RenderJSON.bind(lute);lute.RenderJSON=text=>{probe.parseCalls++;return original(text)};return lute;}}});
    });
    await probe('overlay accepts normal-parser URLs and excludes explicit links/code/math/markers without DOM or selection changes', async()=>{
      const r=await page.evaluate(()=>{const p=__autolink;return{htmlUnchanged:p.before===p.host.innerHTML,selection:getSelection().toString(),expectedSelection:p.selection,highlight:CSS.highlights.has('moye-autolink'),links:p.controller.getLinks().map(l=>({url:l.url,text:l.text,rangeText:l.range.toString()}))}});
      assert.equal(r.htmlUnchanged,true);assert.equal(r.selection,r.expectedSelection);assert.equal(r.highlight,true);assert.deepEqual(r.links.map(l=>l.url),['https://example.com/a_(b)','mailto:x@example.com','http://www.example.com']);assert.ok(r.links.every(l=>l.text===l.rangeText));return r;
    });
    await probe('only modified URLs reparse, candidate-free long prose bypasses Lute',async()=>{
      const r=await page.evaluate(()=>{const p=__autolink,before=p.parseCalls;p.controller.refresh();const cached=p.parseCalls-before;const text=document.createTextNode('中文长文'.repeat(25000));p.host.append(text);p.controller.refresh();return{cached,extraParseCalls:p.parseCalls-before,textLength:text.length}});assert.equal(r.cached,0);assert.equal(r.extraParseCalls,0);return r;
    });
    await probe('Ctrl click follows URL through callback and ordinary click leaves it editable', async()=>{
      const point=await page.evaluate(()=>{const r=__autolink.controller.getLinks()[0].range.getClientRects()[0];return{x:r.x+r.width/2,y:r.y+r.height/2}});
      await page.mouse.click(point.x,point.y);assert.equal(await page.evaluate(()=>__autolink.opened.length),0);
      await page.keyboard.down('Control');await page.mouse.click(point.x,point.y);await page.keyboard.up('Control');assert.deepEqual(await page.evaluate(()=>__autolink.opened),['https://example.com/a_(b)']);
      const immediate=await page.evaluate(()=>{
        const p=__autolink,rect=p.controller.getLinks()[0].range.getClientRects()[0];
        // Mutate in document capture, before this same real mouse click reaches
        // the editor. No 120ms observer timer can run inside that event stack.
        document.addEventListener('click',()=>{
          p.host.querySelector('p').firstChild.data='Visit https://fresh.example.org/new';
          p.immediateHTML=p.host.innerHTML;p.cachedURLAtEdit=p.controller.getLinks()[0].url;
        },{capture:true,once:true});
        return{x:rect.left+5,y:rect.top+rect.height/2};
      });
      await page.keyboard.down('Control');await page.mouse.click(immediate.x,immediate.y);await page.keyboard.up('Control');
      const fresh=await page.evaluate(()=>({opened:__autolink.opened,cachedURLAtEdit:__autolink.cachedURLAtEdit,htmlUnchanged:__autolink.immediateHTML===__autolink.host.innerHTML}));
      assert.equal(fresh.cachedURLAtEdit,'https://example.com/a_(b)');assert.equal(fresh.opened.at(-1),'https://fresh.example.org/new');assert.equal(fresh.htmlUnchanged,true);
      return{callbackOnly:true,immediateEditedURL:fresh.opened.at(-1),staleCachedURLBeforeClick:fresh.cachedURLAtEdit,rawDOMPreserved:fresh.htmlUnchanged};
    });
    await probe('disabled clears highlights and composition defers refresh until commit',async()=>{
      const r=await page.evaluate(()=>{const p=__autolink;p.enabled=false;p.controller.refresh();const disabled=p.controller.getLinks().length===0&&!CSS.highlights.has('moye-autolink');p.enabled=true;p.controller.refresh();p.composing=true;p.host.querySelector('p').firstChild.data='https://changed.example.org/path';p.controller.refresh();const during=p.controller.getLinks().map(l=>l.url);p.composing=false;p.controller.refresh();return{disabled,during,after:p.controller.getLinks().map(l=>l.url)}});assert.equal(r.disabled,true);assert.equal(r.during[0],'https://fresh.example.org/new');assert.deepEqual(r.after,['https://changed.example.org/path']);return r;
    });
    await probe('debounced observer follows text edits and destroy removes its overlay',async()=>{
      await page.evaluate(()=>{__autolink.host.querySelector('p').firstChild.data='https://observer.example.org/new';});
      await page.waitForFunction(()=>__autolink.controller.getLinks()[0]?.url==='https://observer.example.org/new');
      const r=await page.evaluate(()=>{const p=__autolink;p.controller.destroy();return{links:p.controller.getLinks().length,highlight:CSS.highlights.has('moye-autolink'),text:p.host.querySelector('p').textContent}});assert.equal(r.links,0);assert.equal(r.highlight,false);return r;
    });
  } finally { if(app) await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{}); }
  const report={generatedAt:new Date().toISOString(),purpose:'Moye autolink overlay regressions, not Typora equivalence proof',results,pageErrors};await fs.writeFile(path.join(root,'tests/autolinks-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(results.some(r=>r.status!=='pass')||pageErrors.length)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1});
