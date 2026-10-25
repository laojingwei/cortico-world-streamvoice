/**
 * `worlds.streamvoice` 的配置段与 WebUI 配置组。
 *
 * 这个扩展不读别人家的配置：音色、语速、音调、音量、念哪些内容、切块长短、块间停顿，
 * 全在自己的配置组里，存在自己这段 `worlds.streamvoice` 下。改完立刻生效（都标了 `x-hot`）。
 *
 * 合成有两套引擎：`edge`（微软 Edge 朗读接口，开箱能用）和 `api`（任何 OpenAI 兼容的
 * HTTP 语音服务）。切引擎只动 `worlds.streamvoice.engine`，API 那边的根地址、音色、格式
 * 都在这段配置里，不依赖别的扩展。
 *
 * 配置页把两套引擎的参数**都摆出来**（「Edge 语音」「API 语音」两组），每组顶上有一个
 * 启用开关，开一边就把另一边关掉——切引擎不用再回配置页刷新，另一组的参数也随时改得到。
 * 访问令牌不进配置页（那里只能画明文输入框），只在面板上以密码框出现。
 *
 * `enabled` 是框架的挂载开关：关掉就整个 World 不挂载，接收器也就不存在了。
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { SpeechStyle } from './speaker.ts';
import type { ApiCatalog } from './api-catalog.ts';
import {
  API_FORMATS,
  API_TIMEOUT_DEFAULT,
  API_TIMEOUT_MAX,
  API_TIMEOUT_MIN,
  DEFAULT_API_BASE,
  DEFAULT_API_FORMAT,
  DEFAULT_API_VOICE,
  SPEED_DEFAULT,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  clampSpeed,
  isApiFormat,
  normalizeBase,
  type ApiFormat,
  type ApiSpeech,
} from './api-tts.ts';
import {
  DEFAULT_PITCH,
  DEFAULT_VOICE,
  PITCH_OPTIONS,
  RATE_OPTIONS,
  VOLUME_OPTIONS,
  voiceOptionRows,
} from './voices.ts';

export const STREAMVOICE_ID = 'streamvoice';

/** 太短的一句并到下一句：少于这么多字（不含空白）先不切。 */
export const CHUNK_MIN_DEFAULT = 8;
/** 一块最长的字数；超过就在逗号处再切一刀。 */
export const CHUNK_MAX_DEFAULT = 60;

export const CHUNK_MIN_FLOOR = 1;
export const CHUNK_MIN_CEIL = 40;
export const CHUNK_MAX_FLOOR = 20;
export const CHUNK_MAX_CEIL = 200;

/** 一块说完之后额外停多久；0 表示紧接着说。 */
export const GAP_DEFAULT = 0;
export const GAP_MAX = 3000;

/** 两套合成引擎：Edge 朗读接口，或自建/本地的 OpenAI 兼容 HTTP 服务。 */
export type SpeechEngine = 'edge' | 'api';
export const ENGINE_EDGE: SpeechEngine = 'edge';
export const ENGINE_API: SpeechEngine = 'api';
export const ENGINE_VALUES: SpeechEngine[] = [ENGINE_EDGE, ENGINE_API];

