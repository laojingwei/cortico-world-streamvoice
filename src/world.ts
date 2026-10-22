/**
 * 流式语音播报：把宠物的台词，边生成边说。
 *
 * 原来的做法是等整段台词写完、气泡记进事件库，再由负责朗读的 World 轮询一次才合成——一段话
 * 要说完才出声。这里换了一个口子：World 可以声明 `outputTap()`，框架把主 session 的模型输出
 * 增量直接扇过来（装配层合并所有已挂载 World 的接收器）。
 *
 * 于是：
 * 1. `response.output_item.added` 里认出 `pet_say`（`pet_ask` 顺带），看住它的参数流；
 * 2. `response.function_call_arguments.delta` 里的 JSON 碎片，由 args.ts 增量抠出 `script`；
 * 3. clean.ts 去动作标记，chunker.ts 按句切块（太短并下一句、太长在逗号处再切）；
 * 4. 每切出一块就立刻交给 speaker.ts 合成，播放器按顺序连播；
 * 5. 新一轮开始（新的一批送达）、被打断、模型要求安静时，`hush()` 清空队列。
 *
 * 这里不碰气泡、不发事件、不给模型工具：声音只是气泡的回声。
 */
import type {
  OutputTap,
  RunPhase,
  ToolDef,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { JsonStringField } from './args.ts';
import { SentenceChunker } from './chunker.ts';
import { MarkerFilter, speakable } from './clean.ts';
import {
  chunkLimits,
  gapOf,
  streamVoiceConfigGroups,
  streamVoiceText,
  STREAMVOICE_ID,
  type StreamVoiceConfigSection,
} from './config.ts';
import { Speaker } from './speaker.ts';
import {
  describeStyle,
  duplicateReaders,
  prewarmOf,
  readAskOf,
  readOptionsOf,
  readSayOf,
  styleOf,
  verboseOf,
} from './voice.ts';
import type { SpeechStyle } from './speaker.ts';
import { PITCH_OPTIONS, RATE_OPTIONS, VOICE_OPTIONS, VOLUME_OPTIONS, voiceLabel, voiceOptionRows } from './voices.ts';

/** 会念出来的工具：`pet_say` 的 script，`pet_ask` 的 question。 */
const SAY_TOOL = 'pet_say';
const ASK_TOOL = 'pet_ask';
/** 模型要求安静：正在说的停掉，排队的丢掉。 */
const QUIET_TOOL = 'pet_quiet';

/** 流事件按松散形状读：联合类型里每个成员都查一遍不值当。 */
interface StreamLike {
  type: string;
  output_index?: number;
  delta?: string;
  arguments?: string;
  item?: { type?: string; name?: string; arguments?: string } | null;
}

interface CallStream {
  index: number;
  kind: 'say' | 'ask';
  tool: string;
  field: JsonStringField;
  filter: MarkerFilter;
  chunker: SentenceChunker;
  /** 这一条调用切出了几块。 */
  chunks: number;
  /** 第一条增量到达的时刻。 */
  startedAt: number;
}

export interface StreamVoiceWorldOptions {
  /** 活的 `worlds.streamvoice` 段：嗓音、念选项、切块长度都在里面。 */
  cfg: StreamVoiceConfigSection;
  /** 部署目录；只用来看看是不是还有别人也在朗读。 */
  botDir: string;
}

export class StreamVoiceWorld implements World {
  readonly id = STREAMVOICE_ID;
  private host: WorldHost | null = null;
  private readonly speaker: Speaker;
  private readonly streams = new Map<number, CallStream>();
  /** 这一轮台词从什么时候开始写；日志里的「开写后 N ms」用它。 */
  private batchStart = 0;
  private lastError = '';

  constructor(private readonly opts: StreamVoiceWorldOptions) {
    this.speaker = new Speaker((line) => this.log(line));
  }

  private log(line: string): void {
    this.host?.log.info(line);
  }

  /** 每次开口都现读配置：改了嗓音、语速、音量，下一句就是新的。 */
  private get style(): SpeechStyle {
    return styleOf(this.opts.cfg);
  }

  private get limits(): { min: number; max: number } {
    return chunkLimits(this.opts.cfg);
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const style = this.style;
    const limits = this.limits;
    this.syncSpeaker();
    host.log.info(
      `就绪：嗓音 ${style.voice} ${style.rate} ${style.pitch} ${style.volume}，切块 ${limits.min}–${limits.max} 字，`
      + `块间停顿 ${gapOf(this.opts.cfg)}ms，念台词${readSayOf(this.opts.cfg) ? '开' : '关'}，`
      + `念问句${readAskOf(this.opts.cfg) ? '开' : '关'}，念选项${readOptionsOf(this.opts.cfg) ? '开' : '关'}`,
    );
    for (const who of duplicateReaders(this.opts.botDir)) {
      host.log.warn(`${who}也在整段朗读，同一句会被念两遍；把它的朗读关掉，或关掉本扩展`);
    }
    await this.speaker.warm(style);
  }

  async stop(): Promise<void> {
    this.streams.clear();
    await this.speaker.stop();
    this.host = null;
  }

  /**
   * 框架每批投递时现取一次接收器；这里就是流式的入口。
   * 关掉（未挂载）时框架根本不会问，回到大肥鱼的整段朗读。
   */
  outputTap(): OutputTap | undefined {
    if (this.opts.cfg.enabled === false || !this.host) return undefined;
    return {
      // 声音不是「对外发言」：不因为说了话就挡住模型被打断
      externalizes: () => false,
      onEvent: (event) => this.onStreamEvent(event),
      onRoundEnd: () => this.finishAll(),
      onAbort: (reason) => this.hush(`被打断：${reason}`),
    };
  }

  /** 新的一批送达就是新回复：把上一段还没念完的全部丢掉。 */
  onRunPhase(phase: RunPhase): void {
    this.syncSpeaker();
    if (phase.state === 'delivering' && phase.round === undefined) {
      this.hush('新回复开始');
      this.batchStart = Date.now();
      // 趁模型还在想第一句，先把合成链路焐热（Edge TTS 冷启动要好几秒）
      this.speaker.prime(this.style);
      return;
    }
    if (phase.state === 'model') this.speaker.prime(this.style);
  }

  tools(): ToolDef[] {
    return [];
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = streamVoiceText(language);
    const style = this.style;
    const on = this.opts.cfg.enabled !== false;
    const others = duplicateReaders(this.opts.botDir);
    const lamps: WorldLamp[] = [
      {
        label: t.lampSpeech,
        state: !on ? 'offline' : this.lastError ? 'error' : this.speaker.speaking ? 'loading' : 'online',
        hint: !on ? t.off : this.lastError ? this.lastError : this.speaker.speaking ? t.speaking : t.idle,
      },
      { label: t.lampVoice, state: 'online', hint: describeStyle(style) },
    ];
    // 只在真有别人也开着朗读时才提一句，没装就没有这一盏
    if (others.length) lamps.push({ label: t.lampConflict, state: 'error', hint: t.conflict(others.join('、')) });
    return {
      label: t.label,
      lamps,
      panels: [{ id: 'stream', title: t.label, getMethods: ['state', 'hush', 'options', 'preview'] }],
      config: streamVoiceConfigGroups(language),
      invoke: async (panel, method, args) => {
        if (panel !== 'stream') throw new Error(`unknown ${panel}.${method}`);
        switch (method) {
          case 'state':
            return this.state();
          case 'hush':
            this.hush('面板上按了静音');
            return this.state();
          case 'options':
            return {
              voices: voiceOptionRows(),
              rates: [...RATE_OPTIONS],
              pitches: [...PITCH_OPTIONS],
              volumes: [...VOLUME_OPTIONS],
            };
          case 'preview':
            return this.preview(args?.[0]);
          default:
            throw new Error(`unknown ${panel}.${method}`);
        }
      },
    };
  }

  /** 面板上看到的数：切了几块、第一块多快出声。 */
  state(): Record<string, unknown> {
    const style = this.style;
    const limits = this.limits;
    return {
      enabled: this.opts.cfg.enabled !== false,
      voice: style.voice,
      voiceName: voiceLabel(style.voice),
      rate: style.rate,
      pitch: style.pitch,
      volume: style.volume,
      readSay: readSayOf(this.opts.cfg),
      readAsk: readAskOf(this.opts.cfg),
      readOptions: readOptionsOf(this.opts.cfg),
      prewarm: prewarmOf(this.opts.cfg),
      verbose: verboseOf(this.opts.cfg),
      duplicateReaders: duplicateReaders(this.opts.botDir),
      minChars: limits.min,
      maxChars: limits.max,
      gapMs: gapOf(this.opts.cfg),
      voiceCount: VOICE_OPTIONS.length,
      platform: process.platform,
      ...this.speaker.snapshot(),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** 把当前配置里的开关推给 speaker；每次开口前都会调一次，改配置不用重启。 */
  private syncSpeaker(): void {
    this.speaker.setOptions({
      gapMs: gapOf(this.opts.cfg),
      prewarm: prewarmOf(this.opts.cfg),
      verbose: verboseOf(this.opts.cfg),
    });
  }

  /**
   * 试听：按参数（没给的用当前配置）合成一句并放出来，回来告诉你能不能出声、多快。
   *
   * 面板上换个音色、拧一下语速，按一下就知道这台机器认不认、听着是不是想要的那个。
   * 顺带把参数里不合法的东西挡掉：只认 Edge TTS 的写法（`+15%` / `+10Hz`）。
   */
  private async preview(raw: unknown): Promise<Record<string, unknown>> {
    this.syncSpeaker();
    const arg = (raw ?? {}) as Record<string, unknown>;
    const current = this.style;
    const text = typeof arg.text === 'string' && arg.text.trim()
      ? arg.text.trim().slice(0, 120)
      : '你好，这是现在的音色、语速和音调——听得清楚吗？';
    const style: SpeechStyle = {
      voice: shortName(arg.voice) ?? current.voice,
      rate: prosody(arg.rate, /^[+-]?\d{1,3}%$/) ?? current.rate,
      pitch: prosody(arg.pitch, /^[+-]?\d{1,3}Hz$/) ?? current.pitch,
      volume: prosody(arg.volume, /^[+-]?\d{1,3}%$/) ?? current.volume,
    };
    const result = await this.speaker.audition(text, style);
    const label = `${style.voice} ${style.rate} ${style.pitch} ${style.volume}`;
    if (result.ok) this.log(`试听 ${label}：可用（合成 ${result.synthMs ?? 0}ms，共 ${result.ms}ms）`);
    else this.log(`试听 ${label}：失败 —— ${result.error ?? '原因不明'}`);
    return {
      ...result,
      ...(result.ok ? {} : { error: explainTtsError(result.error ?? ''), detail: result.error ?? '' }),
      voice: style.voice,
      voiceName: voiceLabel(style.voice),
      rate: style.rate,
      pitch: style.pitch,
      volume: style.volume,
      text,
    };
  }

  /* ---------- 流 ---------- */

  private onStreamEvent(event: StreamEvent): void {
    if (this.opts.cfg.enabled === false) return;
    const ev = event as unknown as StreamLike;
    switch (ev.type) {
      case 'response.output_item.added': {
        const item = ev.item;
        if (!item || item.type !== 'function_call') return;
        const name = item.name ?? '';
        if (name === QUIET_TOOL) {
          this.hush('模型要求安静');
          return;
        }
        if (name === SAY_TOOL) {
          if (readSayOf(this.opts.cfg)) this.open(ev.output_index ?? 0, 'say', name);
          return;
        }
        if (name === ASK_TOOL && readAskOf(this.opts.cfg)) this.open(ev.output_index ?? 0, 'ask', name);
        return;
      }
      case 'response.function_call_arguments.delta': {
        const stream = this.streams.get(ev.output_index ?? 0);
        if (!stream || !ev.delta) return;
        const text = stream.field.feed(ev.delta);
        if (text) this.feed(stream, text);
        return;
      }
      case 'response.function_call_arguments.done':
      case 'response.output_item.done': {
        const stream = this.streams.get(ev.output_index ?? 0);
        if (stream) this.finish(stream, ev.arguments ?? ev.item?.arguments);
        return;
      }
      case 'response.failed':
      case 'error':
        this.hush('这一轮出错');
        return;
      case 'response.created':
        if (!this.batchStart) this.batchStart = Date.now();
        return;
      default:
        return;
    }
  }

  private open(index: number, kind: 'say' | 'ask', tool: string): void {
    if (!this.batchStart) this.batchStart = Date.now();
    this.streams.set(index, {
      index,
      kind,
      tool,
      field: new JsonStringField(kind === 'ask' ? 'question' : 'script'),
      filter: new MarkerFilter(),
      chunker: new SentenceChunker(this.limits),
      chunks: 0,
      startedAt: Date.now(),
    });
    this.log(`${tool} 开始生成（第 ${index} 条调用）`);
  }

  /** 增量清过标记、切过句，整块交给播放队列。 */
  private feed(stream: CallStream, text: string): void {
    const cleaned = stream.filter.push(text);
    if (!cleaned) return;
    for (const chunk of stream.chunker.push(cleaned)) this.speak(stream, chunk);
  }

  /** 一条调用写完了：把尾巴上不够长的字也说完。 */
  private finish(stream: CallStream, rawArgs?: string): void {
    this.streams.delete(stream.index);
    const tail = stream.filter.flush();
    if (tail) for (const chunk of stream.chunker.push(tail)) this.speak(stream, chunk);
    for (const chunk of stream.chunker.flush()) this.speak(stream, chunk);
    if (stream.kind === 'ask' && readOptionsOf(this.opts.cfg)) {
      const options = optionsOf(rawArgs);
      if (options.length) this.speak(stream, `可选：${options.join('；')}`);
    }
    const ms = Date.now() - stream.startedAt;
    this.log(`${stream.tool} 写完（${ms}ms，共 ${stream.chunks} 块）`);
  }

  /** 一轮结束还没收尾的调用，补一次收尾。 */
  private finishAll(): void {
    for (const stream of [...this.streams.values()]) this.finish(stream);
  }

  private speak(stream: CallStream, chunk: string): void {
    const said = speakable(chunk);
    if (!said) return;
    stream.chunks++;
    const ms = this.batchStart ? Date.now() - this.batchStart : 0;
    if (stream.chunks === 1) this.log(`切出第 1 块（${said.length} 字，开写后 ${ms}ms）：${brief(said)}`);
    else if (verboseOf(this.opts.cfg)) this.log(`切出第 ${stream.chunks} 块（${said.length} 字，开写后 ${ms}ms）`);
    // 嗓音、停顿这些是活配置，每块开口前重读一遍
    this.syncSpeaker();
    this.speaker.say(said, this.style);
  }

  private hush(reason: string): void {
    const hadWork = this.speaker.speaking || this.speaker.queued > 0;
    this.streams.clear();
    this.speaker.hush();
    if (hadWork) this.log(`清空队列（${reason}）`);
  }
}

/**
 * 把合成的原始报错翻成人话，面板上直接给用户看。
 * 认不出来的原样返回，别把信息吞了。
 */
function explainTtsError(raw: string): string {
  if (!raw) return '合成失败，原因不明';
  if (/no turn\.end|Stream closed before/i.test(raw)) {
    return '这个音色没能合成出来：Edge 朗读接口没有提供它，或者连接被对端断开了。换一个音色再试。';
  }
  if (/No audio data received/i.test(raw)) {
    return '没有收到音频：这个音色可能不支持这段文字（比如英文音色念中文），换段话或换音色试试。';
  }
  if (/timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(raw)) {
    return '连不上朗读服务：检查网络后重试。';
  }
  return raw;
}

/** Edge TTS 的 ShortName 形状：`zh-CN-XiaoyiNeural`。不合格就当没给。 */
function shortName(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{2,3}-[A-Za-z0-9-]{2,40}$/.test(value.trim()) ? value.trim() : null;
}

/** 语速／音调／音量：只认 `+15%`、`-10Hz` 这类写法。 */
function prosody(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : null;
}

/** 日志里露一小段就够看。 */
function brief(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** `pet_ask` 的选项；参数不是合法 JSON 时当没有。 */
function optionsOf(rawArgs: string | undefined): string[] {
  if (!rawArgs) return [];
  try {
    const parsed = JSON.parse(rawArgs) as { options?: unknown };
    return Array.isArray(parsed.options) ? parsed.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : [];
  } catch {
    return [];
  }
}
