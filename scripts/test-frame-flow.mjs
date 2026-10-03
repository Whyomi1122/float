// scripts/test-frame-flow.mjs
// 端到端模拟「模型整幕输出 → 一条 turn 落库 → 渲染层切帧」的完整链路。
// 运行：node scripts/test-frame-flow.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadTs(relPath) {
  const src = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

const { parseEnsembleReply } = await import(loadTs("lib/ensemble-parser.ts"));

const CAST = [
  { id: "c1", name: "金成帝", avatar: "a1" },
  { id: "c2", name: "岳霖玉", avatar: "a2" },
];

// 模拟一次完整生成（模型返回一整幕）
const REPLY = `雨丝斜斜地打在医院的玻璃窗上。

金成帝：
（把外套搭在椅背上，没有立刻坐下）"检查结果出来了？"
【她要是真撑不住，我这边的事就得往后挪。】

岳霖玉：
（低头整理袖口，声音很平）"良性。医生说观察两周。"
（说到这里才抬起眼）"你那个案子，别耽误。"

金成帝：
"案子没有你重要。"

（走廊里的灯灭了又亮。两人都没再开口。）`;

// ── 步骤 1：生成逻辑（模拟 ensemble-app 的 triggerAiTurn 落库部分）──
const frames = parseEnsembleReply(REPLY, CAST, CAST).frames;
const leadFrame = frames.find((f) => f.kind === "dialogue");
const turn = {
  id: "turn_test",
  senderId: leadFrame?.speakerId ?? (leadFrame ? undefined : "narration"),
  senderName: leadFrame?.speaker ?? "旁白",
  senderType: leadFrame ? "character" : "narration",
  content: REPLY,
  rawText: REPLY,
};

console.log("═".repeat(64));
console.log("步骤 1 · 落库（一条 turn = 整幕）");
console.log("─".repeat(64));
console.log(`  senderName : ${turn.senderName}  (${turn.senderType})`);
console.log(`  content 长度: ${turn.content.length} 字符`);
console.log(`  主导说话人 : ${leadFrame?.speaker ?? "(无，纯旁白幕)"}`);

// ── 步骤 2：渲染层切帧（模拟 framesOfTurn）──
const renderFrames =
  turn.rawText === undefined ? null : parseEnsembleReply(turn.content, CAST, CAST).frames;

console.log("\n" + "═".repeat(64));
console.log("步骤 2 · 渲染切帧（同一消息流内连续呈现）");
console.log("─".repeat(64));
let lastSpeaker = "\u0000";
renderFrames.forEach((f, i) => {
  const isNarr = f.kind === "narration";
  const showName = !isNarr && f.speaker !== lastSpeaker;
  if (!isNarr) lastSpeaker = f.speaker;
  const head = isNarr ? "  ·「旁白」" : showName ? `  ▸ [${f.speaker}]` : "      ↳";
  console.log(`${head} ${f.text.replace(/\n/g, " ⏎ ")}`);
});

// ── 步骤 3：断言 ──
console.log("\n" + "═".repeat(64));
console.log("步骤 3 · 断言");
console.log("─".repeat(64));
const checks = [];
checks.push(["帧数 ≥ 4（3 段对话 + 2 段旁白）", renderFrames.length >= 4]);
checks.push(["首帧是旁白（开场环境）", renderFrames[0].kind === "narration"]);
checks.push(["含多名说话人", new Set(renderFrames.filter((f) => f.speaker).map((f) => f.speaker)).size === 2]);
checks.push(["金成帝有 2 帧（含内心独白）", renderFrames.filter((f) => f.speaker === "金成帝").length === 2]);
checks.push(["结尾旁白归位（不是挂在角色名下）", renderFrames[renderFrames.length - 1].kind === "narration"]);
// 逐字符覆盖
// 注意：角色名会被解析器识别为 speaker 前缀，从 frame.text 里剥离，
// 但它们并非"丢失"——而是转移到 f.speaker 字段用于内联署名。
// 因此比对池 = 所有帧正文 + 所有 speaker 名。
const extract = (s) => (s.match(/[\u4e00-\u9fa5]/g) || []).sort().join("");
const renderedPool =
  renderFrames.map((f) => f.text).join("\n") +
  "\n" +
  renderFrames.map((f) => f.speaker ?? "").join("");
const pool = extract(renderedPool).split("");
let covered = 0;
for (const ch of extract(REPLY).split("")) {
  const idx = pool.indexOf(ch);
  if (idx >= 0) { pool.splice(idx, 1); covered++; }
}
checks.push([`正文逐字覆盖 (${covered}/${extract(REPLY).length})`, covered === extract(REPLY).length]);

let ok = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (pass) ok++;
}
console.log(`\n结果：${ok}/${checks.length} 通过`);
process.exit(ok === checks.length ? 0 : 1);
