import type { RegexConfig } from "./settings-types";
import { applyAllOutputRegex, applyAllReasoningRegex } from "./llm-prompt-assembler";
import type { MacroEngine } from "./macro-engine";

export const STORY_PARSER_VERSION = 8;

/** 剧情正文里声明的“线上消息”事件（角色在聊天 App 里发出的消息）。 */
export type StoryOnlineMessage = {
    kind: "private" | "group";
    /** private=角色名；group=群名 */
    target: string;
    content: string;
};

export type ParsedStoryResponse = {
  rawText: string;
  renderedText: string;
  summaryText: string;
  /** <online chat="private|group" to="...">内容</online> 解析结果；控制标记不进入正文渲染。 */
  onlineMessages: StoryOnlineMessage[];
};

/**
 * 提取 <online chat="private" to="林深">在忙吗</online> 控制块。
 * 与折叠标签同属“只给代码看”的控制标记：解析后从 renderedText 剥离。
 * 兼容中文别名（在线消息/线上消息）与中文属性（类型/目标），属性缺失时整块忽略（不投递，但仍剥离，避免正文露出标签）。
 */
function extractOnlineMessages(text: string): { cleaned: string; events: StoryOnlineMessage[] } {
  const events: StoryOnlineMessage[] = [];
  // 注意：不能用 \b 词边界，中文标签名（在线消息）与后续空格之间 \b 不成立。
  const rx = /<(online|在线消息|线上消息)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/gi;
  const attrRx = /([a-zA-Z_]+|类型|目标|私聊|群聊|kind)\s*[:=]\s*["“]?([^"\n>”]*?)["”]?\s*(?=[\s/]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(text)) !== null) {
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    attrRx.lastIndex = 0;
    while ((attrMatch = attrRx.exec(match[2])) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2].trim();
    }
    const content = match[3].trim();
    const chatRaw = (attrs.chat || attrs["类型"] || "").toLowerCase();
    if (!content) continue;
    // 新格式：私聊无属性 <online>内容</online>；群聊 <online group="群名">。
    // 兼容旧格式：chat="private|group" / chat="私聊|群聊" + to="..."。
    if (attrs.group || attrs["群聊"] || chatRaw === "group" || chatRaw === "群聊") {
      const target = attrs.group || attrs.to || attrs["目标"] || "";
      if (!target) continue;
      events.push({ kind: "group", target, content });
    } else if (chatRaw === "private" || chatRaw === "私聊") {
      events.push({ kind: "private", target: attrs.to || attrs["目标"] || "", content });
    } else {
      // 无 chat/类型/group 属性：视为私聊（角色发给用户）
      events.push({ kind: "private", target: "", content });
    }
  }
  const cleaned = text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, events };
}

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractXmlField(rawText: string, preferredTag?: string): string {
  const candidates = [preferredTag?.trim(), "summary"]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index) as string[];

  for (const tag of candidates) {
    const match = rawText.match(new RegExp(`<${escapeTagName(tag)}>([\\s\\S]*?)</${escapeTagName(tag)}>`, "i"));
    const content = match?.[1]?.trim();
    if (content) return content;
  }
  return "";
}

