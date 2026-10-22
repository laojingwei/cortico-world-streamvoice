/**
 * 这次要用的嗓音，以及「是不是还有别人在朗读」的检查。
 *
 * 嗓音来自本扩展自己的 `worlds.streamvoice`（voice / rate / volume），跟别的扩展无关；
 * 框架把 cfg 给的是活引用，所以在配置页改完，下一句就换过来，不用重启。
 *
 * `duplicateReaders()` 只是好意提醒：装了别的会整段朗读的 World 又开着它，同一句会被念两遍。
 * 它只是读一下配置里的已知字段，包没装就当不存在——不装也完全能用。
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeechStyle } from './speaker.ts';
import { styleOf } from './voices.ts';

export { styleOf };

/** 问句要不要把可选项念出来；缺省念。 */
export function readOptionsOf(cfg: Record<string, unknown>): boolean {
  return cfg.readOptions !== false;
}

/** 念不念 `pet_say` 的台词；缺省念。 */
export function readSayOf(cfg: Record<string, unknown>): boolean {
  return cfg.readSay !== false;
}

/** 念不念 `pet_ask` 的问题；缺省念。 */
export function readAskOf(cfg: Record<string, unknown>): boolean {
  return cfg.readAsk !== false;
}

/** 预热合成链路；缺省开。 */
export function prewarmOf(cfg: Record<string, unknown>): boolean {
  return cfg.prewarm !== false;
}

/** 逐块打详细日志；缺省关。 */
export function verboseOf(cfg: Record<string, unknown>): boolean {
  return cfg.verbose === true;
}

/** 允不允许模型自己改嗓音；缺省允许。 */
export function allowSelfTuningOf(cfg: Record<string, unknown>): boolean {
  return cfg.allowSelfTuning !== false;
}

/** 已知的「会整段朗读」的 World：配置路径 + 人话名字 + 判断它开没开。 */
const OTHER_READERS: Array<{
  world: string;
  pkg: string;
  name: string;
  on: (cfg: Record<string, unknown>) => boolean;
}> = [
  {
    world: 'fatfish',
    pkg: 'cortico-world-fatfish',
    name: '大肥鱼功能复合包',
    on: (cfg) => cfg.enabled !== false && cfg.ttsEnabled !== false,
  },
  {
    world: 'desktop-pet',
    pkg: 'cortico-world-desktop-pet',
    name: '桌面宠物（语音库朗读）',
    on: (cfg) => (cfg.speech as Record<string, unknown> | undefined)?.enabled === true,
  },
];

/**
 * 还开着整段朗读、并且确实装了包的 World 名字。
 *
 * 只读 config.json 里那几个已知字段，读不到就返回空——没有这些扩展时这里什么都不做。
 */
export function duplicateReaders(botDir: string): string[] {
  const modules = join(botDir, '..', '..', 'extensions', 'node_modules');
  let worlds: Record<string, Record<string, unknown> | undefined>;
  try {
    const root = JSON.parse(readFileSync(join(botDir, 'config.json'), 'utf8')) as {
      worlds?: Record<string, Record<string, unknown> | undefined>;
    };
    worlds = root.worlds ?? {};
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const reader of OTHER_READERS) {
    const cfg = worlds[reader.world];
    if (!cfg) continue;
    // 包不在（卸掉了，配置段还留着）就不提醒
    if (!existsSync(join(modules, reader.pkg))) continue;
    if (reader.on(cfg)) out.push(reader.name);
  }
  return out;
}

/** 面板与日志上用的一句嗓音说明。 */
export function describeStyle(style: SpeechStyle): string {
  return `${style.voice} · ${style.rate} · ${style.pitch} · ${style.volume}`;
}
