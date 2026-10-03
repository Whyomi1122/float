// 群像帧流效果预览（独立页，不依赖登录 / API / dev 服务器）
// 目的：对照目标截图检查「一框内嵌多头名 + 三色 + meta 行」的排版效果。
//
// 用法：
//   node scripts/preview-ensemble-frame.mjs        → 生成 preview-ensemble-frame.html
//   然后直接用浏览器打开该 html
//
// 说明：本 preview 内的解析逻辑是对 lib/ensemble-parser.ts 的**逐行复刻**，
//       TriColorText / EnsembleFrameStream 的样式取自 ensemble-app.tsx。
//       改渲染后请同步本文件，保证预览与实机一致。

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "preview-ensemble-frame.html");

// ══════════════════════════════════════════════════════════
// 1) 解析器（复刻 lib/ensemble-parser.ts）
// ══════════════════════════════════════════════════════════

const SPEAKER_LINE =
  /^\s*(?:[*#>\u3010]{1,3}\s*)?(?:\d+[.、)]\s*)?\*{0,2}\s*([^\s:："“（(【\[]{1,12})\s*[:：]\s*(.*)$/;

function stripReasoningAndExtract(text) {
  let t = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  const m = t.match(/<content>([\s\S]*?)<\/content>/i);
  if (m) t = m[1];
  return t.trim();
}

function findCastMember(cast, name) {
  if (!name) return undefined;
  const n = name.trim();
  let hit = cast.find((c) => c.name === n);
  if (hit) return hit;
  hit = cast.find((c) => c.name.startsWith(n) || n.startsWith(c.name));
  return hit;
}

function parseTriColor(raw) {
  const regex =
    /(?:[（(]([^）)]*)[）)])|(?:["“]([^"”]*)[”"])|(?:[【\[]([^】\]]*)[】\]])/g;
  const segs = [];
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(raw)) !== null) {
    if (m.index > lastIndex) {
      const plain = raw.slice(lastIndex, m.index);
      if (plain) segs.push({ type: "plain", text: plain });
    }
    if (m[1] !== undefined) segs.push({ type: "act", text: m[1] });
    else if (m[2] !== undefined) segs.push({ type: "dial", text: m[2] });
    else if (m[3] !== undefined) segs.push({ type: "inn", text: m[3] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < raw.length) {
    const trailing = raw.slice(lastIndex);
    if (trailing) segs.push({ type: "plain", text: trailing });
  }
  return segs;
}

// 旁白提升：整行被全角圆括号包裹、且出现在空行之后 → 独立旁白帧
function isWrappedNarration(line) {
  const t = line.trim();
  return t.startsWith("（") && t.endsWith("）") && t.length > 4;
}

function parseEnsembleReply(text, cast) {
  const src = stripReasoningAndExtract(text);
  const lines = src.split(/\r?\n/);
  const frames = [];
  let cur = null;
  let blankBefore = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blankBefore = true;
      continue;
    }

    const m = trimmed.match(SPEAKER_LINE);
    const member = m ? findCastMember(cast, m[1]) : undefined;

    if (m && member) {
      const rest = (m[2] ?? "").replace(/[*#>\s]+$/, "");
      cur = {
        speaker: member.name,
        speakerId: member.id,
        speakerAvatar: member.avatar ?? null,
        text: rest,
        kind: "dialogue",
      };
      frames.push(cur);
      blankBefore = false;
      continue;
    }

    // 整段全角括号包裹 + 出现在空行之后 + 已有角色帧 → 提升为旁白
    if (blankBefore && isWrappedNarration(trimmed) && frames.some((f) => f.kind === "dialogue")) {
      frames.push({ text: trimmed, kind: "narration" });
      cur = null;
      blankBefore = false;
      continue;
    }

    // 其余并入当前帧；无当前帧则开旁白帧
    if (cur) {
      cur.text += (cur.text ? "\n" : "") + line;
    } else {
      frames.push({ text: line, kind: "narration" });
    }
    blankBefore = false;
  }

  const cleaned = frames
    .map((f) => ({ ...f, text: f.text.trim() }))
    .filter((f) => f.text.length > 0);

  const speakers = new Set(cleaned.filter((f) => f.speaker).map((f) => f.speaker));
  return {
    frames: cleaned,
    multiSpeaker: speakers.size > 1,
    rawText: src,
  };
}

// ══════════════════════════════════════════════════════════
// 2) 示例数据
// ══════════════════════════════════════════════════════════

const CAST = [
  { id: "c1", name: "金成帝", avatar: null },
  { id: "c2", name: "岳霖玉", avatar: null },
  { id: "c3", name: "沈既川", avatar: null },
];

const SAMPLE = `（雨丝斜斜地打在医院的玻璃窗上，走廊里只有尽头那盏灯还亮着。）

金成帝：（把外套搭在椅背上，没有立刻坐下）"检查结果出来了？"
【她要是真撑不住，我这边的事就得往后挪。】

岳霖玉：（低头整理袖口，声音很平）"良性。医生说观察两周。"
（说到这里才抬起眼）"你那个案子，别耽误。"

金成帝："案子没有你重要。"

（走廊里的灯灭了又亮。两人都没再开口。）`;

const META = {
  date: "2024-12-03 20:15",
  model: "[追光] [角色] [群像] gemini-1.5-flash-8b",
  tokens: 6475,
};

// ══════════════════════════════════════════════════════════
// 3) 渲染（样式取自 ensemble-app.tsx / TriColorText / EnsembleFrameStream）
// ══════════════════════════════════════════════════════════

const GS = { dial: "#111111", act: "#5f5f66", inn: "#8e8e93" };

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderTriColor(raw) {
  const segs = parseTriColor(raw);
  return segs
    .map((s) => {
      const t = esc(s.text.trim());
      if (!t) return "";
      if (s.type === "plain") return `<div class="tri-plain">${t}</div>`;
      if (s.type === "act")  return `<div class="tri-act">${t}</div>`;
      if (s.type === "inn")  return `<div class="tri-inn">${t}</div>`;
      return `<div class="tri-dial">${t}</div>`;
    })
    .join("");
}

function renderFrameStream(frames, cast) {
  let lastSpeaker = "\u0000";
  return frames
    .map((f) => {
      if (f.kind === "narration") {
        return `<div class="fr-narr">${esc(f.text)}</div>`;
      }
      const member =
        (f.speakerId && cast.find((c) => c.id === f.speakerId)) ||
        (f.speaker && cast.find((c) => c.name === f.speaker));
      const showName = f.speaker !== lastSpeaker;
      lastSpeaker = f.speaker;
      const head = showName
        ? `<div class="fr-head">
             <div class="fr-avatar">${
               member?.avatar
                 ? `<img src="${esc(member.avatar)}" alt="">`
                 : esc((f.speaker || "?").slice(0, 1))
             }</div>
             <div class="fr-name">${esc(f.speaker)}</div>
           </div>`
        : "";
      return `<div class="fr-item ${showName ? "is-first" : "is-cont"}">${head}${renderTriColor(f.text)}</div>`;
    })
    .join("");
}

const parsed = parseEnsembleReply(SAMPLE, CAST);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>群像帧流预览</title>
<style>
  :root { --app-text-scale: 1; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 12px 60px;
    background: #f2f2f4;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .phone { max-width: 390px; margin: 0 auto; }

  /* ── 单条 AI 输出框（一条 turn = 一整幕）── */
  .turn {
    background: #fff; border-radius: 20px;
    padding: 16px 16px 12px;
    border: 1px solid rgba(0,0,0,.04);
    box-shadow: 0 1px 3px rgba(0,0,0,.03);
  }

  /* ── 帧流 ── */
  /* 旁白：左侧细竖线（2px 浅黑）+ 轻微缩进，与角色台词拉开层级 */
  .fr-narr {
    color: ${GS.act};
    font-size: 13.5px;
    line-height: 1.9;
    white-space: pre-wrap;
    border-left: 2px solid rgba(0,0,0,.10);
    padding-left: 10px;
    margin-left: 2px;
    margin-bottom: 12px;
  }
  .fr-item { margin-bottom: 12px; }
  .fr-item.is-first { padding-top: 2px; }
  .fr-item.is-cont  { padding-top: 6px; }

  .fr-head {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px;
  }
  .fr-avatar {
    width: 24px; height: 24px; border-radius: 8px;
    background: rgba(0,0,0,.06);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 600; color: rgba(0,0,0,.55);
    box-shadow: inset 0 0 0 1px rgba(0,0,0,.04);
    overflow: hidden; flex: 0 0 auto;
  }
  .fr-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .fr-name { font-weight: 600; font-size: 12px; color: #1a1a1a; }

  /* ── 三色文本 ── */
  .tri-plain { color: #2c2c2c; font-size: 14.5px; line-height: 1.9; white-space: pre-wrap; margin-bottom: 12px; }
  .tri-act   { color: ${GS.act}; font-size: 13.5px; line-height: 1.85; white-space: pre-wrap; margin-bottom: 12px; }
  .tri-inn   { color: ${GS.inn}; font-size: 13.5px; line-height: 1.85; white-space: pre-wrap; margin-bottom: 12px; }
  .tri-dial  { color: ${GS.dial}; font-size: 14.5px; line-height: 1.85; font-weight: 500; white-space: pre-wrap; margin-bottom: 12px; }
  .tri-plain:last-child, .tri-act:last-child, .tri-inn:last-child, .tri-dial:last-child { margin-bottom: 0; }

  /* ── meta 行 ── */
  .meta {
    margin-top: 14px; padding-top: 10px;
    border-top: 1px solid rgba(0,0,0,.05);
    color: #9a9aa0; font-size: 10px; line-height: 1.7;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    letter-spacing: .01em;
  }
  .meta b { font-weight: 400; color: #b0b0b6; }
  .meta-actions { display: flex; justify-content: flex-end; gap: 14px; margin-top: 8px; color: #b9b9bf; }
  .meta-actions span { width: 15px; height: 15px; display: inline-block; }

  /* ── 调试信息 ── */
  .debug {
    max-width: 390px; margin: 20px auto 0;
    background: #fff; border-radius: 14px; padding: 12px 14px;
    font-size: 11px; color: #555; line-height: 1.75;
    font-family: ui-monospace, Menlo, monospace;
    border: 1px solid rgba(0,0,0,.05);
  }
  .debug h3 { margin: 0 0 8px; font-size: 11px; color: #999; font-weight: 500; letter-spacing: .04em; }
  .debug .k { color: #8e8e93; }
  .debug .v { color: #111; }
</style>
</head>
<body>
<div class="phone">
  <div class="turn">
    ${renderFrameStream(parsed.frames, CAST)}
    <div class="meta">
      <div><b>DATE:</b> ${META.date}</div>
      <div><b>MODEL:</b> ${META.model}</div>
      <div><b>TOKENS:</b> ${META.tokens}</div>
      <div class="meta-actions">
        <span>&#8635;</span><span>&#9998;</span><span>&#10064;</span>
      </div>
    </div>
  </div>
</div>

<div class="debug">
  <h3>DEBUG · 解析结果</h3>
  <div><span class="k">帧数:</span> <span class="v">${parsed.frames.length}</span></div>
  <div><span class="k">多说话人:</span> <span class="v">${parsed.multiSpeaker}</span></div>
  ${parsed.frames
    .map(
      (f, i) =>
        `<div><span class="k">${i}.</span> <span class="v">[${f.kind === "narration" ? "旁白" : f.speaker}]</span> ${esc(
          f.text.slice(0, 40)
        )}${f.text.length > 40 ? "…" : ""}</div>`
    )
    .join("")}
</div>
</body>
</html>`;

writeFileSync(OUT, html, "utf8");
console.log(`✅ 预览已生成：${OUT}`);
console.log(`   帧数 ${parsed.frames.length} / 多说话人 ${parsed.multiSpeaker}`);
