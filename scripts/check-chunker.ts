/**
 * 切块机器的本地自测，不进扩展运行路径。
 *
 * 拿一段真实形状的 pet_say 参数流（`{"script":"…"}` 的碎片）喂进去，检查：
 * 标记被去掉、太短的句子并到下一句、超过上限在逗号处切开、增量切分与一次性喂结果一致。
 *
 * 跑：`node --experimental-strip-types scripts/check-chunker.ts`（Node 22.18+）
 * 或：`npx tsx scripts/check-chunker.ts`
 */
import { JsonStringField } from '../src/args.ts';
import { SentenceChunker } from '../src/chunker.ts';
import { MarkerFilter, speakable } from '../src/clean.ts';

let failures = 0;
function ok(cond: boolean, what: string, extra = ''): void {
  if (cond) return;
  failures++;
  console.error(`✗ ${what}${extra ? ` — ${extra}` : ''}`);
}
function eq<T>(got: T, want: T, what: string): void {
  ok(JSON.stringify(got) === JSON.stringify(want), what, `得到 ${JSON.stringify(got)}，应为 ${JSON.stringify(want)}`);
}

/* ---------- 1. 参数流：增量抠出 script ---------- */

const json = '{"script":"我先看一眼【smile】这个文件。<wave>稍等。\\n好了。「引号」也在。","images":["log:blob-1"]}';
const field = new JsonStringField('script');
const filter = new MarkerFilter();
const chunker = new SentenceChunker({ min: 8, max: 60 });
const chunks: string[] = [];
// 按 1–7 个字符一片喂，模拟真实的碎片
let at = 0;
let size = 1;
while (at < json.length) {
  const piece = json.slice(at, at + size);
  at += size;
  size = (size % 7) + 1;
  const text = field.feed(piece);
  if (!text) continue;
  const cleaned = filter.push(text);
  for (const c of chunker.push(cleaned)) chunks.push(speakable(c));
}
for (const c of chunker.push(filter.flush())) chunks.push(speakable(c));
for (const c of chunker.flush()) chunks.push(speakable(c));

eq(field.text, '我先看一眼【smile】这个文件。<wave>稍等。\n好了。「引号」也在。', '参数流按转义解出完整 script');
eq(chunks, ['我先看一眼这个文件。', '稍等。 好了。「引号」也在。'], '标记去掉、句子切块（短的并到下一句）');

/* ---------- 2. 太短的句子并到下一句 ---------- */

const short = new SentenceChunker({ min: 8, max: 60 });
eq(short.push('好。'), [], '太短先不切');
eq(short.push('我看过了，这个文件没问题。'), ['好。我看过了，这个文件没问题。'], '并到下一句一起切');
eq(short.flush(), [], '收尾没有剩余');

/* ---------- 3. 超过上限在逗号处再切 ---------- */

const long = new SentenceChunker({ min: 1, max: 20 });
const text = '这个文件里有三个问题，第一个是缩进，第二个是命名，第三个是注释。';
const out = long.push(text);
ok(out.length >= 2, '长句被切成多块', JSON.stringify(out));
ok(out.every((c) => c.length <= 21), '每块不超过上限（含标点）', JSON.stringify(out.map((c) => c.length)));
ok(out.join('') === text, '切开后拼回去还是原文', out.join(''));

/* ---------- 4. 第一块要赶在整段写完之前出来 ---------- */

const early = new SentenceChunker({ min: 6, max: 60 });
eq(early.push('我先看'), [], '半句不切');
const first = early.push('一眼这个文件。');
eq(first, ['我先看一眼这个文件。'], '第一句写完立刻切出（这一个 chunk 就该去合成了）');

/* ---------- 5. 英文与数字 ---------- */

const en = new SentenceChunker({ min: 4, max: 60 });
eq(en.push('Version 1.5 is out. Try it!'), ['Version 1.5 is out.', 'Try it!'], '小数点不算句子结束');

/* ---------- 6. 标记被切开也认得 ---------- */

const f2 = new MarkerFilter();
let said = '';
said += f2.push('你好【smi');
eq(said, '你好', '半个标记先扣着');
said += f2.push('le】呀。');
eq(said, '你好呀。', '标记闭合后去掉');
said += f2.push('还有<wa');
eq(said, '你好呀。还有', '行内标记也扣着，标记前面的字照常放行');
said += f2.push('ve>呢。');
eq(said, '你好呀。还有呢。', '行内标记去掉');
said += f2.push('剩下的<没闭合');
eq(said, '你好呀。还有呢。剩下的', '没闭合的标记一直扣着');
said += f2.flush();
eq(said, '你好呀。还有呢。剩下的<没闭合', '收尾时不再等，扣着的原样交出去');

/* ---------- 7. 只有标点/表情时不出声 ---------- */

eq(speakable('。'), '。', '标点保留（由调用方过滤空块）');
eq(speakable('🙂'), '', '表情没有可念的字');

if (failures) {
  console.error(`\n${failures} 项不通过`);
  process.exit(1);
}
console.log('切块机器全部通过');
console.log('示例输出：', JSON.stringify(chunks));
