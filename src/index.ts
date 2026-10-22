/** 扩展入口：默认导出 WorldDefinition，框架按 `cortico.kind: world` 装载。 */
export { STREAMVOICE as default } from './definition.ts';
export { STREAMVOICE_DEFAULTS, STREAMVOICE_ID, chunkLimits, streamVoiceConfigGroups, type StreamVoiceConfigSection } from './config.ts';
export { DEFAULT_VOICE, RATE_OPTIONS, VOICE_OPTIONS, VOLUME_OPTIONS, voiceOptionRows, styleOf } from './voices.ts';
export { duplicateReaders, readOptionsOf } from './voice.ts';
export { StreamVoiceWorld, type StreamVoiceWorldOptions } from './world.ts';