/** Convert `<tagname>...</tagname>` into renderer fold markers for each configured fold tag. */
function applyFoldTags(text: string, foldTags?: string): string {
  if (!foldTags) return text;
  const tags = Array.from(new Set(foldTags.split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const placeholders: { placeholder: string; label: string; content: string }[] = [];
  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>([\\s\\S]*?)<\\/\\1>`, "gi");
  const protectedText = text.replace(rx, (_match, tag: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return "";
    const placeholder = `\x00STORY_FOLD_${placeholders.length}\x00`;
    placeholders.push({
      placeholder,
      label: tag.toLowerCase(),
      content: trimmed,
    });
    return placeholder;
  });

  let result = protectedText;
  for (const { placeholder, label, content } of placeholders) {
    const replacement = `\n<!--RHR-FOLD:${label}-->\n${content}\n<!--/RHR-FOLD-->\n`;
    result = result.split(placeholder).join(replacement);
  }
  return result;
}

export function parseStoryResponse(
  rawText: string,
  regexes: RegexConfig[],
  options?: { summaryTag?: string; foldTags?: string; macroEngine?: MacroEngine; activeTags?: string[] },
): ParsedStoryResponse {
  const trimmed = rawText.trim();
  // Strip fold-tag blocks (thinking/think) BEFORE extracting summary,
  // so that <summary> mentioned inside thinking content isn't matched first.
  // 注意跳过摘要标签本身——summary 也可以配进折叠标签（默认已包含），
  // 若在此被剥掉，摘要就提取不到了（recent_story/记忆会断）。
  const effectiveSummaryTag = (options?.summaryTag?.trim() || "summary").toLowerCase();
  let textForSummary = trimmed;
  if (options?.foldTags) {
    for (const tag of options.foldTags.split(",").map(t => t.trim()).filter(Boolean)) {
      if (tag.toLowerCase() === effectiveSummaryTag) continue;
      const escaped = escapeTagName(tag);
      textForSummary = textForSummary.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "");
    }
  }
  const summaryText = extractXmlField(textForSummary, options?.summaryTag);

  // Temporarily replace fold-tag blocks with placeholders before output regex,
  // so that <content>/<summary> mentioned inside thinking aren't matched by regex rules
  let textForRegex = trimmed;
  const foldPlaceholders: { placeholder: string; original: string }[] = [];
  if (options?.foldTags) {
    for (const tag of options.foldTags.split(",").map(t => t.trim()).filter(Boolean)) {
      const escaped = escapeTagName(tag);
      const rx = new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi");
      textForRegex = textForRegex.replace(rx, (match) => {
        const placeholder = `\x00FOLD_${foldPlaceholders.length}\x00`;
        foldPlaceholders.push({ placeholder, original: match });
        return placeholder;
      });
    }
  }
  const regexRendered = applyAllOutputRegex(textForRegex, regexes, {
    macroEngine: options?.macroEngine,
    activeTags: options?.activeTags,
  });
  // Restore fold blocks and apply reasoning regex inside them
  let reasoningProcessed = regexRendered;
  for (const { placeholder, original } of foldPlaceholders) {
    let restored = original;
    // Apply placement=6 (reasoning) regex inside the fold block
    if (regexes.length > 0) {
      // Extract tag name and content from the original fold block
      const tagMatch = original.match(/^<(\w+)>([\s\S]*)<\/\1>$/i);
      if (tagMatch) {
        const [, tagName, content] = tagMatch;
        const regexed = applyAllReasoningRegex(content.trim(), regexes, {
          macroEngine: options?.macroEngine,
          activeTags: options?.activeTags,
        });
        restored = `<${tagName}>${regexed}</${tagName}>`;
      }
    }
    reasoningProcessed = reasoningProcessed.replace(placeholder, restored);
  }

  const folded = applyFoldTags(reasoningProcessed, options?.foldTags);
  // 只在“正文”里提取线上消息：先剥掉折叠块（思考/think 等），避免把思考里的示例也投递出去（导致重复）。
  let foldedBodyForOnline = folded;
  if (options?.foldTags) {
    for (const tag of options.foldTags.split(",").map(t => t.trim()).filter(Boolean)) {
      const escaped = escapeTagName(tag);
      foldedBodyForOnline = foldedBodyForOnline.replace(new RegExp(`<${escaped}>[\\s\\S]*?</${escaped}>`, "gi"), "");
    }
  }
  foldedBodyForOnline = foldedBodyForOnline.replace(/<!--RHR-FOLD:[\s\S]*?<!--\/RHR-FOLD-->/gi, "");
  const online = extractOnlineMessages(foldedBodyForOnline.replace(/\r\n/g, "\n").trim());
  // 从最终渲染文本里剥离线上消息标记（整段 folded，保证标签不会露出）
  const cleanedRendered = folded
    .replace(/<(online|在线消息|线上消息)((?:\s[^>]*)?)>[\s\S]*?<\/\1>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const renderedText = cleanedRendered;

  return {
    rawText: trimmed,
    renderedText,
    summaryText,
    onlineMessages: online.events,
  };
}