export interface StreamVoiceConfigSection {
  [key: string]: unknown;
  /** 挂载开关，由框架读；关掉即整个扩展不工作。 */
  enabled: boolean;
  /** 用哪套引擎合成：`edge` 或 `api`。由两组里的启用开关驱动。 */
  engine: SpeechEngine;
  /** 「Edge 语音」组的启用开关；与 `engine` 联动，开这边就把 `useApi` 关掉。 */
  useEdge: boolean;
  /** 「API 语音」组的启用开关；与 `engine` 联动。 */
  useApi: boolean;
  /** Edge TTS 音色 ShortName。 */
  voice: string;
  /** 相对语速，如 `+15%`。 */
  rate: string;
  /** 音调，如 `+10Hz`。 */
  pitch: string;
  /** 相对音量，如 `+20%`。 */
  volume: string;
  /** API 服务的根地址（OpenAI 的 base_url），如 `http://127.0.0.1:8091/v1`。 */
  apiBase: string;
  /** 老版本存的是整条端点；只在读配置时当兜底，不再写。 */
  apiUrl?: string;
  /** API 引擎的 Bearer 令牌；留空不发。不在配置页显示，只走面板的密码框。 */
  apiKey: string;
  /** API 引擎的 `model` 字段；留空不发。 */
  apiModel: string;
  /** API 引擎的音色名（后端自己的名字，如 `vivian`）。 */
  apiVoice: string;
  /** 要后端回的音频格式。 */
  apiFormat: ApiFormat;
  /** 语气指令，如「用开心的语气说」；留空不发。 */
  apiInstructions: string;
  /** 语言，如 `Chinese`；留空不发。 */
  apiLanguage: string;
  /** 语速倍率 0.25–4，1 = 原速；作为 `speed` 发给后端。 */
  apiSpeedFactor: number;
  /** 播放音量 0–100：API 回来的音频是成品，只能在播放器这边调。 */
  apiVolume: number;
  /** 上次探测到的音色与模型清单，配置页的下拉与面板都读它；不进配置页的 schema。 */
  apiCatalog?: ApiCatalog;
  /** 单次请求的超时（毫秒）。 */
  apiTimeoutMs: number;
  /** 念 `pet_say` 的台词。 */
  readSay: boolean;
  /** 念 `pet_ask` 的问题。 */
  readAsk: boolean;
  /** 问句把可选项也念出来。 */
  readOptions: boolean;
  /** 少于这么多字的句子并到下一句一起说。 */
  chunkMinChars: number;
  /** 一块最多这么多字，超过在逗号处再切。 */
  chunkMaxChars: number;
  /** 一块说完之后额外停这么久（毫秒）。 */
  gapMs: number;
  /** 模型开始写时先空打一发合成，把链路焐热。 */
  prewarm: boolean;
  /** 逐块打详细日志。 */
  verbose: boolean;
  /** 允许模型用 `speech_tune` 自己改音色、语速、音调、音量。 */
  allowSelfTuning: boolean;
}

export const STREAMVOICE_DEFAULTS: StreamVoiceConfigSection = {
  enabled: false,
  engine: ENGINE_EDGE,
  // 两个都默认关：真正生效的由 `engine` 决定，第一次打开配置页会把对应那侧点亮
  useEdge: false,
  useApi: false,
  voice: DEFAULT_VOICE,
  rate: '+0%',
  pitch: DEFAULT_PITCH,
  volume: '+0%',
  // 默认指向本机 8091 上的那套服务；切到 api 之前不用管这些值
  apiBase: DEFAULT_API_BASE,
  apiKey: '',
  apiModel: '',
  apiVoice: DEFAULT_API_VOICE,
  apiFormat: DEFAULT_API_FORMAT,
  apiInstructions: '',
  apiLanguage: '',
  apiSpeedFactor: SPEED_DEFAULT,
  apiVolume: 100,
  apiTimeoutMs: API_TIMEOUT_DEFAULT,
  readSay: true,
  readAsk: true,
  readOptions: true,
  chunkMinChars: CHUNK_MIN_DEFAULT,
  chunkMaxChars: CHUNK_MAX_DEFAULT,
  gapMs: GAP_DEFAULT,
  prewarm: true,
  verbose: false,
  // 默认放任它自己调：用户说「说慢点」的时候，让模型直接改比让用户去点控制台自然
  allowSelfTuning: true,
};

/** 当前引擎；认不出的值一律当 Edge，别因为配置里写了脏东西就整个不出声。 */
export function engineOf(cfg: Partial<StreamVoiceConfigSection> | Record<string, unknown>): SpeechEngine {
  return cfg.engine === ENGINE_API ? ENGINE_API : ENGINE_EDGE;
}

/** 人话里的引擎名。 */
export function engineLabel(engine: SpeechEngine): string {
  return engine === ENGINE_API ? 'API 服务' : 'Edge 朗读';
}

