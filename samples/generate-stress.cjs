#!/usr/bin/env node
'use strict';

// Run: node samples/generate-stress.cjs [output.md]
// Reproducible fixture: exactly 100,000 Han characters, 100 code blocks,
// and 20 references to one packaged local image. ASCII markers are additional.
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(process.argv[2] || path.join(__dirname, '长文性能验收.md'));
const imageSource = path.join(__dirname, 'assets', '书写 测试.svg');
const assetDir = path.join(path.dirname(output), 'assets');
fs.mkdirSync(assetDir, {recursive: true});
const imageDest = path.join(assetDir, '书写 测试.svg');
if (path.resolve(imageSource) !== path.resolve(imageDest)) fs.copyFileSync(imageSource, imageDest);

// All characters in this body are Han characters. 100 sections × 1,000 = 100,000.
const seed = '写作需要安静也需要清楚的结构反复编辑能帮助我们发现问题并逐步整理自己的想法';
const body = seed.repeat(Math.ceil(1000 / seed.length)).slice(0, 1000);
const blocks = ['# Stress fixture', '', '100000 Han characters / 100 code blocks / 20 local image references.', ''];
for (let i = 0; i < 100; i++) {
  blocks.push(`## Section ${String(i + 1).padStart(3, '0')}`, '', body, '',
    '```csharp', `var section = ${i + 1};`, 'Console.WriteLine(section);', '```', '');
  if (i % 5 === 0) blocks.push(`![Image ${i / 5 + 1}](assets/书写%20测试.svg)`, '');
}
const markdown = blocks.join('\n');
const hanCount = (markdown.match(/\p{Script=Han}/gu) || []).length;
// The image filename includes Han characters, so exclude path references when counting body.
const bodyCount = 100 * (body.match(/\p{Script=Han}/gu) || []).length;
fs.writeFileSync(output, markdown, 'utf8');
console.log(JSON.stringify({output, bytes: Buffer.byteLength(markdown), hanBodyCharacters: bodyCount,
  hanCharactersIncludingImagePaths: hanCount, codeBlocks: 100, imageReferences: 20}, null, 2));
