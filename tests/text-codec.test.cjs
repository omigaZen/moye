'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decodeText, encodeText } = require('../electron/text-codec.cjs');
const { DocumentStore, decodeMarkdown, encodeMarkdown } = require('../electron/file-store.cjs');
test('known UTF16 BOM fixtures decode both byte orders and preserve CRLF',()=>{
 for(const [hex,id] of [['fffe2d4e87650d000a00','utf-16le'],['feff4e2d6587000d000a','utf-16be']]){
  const bytes=Buffer.from(hex,'hex'),v=decodeMarkdown(bytes);assert.equal(v.content,'中文\n');assert.equal(v.encoding,id);assert.equal(v.bom,true);assert.deepEqual(encodeMarkdown(v.content,v),bytes);
 }
});
test('legacy known bytes use explicit correct decoding and automatic GB18030 is identified as a guess',()=>{
 for(const [hex,id,text]of [['d6d0cec4','gb18030','中文'],['a4a4a4e5','big5','中文'],['93fa967b8cea','shift_jis','日本語'],['c7d1b1db','euc-kr','한글']]){
  const v=decodeText(Buffer.from(hex,'hex'),{encoding:id});assert.equal(v.text,text);assert.equal(v.encodingGuessed,false);assert.deepEqual(encodeText(text,{encoding:id}),Buffer.from(hex,'hex'));
 }
 const guessed=decodeText(Buffer.from('d6d0cec4','hex'));assert.equal(guessed.text,'中文');assert.equal(guessed.encodingGuessed,true);assert.match(guessed.warning,/推测/);
});
test('GB18030 roundtrips supplementary Unicode and multilingual edits',()=>{
 const text='中文 日本語 한글 😀 𠮷\n';const bytes=encodeText(text,{encoding:'gb18030'});assert.equal(decodeText(bytes,{encoding:'gb18030'}).text,text);
});
test('legacy saves reject unrepresentable characters instead of question mark replacement',()=>{
 for(const id of ['big5','shift_jis','euc-kr'])assert.throws(()=>encodeText('a😀b',{encoding:id}),/不能无损/);
 assert.throws(()=>encodeText('\ud800',{encoding:'utf-8'}),/代理字符/);
 assert.throws(()=>decodeText(Buffer.from([0xff,0xfe,0x00])),/UTF-8/);
 assert.throws(()=>decodeText(Buffer.from('binary\0')),/二进制/);
});
test('DocumentStore preserves original legacy bytes and requires confirmation before saving guessed edits',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md');const original=Buffer.from('d6d0cec40d0a','hex');await fs.writeFile(file,original);const s=new DocumentStore();let payload=await s.open(file);assert.equal(payload.encodingId,'gb18030');assert.equal(payload.encodingGuessed,true);await s.save(payload.content);assert.deepEqual(await fs.readFile(file),original);await assert.rejects(s.save('中文修改\n'),{code:'ENCODING_CONFIRMATION'});assert.deepEqual(await fs.readFile(file),original);s.confirmEncoding();await s.save('中文修改\n');assert.equal(decodeText(await fs.readFile(file),{encoding:'gb18030'}).text,'中文修改\r\n');
});
test('failed legacy edit save leaves file and DocumentStore original intact, explicit UTF8 conversion writes new encoding',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md');const original=Buffer.from('a4a4a4e5','hex');await fs.writeFile(file,original);const s=new DocumentStore();await s.open(file,{encoding:'big5'});await assert.rejects(s.save('中文😀'),/不能无损/);assert.deepEqual(await fs.readFile(file),original);assert.equal(s.originalContent,'中文');s.setEncoding('utf-8');await s.save('中文😀');assert.deepEqual(await fs.readFile(file),Buffer.from('中文😀'));assert.equal(s.payload(s.originalContent).encoding,'UTF-8');
});
test('no-change save with explicitly converted encoding does not reuse old bytes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md');await fs.writeFile(file,Buffer.from('fffe2d4e8765','hex'));const s=new DocumentStore();await s.open(file);s.setEncoding('utf-8');await s.save('中文');assert.deepEqual(await fs.readFile(file),Buffer.from('中文'));assert.equal(s.originalEncoding,'utf-8');
});
test('explicit per-file encoding survives a new store without storing a filename or source',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'private-personal-notes.md'),encodingMemoryPath=path.join(dir,'profile','document-encodings.json');await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));
 const first=new DocumentStore({encodingMemoryPath});assert.equal((await first.open(file,{encoding:'big5'})).content,'中文');const raw=await fs.readFile(encodingMemoryPath,'utf8'),stored=JSON.parse(raw);assert.equal(stored.entries.length,1);assert.equal(stored.entries[0].encoding,'big5');assert.match(stored.entries[0].key,/^[a-f0-9]{64}$/);assert.ok(!raw.includes('private-personal')&&!raw.includes(dir)&&!raw.includes('中文'));
 const second=new DocumentStore({encodingMemoryPath});const opened=await second.open(file);assert.equal(opened.encodingId,'big5');assert.equal(opened.content,'中文');assert.equal(opened.encodingGuessed,false);assert.equal(opened.encodingRemembered,true);
 await second.open(file,{encoding:'gb18030'});const third=new DocumentStore({encodingMemoryPath});assert.equal((await third.open(file)).encodingId,'gb18030');
});
test('BOM takes priority over remembered encoding, while an explicit manual selection remains explicit',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md'),encodingMemoryPath=path.join(dir,'memory.json');await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));const first=new DocumentStore({encodingMemoryPath});await first.open(file,{encoding:'big5'});await fs.writeFile(file,encodeText('BOM 中文',{encoding:'utf-16be',bom:true}));const fresh=new DocumentStore({encodingMemoryPath});const opened=await fresh.open(file);assert.equal(opened.encodingId,'utf-16be');assert.equal(opened.encodingRemembered,false);assert.equal(opened.content,'BOM 中文');
 await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));assert.equal((await fresh.open(file,{encoding:'gb18030'})).encodingId,'gb18030');
});
test('a guessed encoding is never remembered until confirmation and an abandoned conversion does not replace the disk encoding',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md'),encodingMemoryPath=path.join(dir,'memory.json');await fs.writeFile(file,Buffer.from('d6d0cec4','hex'));const first=new DocumentStore({encodingMemoryPath});const opened=await first.open(file);assert.equal(opened.encodingGuessed,true);await first.save(opened.content);await assert.rejects(fs.access(encodingMemoryPath),{code:'ENOENT'});
 await first.confirmEncoding();let fresh=new DocumentStore({encodingMemoryPath});assert.equal((await fresh.open(file)).encodingRemembered,true);first.setEncoding('utf-8');fresh=new DocumentStore({encodingMemoryPath});assert.equal((await fresh.open(file)).encodingId,'gb18030');await first.save('中文');fresh=new DocumentStore({encodingMemoryPath});assert.equal((await fresh.open(file)).encodingId,'utf-8');assert.equal((await fresh.open(file)).content,'中文');
});
test('failed legacy conversion cannot persist its unsaved target and Save As remembers the actual target encoding',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md'),copy=path.join(dir,'copy.txt'),encodingMemoryPath=path.join(dir,'memory.json');await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));const first=new DocumentStore({encodingMemoryPath});await first.open(file,{encoding:'big5'});first.setEncoding('shift_jis');await assert.rejects(first.save('中文😀'),/不能无损/);assert.equal((await new DocumentStore({encodingMemoryPath}).open(file)).encodingId,'big5');first.setEncoding('utf-16le');await first.save('中文',copy);const reopened=await new DocumentStore({encodingMemoryPath}).open(copy);assert.equal(reopened.encodingId,'utf-16le');assert.equal(reopened.encoding,'UTF-16 LE BOM');assert.equal(reopened.content,'中文');
});
test('encoding memory is bounded, treats malformed configuration as recoverable and can be disabled',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md'),encodingMemoryPath=path.join(dir,'memory.json');await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));const entries=Array.from({length:256},(_,i)=>({key:i.toString(16).padStart(64,'0'),encoding:'utf-8',usedAt:i}));await fs.writeFile(encodingMemoryPath,JSON.stringify({version:1,entries}));await new DocumentStore({encodingMemoryPath}).open(file,{encoding:'big5'});let stored=JSON.parse(await fs.readFile(encodingMemoryPath,'utf8'));assert.equal(stored.entries.length,256);assert.ok(!stored.entries.some(entry=>entry.key==='0'.repeat(64)));
 await fs.writeFile(encodingMemoryPath,'{"version":1,"entries":[{"key":"invalid"}]}');const broken=new DocumentStore({encodingMemoryPath});assert.match((await broken.open(file)).encodingWarning,/编码/);assert.equal((await broken.open(file)).encodingGuessed,true);await broken.open(file,{encoding:'big5'});stored=JSON.parse(await fs.readFile(encodingMemoryPath,'utf8'));assert.equal(stored.entries.length,1);assert.equal((await new DocumentStore().open(file)).encodingGuessed,true);
});
test('discarding a pending conversion reloads the original disk encoding without confirming an earlier guess',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moye-codec-memory-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'note.md'),encodingMemoryPath=path.join(dir,'memory.json');await fs.writeFile(file,Buffer.from('a4a4a4e5','hex'));const store=new DocumentStore({encodingMemoryPath});await store.open(file,{encoding:'big5'});store.setEncoding('utf-8');assert.equal(store.encoding,'utf-8');assert.equal(store.originalEncoding,'big5');let reloaded=await store.open(file,{encoding:store.originalEncodingGuessed?'auto':store.originalEncoding,rememberEncoding:false});assert.equal(reloaded.content,'中文');assert.equal(reloaded.encodingId,'big5');
 const guessedFile=path.join(dir,'unconfirmed.md');await fs.writeFile(guessedFile,Buffer.from('d6d0cec4','hex'));await store.open(guessedFile);assert.equal(store.originalEncodingGuessed,true);store.setEncoding('utf-16le');assert.equal(store.encodingGuessed,false);assert.equal(store.originalEncodingGuessed,true);reloaded=await store.open(guessedFile,{encoding:store.originalEncodingGuessed?'auto':store.originalEncoding,rememberEncoding:false});assert.equal(reloaded.encodingGuessed,true);assert.equal(reloaded.content,'中文');await store.confirmEncoding();assert.equal(store.originalEncodingGuessed,false);
});
