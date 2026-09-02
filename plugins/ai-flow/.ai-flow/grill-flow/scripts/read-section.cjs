#!/usr/bin/env node
// 切一段文档出来，**图案失配就非零退出**。
//
// 存在的唯一理由：`awk '/^- \[ \] T40 /,/^  - Touches:/' tickets.md` 这类图案会随文档变化
// 而失配，而失配时 awk/grep 给的是空输出 + 退出码 0 —— 读的人看不出「这一节没有」和
// 「图案漂了」的区别。实测同族事故 4 次：票一勾选 `- [ ]` 变 `- [x]` 图案零命中 ·
// `ledger.md` 表格行编号只到 N34 导致 `^| N45 ` 取不到 · `sed -n '1,95p'` 截断把整节切出范围外。
//
// 用法：
//   node read-section.cjs <file> <start-re> [end-re]
//     只给 start-re      → 取所有匹配的行（grep 语义）
//     给了 end-re        → 取 start 那行到 end 那行之间（含 start、不含 end，awk 范围语义）
//     end-re 写 `EOF`    → 明确表示「从 start 取到文件尾」，不检查结束图案
//   退出码：0 有内容 · 1 图案失配（start 零命中，或 end 给了却没出现）· 2 用法错 / 文件读不到
const [file, startRe, endRe] = process.argv.slice(2);
if (!file || !startRe) {
  console.error('用法: read-section.cjs <file> <start-re> [end-re|EOF]');
  process.exit(2);
}
let lines;
try {
  lines = require('fs').readFileSync(file, 'utf8').split('\n');
} catch (e) {
  console.error(`读不到 ${file}: ${e.message}`);
  process.exit(2);
}
const start = new RegExp(startRe);
const rangeMode = endRe !== undefined && endRe !== '';
const wantEof = endRe === 'EOF';
const end = rangeMode && !wantEof ? new RegExp(endRe) : null;

let out = [];
let closed = false;
if (!rangeMode) {
  out = lines.filter((l) => start.test(l));
} else {
  let on = false;
  for (const l of lines) {
    if (!on) {
      if (start.test(l)) on = true;
    } else if (end && end.test(l)) {
      closed = true;
      break;
    }
    if (on) out.push(l);
  }
}

if (out.length === 0) {
  console.error(
    `零命中：${file} 里没有匹配 /${startRe}/ 的行。\n` +
    `图案很可能已经漂了 —— ⛔ 别把空输出当成「这一节不存在」，去文件里确认真实标题再改图案。`
  );
  process.exit(1);
}

// end 给了却一次没命中 = 同一类静默失配，只是表现相反：不是空输出，而是把「起始行到文件尾」
// 整片当成了那一节。⛔ 不能只报 start 那一半，否则这个封装挡不住它本来要挡的另一半。
if (end && !closed) {
  console.error(
    `结束图案没命中：/${endRe}/ 在 ${file} 里没出现，取到的是「起始行到文件尾」共 ${out.length} 行，\n` +
    `可能远超你要的范围。去文件里确认真实的结束标题；若本来就要取到文件尾，把结束图案写成 EOF。`
  );
  console.log(out.join('\n'));
  process.exit(1);
}

console.log(out.join('\n'));
