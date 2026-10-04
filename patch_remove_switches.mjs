import { readFileSync, writeFileSync } from 'fs';

const file = 'components/ensemble/ensemble-app.tsx';
let c = readFileSync(file, 'utf8');

// 1. 删除两个 toggle 按钮（从「{/* 是否启用旁白 */}」到 </button> 后的空行）
// 找旁白 toggle 开始
const narrToggleStart = c.indexOf('{/* 是否启用旁白');
if (narrToggleStart < 0) { console.error('NARR_TOGGLE_NOT_FOUND'); process.exit(1); }

// 找双语 toggle 结束（下一个 </button> 后的两个换行）
const biToggleEnd = c.indexOf('</button>', c.indexOf('双语语言格式', narrToggleStart));
if (biToggleEnd < 0) { console.error('BI_TOGGLE_END_NOT_FOUND'); process.exit(1); }
// 往前推到行首（保留缩进）
const lineStart = c.lastIndexOf('\\n', narrToggleStart) + 1;
// 往后推到 </button> 后两个换行
const blockEnd = c.indexOf('\\n\\n', biToggleEnd) + 2;

const oldToggles = c.slice(lineStart, blockEnd);
c = c.slice(0, lineStart) + c.slice(blockEnd);
console.log('TOGGLES_DELETED');

// 2. 把 narrationEnabled 和 bilingualEnabled 的读取处改为恒 true
// script.narrationEnabled → true (恒开)
// script.bilingualEnabled → true (恒开)
// 但保留 DB 字段（不改存储结构，只是读的时候恒返回 true）

// ① narrationBlock 判断已在第一步改过（删开关），跳过
// ② bilingualBlock 判断已在第一步改过（删开关），跳过
// ③ EnsembleFrameStream 渲染处的 narrationEnabled prop
//    找到 framesOfTurn(turn, cast, narrationEnabled = false)
const framesCallPattern = /framesOfTurn\(([^,]+),\s*([^,]+),\s*script\.narrationEnabled\)/g;
c = c.replace(framesCallPattern, 'framesOfTurn($1, $2, true)');
console.log('framesOfTurn_FIXED');

// ④ EnsembleFrameStream 组件内的 narrationEnabled 判断
//    if (narrationEnabled !== true) return null; → 删掉此判断，旁白始终渲染
const narrCheckPattern = /if \(narrationEnabled !== true\) \{[^}]*return null;[^}]*\}/g;
c = c.replace(narrCheckPattern, '// narrationEnabled 恒 true，旁白始终渲染');
console.log('narrationEnabled_CHECK_REMOVED');

// ⑤ TriColorText 渲染时传 bilingual prop → 恒 true
//    bilingual={script.bilingualEnabled} → bilingual={true}
c = c.replace(/bilingual=\{script\.bilingualEnabled\}/g, 'bilingual={true}');
console.log('bilingual_PROP_FIXED');

writeFileSync(file, c, 'utf8');
console.log('ALL_SWITCHES_REMOVED');
