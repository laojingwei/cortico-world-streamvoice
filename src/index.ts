/** 扩展入口：默认导出 WorldDefinition，框架按 `cortico.kind: world` 装载。 */
export { STREAMVOICE as default } from './definition.ts';
export {
  STREAMVOICE_DEFAULTS,
  STREAMVOICE_ID,
  apiOf,
  chunkLimits,
  engineOf,
  streamVoiceConfigGroups,
  styleOf,
  type SpeechEngine,
  type StreamVoiceConfigSection,
} from './config.ts';
export { DEFAULT_VOICE, RATE_OPTIONS, VOICE_OPTIONS, VOLUME_OPTIONS, voiceOptionRows } from './voices.ts';
export { duplicateReaders, readOptionsOf } from './voice.ts';
export { StreamVoiceWorld, type StreamVoiceWorldOptions } from './world.ts';
