/**
 * 给模型的三个工具：查配置、改配置、立刻闭嘴。
 *
 * 为什么用工具而不是让模型改配置页：用户平时是「说慢点」「声音太大」「换个男声」这么说的，
 * 让他自己去点控制台不现实。工具里做三件事——把口语翻译成合法档位、写进 `worlds.streamvoice`
 * （`ctx.persist`，落盘并立刻生效）、把改动讲回给模型，模型才知道自己现在是什么设置。
 *
 * **这个扩展能调的东西，工具里都能调**：嗓音四项、念哪些内容、切块长度、块间停顿、
 * 预热与详细日志，连挂载开关 `enabled` 也在里面。改的是同一份 `worlds.streamvoice`，
 * 和配置页完全等价，不是另一套影子参数。
 *
 * 数值都收整数并在这里对齐：语速/音调/音量按 5 一档，切块与停顿按配置页的上下限夹住，
 * 免得配置里留下下拉框和滑块显示不出来的野值。
 */
import type { ToolDef, ToolOutcome, ToolSpec } from 'cortico/core/types.ts';
import type { DescribeText } from 'cortico/core/types.ts';
import {
  CHUNK_MAX_CEIL,
  CHUNK_MAX_FLOOR,
  CHUNK_MIN_CEIL,
  CHUNK_MIN_FLOOR,
  GAP_MAX,
} from './config.ts';
import { VOICE_OPTIONS, type VoiceOption } from './voices.ts';

export const STATUS_TOOL = 'speech_status';
export const TUNE_TOOL = 'speech_tune';
export const SILENCE_TOOL = 'speech_silence';

/** 语速／音调／音量的上下限与档位；和配置页的下拉一致。 */
export const PROSODY_LIMIT = 50;
export const PROSODY_STEP = 5;

/** 模型能改的每一项；全部可选，但至少要有一项。 */
export interface SpeechPatch {
  // 嗓音
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  // 念什么
  readSay?: boolean;
  readAsk?: boolean;
  readOptions?: boolean;
  // 切块与节奏
  chunkMinChars?: number;
  chunkMaxChars?: number;
  gapMs?: number;
  // 高级
  prewarm?: boolean;
  verbose?: boolean;
  // 挂载开关
  enabled?: boolean;
}

/**
 * 全部工具的声明（不含 handler）；`tools()` 和 describe.json 都从这里取，
 * 免得两边各写一份、慢慢对不上。
 */