/** 从配置读出 API 引擎要的全部请求参数；缺项退回默认值。 */
export function apiOf(cfg: Partial<StreamVoiceConfigSection> | Record<string, unknown>): ApiSpeech {
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  return {
    // 老版本把整条 /v1/audio/speech 存在 apiUrl 里，这里一并认
    base: normalizeBase(cfg.apiBase) || normalizeBase(cfg.apiUrl) || DEFAULT_API_BASE,
    key: str(cfg.apiKey, ''),
    model: str(cfg.apiModel, ''),
    voice: str(cfg.apiVoice, DEFAULT_API_VOICE),
    format: isApiFormat(cfg.apiFormat) ? cfg.apiFormat : DEFAULT_API_FORMAT,
    instructions: str(cfg.apiInstructions, ''),
    language: str(cfg.apiLanguage, ''),
    timeoutMs: numberIn(cfg.apiTimeoutMs, API_TIMEOUT_DEFAULT, API_TIMEOUT_MIN, API_TIMEOUT_MAX),
    speed: clampSpeed(cfg.apiSpeedFactor),
    volume: Math.min(100, Math.max(0, numberIn(cfg.apiVolume, 100, 0, 100))),
  };
}

/**
 * 从配置读出这次要用的嗓音；缺项退回默认值。
 *
 * 引擎一换，`voice` 就跟着换成那套引擎的名字：API 引擎下真正起作用的是后端的音色名，
 * Edge 的 `voice` 原样留在配置里，切回去还是原来那个。
 *
 * 放在这里而不是 voices.ts：那边被本文件引常量，反过来引本文件会形成循环导入。
 */
export function styleOf(cfg: Partial<StreamVoiceConfigSection> | Record<string, unknown>): SpeechStyle {
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const engine = engineOf(cfg);
  const api = apiOf(cfg);
  return {
    engine,
    voice: engine === ENGINE_API ? api.voice : str(cfg.voice, DEFAULT_VOICE),
    rate: str(cfg.rate, '+0%'),
    pitch: str(cfg.pitch, DEFAULT_PITCH),
    volume: str(cfg.volume, '+0%'),
    api,
  };
}


/** 一个数字配置项：越界或不是数字时退回默认值。 */
export function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 当前生效的切块参数；`max` 永远不小于 `min`。 */
export function chunkLimits(cfg: StreamVoiceConfigSection): { min: number; max: number } {
  const min = numberIn(cfg.chunkMinChars, CHUNK_MIN_DEFAULT, CHUNK_MIN_FLOOR, CHUNK_MIN_CEIL);
  const max = numberIn(cfg.chunkMaxChars, CHUNK_MAX_DEFAULT, CHUNK_MAX_FLOOR, CHUNK_MAX_CEIL);
  return { min, max: Math.max(max, min) };
}

/** 块间停顿；缺省 0。 */
export function gapOf(cfg: StreamVoiceConfigSection): number {
  return numberIn(cfg.gapMs, GAP_DEFAULT, 0, GAP_MAX);
}

interface StreamVoiceText {
  label: string;
  engineGroup: string;
  engineGroupDesc: string;
  engine: string;
  engineHint: string;
  edgeSwitch: string;
  edgeSwitchHint: string;
  apiSwitch: string;
  apiSwitchHint: string;
  apiGroup: string;
  apiGroupDesc: string;
  apiBase: string;
  apiBaseHint: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  apiModel: string;
  apiModelHint: string;
  apiVoice: string;
  apiVoiceHint: string;
  apiFormat: string;
  apiFormatHint: string;
  apiInstructions: string;
  apiInstructionsHint: string;
  apiLanguage: string;
  apiLanguageHint: string;
  apiSpeedFactor: string;
  apiSpeedFactorHint: string;
  apiVolume: string;
  apiVolumeHint: string;
  apiTimeout: string;
  apiTimeoutHint: string;
  voiceGroup: string;
  voiceGroupDesc: string;
  voice: string;
  voiceHint: string;
  rate: string;
  rateHint: string;
  pitch: string;
  pitchHint: string;
  volume: string;
  volumeHint: string;
  contentGroup: string;
  contentGroupDesc: string;
  readSay: string;
  readSayHint: string;
  readAsk: string;
  readAskHint: string;
  readOptions: string;
  readOptionsHint: string;
  chunkGroup: string;
  chunkGroupDesc: string;
  min: string;
  minHint: (floor: number, ceil: number) => string;
  max: string;
  maxHint: string;
  gap: string;
  gapHint: string;
  advGroup: string;
  advGroupDesc: string;
  prewarm: string;
  prewarmHint: string;
  verbose: string;
  verboseHint: string;
  selfTuning: string;
  selfTuningHint: string;
  promptTitle: string;
  promptDesc: string;
  lampSpeech: string;
  lampVoice: string;
  lampConflict: string;
  speaking: string;
  idle: string;
  off: string;
  conflict: (who: string) => string;
}

