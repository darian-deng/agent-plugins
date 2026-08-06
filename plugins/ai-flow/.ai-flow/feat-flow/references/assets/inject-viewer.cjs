#!/usr/bin/env node
// feat-flow 查看器资产注入 — 同源副本在 plugins/ai-flow/.ai-flow/grill-flow/references/assets/inject-viewer.cjs，改动两边必须同步。
// 用法：node <此脚本> <tech-design.html 绝对路径>
// 作用：把 references/assets/viewer.css / viewer.js 的内容替换进 HTML 骨架里的
//       <!--VIEWER_CSS--> / <!--VIEWER_JS--> 两个占位锚点。
'use strict';

const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

// 几条实现缘由（都是踩过的坑，改这个脚本前先读）：
// 1. 为什么不用 `sed`：viewer.js 是压缩过的，含 20 处 `/`（撞 sed 默认分隔符）与 `&`
//    （sed 替换串里的 `&` 会被展开成「整个匹配」）；viewer.css 还含 `/*`。换分隔符 +
//    逐个转义只要漏一处，注进去的脚本就被**静默**改坏——不报错、页面照常打开，
//    只是点「全屏」没反应。
// 2. 为什么用 `split().join()` 而不是 `replace` / 正则：`replace` 的替换串里 `$&`、
//    `$1`、`$$` 是特殊语法，会把资产内容里的这些字符当模板展开，二次踩同一个坑。
//    `split().join()` 是纯字面量替换，资产内容原样进去。
// 3. 为什么锚点缺失要抛错：静默跳过 = 查看器失效但页面照常打开，没人会发现。
//    写盘在循环之后，任一锚点缺失都不会留下半注入的 HTML。
// 4. 资产路径从 `__dirname` 解析而非 cwd：调用方的工作目录不保证。

// 5. 为什么住在 references/assets/ 而不是 scripts/：引擎的 Bash 守卫按**路径片段**拦截
//    `.ai-flow/<flow>/scripts`（见 src/lib/pretool-handler.ts 的 cpFragments，其 deny 文案
//    明写 "matching is by path fragment, so this covers reads too"）。放 scripts/ 下则 AI
//    连 `node .../scripts/inject-viewer.cjs` 都会被 deny，注入这一步永远跑不了。

const ANCHORS = [
  ['<!--VIEWER_CSS-->', 'viewer.css'],
  ['<!--VIEWER_JS-->', 'viewer.js'],
];

const htmlPath = process.argv[2];
if (!htmlPath) {
  process.stderr.write('用法: node inject-viewer.cjs <tech-design.html 绝对路径>\n');
  process.exit(1);
}

const assetsDir = __dirname;   // 本脚本与资产同目录

let html = readFileSync(htmlPath, 'utf8');
for (const [anchor, assetFile] of ANCHORS) {
  if (!html.includes(anchor)) {
    throw new Error('锚点缺失(骨架没留或已被覆盖): ' + anchor);
  }
  const asset = readFileSync(join(assetsDir, assetFile), 'utf8');
  html = html.split(anchor).join(asset);
}
writeFileSync(htmlPath, html);
console.log('viewer assets injected: ' + htmlPath);
