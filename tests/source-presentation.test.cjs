'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize, limits } = require('../src/source-presentation.js');
function pieces(text) { const parsed=tokenize(text);assert.equal(parsed.fallback,null);return parsed.tokens.map(token=>({type:token.type,text:text.slice(token.start,token.end),start:token.start,end:token.end})); }
test('source lexer distinguishes headings, emphasis, links and fenced literal code',()=>{
 const text='# 标题 **强调**\n\n*italic* [链接](path/a(b).md)\n```js\n**literal** [x](y)\n```\n';const p=pieces(text);
 assert.ok(p.some(x=>x.type==='heading'&&x.text==='标题 '));assert.ok(p.some(x=>x.type==='strong'&&x.text==='**强调**'));assert.ok(p.some(x=>x.type==='emphasis'&&x.text==='*italic*'));assert.ok(p.some(x=>x.type==='link'&&x.text==='[链接](path/a(b).md)'));assert.ok(p.some(x=>x.type==='code'&&x.text==='**literal** [x](y)'));assert.equal(p.filter(x=>x.type==='fence').length,2);
});
test('source tokens are ordered UTF16 ranges and preserve every original byte when reconstructed',()=>{
 const text='---\r\nname: 中文\r\n---\r\n# 😀 标题\r\n\ttext **bold** _斜体_ ~~删除~~ ==高亮== `a < b`\r\n';const p=pieces(text);let previous=0,out='';for(const token of p){assert.ok(token.start>=previous);assert.ok(token.end>token.start);out+=text.slice(previous,token.start)+text.slice(token.start,token.end);previous=token.end;}out+=text.slice(previous);assert.equal(out,text);assert.equal(p.filter(x=>x.type==='meta').length,3);
});
test('source escaped delimiters and inline code are not interpreted as active formatting',()=>{
 const p=pieces('\\*literal\\* and `**code** [x](y)` and \\[label](dest)\n');assert.equal(p.filter(x=>x.type==='strong'||x.type==='emphasis'||x.type==='link').length,0);assert.ok(p.some(x=>x.type==='code'));
 assert.equal(pieces('file_name_value and **unfinished\\*\n').filter(x=>x.type==='strong'||x.type==='emphasis').length,0);
});
test('source fence lengths and characters are respected',()=>{
 const p=pieces('````md\n```\n# literal\n````\n### heading\n~~~\n# other\n~~~\n');assert.equal(p.filter(x=>x.type==='fence').length,4);assert.ok(p.some(x=>x.type==='code'&&x.text==='# literal'));assert.ok(p.some(x=>x.type==='heading'&&x.text==='heading'));
});
test('source safety budgets return plain-text fallback without partial token results',()=>{
 for(const [text,options,reason]of[['x'.repeat(limits.maxChars+1),{},'large-document'],['x'.repeat(limits.maxLine+1),{},'long-line'],['**a** **b**\n',{maxTokens:1},'token-budget']]){const r=tokenize(text,options);assert.equal(r.fallback,reason);assert.deepEqual(r.tokens,[]);}
});
test('source lexer checks its deadline inside unfinished nested links and discards partial tokens',()=>{
 let checks=0;const text='# Already colored\n'+'[x]('.repeat(4999);
 const result=tokenize(text,{now:()=>checks++,maxDurationMs:4});
 assert.equal(result.fallback,'time-budget');assert.deepEqual(result.tokens,[]);assert.equal(checks,6);
});
test('source empty and plain text do not need a redundant overlay',()=>{assert.deepEqual(tokenize(''),{tokens:[],fallback:null});assert.deepEqual(tokenize('纯文本 😀\n第二行\n'),{tokens:[],fallback:null});assert.equal(pieces('---\nplain paragraph\n')[0].type,'marker');});