const zh: StreamVoiceText = {
  label: '流式语音播报',
  engineGroup: '合成引擎',
  engineGroupDesc:
    '两套引擎的参数都摆在下面，各有一组，改哪组都行，切引擎也不用刷新页面：'
    + '开哪一组的「启用」，声音就来自哪一组。',
  engine: '引擎',
  engineHint:
    'edge = 微软 Edge 朗读接口，联网即用；api = 任何 OpenAI 兼容的 HTTP 语音服务（自建、云厂商都行）。'
    + '直接改下面两组的启用开关即可，两个开关互斥。',
  edgeSwitch: '启用 Edge 语音',
  edgeSwitchHint: '打开就用下面这组嗓音念；打开时「启用 API 语音」会自动关掉。',
  apiSwitch: '启用 API 语音',
  apiSwitchHint: '打开就用下面这组参数念；打开时「启用 Edge 语音」会自动关掉。',
  apiGroup: 'API 语音',
  apiGroupDesc:
    '地址只填服务的根地址（OpenAI 说的 base_url），具体接口路径按规范自己拼，'
    + '换后端一般只改地址、音色、模型这几项。',
  apiBase: '服务地址',
  apiBaseHint:
    '服务的根地址，形如 http://127.0.0.1:8091/v1。只写主机名会自动补上 /v1；'
    + '把整条 /v1/audio/speech 贴进来也能认，会自动截回根地址。',
  apiKeyLabel: '访问令牌',
  apiKeyHint: '后端要 Bearer 令牌时填这里。掩码显示、写完不回显；留空表示不改，本地服务通常不用。',
  apiModel: '模型名',
  apiModelHint: 'OpenAI 协议的 model 字段；选「（不发送）」就不带这一项。',
  apiVoice: 'API 音色',
  apiVoiceHint:
    '下拉里是这台服务实际支持的音色，来自最近一次「连接测试」的结果（启动时也会自动探一次），'
    + '所以不用每次打开都重测。换后端或它新增了音色，在面板上再点一次测试即可刷新。',
  apiFormat: '音频格式',
  apiFormatHint: '让后端回什么容器。mp3 最省带宽、播放器也认；后端只给 wav 时就选 wav。pcm 是无头裸流，播不出来，仅留给特殊服务。',
  apiInstructions: '语气指令',
  apiInstructionsHint:
    '整段话共用的语气要求，如「用开心的语气说」「语速偏慢、语气温柔」。支持自然语言控制的后端会照做，不支持的会忽略；'
    + '不想要就留空。这一项对所有块都一样，不能逐句变。',
  apiLanguage: '语言',
  apiLanguageHint: '如 Chinese / English / Japanese；留空则由后端自己判断。',
  apiSpeedFactor: '语速倍率',
  apiSpeedFactorHint:
    '0.25–4，1 是原速，作为 speed 发给后端；等于 1 时不发送这一项。'
    + '这是输出端变速，压得太多音调会发飘——介意音色就改用「语气指令」写「语速快一点」。'
    + '后端不认 speed 时这一项没有效果。',
  apiVolume: '播放音量',
  apiVolumeHint:
    'API 回来的音频是成品，音量只能在播放器这边调：0–100，100 是原音量。'
    + '它不影响音色，也不发给后端，纯粹让本地放得轻一点。',
  apiTimeout: '请求超时',
  apiTimeoutHint: '单块合成的等待上限。本地服务冷启动或显存紧张时可以调大；卡住超时会跳过这一块，不影响后面。',
  voiceGroup: 'Edge 语音',
  voiceGroupDesc: '只在 Edge 引擎下生效；这些参数只属于本扩展，不读别的扩展的设置。改完下一句就生效，面板上可以逐个试听。',
  voice: '音色',
  voiceHint: 'Edge 朗读接口的音色，只在 edge 引擎下生效。列表是这台机器上的接口实际提供、且逐个试过能出声的；别的 ShortName 也能写进 config.json，只是可能合成失败。',
  rate: '语速',
  rateHint: '相对原速的百分比，5% 一档：-50% 约半速，+50% 约倍半速。',
  pitch: '音调',
  pitchHint: '相对原音调的高低，5Hz 一档：负数更低沉，正数更明亮。',
  volume: '音量',
  volumeHint: '相对原音量的百分比，5% 一档。',
  contentGroup: '念什么',
  contentGroupDesc: '决定哪些内容会被念出来，以及问句的选项念不念。',
  readSay: '念台词',
  readSayHint: '念 `pet_say` 说的话。关掉就只剩问句和选项有声音。',
  readAsk: '念问句',
  readAskHint: '念 `pet_ask` 提的问题。',
  readOptions: '念出可选项',
  readOptionsHint: '问到选择时，把几个可选答案也念出来。',
  chunkGroup: '切块与节奏',
  chunkGroupDesc: '边生成边切：一句话说完就进场合成，不等整段。',
  min: '切块最小字数',
  minHint: (floor, ceil) => `短于这么多字的一句不单独说，并到下一句一起（${floor}–${ceil}）。想让它第一声更快，就调小。`,
  max: '切块最大字数',
  maxHint: '一块最多这么多字；超过的在逗号处再切一刀，避免一整段音频太长、断不干净。',
  gap: '块间停顿',
  gapHint: '一块说完之后额外等这么久再念下一块。0 表示紧接着说；嫌它说得太赶可以加几十毫秒。',
  advGroup: '高级',
  advGroupDesc: '影响链路行为和日志量，一般不用动。',
  prewarm: '预热合成链路',
  prewarmHint: '模型开始写时先空合成一声把连接焐热，第一句能快 2 秒左右；关掉就省这一次请求。',
  verbose: '详细日志',
  verboseHint: '把每一块的合成耗时都写进 core.log；关掉只留第一块那行。',
  selfTuning: '允许模型自己调嗓音',
  selfTuningHint:
    '开着时模型可以按你的话改音色、语速、音调、音量（改的是这份配置，下一句生效）；'
    + '关掉后它只剩「查看当前嗓音」和「立刻停止朗读」两件事可做。',
  promptTitle: '环境提示词',
  promptDesc: '发给模型的环境说明：现在是什么嗓音、念哪些内容、能调哪些参数、有哪些工具。改这里就能改它对语音的理解，清空则回落到包内的默认模板。',
  lampSpeech: '流式朗读',
  lampVoice: '嗓音',
  lampConflict: '另一处也在朗读',
  speaking: '正在说',
  idle: '待命',
  off: '已关',
  conflict: (who) => `${who}也在整段朗读，同一句会念两遍：把它的朗读关掉`,
};

