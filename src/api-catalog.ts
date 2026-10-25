/**
 * API 引擎的音色与模型清单：探测结果缓存 + 人类看得懂的说明。
 *
 * 两个用途：
 * 1. 配置页的 `apiVoice` / `apiModel` 是 `x-options` 下拉，选项从这里来——所以不用先点
 *    「连接测试」，只要探测过一次（或启动时自动探测），下拉里就有后端真实支持的清单；
 * 2. 面板打开时直接渲染下拉，同样不必每次重测。
 *
 * 后端只回名字（`{"voices":["vivian", …]}`）时，说明来自内置表：那是 Qwen3-TTS 官方
 * 公布的音色描述，名字对不上就只显示名字，不硬猜。
 */
import type { Language } from 'cortico/core/language.ts';

/** 探测一次拿到的清单；存进 `worlds.streamvoice.apiCatalog`。 */
export interface ApiCatalog {
  /** 探测时用的根地址，地址改了这份缓存就作废。 */
  base: string;
  /** 探测时刻（毫秒）。 */
  at: number;
  voices: string[];
  models: string[];
}

/** 配置页 `x-options` 用的 kind：音色与模型。 */
export const API_VOICES_KIND = 'streamvoice.apiVoices';
export const API_MODELS_KIND = 'streamvoice.apiModels';

/** 内置说明：value 是后端要的名字（大小写不敏感匹配）。 */
const KNOWN: Record<string, { zh: string; en: string }> = {
  vivian: { zh: '明亮、略带锋芒的年轻女声 · 中文', en: 'bright, slightly edgy young female · Chinese' },
  serena: { zh: '温暖、柔和的年轻女声 · 中文', en: 'warm, gentle young female · Chinese' },
  uncle_fu: { zh: '低沉圆润的熟龄男声 · 中文', en: 'seasoned male, low and mellow · Chinese' },
  dylan: { zh: '清亮自然的北京青年男声 · 中文（北京话）', en: 'youthful Beijing male · Chinese (Beijing)' },
  eric: { zh: '略带沙哑的成都青年男声 · 中文（四川话）', en: 'lively Chengdu male · Chinese (Sichuan)' },
  ryan: { zh: '节奏感强的动感男声 · 英语', en: 'dynamic male with strong rhythm · English' },
  aiden: { zh: '中音清亮的阳光美式男声 · 英语', en: 'sunny American male · English' },
  ono_anna: { zh: '轻快灵动的俏皮日系女声 · 日语', en: 'playful Japanese female · Japanese' },
  sohee: { zh: '情感丰沛的温暖韩系女声 · 韩语', en: 'warm Korean female · Korean' },
  default: { zh: '后端默认音色', en: "the backend's default voice" },
};

/** 名字后面那段说明；不认识的名字返回空串。 */
export function apiVoiceNote(name: string, language: Language = 'zh'): string {
  const hit = KNOWN[name.trim().toLowerCase()];
  if (!hit) return '';
  return language === 'en' ? hit.en : hit.zh;
}

/** 配置页与面板上用的一行：「serena — 温暖柔和的年轻女声 · 中文」。 */
export function apiVoiceLabel(name: string, language: Language = 'zh'): string {
  const note = apiVoiceNote(name, language);
  return note ? `${name} — ${note}` : name;
}

/** 从配置里读缓存；形状不对就当没有。 */
export function catalogOf(cfg: Record<string, unknown>): ApiCatalog | null {
  const raw = cfg.apiCatalog;
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  const voices = strings(it.voices);
  const models = strings(it.models);
  if (!voices.length && !models.length) return null;
  return {
    base: typeof it.base === 'string' ? it.base : '',
    at: typeof it.at === 'number' && Number.isFinite(it.at) ? it.at : 0,
    voices,
    models,
  };
}

/** 缓存还认不认这个地址：地址变了就当过期。 */
export function catalogFits(catalog: ApiCatalog | null, base: string): boolean {
  return !!catalog && (!catalog.base || !base || catalog.base === base);
}

/* ---------------- x-options：配置页与面板共用的选项表 ---------------- */

/**
 * 进程内当前生效的缓存。
 *
 * `configOptions(kind, language)` 是 World 定义上的纯函数，拿不到 cfg，所以由 World 在
 * 启动、探测、保存时把缓存同步到这里；配置页请求下拉选项时读它。
 */
let active: ApiCatalog | null = null;

export function setActiveCatalog(catalog: ApiCatalog | null): void {
  active = catalog;
}

export function activeCatalog(): ApiCatalog | null {
  return active;
}

export function apiVoiceRows(language: Language = 'zh'): Array<{ value: string; label: string }> {
  const names = active?.voices ?? [];
  return names.map((name) => ({ value: name, label: apiVoiceLabel(name, language) }));
}

/**
 * 模型下拉。空值表示「不发送 model」，所以永远排第一行；
 * 缓存里没有模型时只留这一行——框架会把当前值补进表里，不会把设置弄丢。
 */
export function apiModelRows(language: Language = 'zh'): Array<{ value: string; label: string }> {
  const rows = [{ value: '', label: language === 'en' ? '(not sent)' : '（不发送）' }];
  for (const name of active?.models ?? []) rows.push({ value: name, label: name });
  return rows;
}
