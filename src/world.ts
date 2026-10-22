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
 * 这里不碰气泡、不发事件；给模型的只有三个只管声音的工具（查嗓音、改嗓音、立刻停），
 * 改的是本扩展自己的配置，和别人的朗读无关。
 */
import type {
  OutputTap,
  RunPhase,
  ToolDef,
  ToolOutcome,
  World,
  WorldHost,
  WorldLamp,
  WorldWebUiDecl,
} from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { fileURLToPath } from 'node:url';
import { JsonStringField } from './args.ts';
import { SentenceChunker } from './chunker.ts';
import { MarkerFilter, speakable } from './clean.ts';
import {
  CHUNK_MAX_CEIL,
  CHUNK_MAX_FLOOR,
  CHUNK_MIN_CEIL,
  CHUNK_MIN_FLOOR,
  GAP_MAX,
  chunkLimits,
  gapOf,
  numberIn,
  streamVoiceConfigGroups,
  streamVoiceText,
  STREAMVOICE_ID,
  type StreamVoiceConfigSection,
} from './config.ts';
import { Speaker } from './speaker.ts';
import {
  allowSelfTuningOf,
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
import { nameOf, prosodyValue, resolveVoice, speechToolDefs, voiceListBrief, type SpeechPatch } from './tools.ts';

/** 会念出来的工具：`pet_say` 的 script，`pet_ask` 的 question。 */
const SAY_TOOL = 'pet_say';
const ASK_TOOL = 'pet_ask';
/** 模型要求安静：正在说的停掉，排队的丢掉。 */
const QUIET_TOOL = 'pet_quiet';

/**
 * 环境提示词的默认模板，随包发；用户在 World 页改过之后，框架优先读
 * `<部署目录>/worlds/streamvoice/ENV_PROMPT.md` 那份覆盖文件。
 */
const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 回执与日志里用的字段名。 */
const PROSODY_LABEL: Record<'rate' | 'pitch' | 'volume', string> = {
  rate: '语速',
  pitch: '音调',
  volume: '音量',
};

const CONTENT_LABEL: Record<'readSay' | 'readAsk' | 'readOptions', string> = {
  readSay: '念台词',
  readAsk: '念问句',
  readOptions: '念选项',
};

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
  /** 把改动深合并进 `worlds.streamvoice` 并落盘；模型改嗓音时用。 */
  persist: (patch: Record<string, unknown>) => void;
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

  /**
   * 给模型的工具：查嗓音、改嗓音、立刻闭嘴。
   *
   * `allowSelfTuning` 关掉时 `speech_tune` 不出现在工具表里——模型根本看不到它，
   * 不是「看到了再被拒」，这样它也不会反复尝试。
   */
  tools(): ToolDef[] {
    if (this.opts.cfg.enabled === false) return [];
    return speechToolDefs({
      status: () => this.describeForModel(),
      tune: (patch) => this.tune(patch),
      silence: () => this.silenceForModel(),
      allowTuning: () => allowSelfTuningOf(this.opts.cfg),
    });
  }

  /**
   * 环境提示词里的变量。每次重建前缀都会重新取，所以模型看到的永远是当下这份设置，
   * 不是启动时那份。返回的键必须与 `ENV_PROMPT.md` 里的占位符一一对应。
   */
  envPromptVars(): Record<string, string> {
    const style = this.style;
    const cfg = this.opts.cfg;
    const limits = this.limits;
    const others = duplicateReaders(this.opts.botDir);
    return {
      'streamvoice.state': `${voiceLabel(style.voice)}（${style.voice}），语速 ${style.rate}，音调 ${style.pitch}，音量 ${style.volume}。`,
      'streamvoice.content': `念什么：台词${onOff(readSayOf(cfg))}、问句${onOff(readAskOf(cfg))}、选项${onOff(readOptionsOf(cfg))}。`,
      'streamvoice.chunks': `切块与节奏：短句并下一句的门槛 ${limits.min} 字，单块上限 ${limits.max} 字，块间停顿 ${gapOf(cfg)}ms。`,
      'streamvoice.switches': `预热${onOff(prewarmOf(cfg))}、详细日志${onOff(verboseOf(cfg))}、总开关${onOff(cfg.enabled !== false)}。`,
      'streamvoice.canTune': allowSelfTuningOf(cfg)
        ? '主人允许你自己改这些设置（`worlds.streamvoice.allowSelfTuning` 开着），改完下一句就生效。'
        : '主人关掉了「允许模型自己调嗓音」：`speech_tune` 不在你的工具表里，要改得请主人去控制台改。',
      'streamvoice.voices': voiceGroupsBrief(),
      'streamvoice.otherReaders': others.length
        ? `注意：${others.join('、')}也在整段朗读，同一句会被念两遍；可以提醒主人把它那边关掉。`
        : '',
    };
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
      // 环境提示词：默认模板随包发，用户在 World 页改的是部署目录那份覆盖文件
      promptDocs: [{
        key: `worlds.${STREAMVOICE_ID}.env`,
        title: t.promptTitle,
        description: t.promptDesc,
        path: ENV_PROMPT,
        role: 'envPrompt',
        vars: [
          { name: 'streamvoice.state', description: '当前音色、语速、音调、音量' },
          { name: 'streamvoice.content', description: '念台词／问句／选项的开关' },
          { name: 'streamvoice.chunks', description: '切块门槛、单块上限、块间停顿' },
          { name: 'streamvoice.switches', description: '预热、详细日志、总开关' },
          { name: 'streamvoice.canTune', description: '模型能不能自己改设置（取决于 allowSelfTuning）' },
          { name: 'streamvoice.voices', description: '可用音色清单：中文名 + ShortName' },
          { name: 'streamvoice.otherReaders', description: '还有谁也在整段朗读；没有则留空', multiline: true },
        ],
      }],
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
      allowSelfTuning: allowSelfTuningOf(this.opts.cfg),
      minChars: limits.min,
      maxChars: limits.max,
      gapMs: gapOf(this.opts.cfg),
      voiceCount: VOICE_OPTIONS.length,
      platform: process.platform,
      ...this.speaker.snapshot(),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /* ---------- 工具：模型自己改设置 ---------- */

  /** 给 `speech_status` 的一段话：模型读完就知道自己的全部设置和此刻状态。 */
  private describeForModel(): string {
    const style = this.style;
    const cfg = this.opts.cfg;
    const limits = this.limits;
    const on = cfg.enabled !== false;
    const now = !on ? '本扩展已关闭，不会出声' : this.speaker.speaking ? '此刻正在说' : '此刻待命';
    const queue = this.speaker.queued > 0 ? `，还有 ${this.speaker.queued} 块排队` : '';
    return `嗓音：${voiceLabel(style.voice)}（${style.voice}），语速 ${style.rate}，音调 ${style.pitch}，音量 ${style.volume}。`
      + `念什么：台词${onOff(readSayOf(cfg))}、问句${onOff(readAskOf(cfg))}、选项${onOff(readOptionsOf(cfg))}。`
      + `切块与节奏：短句并下一句的门槛 ${limits.min} 字，单块上限 ${limits.max} 字，块间停顿 ${gapOf(cfg)}ms。`
      + `高级：预热${onOff(prewarmOf(cfg))}、详细日志${onOff(verboseOf(cfg))}；总开关${onOff(on)}。`
      + `${now}${queue}。`;
  }

  /**
   * 按模型给的参数改设置——这个扩展能调的项都在这里，和配置页改的是同一份 `worlds.streamvoice`。
   *
   * 先把口语值翻成合法档位（语速/音调/音量对齐到 5，切块与停顿夹进配置页的范围），
   * 再写进配置（落盘 + 活引用立即生效），最后把「原来什么样、现在什么样」讲回去，
   * 模型才知道自己改成了什么、要不要继续调。
   */
  private tune(patch: SpeechPatch): string | ToolOutcome {
    const cfg = this.opts.cfg;
    if (!allowSelfTuningOf(cfg)) {
      return {
        text: '这台机器把「允许模型自己调嗓音」关着（worlds.streamvoice.allowSelfTuning），我不能自己改。要改得主人去控制台。',
        failed: true,
      };
    }

    const before = this.style;
    const next: Record<string, unknown> = {};
    const changed: string[] = [];

    // ---- 嗓音 ----
    if (patch.voice !== undefined) {
      const found = resolveVoice(patch.voice);
      if (!found) {
        return {
          text: `没有叫「${patch.voice}」的音色。常用的中文音色：${voiceListBrief()}；`
            + '另外还有粤语、台湾、英/日/韩的音色。问一下主人想换哪个，别自己猜。',
          failed: true,
        };
      }
      next.voice = found.id;
      if (found.id !== before.voice) changed.push(`音色 ${voiceLabel(before.voice)} → ${nameOf(found)}`);
    }
    for (const key of ['rate', 'pitch', 'volume'] as const) {
      const raw = patch[key];
      if (raw === undefined) continue;
      const value = prosodyValue(key === 'pitch' ? 'hz' : 'percent', raw);
      next[key] = value;
      if (value !== before[key]) changed.push(`${PROSODY_LABEL[key]} ${before[key]} → ${value}`);
    }

    // ---- 念什么 ----
    for (const key of ['readSay', 'readAsk', 'readOptions'] as const) {
      const raw = patch[key];
      if (raw === undefined) continue;
      const was = cfg[key] !== false;
      next[key] = raw;
      if (raw !== was) changed.push(`${CONTENT_LABEL[key]} ${onOff(was)} → ${onOff(raw)}`);
    }

    // ---- 切块与节奏 ----
    const limits = chunkLimits(cfg);
    let min = limits.min;
    let max = limits.max;
    if (patch.chunkMinChars !== undefined) min = numberIn(patch.chunkMinChars, min, CHUNK_MIN_FLOOR, CHUNK_MIN_CEIL);
    if (patch.chunkMaxChars !== undefined) max = numberIn(patch.chunkMaxChars, max, CHUNK_MAX_FLOOR, CHUNK_MAX_CEIL);
    // 和 chunkLimits() 一样：max 永远不小于 min。谁给的值越界，就让 max 让路
    const bumpedMax = max < min;
    if (bumpedMax) max = min;
    if (min !== limits.min) {
      next.chunkMinChars = min;
      changed.push(`切块门槛 ${limits.min} → ${min} 字`);
    }
    if (max !== limits.max) {
      next.chunkMaxChars = max;
      changed.push(`单块上限 ${limits.max} → ${max} 字${bumpedMax ? '（比门槛小，已抬到门槛）' : ''}`);
    }
    if (patch.gapMs !== undefined) {
      const gap = numberIn(patch.gapMs, gapOf(cfg), 0, GAP_MAX);
      next.gapMs = gap;
      if (gap !== gapOf(cfg)) changed.push(`块间停顿 ${gapOf(cfg)} → ${gap}ms`);
    }

    // ---- 高级与总开关 ----
    if (patch.prewarm !== undefined) {
      const was = prewarmOf(cfg);
      next.prewarm = patch.prewarm;
      if (patch.prewarm !== was) changed.push(`预热 ${onOff(was)} → ${onOff(patch.prewarm)}`);
    }
    if (patch.verbose !== undefined) {
      const was = verboseOf(cfg);
      next.verbose = patch.verbose;
      if (patch.verbose !== was) changed.push(`详细日志 ${onOff(was)} → ${onOff(patch.verbose)}`);
    }
    let disabling = false;
    if (patch.enabled !== undefined) {
      const was = cfg.enabled !== false;
      next.enabled = patch.enabled;
      if (patch.enabled !== was) {
        changed.push(`总开关 ${onOff(was)} → ${onOff(patch.enabled)}`);
        disabling = !patch.enabled;
      }
    }

    if (!Object.keys(next).length) {
      return '这次没给任何能改的字段，什么都没改。至少给一项（字段见工具说明），不确定当前值就先调 speech_status。';
    }

    this.opts.persist(next);
    const after = this.style;
    const afterLimits = this.limits;
    if (changed.length) this.log(`模型改了设置：${changed.join('，')}`);

    const head = changed.length ? `改动：${changed.join('，')}。` : '给的数值和原来一样，配置没变。';
    const now = `现在：${voiceLabel(after.voice)}，语速 ${after.rate}，音调 ${after.pitch}，音量 ${after.volume}；`
      + `念台词${onOff(readSayOf(cfg))}、问句${onOff(readAskOf(cfg))}、选项${onOff(readOptionsOf(cfg))}；`
      + `切块 ${afterLimits.min}–${afterLimits.max} 字，停顿 ${gapOf(cfg)}ms；`
      + `预热${onOff(prewarmOf(cfg))}、日志${onOff(verboseOf(cfg))}。下一句起生效。`;
    const warn = disabling
      ? '注意：总开关已经关掉，这个扩展从现在起停止工作、不再出声，我也没办法自己再打开——要恢复得请主人在控制台「流式语音播报」页重新打开。'
      : '';
    return `${head}${now}${warn}`;
  }

  /** `speech_silence`：停掉当前与队列，但不影响后面的新台词。 */
  private silenceForModel(): string {
    const queued = this.speaker.queued;
    const speaking = this.speaker.speaking;
    if (!speaking && queued === 0) return '现在没在念、队列也是空的，不用停。';
    this.hush('模型要求先停一下');
    return `已停：${speaking ? '正在念的那一块中断了' : '本来没在念'}，队列里的 ${queued} 块丢掉了。后面新说的话照常念。`;
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

/** 开关在人话里的样子。 */
function onOff(value: boolean): string {
  return value ? '开' : '关';
}

/**
 * 按语言分组的音色名，给环境提示词用。
 *
 * 只写名字不写 ShortName：名字能被 `resolveVoice()` 认出来，而 29 个 ShortName 全写进
 * 前缀要吃掉七百多个字符，每次请求都付一遍不值得。要精确写法时看配置页。
 */
function voiceGroupsBrief(): string {
  const groups: Array<[string, string]> = [
    ['中文', 'zh-CN'],
    ['粤语', 'zh-HK'],
    ['台湾', 'zh-TW'],
    ['英语', 'en'],
    ['日语', 'ja'],
    ['韩语', 'ko'],
  ];
  const parts = groups.map(([label, prefix]) => {
    const names = VOICE_OPTIONS.filter((v) => v.id.startsWith(prefix)).map(nameOf);
    return names.length ? `${label}：${names.join('、')}` : '';
  }).filter(Boolean);
  return `${parts.join('；')}。给名字或 ShortName 都行。`;
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