const en: StreamVoiceText = {
  label: 'Streaming speech',
  engineGroup: 'Engine',
  engineGroupDesc:
    'Both engines are shown below, each with its own group, so switching never needs a reload: '
    + 'turn on the "Enable" switch of the side you want to hear.',
  engine: 'Engine',
  engineHint:
    'edge = the Microsoft Edge reading service, works out of the box; api = any OpenAI-compatible HTTP speech service. '
    + 'Use the Enable switches in the two groups below; they are mutually exclusive.',
  edgeSwitch: 'Enable Edge speech',
  edgeSwitchHint: 'Speak with the voice group below. Turning this on switches "Enable API speech" off.',
  apiSwitch: 'Enable API speech',
  apiSwitchHint: 'Speak with the API group below. Turning this on switches "Enable Edge speech" off.',
  apiGroup: 'Speech API',
  apiGroupDesc:
    'Enter the service root (the OpenAI base_url); request paths are appended by convention, '
    + 'so switching backends usually means changing only the address, voice and model.',
  apiBase: 'Service address',
  apiBaseHint:
    'The service root, e.g. http://127.0.0.1:8091/v1. A bare host gets /v1 appended; '
    + 'pasting the full /v1/audio/speech endpoint also works — it is trimmed back to the root.',
  apiKeyLabel: 'Token',
  apiKeyHint: 'Bearer token if the service needs one. Masked and never echoed back; leave blank to keep it. Local services usually need none.',
  apiModel: 'Model',
  apiModelHint: 'The OpenAI model field. Pick "(not sent)" to leave it out of the request.',
  apiVoice: 'API voice',
  apiVoiceHint:
    'The list holds what this service actually supports, from the last connection test (one is also run at startup), '
    + 'so there is no need to test every time. Press Test again on the panel after changing backends or voices.',
  apiFormat: 'Audio format',
  apiFormatHint: 'The container to ask for. mp3 is small and the player handles it; pick wav if the backend only speaks wav. pcm is headerless and will not play — for special cases only.',
  apiInstructions: 'Tone instruction',
  apiInstructionsHint:
    'One tone instruction for every chunk, e.g. "say it cheerfully" or "slow and gentle". Backends with natural-language control follow it, others ignore it; '
    + 'leave empty for none. It applies to the whole session, not per sentence.',
  apiLanguage: 'Language',
  apiLanguageHint: 'e.g. Chinese / English / Japanese; leave empty to let the backend decide.',
  apiSpeedFactor: 'Speed factor',
  apiSpeedFactorHint:
    '0.25–4, where 1 is the original speed, sent as `speed`; it is omitted when 1. '
    + 'This is output-side time stretching, so extreme values wobble the pitch — use a tone instruction like "a bit faster" instead if that matters. '
    + 'It has no effect when the backend ignores speed.',
  apiVolume: 'Playback volume',
  apiVolumeHint:
    'The audio the API returns is final, so loudness is adjusted in the player: 0–100, where 100 is the original level. '
    + 'It changes nothing about the timbre and is never sent to the backend.',
  apiTimeout: 'Request timeout',
  apiTimeoutHint: 'Per-chunk limit. Raise it when a local service is slow to warm up; a timed-out chunk is skipped without blocking the rest.',
  voiceGroup: 'Edge voice',
  voiceGroupDesc: 'Used only with the edge engine. These settings belong to this extension alone; nothing is read from other extensions.',
  voice: 'Voice',
  voiceHint: 'An Edge reading voice, used only with the edge engine. The list holds what this machine actually offers and what was tested end to end; other ShortNames can be written into config.json but may fail.',
  rate: 'Rate',
  rateHint: 'Relative to the normal speaking rate, in 5% steps.',
  pitch: 'Pitch',
  pitchHint: 'Relative pitch in Hz, 5Hz steps: negative is lower, positive is brighter.',
  volume: 'Volume',
  volumeHint: 'Relative to the normal volume, in 5% steps.',
  contentGroup: 'What is read',
  contentGroupDesc: 'Which parts of a reply get a voice, and whether choices are read out.',
  readSay: 'Read the line',
  readSayHint: 'Read what `pet_say` says. Switch it off to keep only questions and choices voiced.',
  readAsk: 'Read the question',
  readAskHint: 'Read the question asked by `pet_ask`.',
  readOptions: 'Read the choices',
  readOptionsHint: 'When it asks a question, also read out the available answers.',
  chunkGroup: 'Chunking and pacing',
  chunkGroupDesc: 'Cut while the text is still being written: a finished sentence goes to synthesis right away.',
  min: 'Shortest chunk',
  minHint: (floor, ceil) => `A sentence shorter than this waits and is said with the next one (${floor}–${ceil}). Lower it for a faster first sound.`,
  max: 'Longest chunk',
  maxHint: 'A chunk is cut at a comma before it grows past this many characters.',
  gap: 'Pause between chunks',
  gapHint: 'Extra pause after each chunk before the next one starts. 0 means back to back.',
  advGroup: 'Advanced',
  advGroupDesc: 'Pipeline behaviour and log volume; normally leave these alone.',
  prewarm: 'Prewarm the link',
  prewarmHint: 'Warm up the synthesis connection while the model starts writing; the first sentence lands about 2s sooner. Off saves that request.',
  verbose: 'Verbose log',
  verboseHint: 'Log the timing of every chunk to core.log; off keeps only the first-chunk line.',
  selfTuning: 'Let the model tune the voice',
  selfTuningHint:
    'When on, the model may change voice, rate, pitch and volume on request; it edits this config and the next sentence follows. '
    + 'When off, it can still inspect the voice and stop the current line.',
  promptTitle: 'Environment prompt',
  promptDesc: 'The environment note sent to the model: current voice, what is read, which settings it may tune, which tools it has. Edit it to change how speech is framed; clearing it falls back to the bundled template.',
  lampSpeech: 'streaming speech',
  lampVoice: 'voice',
  lampConflict: 'something else reads aloud',
  speaking: 'speaking',
  idle: 'ready',
  off: 'off',
  conflict: (who) => `${who} reads whole lines too, so every line is said twice: turn its reading off`,
};

