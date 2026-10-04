import { readFileSync, writeFileSync } from 'fs';

const file = 'components/ensemble/ensemble-app.tsx';
let c = readFileSync(file, 'utf8');

const anchorA = '═══════════ 行文规范（硬性，违反即视为错误）═══════════';
const anchorB = '═══════════ 选角：这一幕谁上场';

const idxA = c.indexOf(anchorA);
const idxB = c.indexOf(anchorB);
if (idxA < 0 || idxB < 0) {
  console.error(`ANCHOR_NOT_FOUND idxA=${idxA} idxB=${idxB}`);
  process.exit(1);
}

const oldSeg = c.slice(idxA, idxB);

// 新的行文规范块（锚点A到锚点B之间的内容）
const newSeg = `═══════════ 行文规范（硬性，违反即视为错误）═══════════
每个出场角色用一行 [角色名]: 起头（半角方括号+半角冒号），紧接着写该角色的内容，例如：
   [金成帝]:
   他抬眼扫过来，语气压得很低。
   "别动。"
   这人又在硬撑。
   [岳霖玉]:
   指尖一颤，笔尖停在纸上。
   "我……我自己来。"

1. 叙述/动作/神态/环境/心理：直接写成叙述句，**不加任何符号和括号**。
2. 中文台词：必须用英文双引号包裹，例如 "别动。"，台词单独成段。
3. 韩语台词：用「」包裹原文，下一行紧接**无引号**中文翻译，例如：
   「너 졸려?」
   你困了吗?
4. 混说角色（既说中文也说韩语）：中文台词用英文双引号，韩语台词用「」+翻译行，规则同上。
5. 严禁：（）、【】、*、《》、#、~；严禁 Markdown 标题、序号列表。
\${bilingualBlock}

`;

const c2 = c.replace(oldSeg, newSeg);
if (c2 === c) {
  console.error('BLOCK2_NOT_FOUND: replacement had no effect');
  process.exit(1);
}
writeFileSync(file, c2, 'utf8');
console.log('BLOCK2_OK');
