/** 流式语音播报的 World 定义。 */
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { STREAMVOICE_DEFAULTS, STREAMVOICE_ID, type StreamVoiceConfigSection } from './config.ts';
import { VOICE_OPTIONS_KIND, voiceOptionRows } from './voices.ts';
import { StreamVoiceWorld } from './world.ts';

export const STREAMVOICE: WorldDefinition<StreamVoiceConfigSection> = {
  id: STREAMVOICE_ID,
  label: '流式语音播报',
  defaults: () => ({ ...STREAMVOICE_DEFAULTS }),
  create: (ctx) => new StreamVoiceWorld({ cfg: ctx.cfg, botDir: ctx.botDir }),
  // 音色下拉的选项表由本扩展自己给，所以不依赖别的 World 提供的音色清单
  configOptions: (kind: string, _language: Language) => (kind === VOICE_OPTIONS_KIND ? voiceOptionRows() : []),
  // 不发事件、不给模型工具：声音只是气泡的回声
  describe: { tools: [], events: [] },
};