const TEXT: Record<string, StreamVoiceText> = { zh, en };

export function streamVoiceText(language: Language = 'zh'): StreamVoiceText {
  return TEXT[language] ?? en;
}

/** 面板画字段用的最小描述：文案与选项都从这里来，前端只管摆位置。 */
export interface PanelFieldSpec {
  /** `worlds.streamvoice` 下的键名。 */
  key: string;
  type: 'boolean' | 'select' | 'number' | 'text' | 'password';
  title: string;
  desc?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** 输入框的占位提示（令牌那行用来说「已设置，留空不改」）。 */
  placeholder?: string;
  /** 当前值；由 World 从活配置里填。 */
  value?: unknown;
}

export interface PanelSpec {
  /** 保存时提交的组 id。 */
  group: string;
  title: string;
  desc: string;
  fields: PanelFieldSpec[];
}

const literalRows = (values: readonly string[]): Array<{ value: string; label: string }> =>
  values.map((v) => ({ value: v, label: v }));

/**
 * 「Edge 语音」页签的字段表。
 *
 * 这一组不在「配置」页签里：它自己是一页，用户想用 Edge 就点这一页上的启用开关。
 * 字段顺序就是页面上从上到下的顺序。
 */
export function edgeVoicePanelSpec(language: Language = 'zh'): PanelSpec {
  const t = streamVoiceText(language);
  return {
    group: `world:${STREAMVOICE_ID}.voice`,
    title: t.voiceGroup,
    desc: t.voiceGroupDesc,
    fields: [
      { key: 'useEdge', type: 'boolean', title: t.edgeSwitch, desc: t.edgeSwitchHint },
      { key: 'voice', type: 'select', title: t.voice, desc: t.voiceHint, options: voiceOptionRows() },
      { key: 'rate', type: 'select', title: t.rate, desc: t.rateHint, options: literalRows(RATE_OPTIONS) },
      { key: 'pitch', type: 'select', title: t.pitch, desc: t.pitchHint, options: literalRows(PITCH_OPTIONS) },
      { key: 'volume', type: 'select', title: t.volume, desc: t.volumeHint, options: literalRows(VOLUME_OPTIONS) },
    ],
  };
}

