import { readFileSync, writeFileSync } from 'fs';

const file = 'components/ensemble/ensemble-app.tsx';
let c = readFileSync(file, 'utf8');

// 1. 替换 TriColorSegment 接口：加 krdial 类型
const oldIface = `interface TriColorSegment {
  type: "act" | "dial" | "inn" | "plain";
  text: string;
  /** 双语模式下：外语台词对应的中文翻译（渲染在括号里，紧跟台词） */
  translation?: string;
}`;

const newIface = `interface TriColorSegment {
  type: "act" | "dial" | "krdial" | "inn" | "plain";
  text: string;
  /** 韩语对白（krdial）的中文翻译行（无引号，紧接在韩语行下方） */
  translation?: string;
}`;

c = c.replace(oldIface, newIface);
if (!c.includes('krdial')) { console.error('IFACE_NOT_REPLACED'); process.exit(1); }
console.log('IFACE_OK');

// 2. 替换 parseTriColor 函数体
// 找到函数开始和结束位置
const fnStart = c.indexOf('export function parseTriColor(');
const fnEnd = c.indexOf('\n// 去符号', fnStart);
if (fnStart < 0 || fnEnd < 0) { console.error('PARSE_FN_NOT_FOUND'); process.exit(1); }

const oldFn = c.slice(fnStart, fnEnd);

const newFn = `export function parseTriColor(raw: string, bilingual = false): TriColorSegment[] {
  if (!raw) return [];
  const segments: TriColorSegment[] = [];

  // 先识别韩语对白「」+ 下行翻译（无引号）
  // 按行切分，逐行扫描：
  //   「...」行 → krdial，如果下一行是纯中文（无任何标记）→ translation
  //   "..." 行 → dial（中文对白）
  //   其他 → 走通用三色解析
  const lines = raw.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // 韩语对白：「...」
    const krM = line.match(/^「([^」]*)」$/);
    if (krM) {
      const krText = krM[1].trim();
      // 看下一行是否为翻译行（纯中文，无任何标记）
      let trans = undefined;
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // 翻译行判定：不含任何标记符号（"" 「」 （） 【】）
        if (nextLine && !/[""\u300c\u300d\uff08\uff09\u3010\u3011\(\)\[\]]/.test(nextLine)) {
          trans = nextLine;
          i++; // 跳过已消费的翻译行
        }
      }
      segments.push({ type: 'krdial', text: krText, translation: trans });
      continue;
    }

    // 中文对白："..."（加粗黑色）
    const cnM = line.match(/^"([^"]*)"$/);
    if (cnM) {
      segments.push({ type: 'dial', text: cnM[1].trim() });
      continue;
    }

    // 其他：走通用三色解析（动作/心理/plain）
    // 这一行可能混杂多种标记，逐段识别
    const regex = /(?:[（\\(]([^）\\)]*)[）\\)])|(?:[""]([^""]*)[""])|(?:[【\\[]([^】\\]]*)[】\\]])/g;
    let lastIndex = 0;
    let match;
    let hasMatch = false;

    while ((match = regex.exec(line)) !== null) {
      hasMatch = true;
      if (match.index > lastIndex) {
        const plainText = line.slice(lastIndex, match.index).trim();
        if (plainText) segments.push({ type: 'plain', text: plainText });
      }
      if (match[1] !== undefined) {
        segments.push({ type: 'act', text: match[1] });
      } else if (match[2] !== undefined) {
        segments.push({ type: 'dial', text: match[2] });
      } else if (match[3] !== undefined) {
        segments.push({ type: 'inn', text: match[3] });
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < line.length || !hasMatch) {
      const trailing = hasMatch ? line.slice(lastIndex).trim() : line;
      if (trailing) segments.push({ type: 'plain', text: trailing });
    }
  }

  return segments;
}
`;

c = c.slice(0, fnStart) + newFn + c.slice(fnEnd);
console.log('PARSE_FN_OK');

writeFileSync(file, c, 'utf8');
console.log('ALL_OK');
