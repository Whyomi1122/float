import { readFileSync, writeFileSync } from 'fs';

const file = 'components/ensemble/ensemble-app.tsx';
let c = readFileSync(file, 'utf8');

// 找到 TriColorText 函数中「对白：深黑」这一段的开始位置
const dialStart = c.indexOf('        // 对白：深黑，核心内容；单独成行。');
if (dialStart < 0) { console.error('DIAL_COMMENT_NOT_FOUND'); process.exit(1); }

// 找到这段的结束（下一个 })} 闭合）
const dialEnd = c.indexOf('      })}', dialStart);
if (dialEnd < 0) { console.error('DIAL_END_NOT_FOUND'); process.exit(1); }

const oldDial = c.slice(dialStart, dialEnd);

const newDial = `        // krdial：韩语对白，用「」包裹，下行翻译无引号灰色
        if (s.type === 'krdial') {
          return (
            <div key={i} className="space-y-1">
              <div
                style={{ color: pal.dial, fontSize: ts(14) }}
                className="whitespace-pre-wrap leading-[1.9]"
              >
                「{body}」
              </div>
              {s.translation && (
                <div
                  style={{ color: pal.act, fontSize: ts(13) }}
                  className="whitespace-pre-wrap leading-[1.9]"
                >
                  {s.translation}
                </div>
              )}
            </div>
          );
        }

        // 对白（中文）：深黑加粗，用 "" 包裹
        return (
          <div
            key={i}
            style={{ color: pal.dial, fontSize: ts(14) }}
            className="whitespace-pre-wrap font-bold leading-[1.9]"
          >
            "{body}"
          </div>
        );`;

c = c.slice(0, dialStart) + newDial + '\n' + c.slice(dialEnd);
if (!c.includes('krdial')) { console.error('KRDIAL_NOT_ADDED'); process.exit(1); }
console.log('TRICOLOR_TEXT_OK');

writeFileSync(file, c, 'utf8');
