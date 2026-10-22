/** 把流式进来的台词清成能读的句子：动作标记去掉，表情、网址、Markdown 也去掉。 */

/** 表情和符号读出来是空的；SSML 模板也不认它们。与大肥鱼的 clean.ts 同一套规则。 */
const NOISE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
/** Markdown 的强调与代码记号。 */
const MARKS = /[*_`~#>|]+/g;
/** 网址念不出东西，前后的字才带意思。 */
const URLS = /https?:\/\/\S+/g;

/** 一次最多读这么长；超出的留在屏幕上。 */
export const SPEAK_MAX = 600;

/** 一段文本里真正要念的部分；没有可念的字时返回空串。 */
export function speakable(text: string): string {
  const cleaned = text
    .replace(URLS, ' ')
    .replace(NOISE, ' ')
    .replace(MARKS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > SPEAK_MAX ? `${cleaned.slice(0, SPEAK_MAX)}……` : cleaned;
}

/** 行内标记的边界：`【表情, 动作】` 阻塞、`<表情>` 行内，剧本语法见大肥鱼的 script.ts。 */
const MARKER_MAX = 32;

/**
 * 增量地去标记。
 *
 * 标记可能被切在两个增量之间（`【` 在前一个 delta、`】` 在后一个），所以尾巴上没闭合的
 * 半个标记先扣在 `hold` 里，等下一个增量到了再判；一直不闭合的，超过长度或换行就当正文发出去。
 */
export class MarkerFilter {
  private hold = '';

  push(text: string): string {
    this.hold += text;
    let out = '';
    let i = 0;
    while (i < this.hold.length) {
      const ch = this.hold[i];
      if (ch === '【') {
        const end = this.hold.indexOf('】', i + 1);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      if (ch === '<') {
        const end = this.hold.indexOf('>', i + 1);
        if (end < 0) {
          const rest = this.hold.slice(i);
          if (rest.length > MARKER_MAX || rest.includes('\n')) {
            out += ch;
            i++;
            continue;
          }
          break;
        }
        const inner = this.hold.slice(i + 1, end);
        if (inner.length <= MARKER_MAX && !inner.includes('\n')) {
          i = end + 1;
          continue;
        }
        out += ch;
        i++;
        continue;
      }
      out += ch;
      i++;
    }
    this.hold = this.hold.slice(i);
    return out;
  }

  /** 收尾：扣着的半个标记不再等，闭合的标记仍然去掉。 */
  flush(): string {
    const rest = this.hold;
    this.hold = '';
    return rest.replace(/【[^】]*】/g, '').replace(/<[^<>\n]{1,32}>/g, '');
  }
}
