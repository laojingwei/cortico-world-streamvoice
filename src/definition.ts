/** 流式语音播报的 World 定义。 */
import type { Language } from 'cortico/core/language.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { STREAMVOICE_DEFAULTS, STREAMVOICE_ID, type StreamVoiceConfigSection } from './config.ts';
import { SPEECH_TOOL_DECLS, SPEECH_TOOL_SUMMARIES } from './tools.ts';
import { VOICE_OPTIONS_KIND, voiceOptionRows } from './voices.ts';
import { StreamVoiceWorld } from './world.ts';

/**
 * 自描述里的工具清单。刻意不用 `describeTools()`：那是从 `cortico/world.ts` 取的值，
 * 而本扩展在运行期只依赖类型导入，少一个跨包解析就少一种装不上的可能。
 */
const DESCRIBE = {
  tools: SPEECH_TOOL_DECLS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    tags: d.tags,
    summary: SPEECH_TOOL_SUMMARIES[d.name] ?? d.description,
  })),
  events: [],
};

export const STREAMVOICE: WorldDefinition<StreamVoiceConfigSection> = {
  id: STREAMVOICE_ID,
  label: '流式语音播报',
  defaults: () => ({ ...STREAMVOICE_DEFAULTS }),
  create: (ctx) => new StreamVoiceWorld({
    cfg: ctx.cfg,
    botDir: ctx.botDir,
    // 模型改嗓音时走这里：深合并进 worlds.streamvoice，活引用与 config.json 同步
    persist: (patch) => ctx.persist(patch as Partial<StreamVoiceConfigSection>),
  }),
  // 音色下拉的选项表由本扩展自己给，所以不依赖别的 World 提供的音色清单
  configOptions: (kind: string, _language: Language) => (kind === VOICE_OPTIONS_KIND ? voiceOptionRows() : []),
  // 三个只管声音的工具，不发事件；清单与 tools() 同源
  describe: DESCRIBE,
};