export const SPEECH_TOOL_DECLS: ToolSpec[] = [
  {
    name: STATUS_TOOL,
    tags: ['read', 'snapshot'],
    description:
      '查看自己现在的朗读设置：音色、语速、音调、音量，念哪些内容，切块长度、块间停顿，'
      + '预热与详细日志，扩展是开是关，以及此刻在不在说、队列还有几块。'
      + '刚改过设置想复核、不确定当前值、或者用户问「你现在什么声音」「你怎么念得这么慢」时用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: TUNE_TOOL,
    tags: ['write'],
    description:
      '修改自己的朗读设置，覆盖本扩展的全部可调项。改的是长期配置（和配置页同一份），下一句就生效，重启也还在。'
      + '所有字段都可选，但至少要给一项。常用对应关系：'
      + '说快/说慢 → rate；声音大/小 → volume；低沉/高一点 → pitch；换男声/女声/口音 → voice；'
      + '「别念选项」→ readOptions；「只念台词别念问题」→ readAsk；'
      + '「一句一停顿」→ gapMs；「别把半句话攒着」→ chunkMinChars；「别一次念太长」→ chunkMaxChars；'
      + '「别预热」→ prewarm；「详细日志」→ verbose；「整个别念了」→ enabled false（会停掉整个扩展，慎用）。'
      + '不确定当前值就先调 speech_status。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        voice: {
          type: 'string',
          description: '音色：中文名（晓晓、晓伊、云希、云扬、曉佳…）或 Edge ShortName（zh-CN-XiaoxiaoNeural）。只能用可用列表里的。',
        },
        rate: {
          type: 'integer',
          minimum: -PROSODY_LIMIT,
          maximum: PROSODY_LIMIT,
          description: '语速：相对原速的百分比，负数更慢，正数更快；按 5 取整。',
        },
        pitch: {
          type: 'integer',
          minimum: -PROSODY_LIMIT,
          maximum: PROSODY_LIMIT,
          description: '音调：Hz，负数更低沉，正数更明亮；按 5 取整。',
        },
        volume: {
          type: 'integer',
          minimum: -PROSODY_LIMIT,
          maximum: PROSODY_LIMIT,
          description: '音量：相对原音量的百分比，负数更轻；按 5 取整。',
        },
        readSay: { type: 'boolean', description: '念不念 pet_say 的台词。' },
        readAsk: { type: 'boolean', description: '念不念 pet_ask 的问题。' },
        readOptions: { type: 'boolean', description: '问句把可选答案也念出来吗。' },
        chunkMinChars: {
          type: 'integer',
          minimum: CHUNK_MIN_FLOOR,
          maximum: CHUNK_MIN_CEIL,
          description: `短于这么多字的一句并到下一句（${CHUNK_MIN_FLOOR}–${CHUNK_MIN_CEIL}）。调小第一声更快。`,
        },
        chunkMaxChars: {
          type: 'integer',
          minimum: CHUNK_MAX_FLOOR,
          maximum: CHUNK_MAX_CEIL,
          description: `一块最多这么多字，超过在逗号处再切（${CHUNK_MAX_FLOOR}–${CHUNK_MAX_CEIL}）。`,
        },
        gapMs: {
          type: 'integer',
          minimum: 0,
          maximum: GAP_MAX,
          description: `一块说完后额外停多久，毫秒（0–${GAP_MAX}）。嫌说得太赶就加几十毫秒。`,
        },
        prewarm: { type: 'boolean', description: '模型开始写时先空合成一声预热连接，第一句能快约 2 秒。' },
        verbose: { type: 'boolean', description: '把每一块的合成耗时写进日志。' },
        enabled: {
          type: 'boolean',
          description: '扩展的总开关。false = 整个扩展停止工作、不再出声，要重新打开得先关掉「允许模型自己调嗓音」以外的地方有人动手；除非用户明确要求彻底别念，否则用 speech_silence。',
        },
      },
    },
  },
  {
    name: SILENCE_TOOL,
    tags: ['write'],
    description:
      '立刻停掉自己正在念的、以及排队等着念的内容，但不影响接下来的新台词，也不改任何设置。'
      + '用户说「别念了」「先停一下」「安静」，而你这一轮还要继续说别的话时用它；'
      + '要整轮彻底安静用 pet_quiet——那个是连后面的台词一起不念。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** 自描述里给人看的一句话（扩展市场与 World 页用）。 */
export const SPEECH_TOOL_SUMMARIES: Record<string, DescribeText> = {
  [STATUS_TOOL]: {
    zh: '查看当前的嗓音、念什么、切块与节奏、高级项和队列状态。',
    en: 'Show voice, what is read, chunking, advanced flags and the queue.',
  },
  [TUNE_TOOL]: {
    zh: '按用户的口语要求改本扩展的全部可调项（嗓音、念什么、切块、节奏、高级、总开关），写进长期配置，下一句生效。',
    en: 'Tune any setting of this extension from a spoken request; persists and applies to the next sentence.',
  },
  [SILENCE_TOOL]: {
    zh: '立刻停掉正在念的和排队的，不改设置、不影响后面的新台词。',
    en: 'Stop the current line and the queue, without changing settings or later lines.',
  },
};

export interface SpeechToolHandlers {
  /** 一句话描述当前设置。 */
  status(): string;
  /** 改设置；返回回执，失败时给 failed。 */
  tune(patch: SpeechPatch): string | ToolOutcome;
  /** 立刻停止；返回告诉模型清掉了几块。 */
  silence(): string;
  /** 配置里是否允许模型自己改设置。 */
  allowTuning(): boolean;
}

/**
 * 装配成 ToolDef。`allowTuning()` 为 false 时只给查看和停止——
 * 有人不喜欢宠物自己改设置，关掉那个开关就够了。
 */
export function speechToolDefs(handlers: SpeechToolHandlers): ToolDef[] {
  const defs: ToolDef[] = [];
  const decl = (name: string): ToolSpec => {
    const found = SPEECH_TOOL_DECLS.find((d) => d.name === name);
    if (!found) throw new Error(`missing tool declaration: ${name}`);
    return found;
  };

  defs.push({ ...decl(STATUS_TOOL), handler: async () => handlers.status() });

  if (handlers.allowTuning()) {
    defs.push({ ...decl(TUNE_TOOL), handler: async (args) => handlers.tune(readPatch(args)) });
  }

  defs.push({ ...decl(SILENCE_TOOL), handler: async () => handlers.silence() });

  return defs;
}

const BOOLEAN_KEYS = ['readSay', 'readAsk', 'readOptions', 'prewarm', 'verbose', 'enabled'] as const;
const NUMBER_KEYS = ['rate', 'pitch', 'volume', 'chunkMinChars', 'chunkMaxChars', 'gapMs'] as const;

/**
 * 从工具参数里挑出各项。模型偶尔把数字写成字符串、把布尔写成 `"true"`，
 * 这里顺手认掉；认不出来的直接丢，交给上层报「没改动」。
 */
export function readPatch(args: Record<string, unknown>): SpeechPatch {
  const patch: SpeechPatch = {};
  if (typeof args.voice === 'string' && args.voice.trim()) patch.voice = args.voice.trim();
  for (const key of NUMBER_KEYS) {
    const raw = args[key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n)) patch[key] = n;
  }
  for (const key of BOOLEAN_KEYS) {
    const raw = args[key];
    if (typeof raw === 'boolean') patch[key] = raw;
    else if (raw === 'true' || raw === 'false') patch[key] = raw === 'true';
  }
  return patch;
}

/** 对齐到 5 的整数档并夹进 -50…50；`kind` 决定单位。 */
export function prosodyValue(kind: 'percent' | 'hz', raw: number): string {
  const snapped = Math.round(Math.max(-PROSODY_LIMIT, Math.min(PROSODY_LIMIT, raw)) / PROSODY_STEP) * PROSODY_STEP;
  return `${snapped >= 0 ? '+' : ''}${snapped}${kind === 'hz' ? 'Hz' : '%'}`;
}

/** 音色：先认 ShortName，再认中文名（「晓晓」「云希」），也认整段标签。 */
export function resolveVoice(raw: string): VoiceOption | null {
  const want = raw.trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  const byId = VOICE_OPTIONS.find((v) => v.id.toLowerCase() === lower);
  if (byId) return byId;
  const byName = VOICE_OPTIONS.find((v) => nameOf(v) === want);
  if (byName) return byName;
  const byFullLabel = VOICE_OPTIONS.find((v) => v.label === want);
  return byFullLabel ?? null;
}

/** 音色名（标签的第一段）。 */
export function nameOf(v: VoiceOption): string {
  return v.label.split(' · ')[0]!.trim();
}

/** 给模型看的可用音色清单，错误回执里附几行，免得它瞎猜。 */
export function voiceListBrief(limit = 8): string {
  const zh = VOICE_OPTIONS.filter((v) => v.id.startsWith('zh-CN')).slice(0, limit);
  return zh.map((v) => `${nameOf(v)}（${v.id}）`).join('、');
}
