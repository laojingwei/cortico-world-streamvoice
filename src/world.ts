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
  ENGINE_API,
  ENGINE_EDGE,
  GAP_MAX,
  apiOf,
  chunkLimits,
  edgeVoicePanelSpec,
  apiVoicePanelSpec,
  engineLabel,
  engineOf,
  gapOf,
  numberIn,
  streamVoiceConfigGroups,
  streamVoiceText,
  STREAMVOICE_ID,
  type PanelFieldSpec,
  type PanelSpec,
  type SpeechEngine,
  type StreamVoiceConfigSection,
} from './config.ts';
import { apiModelRows, apiVoiceLabel, apiVoiceRows, catalogFits, catalogOf, setActiveCatalog } from './api-catalog.ts';
import {
  API_FORMATS,
  API_TIMEOUT_MAX,
  API_TIMEOUT_MIN,
  clampSpeed,
  clampUnit,
  isApiFormat,
  normalizeBase,
  probeApi,
  unitFactor,
} from './api-tts.ts';
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
import { DEFAULT_PITCH, DEFAULT_VOICE, PITCH_OPTIONS, VOICE_OPTIONS, voiceLabel } from './voices.ts';
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
  /** 后台探测清单是否在跑，避免重复发请求。 */
  private probing = false;

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

  /**
   * 两个「启用」开关与 `engine` 联动。
   *
   * 配置页把两套参数都摆出来，靠开关决定谁生效：开一边就把另一边关掉。两个都开着这种情况
   * 只可能是用户刚打开了另一边（原来那个一直是开的），所以取「当前引擎的对面」；
   * 两个都关着则保持现有引擎，只把对应那侧的开关点亮。
   */
  private syncEngineFlags(): void {
    const cfg = this.opts.cfg;
    const engine = engineOf(cfg);
    const wantEdge = cfg.useEdge === true;
    const wantApi = cfg.useApi === true;
    let target: SpeechEngine = engine;
    if (wantEdge && wantApi) target = engine === ENGINE_EDGE ? ENGINE_API : ENGINE_EDGE;
    else if (wantEdge !== wantApi) target = wantEdge ? ENGINE_EDGE : ENGINE_API;
    if (
      cfg.engine === target
      && cfg.useEdge === (target === ENGINE_EDGE)
      && cfg.useApi === (target === ENGINE_API)
    ) return;
    this.opts.persist({ engine: target, useEdge: target === ENGINE_EDGE, useApi: target === ENGINE_API });
  }

  /**
   * 把缓存里的清单交给 `configOptions`（配置页下拉读它），顺便在没缓存时补探一次。
   *
   * 只探一次、探完落盘：配置页一打开就有音色可选，不用每次去点「连接测试」。
   */
  private refreshCatalog(): void {
    const cfg = this.opts.cfg;
    const api = apiOf(cfg);
    const cached = catalogOf(cfg);
    setActiveCatalog(catalogFits(cached, api.base) ? cached : null);
    if (cached && catalogFits(cached, api.base)) return;
    if (engineOf(cfg) !== ENGINE_API) return;
    void this.probeApiCatalog(api.base, api.key, api);
  }

  /** 后台探一次并缓存；失败只记一行日志，不打扰用户。 */
  private async probeApiCatalog(base: string, key: string, api: { voice: string; model: string }): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const result = await probeApi(base, key, 8_000);
      if (!result.ok) {
        this.log(`自动探测音色清单失败：${result.error ?? '原因不明'}`);
        return;
      }
      const voices = result.voices.length ? result.voices : [];
      const models = result.models.length ? result.models : [];
      if (!voices.length && !models.length) return;
      const catalog = { base: result.base, at: Date.now(), voices, models };
      setActiveCatalog(catalog);
      this.opts.persist({ apiCatalog: catalog });
      this.log(`已缓存音色清单：${voices.length} 个音色、${models.length} 个模型（${catalog.base}）`);
      // 缓存里的第一个音色可能比配置里的更靠得住；只在配置没指定时补一次
      if (!api.voice && voices.length) this.opts.persist({ apiVoice: voices[0] });
    } catch (err) {
      this.log(`自动探测音色清单出错：${(err as Error).message}`);
    } finally {
      this.probing = false;
    }
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.syncEngineFlags();
    this.refreshCatalog();
    const style = this.style;
    const limits = this.limits;
    const engine = engineOf(this.opts.cfg);
    const api = apiOf(this.opts.cfg);
    this.syncSpeaker();
    host.log.info(
      `就绪：引擎 ${engineLabel(engine)}`
      + (engine === 'api'
        ? `（${api.base}，音色 ${api.voice}，格式 ${api.format}，语速 ${api.speed}×，播放音量 ${api.volume}×）`
        : `（嗓音 ${style.voice} 语速 ${fmtX(style.rate)} ${style.pitch} 音量 ${fmtX(style.volume)}）`)
      + `，切块 ${limits.min}–${limits.max} 字，`
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
    const engine = engineOf(cfg);
    const api = apiOf(cfg);
    const others = duplicateReaders(this.opts.botDir);
    return {
      'streamvoice.engine': engine === 'api'
        ? `合成引擎：自建 API 服务 ${api.base}，音色 ${api.voice}，格式 ${api.format}`
          + `${api.model ? `，模型 ${api.model}` : ''}`
          + `${api.instructions ? `，整段语气指令「${brief(api.instructions)}」` : ''}`
          + `${api.key ? '，需要令牌' : ''}。这一套参数整段共用，不能逐句改。`
        : `合成引擎：Edge 朗读接口，音色 ${voiceLabel(style.voice)}（${style.voice}），`
          + `语速 ${fmtX(style.rate)}，音调 ${style.pitch}，音量 ${fmtX(style.volume)}。`,
      'streamvoice.state': engine === 'api'
        ? `嗓音 ${api.voice}（API 服务返回的声音），语速倍率 ${api.speed}×，播放音量 ${api.volume}×；音调由后端决定。`
        : `嗓音 ${voiceLabel(style.voice)}（${style.voice}），语速 ${fmtX(style.rate)}，音调 ${style.pitch}，音量 ${fmtX(style.volume)}。`,
      'streamvoice.content': `念什么：台词${onOff(readSayOf(cfg))}、问句${onOff(readAskOf(cfg))}、选项${onOff(readOptionsOf(cfg))}。`,
      'streamvoice.chunks': `切块与节奏：短句并下一句的门槛 ${limits.min} 字，单块上限 ${limits.max} 字，块间停顿 ${gapOf(cfg)}ms。`,
      'streamvoice.switches': `预热${onOff(prewarmOf(cfg))}、详细日志${onOff(verboseOf(cfg))}、总开关${onOff(cfg.enabled !== false)}。`,
      'streamvoice.canTune': allowSelfTuningOf(cfg)
        ? '主人允许你自己改这些设置（`worlds.streamvoice.allowSelfTuning` 开着），改完下一句就生效。'
        : '主人关掉了「允许模型自己调嗓音」：`speech_tune` 不在你的工具表里，要改得请主人去控制台改。',
      'streamvoice.voices': engine === 'api' ? this.apiVoicesBrief() : voiceGroupsBrief(),
      'streamvoice.otherReaders': others.length
        ? `注意：${others.join('、')}也在整段朗读，同一句会被念两遍；可以提醒主人把它那边关掉。`
        : '',
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = streamVoiceText(language);
    // 配置页刚写完「启用」开关，这里有请求就会跑一次：谁开谁生效，另一边自动关掉
    this.syncEngineFlags();
    this.refreshCatalog();
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
      /**
       * 三个页签：运行状态、Edge 语音、API 语音。
       *
       * 两套引擎各自一页，页内只有那一套参数和一个「启用」开关——用户想去哪一边启用就点
       * 哪一边，不用在两套并排的字段里猜哪一组是此刻生效的。「配置」页签（框架画的）只剩
       * 念什么、切块、高级这些跟引擎无关的项。
       */
      panels: [
        { id: 'stream', title: t.label, getMethods: ['state', 'hush'] },
        {
          id: 'edge-voice',
          title: t.voiceGroup,
          description: t.voiceGroupDesc,
          getMethods: ['fields', 'state', 'preview'],
        },
        {
          id: 'api-voice',
          title: t.apiGroup,
          description: t.apiGroupDesc,
          getMethods: ['fields', 'state', 'preview', 'probe'],
        },
      ],
      // 环境提示词：默认模板随包发，用户在 World 页改的是部署目录那份覆盖文件
      promptDocs: [{
        key: `worlds.${STREAMVOICE_ID}.env`,
        title: t.promptTitle,
        description: t.promptDesc,
        path: ENV_PROMPT,
        role: 'envPrompt',
        vars: [
          { name: 'streamvoice.engine', description: '当前引擎：Edge 朗读，或自建 API 服务（地址、音色、格式）' },
          { name: 'streamvoice.state', description: '当前音色；Edge 引擎下还带语速、音调、音量' },
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
        // 三个页签共用：状态、字段表、保存
        if (method === 'state') return this.state(language);
        if (method === 'fields') {
          if (panel === 'edge-voice') return this.voiceFields('edge', language);
          if (panel === 'api-voice') return this.voiceFields('api', language);
        }
        if (method === 'save') {
          if (panel === 'edge-voice') return this.saveVoiceFields('edge', args?.[0]);
          if (panel === 'api-voice') return this.saveVoiceFields('api', args?.[0]);
        }
        if (panel === 'stream') {
          if (method === 'hush') {
            this.hush('面板上按了静音');
            return this.state(language);
          }
        } else if (panel === 'edge-voice' || panel === 'api-voice') {
          // 在哪一页按试听就用那一套，哪怕它没被「启用」——试听本来就是拿来做对比的
          if (method === 'preview') {
            return this.preview(args?.[0], panel === 'api-voice' ? ENGINE_API : ENGINE_EDGE);
          }
          // 面板上的「连接测试」：拿它给的地址与令牌现问一遍，不改配置
          if (method === 'probe' && panel === 'api-voice') return this.probe(args?.[0]);
        }
        throw new Error(`unknown ${panel}.${method}`);
      },
    };
  }

  /**
   * 页签上的字段表：schema 与文案来自 config.ts，当前值从活配置里现读。
   *
   * 两套引擎各一页，但前端走同一套渲染：它只按 `type` 摆控件，不认识任何字段名。
   * API 的音色、模型是下拉，候选项来自最近一次探测缓存（进程内那份），所以打开就有，
   * 不必先点「连接测试」。
   */
  private voiceFields(which: 'edge' | 'api', language: Language): PanelSpec {
    const spec = which === 'edge' ? edgeVoicePanelSpec(language) : apiVoicePanelSpec(language);
    const cfg = this.opts.cfg;
    const api = apiOf(cfg);
    const edgeOn = engineOf(cfg) === ENGINE_EDGE;
    // Edge 那几项一律读配置原值：`this.style` 在 API 引擎下报的是 API 的参数
    const pickStr = (value: unknown, fallback: string): string =>
      (typeof value === 'string' && value.trim() ? value : fallback);
    const keySet = api.key !== '';
    const en = language === 'en';
    const placeholders = {
      set: en ? 'set — leave blank to keep' : '已设置，留空不改',
      empty: en ? 'not set (local services usually need none)' : '没有设置（本地服务通常不用）',
    };

    const fields = spec.fields.map((field): PanelFieldSpec => {
      const out: PanelFieldSpec = { ...field };
      switch (field.key) {
        case 'useEdge':
          out.value = edgeOn;
          break;
        case 'useApi':
          out.value = !edgeOn;
          break;
        case 'voice':
          out.value = pickStr(cfg.voice, DEFAULT_VOICE);
          break;
        case 'rate':
          out.value = unitFactor(cfg.rate);
          break;
        case 'pitch':
          out.value = pickStr(cfg.pitch, DEFAULT_PITCH);
          break;
        case 'volume':
          out.value = unitFactor(cfg.volume);
          break;
        case 'apiBase':
          out.value = api.base;
          break;
        case 'apiKey':
          // 令牌只报「有没有」，值永远不下发
          out.value = '';
          out.placeholder = keySet ? placeholders.set : placeholders.empty;
          break;
        case 'apiVoice': {
          out.value = api.voice;
          const rows = apiVoiceRows(language);
          out.options = rows.length ? rows : [{ value: api.voice, label: api.voice }];
          break;
        }
        case 'apiModel':
          out.value = api.model;
          out.options = apiModelRows(language);
          break;
        case 'apiFormat':
          out.value = api.format;
          break;
        case 'apiLanguage':
          out.value = api.language;
          break;
        case 'apiInstructions':
          out.value = api.instructions;
          break;
        case 'apiSpeedFactor':
          out.value = api.speed;
          break;
        case 'apiVolume':
          out.value = api.volume;
          break;
        case 'apiTimeoutMs':
          out.value = api.timeoutMs;
          break;
        default:
          break;
      }
      return out;
    });
    return { ...spec, fields };
  }

  /** 面板上看到的数：切了几块、第一块多快出声。 */
  state(language: Language = 'zh'): Record<string, unknown> {
    this.syncEngineFlags();
    const style = this.style;
    const limits = this.limits;
    const engine = engineOf(this.opts.cfg);
    const api = apiOf(this.opts.cfg);
    const catalog = catalogOf(this.opts.cfg);
    return {
      enabled: this.opts.cfg.enabled !== false,
      engine,
      engineName: engineLabel(engine),
      useEdge: engine === ENGINE_EDGE,
      useApi: engine === ENGINE_API,
      voice: style.voice,
      voiceName: voiceLabel(style.voice),
      rate: style.rate,
      pitch: style.pitch,
      volume: style.volume,
      apiBase: api.base,
      apiVoice: api.voice,
      apiModel: api.model,
      apiFormat: api.format,
      apiInstructions: api.instructions,
      apiLanguage: api.language,
      apiSpeedFactor: api.speed,
      apiVolume: api.volume,
      apiTimeoutMs: api.timeoutMs,
      // 上次探测到的清单：面板一打开就能画成下拉，不用每次重测
      apiVoices: (catalog?.voices ?? []).map((name) => ({ value: name, label: apiVoiceLabel(name, language) })),
      apiModels: catalog?.models ?? [],
      apiCatalogAt: catalog?.at ?? 0,
      // 令牌只报有没有，绝不回显
      apiKeySet: !!api.key,
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

  /** 给模型看的 API 音色清单；没缓存时说清怎么把清单拿回来。 */
  private apiVoicesBrief(): string {
    const catalog = catalogOf(this.opts.cfg);
    if (!catalog?.voices.length) {
      return '当前是 API 引擎，音色由后端决定。还没拿到清单：调 speech_status 看当前音色，'
        + '或请主人在面板上点「连接测试」——之后这里会列出全部可用音色。';
    }
    const voices = catalog.voices.map((name) => apiVoiceLabel(name)).join('、');
    const models = catalog.models.length ? `模型：${catalog.models.join('、')}。` : '模型：不指定。';
    return `当前是 API 引擎。后端音色：${voices}。${models}换音色用 apiVoice，名字要一字不差。`;
  }

  /** 给 `speech_status` 的一段话：模型读完就知道自己的全部设置和此刻状态。 */
  private describeForModel(): string {
    const style = this.style;
    const cfg = this.opts.cfg;
    const limits = this.limits;
    const engine = engineOf(cfg);
    const api = apiOf(cfg);
    const on = cfg.enabled !== false;
    const now = !on ? '本扩展已关闭，不会出声' : this.speaker.speaking ? '此刻正在说' : '此刻待命';
    const queue = this.speaker.queued > 0 ? `，还有 ${this.speaker.queued} 块排队` : '';
    const engineLine = engine === 'api'
      ? `引擎：API 服务 ${api.base}，音色 ${api.voice}，格式 ${api.format}`
        + `${api.model ? `，模型 ${api.model}` : ''}`
        + `${api.language ? `，语言 ${api.language}` : ''}`
        + `${api.instructions ? `，整段语气「${brief(api.instructions)}」` : ''}`
        + `${api.key ? '，带访问令牌' : ''}，超时 ${api.timeoutMs}ms；`
        + `语速倍率 ${api.speed}×，播放音量 ${api.volume}×（音调只能在后端决定；rate/pitch/volume 只在 Edge 引擎下生效）。`
      : `引擎：Edge 朗读，嗓音 ${voiceLabel(style.voice)}（${style.voice}），语速 ${fmtX(style.rate)}，音调 ${style.pitch}，音量 ${fmtX(style.volume)}。`;
    return `${engineLine}`
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

    // ---- 引擎与 API ----
    if (patch.engine !== undefined) {
      const want = patch.engine.trim().toLowerCase();
      if (want !== 'edge' && want !== 'api') {
        return {
          text: `引擎只有两种：edge（Edge 朗读接口）和 api（自建的 /v1/audio/speech 服务）。没有「${patch.engine}」。`,
          failed: true,
        };
      }
      const was = engineOf(cfg);
      next.engine = want;
      // 开关跟着引擎走，否则下一次归一化会按旧开关把它拉回去
      next.useEdge = want === ENGINE_EDGE;
      next.useApi = want === ENGINE_API;
      if (want !== was) changed.push(`引擎 ${engineLabel(was)} → ${engineLabel(want)}`);
    }
    if (patch.apiBase !== undefined) {
      const base = normalizeBase(patch.apiBase);
      if (!base) {
        return {
          text: `「${patch.apiBase}」不像服务地址：要形如 http://127.0.0.1:8091/v1 的根地址；`
            + '只写主机名也行，会自动补 /v1。接口路径由扩展自己拼，不用把 /audio/speech 带上。',
          failed: true,
        };
      }
      const was = apiOf(cfg).base;
      next.apiBase = base;
      if (base !== was) changed.push(`服务地址 → ${base}`);
    }
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      next.apiKey = key;
      changed.push(key ? '访问令牌 已设置（不回显）' : '访问令牌 已清空');
    }
    if (patch.apiModel !== undefined) {
      const model = patch.apiModel.trim();
      const was = apiOf(cfg).model;
      next.apiModel = model;
      if (model !== was) changed.push(`模型名 ${was || '（空）'} → ${model || '（空）'}`);
    }
    if (patch.apiVoice !== undefined) {
      const voice = patch.apiVoice.trim();
      if (!voice) return { text: 'API 音色不能是空的：给后端认识的音色名，比如 vivian。', failed: true };
      const was = apiOf(cfg).voice;
      next.apiVoice = voice;
      if (voice !== was) changed.push(`API 音色 ${was} → ${voice}`);
    }
    if (patch.apiFormat !== undefined) {
      const format = patch.apiFormat.trim().toLowerCase();
      if (!isApiFormat(format)) {
        return {
          text: `音频格式只能选 ${API_FORMATS.join(' / ')}；给的是「${patch.apiFormat}」。`,
          failed: true,
        };
      }
      const was = apiOf(cfg).format;
      next.apiFormat = format;
      if (format !== was) changed.push(`音频格式 ${was} → ${format}`);
    }
    if (patch.apiInstructions !== undefined) {
      const instructions = patch.apiInstructions.trim();
      const was = apiOf(cfg).instructions;
      next.apiInstructions = instructions;
      if (instructions !== was) {
        changed.push(instructions ? `语气指令 → 「${brief(instructions)}」` : '语气指令 已清空');
      }
    }
    if (patch.apiLanguage !== undefined) {
      const language = patch.apiLanguage.trim();
      const was = apiOf(cfg).language;
      next.apiLanguage = language;
      if (language !== was) changed.push(`语言 ${was || '（自动）'} → ${language || '（自动）'}`);
    }
    if (patch.apiSpeedFactor !== undefined) {
      const was = apiOf(cfg).speed;
      const factor = clampSpeed(patch.apiSpeedFactor);
      next.apiSpeedFactor = factor;
      if (factor !== was) changed.push(`语速倍率 ${was}× → ${factor}×`);
    }
    if (patch.apiVolume !== undefined) {
      const was = apiOf(cfg).volume;
      const volume = unitFactor(patch.apiVolume);
      next.apiVolume = volume;
      if (volume !== was) changed.push(`API 播放音量 ${fmtX(was)} → ${fmtX(volume)}`);
    }
    // 两个启用开关：开一个就把另一个关掉，和配置页上的行为一致
    if (patch.useEdge === true && patch.useApi === true) {
      return { text: '两个引擎不能同时启用：要么 edge，要么 api。想用哪个就只开那个。', failed: true };
    }
    if (patch.useEdge === true || patch.useApi === true) {
      const target: SpeechEngine = patch.useEdge === true ? ENGINE_EDGE : ENGINE_API;
      next.engine = target;
      next.useEdge = target === ENGINE_EDGE;
      next.useApi = target === ENGINE_API;
      if (engineOf(cfg) !== target) changed.push(`启用 ${engineLabel(target)}`);
    }
    if (patch.apiTimeoutMs !== undefined) {
      const was = apiOf(cfg).timeoutMs;
      const ms = numberIn(patch.apiTimeoutMs, was, API_TIMEOUT_MIN, API_TIMEOUT_MAX);
      next.apiTimeoutMs = ms;
      if (ms !== was) changed.push(`API 超时 ${was} → ${ms}ms`);
    }

    // ---- 嗓音 ----
    if (patch.voice !== undefined) {
      const found = resolveVoice(patch.voice);
      if (!found) {
        return {
          text: `没有叫「${patch.voice}」的 Edge 音色。常用的中文音色：${voiceListBrief()}；`
            + '另外还有粤语、台湾、英/日/韩的音色。问一下主人想换哪个，别自己猜。'
            + '（如果是在调 API 引擎，音色要用 `apiVoice`，名字是后端的那一套。）',
          failed: true,
        };
      }
      // 比的是 Edge 音色本身，不是当前生效的嗓音（API 引擎下那是后端的名字）
      const wasVoice = typeof cfg.voice === 'string' && cfg.voice.trim() ? cfg.voice.trim() : DEFAULT_VOICE;
      next.voice = found.id;
      if (found.id !== wasVoice) changed.push(`音色 ${voiceLabel(wasVoice)} → ${nameOf(found)}`);
    }
    for (const key of ['rate', 'pitch', 'volume'] as const) {
      const raw = patch[key];
      if (raw === undefined) continue;
      if (key === 'pitch') {
        const value = prosodyValue('hz', Number(raw));
        next.pitch = value;
        if (value !== before.pitch) changed.push(`${PROSODY_LABEL.pitch} ${before.pitch} → ${value}`);
      } else {
        // 语速/音量是 0.1–5 的倍率（1 = 原值），夹进范围即可；不再走百分比档位
        const value = clampUnit(Number(raw));
        next[key] = value;
        const was = key === 'rate' ? before.rate : before.volume;
        if (value !== was) changed.push(`${PROSODY_LABEL[key]} ${fmtX(was)} → ${fmtX(value)}`);
      }
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
    const apiNow = apiOf(cfg);
    const engineNow = engineOf(cfg);
    const voiceLine = engineNow === 'api'
      ? `引擎 API 服务（${apiNow.base}），音色 ${apiNow.voice}，格式 ${apiNow.format}，语速倍率 ${apiNow.speed}×`
        + `${apiNow.instructions ? `，语气「${brief(apiNow.instructions)}」` : ''}；`
      : `引擎 Edge 朗读，音色 ${voiceLabel(after.voice)}，语速 ${fmtX(after.rate)}，音调 ${after.pitch}，音量 ${fmtX(after.volume)}；`;
    const now = `现在：${voiceLine}`
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
   * **用哪套引擎由所在的页签决定**（`which`），不看「启用」开关：在 API 页按试听就走 API，
   * 在 Edge 页就走 Edge，两页可以来回比对，不必先切换引擎。
   *
   * Edge 下只认 `+15%` / `+10Hz` 这类写法，音色必须是 ShortName；API 下音色就是后端自己的
   * 名字（`vivian`），还能临时试语气指令。
   */
  private async preview(raw: unknown, which?: SpeechEngine): Promise<Record<string, unknown>> {
    this.syncSpeaker();
    const arg = (raw ?? {}) as Record<string, unknown>;
    const cfg = this.opts.cfg;
    const current = this.style;
    const engine: SpeechEngine = which ?? engineOf(cfg);
    // Edge 那几项一律读配置原值：`this.style` 在 API 引擎下 voice 报的是 API 的音色
    const pickStr = (value: unknown, fallback: string): string =>
      (typeof value === 'string' && value.trim() ? value : fallback);
    const text = typeof arg.text === 'string' && arg.text.trim()
      ? arg.text.trim().slice(0, 120)
      : '你好，这是现在的音色、语速和音调——听得清楚吗？';
    const picked = (value: unknown): string | undefined =>
      (typeof value === 'string' && value.trim() ? value.trim() : undefined);

    let style: SpeechStyle;
    if (engine === 'api') {
      const base = apiOf(cfg);
      // 面板上可能刚改过地址/音色/语气还没保存，试听就用它给的那几个值
      const api = {
        ...base,
        base: normalizeBase(arg.base) || base.base,
        key: typeof arg.key === 'string' && arg.key.trim() ? arg.key.trim() : base.key,
        voice: picked(arg.voice) ?? base.voice,
        model: typeof arg.model === 'string' ? arg.model.trim() : base.model,
        instructions: typeof arg.instructions === 'string' ? arg.instructions.trim() : base.instructions,
        language: picked(arg.language) ?? base.language,
        speed: arg.speed === undefined ? base.speed : clampSpeed(arg.speed),
        volume: unitFactor(arg.volume, base.volume),
      };
      style = {
        engine,
        voice: api.voice,
        rate: current.rate,
        pitch: current.pitch,
        volume: current.volume,
        api,
      };
    } else {
      style = {
        engine,
        voice: shortName(arg.voice) ?? pickStr(cfg.voice, DEFAULT_VOICE),
        rate: unitFactor(arg.rate, unitFactor(cfg.rate)),
        pitch: prosody(arg.pitch, /^[+-]?\d{1,3}Hz$/) ?? pickStr(cfg.pitch, DEFAULT_PITCH),
        volume: unitFactor(arg.volume, unitFactor(cfg.volume)),
        api: current.api,
      };
    }

    const result = await this.speaker.audition(text, style);
    const label = describeStyle(style);
    if (result.ok) this.log(`试听（${engineLabel(engine)}）${label}：可用（合成 ${result.synthMs ?? 0}ms，共 ${result.ms}ms）`);
    else this.log(`试听（${engineLabel(engine)}）${label}：失败 —— ${result.error ?? '原因不明'}`);
    return {
      ...result,
      ...(result.ok ? {} : { error: explainTtsError(result.error ?? ''), detail: result.error ?? '' }),
      engine,
      engineName: engineLabel(engine),
      voice: style.voice,
      voiceName: voiceLabel(style.voice),
      rate: style.rate,
      pitch: style.pitch,
      volume: style.volume,
      ...(engine === 'api'
        ? {
          apiBase: style.api.base,
          apiFormat: style.api.format,
          apiSpeedFactor: style.api.speed,
          apiVolume: style.api.volume,
        }
        : {}),
      text,
    };
  }

  /**
   * 面板上的「连接测试」：照 OpenAI 的约定问一遍 `/models` 与 `/audio/voices`。
   *
   * 用的是面板上**此刻填的**地址与令牌（还没保存也行），不改任何配置。
   * 服务通了就把音色与模型清单带回去，让面板把它们变成下拉框。
   */
  private async probe(raw: unknown): Promise<Record<string, unknown>> {
    const arg = (raw ?? {}) as Record<string, unknown>;
    const current = apiOf(this.opts.cfg);
    const base = typeof arg.base === 'string' && arg.base.trim() ? arg.base.trim() : current.base;
    const key = typeof arg.key === 'string' && arg.key.trim() ? arg.key.trim() : current.key;
    const result = await probeApi(base, key, 8_000);
    if (result.ok) {
      const bits = [
        result.voices.length ? `${result.voices.length} 个音色` : '',
        result.models.length ? `${result.models.length} 个模型` : '',
      ].filter(Boolean);
      this.log(`连接测试 ${result.base}：通（${result.ms}ms${bits.length ? `，${bits.join('、')}` : ''}）`);
      // 只有测的就是配置里那个地址才留作缓存：测完别处不该把配置页的下拉换掉
      const configured = apiOf(this.opts.cfg).base;
      if ((result.voices.length || result.models.length) && result.base === configured) {
        const catalog = { base: result.base, at: Date.now(), voices: result.voices, models: result.models };
        setActiveCatalog(catalog);
        this.opts.persist({ apiCatalog: catalog });
      }
    } else {
      this.log(`连接测试 ${base}：失败 —— ${result.error ?? '原因不明'}`);
    }
    // 面板要拿带说明的标签直接画下拉，别只给一串英文名
    return {
      ...result,
      voiceRows: result.voices.map((name) => ({ value: name, label: apiVoiceLabel(name) })),
    };
  }

  /**
   * 页签上保存一组（Edge 语音 / API 语音）。
   *
   * 不走 `/api/config`：这两组已经不在「配置」页签里，框架没认领它们，POST 会当成未知组拒掉。
   * 校验因此放在这里做，规则和原先写在 schema 里的一致（枚举、范围、地址规范）；写进去的
   * 仍是同一份 `worlds.streamvoice`，落盘 + 活引用立即生效，下一句就按新的来。
   *
   * 两个「启用」开关互斥：在本页打开就把另一个关掉，和 `syncEngineFlags()` 的口径一致。
   */
  private saveVoiceFields(which: 'edge' | 'api', raw: unknown): Record<string, unknown> {
    const arg = (raw ?? {}) as Record<string, unknown>;
    const cfg = this.opts.cfg;
    const next: Record<string, unknown> = {};
    const changed: string[] = [];
    const fail = (text: string): Record<string, unknown> => ({ ok: false, error: text });
    const num = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };

    // ---- 启用开关 ----
    const wantSwitch = which === 'edge' ? arg.useEdge : arg.useApi;
    if (wantSwitch === true) {
      const target: SpeechEngine = which === 'edge' ? ENGINE_EDGE : ENGINE_API;
      if (engineOf(cfg) !== target) {
        next.engine = target;
        next.useEdge = target === ENGINE_EDGE;
        next.useApi = target === ENGINE_API;
        changed.push(`引擎 → ${engineLabel(target)}`);
      }
    } else if (wantSwitch === false) {
      const active: SpeechEngine = which === 'edge' ? ENGINE_EDGE : ENGINE_API;
      if (engineOf(cfg) === active) {
        return fail('两个引擎至少留一个启用：想换另一个，去那一页把它的开关打开就行。');
      }
    }

    if (which === 'edge') {
      // 与配置原值比，而不是 `this.style`：API 引擎下后者报的是 API 的参数
      const cur = {
        voice: typeof cfg.voice === 'string' && cfg.voice.trim() ? cfg.voice : DEFAULT_VOICE,
        rate: unitFactor(cfg.rate),
        pitch: typeof cfg.pitch === 'string' && cfg.pitch.trim() ? cfg.pitch : DEFAULT_PITCH,
        volume: unitFactor(cfg.volume),
      };
      if (typeof arg.voice === 'string') {
        const voice = arg.voice.trim();
        if (!voice) return fail('音色不能是空的：下拉里挑一个。');
        if (voice !== cur.voice) {
          next.voice = voice;
          changed.push(`音色 ${voiceLabel(cur.voice)} → ${voiceLabel(voice)}`);
        }
      }
      // 语速/音量：滑动条给 0.1–5 的倍率（也兼容旧字符串/百分比），夹进范围即可
      if (arg.rate !== undefined) {
        const rate = unitFactor(arg.rate);
        if (rate !== cur.rate) {
          next.rate = rate;
          changed.push(`语速 ${fmtX(cur.rate)} → ${fmtX(rate)}`);
        }
      }
      if (arg.volume !== undefined) {
        const volume = unitFactor(arg.volume);
        if (volume !== cur.volume) {
          next.volume = volume;
          changed.push(`音量 ${fmtX(cur.volume)} → ${fmtX(volume)}`);
        }
      }
      // 音调仍是下拉档位（字符串）
      if (typeof arg.pitch === 'string') {
        const pitch = arg.pitch.trim();
        if (!PITCH_OPTIONS.includes(pitch)) {
          return fail(`音调只能选 ${PITCH_OPTIONS[0]} … ${PITCH_OPTIONS[PITCH_OPTIONS.length - 1]} 之间的档位，给的是「${pitch}」。`);
        }
        if (pitch !== cur.pitch) {
          next.pitch = pitch;
          changed.push(`音调 ${cur.pitch} → ${pitch}`);
        }
      }
    } else {
      const before = apiOf(cfg);
      if (typeof arg.apiBase === 'string') {
        const base = normalizeBase(arg.apiBase);
        if (!base) {
          return fail('地址填得不对：要形如 http://127.0.0.1:8091/v1 的根地址；只写主机名也行，会自动补 /v1。');
        }
        if (base !== before.base) {
          next.apiBase = base;
          changed.push(`服务地址 → ${base}`);
        }
      }
      // 令牌：留空表示不改（掩码框本来就读不出原值），要清空得明说
      if (arg.clearKey === true) {
        if (before.key) {
          next.apiKey = '';
          changed.push('访问令牌 已清空');
        }
      } else if (typeof arg.apiKey === 'string' && arg.apiKey.trim()) {
        const key = arg.apiKey.trim();
        if (key !== before.key) {
          next.apiKey = key;
          changed.push('访问令牌 已更新（不回显）');
        }
      }
      if (typeof arg.apiVoice === 'string') {
        const voice = arg.apiVoice.trim();
        if (!voice) return fail('音色不能是空的：先点「连接测试」挑一个，或手填后端认识的名字。');
        if (voice !== before.voice) {
          next.apiVoice = voice;
          changed.push(`音色 ${before.voice} → ${voice}`);
        }
      }
      if (typeof arg.apiModel === 'string') {
        const model = arg.apiModel.trim();
        if (model !== before.model) {
          next.apiModel = model;
          changed.push(`模型 ${before.model || '（空）'} → ${model || '（空）'}`);
        }
      }
      if (typeof arg.apiFormat === 'string') {
        const format = arg.apiFormat.trim().toLowerCase();
        if (!isApiFormat(format)) {
          return fail(`音频格式只能选 ${API_FORMATS.join(' / ')}；给的是「${arg.apiFormat}」。`);
        }
        if (format !== before.format) {
          next.apiFormat = format;
          changed.push(`音频格式 ${before.format} → ${format}`);
        }
      }
      if (typeof arg.apiLanguage === 'string') {
        const language = arg.apiLanguage.trim();
        if (language !== before.language) {
          next.apiLanguage = language;
          changed.push(`语言 ${before.language || '（自动）'} → ${language || '（自动）'}`);
        }
      }
      if (typeof arg.apiInstructions === 'string') {
        const instructions = arg.apiInstructions.trim();
        if (instructions !== before.instructions) {
          next.apiInstructions = instructions;
          changed.push(instructions ? `语气指令 → 「${brief(instructions)}」` : '语气指令 已清空');
        }
      }
      if (arg.apiSpeedFactor !== undefined) {
        const speed = clampSpeed(Number(arg.apiSpeedFactor));
        if (speed !== before.speed) {
          next.apiSpeedFactor = speed;
          changed.push(`语速倍率 ${before.speed}× → ${speed}×`);
        }
      }
      if (arg.apiVolume !== undefined) {
        const volume = unitFactor(arg.apiVolume);
        if (volume !== before.volume) {
          next.apiVolume = volume;
          changed.push(`播放音量 ${fmtX(before.volume)} → ${fmtX(volume)}`);
        }
      }
      if (arg.apiTimeoutMs !== undefined) {
        const timeout = num(arg.apiTimeoutMs) === undefined
          ? before.timeoutMs
          : numberIn(num(arg.apiTimeoutMs), before.timeoutMs, API_TIMEOUT_MIN, API_TIMEOUT_MAX);
        if (timeout !== before.timeoutMs) {
          next.apiTimeoutMs = timeout;
          changed.push(`请求超时 ${before.timeoutMs}ms → ${timeout}ms`);
        }
      }
    }

    if (!changed.length) return { ok: true, text: '和原来一样，没有改动。', changed: [] };
    this.opts.persist(next);
    // 地址换了，旧清单就不作数了；后台按新地址重探，下次打开页面就有新的下拉
    if (next.apiBase !== undefined) {
      setActiveCatalog(null);
      this.opts.persist({ apiCatalog: { base: '', at: 0, voices: [], models: [] } });
      const after = apiOf(this.opts.cfg);
      void this.probeApiCatalog(after.base, after.key, after);
    }
    this.log(`页签改了${which === 'edge' ? ' Edge ' : ' API '}语音设置：${changed.join('，')}`);
    return { ok: true, text: `已保存：${changed.join('，')}。下一句就按这个来。`, changed };
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
  // API 引擎的报错在 api-tts.ts 里已经翻成人话，这里只补两条最常撞上的状态码
  if (/HTTP 401|HTTP 403/.test(raw)) {
    return `${raw}\n服务拒绝了这个请求：多半是「访问令牌」不对或没权限，去配置页「语音 API」组核一下。`;
  }
  if (/HTTP 404/.test(raw)) {
    return `${raw}\n端点不存在：接口地址要写到 /v1/audio/speech 这一整段，别只写主机名或漏了 /v1。`;
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

/** 倍率在人话里的样子：1 → `1×`，1.2 → `1.2×`。 */
function fmtX(n: number): string {
  const v = Math.round((Number.isFinite(n) ? n : 1) * 100) / 100;
  return `${v}×`;
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