/**
 * 「API 语音」页签的字段表。
 *
 * 音色与模型的候选项由 World 现填（来自探测缓存）：这里只给出「是个下拉」。
 * 令牌是 password，值永远不回显。
 */
export function apiVoicePanelSpec(language: Language = 'zh'): PanelSpec {
  const t = streamVoiceText(language);
  return {
    group: `world:${STREAMVOICE_ID}.api`,
    title: t.apiGroup,
    desc: t.apiGroupDesc,
    fields: [
      { key: 'useApi', type: 'boolean', title: t.apiSwitch, desc: t.apiSwitchHint },
      { key: 'apiBase', type: 'text', title: t.apiBase, desc: t.apiBaseHint },
      { key: 'apiKey', type: 'password', title: t.apiKeyLabel, desc: t.apiKeyHint },
      { key: 'apiVoice', type: 'select', title: t.apiVoice, desc: t.apiVoiceHint },
      { key: 'apiModel', type: 'select', title: t.apiModel, desc: t.apiModelHint },
      { key: 'apiFormat', type: 'select', title: t.apiFormat, desc: t.apiFormatHint, options: literalRows(API_FORMATS) },
      { key: 'apiLanguage', type: 'text', title: t.apiLanguage, desc: t.apiLanguageHint },
      { key: 'apiInstructions', type: 'text', title: t.apiInstructions, desc: t.apiInstructionsHint },
      {
        key: 'apiSpeedFactor',
        type: 'number',
        title: t.apiSpeedFactor,
        desc: t.apiSpeedFactorHint,
        min: SPEED_MIN,
        max: SPEED_MAX,
        step: SPEED_STEP,
        suffix: '×',
      },
      {
        key: 'apiVolume',
        type: 'number',
        title: t.apiVolume,
        desc: t.apiVolumeHint,
        min: 0,
        max: 100,
        step: 5,
        suffix: '%',
      },
      {
        key: 'apiTimeoutMs',
        type: 'number',
        title: t.apiTimeout,
        desc: t.apiTimeoutHint,
        min: API_TIMEOUT_MIN,
        max: API_TIMEOUT_MAX,
        step: 500,
        suffix: 'ms',
      },
    ],
  };
}

