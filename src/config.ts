/**
 * `worlds.streamvoice` 的配置段与 WebUI 配置组。
 *
 * 这个扩展不读别人家的配置：音色、语速、音调、音量、念哪些内容、切块长短、块间停顿，
 * 全在自己的配置组里，存在自己这段 `worlds.streamvoice` 下。改完立刻生效（都标了 `x-hot`）。
 *
 * `enabled` 是框架的挂载开关：关掉就整个 World 不挂载，接收器也就不存在了。
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import {
  DEFAULT_PITCH,
  DEFAULT_VOICE,
  PITCH_OPTIONS,
  RATE_OPTIONS,
  VOICE_OPTIONS_KIND,
  VOLUME_OPTIONS,
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

export interface StreamVoiceConfigSection {
  [key: string]: unknown;
  /** 挂载开关，由框架读；关掉即整个扩展不工作。 */
  enabled: boolean;
  /** Edge TTS 音色 ShortName。 */
  voice: string;
  /** 相对语速，如 `+15%`。 */
  rate: string;
  /** 音调，如 `+10Hz`。 */
  pitch: string;
  /** 相对音量，如 `+20%`。 */
  volume: string;
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
  voice: DEFAULT_VOICE,
  rate: '+0%',
  pitch: DEFAULT_PITCH,
  volume: '+0%',
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
  voiceGroup: '嗓音',
  voiceGroupDesc: '这些参数只属于本扩展，不读别的扩展的设置；改完下一句就生效。面板上可以逐个试听。',
  voice: '音色',
  voiceHint: 'Edge TTS 的音色。列表是这台机器上的朗读接口实际提供、且逐个试过能出声的；别的 ShortName 也能写进 config.json，只是可能合成失败。',
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
  voiceGroup: 'Voice',
  voiceGroupDesc: 'These settings belong to this extension alone; nothing is read from other extensions. Changes apply to the next sentence, and the panel can audition each voice.',
  voice: 'Voice',
  voiceHint: 'An Edge TTS voice. The list holds what this machine actually offers and what was tested end to end; other ShortNames can be written into config.json but may fail.',
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

/** 本 World 的配置组；键是 `worlds.streamvoice` 里的路径。 */
export function streamVoiceConfigGroups(language: Language = 'zh'): ConfigGroup[] {
  const t = streamVoiceText(language);
  const at = (key: string): string => `worlds.${STREAMVOICE_ID}.${key}`;
  const owner = `world:${STREAMVOICE_ID}`;
  return [
    {
      id: `${owner}.voice`,
      owner,
      schema: {
        type: 'object',
        title: t.voiceGroup,
        description: t.voiceGroupDesc,
        properties: {
          [at('voice')]: {
            type: 'string',
            title: t.voice,
            description: t.voiceHint,
            'x-options': VOICE_OPTIONS_KIND,
            'x-hot': true,
          },
          [at('rate')]: {
            type: 'string',
            title: t.rate,
            description: t.rateHint,
            enum: [...RATE_OPTIONS],
            'x-hot': true,
          },
          [at('pitch')]: {
            type: 'string',
            title: t.pitch,
            description: t.pitchHint,
            enum: [...PITCH_OPTIONS],
            'x-hot': true,
          },
          [at('volume')]: {
            type: 'string',
            title: t.volume,
            description: t.volumeHint,
            enum: [...VOLUME_OPTIONS],
            'x-hot': true,
          },
        },
      },
    },
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
