/**
 * 本扩展自己的嗓音表。
 *
 * 不读任何别的扩展的配置：默认值、可选音色、语速／音调／音量档位都在这里定，
 * 存在 `worlds.streamvoice` 自己那段里。
 *
 * 音色是本机 Edge 朗读接口实际返回的名单（`voices/list` 拉下来筛的中日韩英 30 个），
 * 不在名单里的 ShortName 也可以手写进 config.json，只是可能合成失败。
 */
import type { SpeechStyle } from './speaker.ts';

export interface VoiceOption {
  /** Edge TTS 的 ShortName，存进配置的就是它。 */
  id: string;
  /** 给人看的名字。 */
  label: string;
}

/** 常用音色，中文排前面；名单已逐个试过能出声（Edge 朗读接口实际提供的就这些）。 */
export const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女 · 温暖' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女 · 活泼' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男 · 阳光' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男 · 播音' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男 · 浑厚' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 男 · 少年' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女 · 东北口音' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女 · 陕西口音' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 女 · 粤语' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女 · 粤语' },
  { id: 'zh-HK-WanLungNeural', label: '萬龍 · 男 · 粤语' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 女 · 台湾' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 女 · 台湾' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲 · 男 · 台湾' },
  { id: 'en-US-AriaNeural', label: 'Aria · 女 · English (US)' },
  { id: 'en-US-JennyNeural', label: 'Jenny · 女 · English (US)' },
  { id: 'en-US-AvaNeural', label: 'Ava · 女 · English (US)' },
  { id: 'en-US-EmmaNeural', label: 'Emma · 女 · English (US)' },
  { id: 'en-US-GuyNeural', label: 'Guy · 男 · English (US)' },
  { id: 'en-US-AndrewNeural', label: 'Andrew · 男 · English (US)' },
  { id: 'en-US-BrianNeural', label: 'Brian · 男 · English (US)' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher · 男 · English (US)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · 女 · English (UK)' },
  { id: 'en-GB-LibbyNeural', label: 'Libby · 女 · English (UK)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan · 男 · English (UK)' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 女 · 日本語' },
  { id: 'ja-JP-KeitaNeural', label: '圭太 · 男 · 日本語' },
  { id: 'ko-KR-SunHiNeural', label: '선히 · 女 · 한국어' },
  { id: 'ko-KR-InJoonNeural', label: '인준 · 男 · 한국어' },
];

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 语速：相对原速的百分比，5% 一档。-50% 约为半速，+50% 约为倍半速。 */
export const RATE_OPTIONS = percentSteps(-50, 50, 5);
/** 音量：相对原音量的百分比，5% 一档。 */
export const VOLUME_OPTIONS = percentSteps(-50, 50, 5);
/** 音调：Hz，5Hz 一档。负数更低沉，正数更明亮。 */
export const PITCH_OPTIONS = hzSteps(-50, 50, 5);

export const DEFAULT_PITCH = '+0Hz';

/** `-50%` … `+50%`，5 一档，0 写成 `+0%`。 */
function percentSteps(from: number, to: number, step: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += step) out.push(`${n >= 0 ? '+' : ''}${n}%`);
  return out;
}

/** `-50Hz` … `+50Hz`。 */
function hzSteps(from: number, to: number, step: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n += step) out.push(`${n >= 0 ? '+' : ''}${n}Hz`);
  return out;
}

/** 音色下拉走这个 kind；由 WorldDefinition.configOptions 供给选项表。 */
export const VOICE_OPTIONS_KIND = 'streamvoice.voices';

/** `/api/config/options/:kind` 要的 `{value,label}` 行。 */
export function voiceOptionRows(): Array<{ value: string; label: string }> {
  return VOICE_OPTIONS.map((v) => ({ value: v.id, label: v.label }));
}

/** 音色的中文名，日志和面板上用；表里没有就原样给 ShortName。 */
export function voiceLabel(id: string): string {
  return VOICE_OPTIONS.find((v) => v.id === id)?.label.split(' · ')[0] ?? id;
}

/** 从配置读出这次要用的嗓音；缺项退回默认值。 */
export function styleOf(cfg: Record<string, unknown>): SpeechStyle {
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  return {
    voice: str(cfg.voice, DEFAULT_VOICE),
    rate: str(cfg.rate, '+0%'),
    pitch: str(cfg.pitch, DEFAULT_PITCH),
    volume: str(cfg.volume, '+0%'),
  };
}