/**
 * 「配置」页签里的组：念什么、切块与节奏、高级。
 *
 * 两套引擎**不在这里**——它们各自是一个独立页签（`Edge 语音` / `API 语音`），由面板自己画，
 * 见 `edgeVoicePanelSpec()` / `apiVoicePanelSpec()`。放在同一个页面里并排摆，用户根本分不清
 * 哪一组是此刻生效的；拆成页签之后，想去哪一边启用就点哪一边。
 */
export function streamVoiceConfigGroups(language: Language = 'zh'): ConfigGroup[] {
  const t = streamVoiceText(language);
  const at = (key: string): string => `worlds.${STREAMVOICE_ID}.${key}`;
  const owner = `world:${STREAMVOICE_ID}`;
  return [
    {
      id: `${owner}.content`,
      owner,
      schema: {
        type: 'object',
        title: t.contentGroup,
        description: t.contentGroupDesc,
        properties: {
          [at('readSay')]: { type: 'boolean', title: t.readSay, description: t.readSayHint, 'x-hot': true },
          [at('readAsk')]: { type: 'boolean', title: t.readAsk, description: t.readAskHint, 'x-hot': true },
          [at('readOptions')]: { type: 'boolean', title: t.readOptions, description: t.readOptionsHint, 'x-hot': true },
        },
      },
    },
    {
      id: `${owner}.chunks`,
      owner,
      schema: {
        type: 'object',
        title: t.chunkGroup,
        description: t.chunkGroupDesc,
        properties: {
          [at('chunkMinChars')]: {
            type: 'integer',
            title: t.min,
            description: t.minHint(CHUNK_MIN_FLOOR, CHUNK_MIN_CEIL),
            minimum: CHUNK_MIN_FLOOR,
            maximum: CHUNK_MIN_CEIL,
            'x-suffix': '字',
            'x-hot': true,
          },
          [at('chunkMaxChars')]: {
            type: 'integer',
            title: t.max,
            description: t.maxHint,
            minimum: CHUNK_MAX_FLOOR,
            maximum: CHUNK_MAX_CEIL,
            'x-suffix': '字',
            'x-hot': true,
          },
          [at('gapMs')]: {
            type: 'integer',
            title: t.gap,
            description: t.gapHint,
            minimum: 0,
            maximum: GAP_MAX,
            'x-suffix': 'ms',
            'x-hot': true,
          },
        },
      },
    },
    {
      id: `${owner}.advanced`,
      owner,
      schema: {
        type: 'object',
        title: t.advGroup,
        description: t.advGroupDesc,
        properties: {
          [at('prewarm')]: { type: 'boolean', title: t.prewarm, description: t.prewarmHint, 'x-hot': true },
          [at('verbose')]: { type: 'boolean', title: t.verbose, description: t.verboseHint, 'x-hot': true },
          [at('allowSelfTuning')]: {
            type: 'boolean',
            title: t.selfTuning,
            description: t.selfTuningHint,
            'x-hot': true,
          },
        },
      },
    },
  ];
}
