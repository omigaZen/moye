'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateExportOptions,validateImageDimensions,resourceAllowed,buildExportHtml,pageGeometry }=require('../electron/export-service.cjs');
test('export settings reject unknown, nonfinite, undersized and unsupported values',()=>{assert.equal(validateExportOptions().format,'pdf');for(const value of [{width:NaN},{width:399},{width:4097},{scale:4},{format:'svg'},{paperSize:'whatever'},{marginMm:Infinity},{destination:'/secret'}])assert.throws(()=>validateExportOptions(value));assert.equal(validateExportOptions({format:'png',width:400,scale:3,theme:'current'}).width,400);});
test('full-document image limits are explicit before allocation',()=>{assert.deepEqual(validateImageDimensions(400,1000,2),{width:800,height:2000,pixels:1600000});for(const dims of [[0,1,1],[4096,20000,3],[1000,40000,1],[Infinity,100,1]])assert.throws(()=>validateImageDimensions(...dims));});
test('export resources require canonical image/font/style under approved roots',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'moye-export-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const a=path.join(root,'app'),d=path.join(root,'doc'),out=path.join(root,'outside');await Promise.all([fs.mkdir(a),fs.mkdir(d),fs.mkdir(out)]);await fs.writeFile(path.join(d,'photo.png'),'image');await fs.writeFile(path.join(out,'secret.png'),'secret');await fs.symlink(path.join(out,'secret.png'),path.join(d,'link.png'));const scope={appRoot:a,documentRoot:d};assert.equal(await resourceAllowed(pathToFileURL(path.join(d,'photo.png')).href,scope),true);assert.equal(await resourceAllowed(pathToFileURL(path.join(d,'link.png')).href,scope),false);assert.equal(await resourceAllowed('https://example.com/tracker.png',scope),false);assert.equal(await resourceAllowed('file:///etc/passwd',scope),false);assert.equal(await resourceAllowed('data:text/html;base64,AAAA',scope),false);assert.equal(await resourceAllowed('data:image/png;base64,AAAA',scope),true);});
test('export wrapper preserves passive formula SVG and adds print constraints',()=>{const html=buildExportHtml({html:'<h1>Title</h1><svg><path d="M0 0"/></svg><table><thead><tr><th>A</th></tr></thead></table>',title:'<unsafe>',options:{format:'pdf'}});assert.match(html,/script-src 'none'/);assert.match(html,/&lt;unsafe&gt;/);assert.match(html,/table-header-group/);assert.match(html,/widows:3/);assert.match(buildExportHtml({html:'<svg><foreignObject><div>Diagram label</div></foreignObject></svg>'}),/Diagram label/);for(const source of ['<script>x</script>','<img onerror="x">','<iframe src="file:///etc/passwd">','<a href="javascript:alert(1)">x</a>'])assert.throws(()=>buildExportHtml({html:source}),/活动内容/);assert.throws(()=>buildExportHtml({html:'x',baseUrl:'https://example.com'}),/资源目录/);});

test('printable geometry reserves margins and swaps landscape dimensions for each paper',()=>{
  assert.deepEqual(pageGeometry(),{widthMm:210,heightMm:297,contentWidthMm:180,contentHeightMm:267});
  assert.deepEqual(pageGeometry({paperSize:'A5',landscape:true,marginMm:20}),{widthMm:210,heightMm:148,contentWidthMm:170,contentHeightMm:108});
  const letter=pageGeometry({paperSize:'Letter',marginMm:8});assert.ok(Math.abs(letter.contentWidthMm-199.9)<1e-9);assert.ok(Math.abs(letter.contentHeightMm-263.4)<1e-9);
  assert.throws(()=>pageGeometry({paperSize:'Unknown'}));assert.throws(()=>pageGeometry({marginMm:80}));
});
