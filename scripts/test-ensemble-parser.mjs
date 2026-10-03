// scripts/test-ensemble-parser.mjs
// 用真实形态的样本验证 parseEnsembleReply 的解析结果。
// 运行：node scripts/test-ensemble-parser.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// 极简 TS→JS 转译（只为跑测试，不引入构建链）
function loadTs(relPath) {
  const src = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

// ensemble-parser 只 import type，转译后无运行时依赖 → 可直接动态 import
const mod = await import(loadTs("lib/ensemble-parser.ts"));
const { parseEnsembleReply } = mod;

const CAST = [
  { id: "c1", name: "金成帝", avatar: "a1" },
  { id: "c2", name: "岳霖玉", avatar: "a2" },
  { id: "c3", name: "沈既川", avatar: "a3" },
];

const CASES = [
  {
    name: "① 标准群像：两角色交锋 + 内心独白",
    text: `金成帝：
（他抬眼扫过来，语气压得很低）"别动。"
【这人又在硬撑。】

岳霖玉：
（指尖一颤，笔尖停在纸上）"我……我自己来。"`,
  },
  {
    name: "② 开场环境描写在前（旁白应归位）",
    text: `雨敲着玻璃，走廊尽头的灯管闪烁了一下。

金成帝：
（没有回头）"你迟到了。"`,
  },
  {
    name: "③ 脏格式：**加粗** + 序号 + 全角冒号 + 前后空格",
    text: `**1. 金成帝：**
（靠在门框上）"说吧。"

**2. 岳霖玉：**
"没什么好说的。"`,
  },
  {
    name: "④ 模型没写角色名（整段应兜底为旁白，不丢字）",
    text: `他站在窗前，很久没有动。
楼下的车流声一阵阵涌上来。`,
  },
  {
    name: "⑤ 含 think 推理泄漏（应先剥离）",
    text: `<think>让我想想这一幕该怎么写…</think>
金成帝：
（冷笑）"你倒是会挑时候。"

沈既川：
"我只是路过。"`,
  },
  {
    name: "⑥ 认不出的人名（不应误判为说话人）",
    text: `金成帝：
（皱眉）"谁在外面？"

（门外传来脚步声，没人回答。）`,
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const r = parseEnsembleReply(c.text, CAST, CAST);
  console.log("\n" + "═".repeat(64));
  console.log(c.name);
  console.log("─".repeat(64));
  console.log(`多说话人: ${r.multiSpeaker}   帧数: ${r.frames.length}`);
  r.frames.forEach((f, i) => {
    const who = f.speaker ? `[${f.speaker}${f.speakerId ? ":" + f.speakerId : ""}]` : "[旁白]";
    const preview = f.text.replace(/\n/g, " ⏎ ").slice(0, 70);
    console.log(`  ${i}. ${who} ${preview}${f.text.length > 70 ? "…" : ""}`);
  });

  // 断言：把「正文实质字符」抽出来做集合比对——
  // 源里每个 CJK/字母数字字符都应能在帧输出里找到（顺序无关，容忍重排）。
  const joined = r.frames.map((f) => f.text).join("\n");
  const srcClean = c.text.replace(
    /<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi,
    ""
  );
  // 去掉说话人前缀行（"角色名：" 所在行的名字部分），只留正文
  const srcBody = srcClean
    .split("\n")
    .filter((ln) => !/^\s*(?:[*#>\u3010]{1,3}\s*)?(?:\d+[.、)]\s*)?\*{0,2}\s*[^\s:：]{1,12}\s*[:：]\s*\**\s*$/.test(ln))
    .join("\n");
  const extract = (s) => (s.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).sort().join("");
  const srcChars = extract(srcBody);
  const gotChars = extract(joined);
  // 源里每个正文实义字符都应被覆盖（重复字符按出现次数校验）
  let covered = 0;
  const pool = gotChars.split("");
  for (const ch of srcChars.split("")) {
    const i = pool.indexOf(ch);
    if (i >= 0) {
      pool.splice(i, 1);
      covered++;
    }
  }
  const lossless = srcChars.length === 0 || covered >= srcChars.length;
  console.log(
    `  内容保全: ${lossless ? "✓" : "✗"}  (源实义 ${srcChars.length} / 覆盖 ${covered})`
  );
  lossless ? pass++ : fail++;
}

console.log("\n" + "═".repeat(64));
console.log(`结果：${pass} 通过 / ${fail} 需检查（共 ${CASES.length}）`);

// ──────────────────────────────────────────────────────────────
// 旁白开关语义（2026-10 修正）：
//   · narrationEnabled=false（默认）→ 一句旁白都不产出，全部归角色；
//   · narrationEnabled=true          → 段首整行括号段可判为旁白帧。
// 这是 BUG2 的回归护栏：未开开关时绝不能再冒出旁白。
console.log("\n" + "═".repeat(64));
console.log("旁白开关语义（BUG2/BUG3 回归护栏）");
console.log("─".repeat(64));

const NARR_CASE = `金成帝：
（他抬眼扫过来，语气压得很低）"别动。"

（窗外的雨忽然大了，敲得玻璃作响。）

岳霖玉：
（指尖一颤）"我自己来。"`;

const offR = parseEnsembleReply(NARR_CASE, CAST, CAST, { narrationEnabled: false });
const onR = parseEnsembleReply(NARR_CASE, CAST, CAST, { narrationEnabled: true });

const narrOff = offR.frames.filter((f) => f.kind === "narration").length;
const narrOn = onR.frames.filter((f) => f.kind === "narration").length;

console.log(
  `  开关 OFF → 旁白帧数 ${narrOff}（期望 0）  ${
    narrOff === 0 ? "✓" : "✗"
  }`
);
console.log(
  `  开关 ON  → 旁白帧数 ${narrOn}（期望 >0） ${
    narrOn > 0 ? "✓" : "✗"
  }`
);
console.log(
  `  开关 OFF 时「窗外的雨」是否保留正文：${
    offR.frames.some((f) => f.text.includes("窗外的雨")) ? "✓" : "✗"
  }`
);

const narrOk = narrOff === 0 && narrOn > 0;
console.log(
  `\n旁白护栏：${narrOk ? "✓ 通过" : "✗ 需检查"}` +
    `   （OFF=${narrOff} / ON=${narrOn}）`
);
