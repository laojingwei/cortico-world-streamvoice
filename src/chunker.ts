/**
 * 按句切块的机器：流进来的字凑够一句就切一块出去。
 *
 * 规则就是人耳的习惯：
 * - 句末（。！？；换行，以及英文的 .!?;）切一刀；
 * - 短于 `min` 字的一句不单独说，和下一句并成一块（所以第一块可能等第二句写完）；
 * - 一块超过 `max` 字，在它前面的逗号、顿号、冒号处再切一刀；找不到标点就硬切在 `max`。
 *
 * 切块不依赖句读之外的上下文，喂多少吐多少，最后 flush 收尾。
 */

export interface ChunkLimits {
  /** 少于这么多字（不含空白）不单独成块。 */
  min: number;
  /** 一块最多这么多字。 */
  max: number;
}

/** 一看见就切：句末标点与换行。 */
const HARD_ENDS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n', '\r']);
/** 句末标点后面跟着的收尾符号，归前一块。 */
const CLOSERS = new Set(['」', '』', '”', '’', '）', ')', '】', '》', '"', "'"]);
/** 超过 max 时可以下刀的地方，优先靠后。 */
const SOFT_ENDS = new Set(['，', ',', '、', '：', ':']);

/** 可见字数：空白不算。 */
function visibleLength(text: string): number {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n++;
  return n;
}

function isHardEnd(text: string, i: number): boolean {
  const ch = text[i];
  if (HARD_ENDS.has(ch)) return true;
  if (ch === '.') {
    // 小数点、版本号里的点不算句子结束
    const prev = text[i - 1] ?? '';
    const next = text[i + 1];
    if (/\d/.test(prev)) return false;
    // 句尾的点后面还没有下一个字时先不切，等它落地
    return next === undefined ? false : /[\s"')）」』】]/.test(next);
  }
  return false;
}

export class SentenceChunker {
  private buf = '';

  constructor(private limits: ChunkLimits) {}

  /** 换参数（配置是热改的）。已经攒着的字不重新切，后续按新参数走。 */
  setLimits(limits: ChunkLimits): void {
    this.limits = limits;
  }

  /** 还攒着多少字没吐。 */
  get pending(): number {
    return visibleLength(this.buf);
  }

  /** 喂一段增量，返回这次能切出来的整块（可能 0 块、也可能 2 块以上）。 */
  push(text: string): string[] {
    if (!text) return [];
    this.buf += text;
    return this.drain();
  }

  /** 收尾：剩下的字不管够不够长都算一块。 */
  flush(): string[] {
    const out: string[] = [];
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) out.push(rest);
    return out;
  }

  private drain(): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut <= 0) return out;
      const piece = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut);
      const trimmed = piece.replace(/^[\s，,、：:]+/, '').trim();
      if (trimmed) out.push(trimmed);
    }
  }

  /** 这一刀切在哪里（切在这个下标之后）；0 表示还不到时候。 */
  private findCut(): number {
    const { min, max } = this.limits;
    let i = 0;
    while (i < this.buf.length) {
      if (isHardEnd(this.buf, i)) {
        let end = i + 1;
        while (end < this.buf.length && CLOSERS.has(this.buf[end])) end++;
        const piece = this.buf.slice(0, end);
        const len = visibleLength(piece);
        if (len < min) {
          // 太短：并到下一句，接着找下一个句末
          i = end;
          continue;
        }
        if (len > max) return this.softCut(max);
        return end;
      }
      i++;
    }
    // 一个能用的句末都没有：攒太长了就先切一刀
    if (visibleLength(this.buf) > max) return this.softCut(max);
    return 0;
  }

  /** 在 max 以内靠后的标点处下刀；没有标点就硬切在 max。 */
  private softCut(max: number): number {
    let seen = 0;
    let lastSoft = -1;
    let hardAt = -1;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (/\s/.test(ch)) continue;
      seen++;
      if (seen > max) {
        hardAt = i;
        break;
      }
      if (SOFT_ENDS.has(ch)) lastSoft = i + 1;
    }
    if (lastSoft > 0) return lastSoft;
    if (hardAt > 0) return hardAt;
    return this.buf.length;
  }
}
