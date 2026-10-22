/**
 * 声音链路的本地自测：直接喂三块字，看合成与连播的时序。
 *
 * 这一步会真的出声（本机扬声器），用来确认 Edge TTS 连得上、常驻播放器两片之间的空隙够小。
 * 跑：node <tsx> scripts/check-speaker.ts
 */
import { Speaker } from '../src/speaker.ts';

const style = { voice: 'zh-CN-XiaoyiNeural', rate: '+15%', volume: '+20%' };
const t0 = Date.now();
const log = (line: string): void => console.log(`[${String(Date.now() - t0).padStart(5)}ms] ${line}`);

const speaker = new Speaker(log);
await speaker.warm(style);
log(`预热完（${Date.now() - t0}ms）`);

// 模拟「模型开始写了」：这时候预热，等第一句切出来
speaker.prime(style);
await new Promise((r) => setTimeout(r, 2500));
log('假装第一句切出来了');

const chunks = [
  '这是流式播报的第一块，应该立刻出声。',
  '第二块在上一块还在说的时候就已经合成好了。',
  '第三块接着放，中间不该有明显空隙。',
];
for (const text of chunks) speaker.say(text, style);

while (speaker.speaking || speaker.queued > 0) await new Promise((r) => setTimeout(r, 100));
log(`全部结束 ${JSON.stringify(speaker.snapshot())}`);
await speaker.stop();
