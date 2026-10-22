/**
 * 从流式的函数调用参数里，增量地抠出一个字符串字段。
 *
 * 模型吐出来的是 JSON 的碎片：`{"script":"我先","看一下。"}` 会分成好几次到，甚至
 * `\"` `\n` 这些转义也会被切在中间。这里只做一件事：盯着目标字段的字符串值，把已经
 * 解好转义的那部分交出去，剩下的等下一片。
 *
 * 别的字段（images 之类）整段跳过，不需要把 JSON 解析完。
 */

type State = 'obj' | 'key' | 'colon' | 'value' | 'text' | 'skip' | 'after' | 'done';

export class JsonStringField {
  private buf = '';
  private pos = 0;
  private state: State = 'obj';
  private target = false;
  private value = '';
  /** 跳过别的值时的括号深度与字符串状态。 */
  private depth = 0;
  private inString = false;
  private escape = false;

  constructor(private readonly field: string) {}

  /** 到目前为止该字段的完整值。 */
  get text(): string {
    return this.value;
  }

  /** 该字段的字符串已经闭合。 */
  get complete(): boolean {
    return this.state === 'after' || this.state === 'done';
  }

  /** 喂一片参数，返回这一片里新解出来的文字。 */
  feed(delta: string): string {
    if (!delta) return '';
    this.buf += delta;
    const before = this.value.length;
    this.pump();
    return this.value.slice(before);
  }

  private pump(): void {
    const s = this.buf;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      switch (this.state) {
        case 'obj':
          if (ch === '{') { this.state = 'key'; this.pos++; break; }
          if (/\s/.test(ch)) { this.pos++; break; }
          this.state = 'done';
          return;
        case 'key': {
          if (ch === '"') {
            const out = this.readKey();
            if (out === null) return;
            this.target = out === this.field;
            this.state = 'colon';
            break;
          }
          if (ch === '}') { this.state = 'done'; return; }
          this.pos++;
          break;
        }
        case 'colon':
          if (ch === ':') { this.state = 'value'; this.pos++; break; }
          if (/\s/.test(ch)) { this.pos++; break; }
          this.state = 'done';
          return;
        case 'value':
          if (/\s/.test(ch)) { this.pos++; break; }
          if (this.target && ch === '"') { this.state = 'text'; this.pos++; break; }
          this.state = 'skip';
          this.depth = 0;
          this.inString = false;
          this.escape = false;
          break;
        case 'text': {
          if (this.escape) {
            if (ch === 'u') {
              if (this.pos + 4 >= s.length) return; // 四个十六进制还没到齐
              const hex = s.slice(this.pos + 1, this.pos + 5);
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) { this.escape = false; this.pos++; break; }
              this.value += String.fromCharCode(parseInt(hex, 16));
              this.escape = false;
              this.pos += 5;
              break;
            }
            this.value += unescapeChar(ch);
            this.escape = false;
            this.pos++;
            break;
          }
          if (ch === '\\') { this.escape = true; this.pos++; break; }
          if (ch === '"') { this.state = 'after'; this.pos++; break; }
          this.value += ch;
          this.pos++;
          break;
        }
        case 'skip':
          if (this.inString) {
            if (this.escape) { this.escape = false; this.pos++; break; }
            if (ch === '\\') { this.escape = true; this.pos++; break; }
            if (ch === '"') { this.inString = false; this.pos++; break; }
            this.pos++;
            break;
          }
          if (ch === '"') { this.inString = true; this.pos++; break; }
          if (ch === '{' || ch === '[') { this.depth++; this.pos++; break; }
          if (ch === '}' || ch === ']') {
            if (this.depth === 0) { this.state = 'after'; break; }
            this.depth--;
            this.pos++;
            break;
          }
          if (ch === ',' && this.depth === 0) { this.state = 'key'; this.pos++; break; }
          this.pos++;
          break;
        case 'after':
          if (ch === ',') { this.state = 'key'; this.pos++; break; }
          if (ch === '}') { this.state = 'done'; return; }
          this.pos++;
          break;
        case 'done':
          return;
      }
    }
  }

  /** 读一个键名；字符串还没闭合时返回 null，一个字节都不吃掉。 */
  private readKey(): string | null {
    let i = this.pos + 1;
    let out = '';
    let esc = false;
    while (i < this.buf.length) {
      const ch = this.buf[i];
      if (esc) { out += unescapeChar(ch); esc = false; i++; continue; }
      if (ch === '\\') { esc = true; i++; continue; }
      if (ch === '"') {
        this.pos = i + 1;
        return out;
      }
      out += ch;
      i++;
    }
    return null;
  }
}

function unescapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    default: return ch;
  }
}
