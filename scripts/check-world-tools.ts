/**
 * World 层的冒烟测试：真的 new 一个 StreamVoiceWorld，调它交给模型的工具。
 *
 *   node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs scripts/check-world-tools.ts
 *
 * 不连 Edge、不出声、不碰部署目录：只验「工具表给不给、改完配置变没变、回执说不说得清」。
 * 重点验一句承诺：**这个扩展能调的，模型就能调**——十三项都要真的落到配置里。
 */
import { existsSync, readFileSync } from 'node:fs';
import { STREAMVOICE_DEFAULTS, type StreamVoiceConfigSection } from '../src/config.ts';
import { StreamVoiceWorld } from '../src/world.ts';
import { SILENCE_TOOL, STATUS_TOOL, TUNE_TOOL } from '../src/tools.ts';

let failed = 0;
function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 活的配置对象 + 记下每次 persist 的补丁（和框架一样做浅合并就够验了）。 */
function makeWorld(overrides: Partial<StreamVoiceConfigSection> = {}): {
  world: StreamVoiceWorld;
  cfg: StreamVoiceConfigSection;
  patches: Record<string, unknown>[];
} {
  const cfg: StreamVoiceConfigSection = { ...STREAMVOICE_DEFAULTS, enabled: true, ...overrides };
  const patches: Record<string, unknown>[] = [];
  const world = new StreamVoiceWorld({
    cfg,
    botDir: process.cwd(),
    persist: (patch) => {
      patches.push(patch);
      Object.assign(cfg, patch);
    },
  });
  return { world, cfg, patches };
}

const tool = (world: StreamVoiceWorld, name: string) => world.tools().find((t) => t.name === name);

console.log('工具表');
const { world, cfg, patches } = makeWorld();
ok('挂载后给出 3 个工具', world.tools().length === 3, world.tools().map((t) => t.name).join(','));
ok('三个名字都在', [STATUS_TOOL, TUNE_TOOL, SILENCE_TOOL].every((n) => !!tool(world, n)));

console.log('speech_status');
const status = await tool(world, STATUS_TOOL)!.handler({}, {} as never);
ok('回执带当前音色', status.includes('zh-CN-XiaoxiaoNeural'), String(status).slice(0, 80));
ok('回执带念什么', status.includes('念什么'));
ok('回执带切块与节奏', status.includes('切块与节奏'));
ok('回执带高级项与总开关', status.includes('详细日志') && status.includes('总开关'));
ok('回执带此刻状态', status.includes('待命'));

console.log('speech_tune：嗓音四项');
const tuned = await tool(world, TUNE_TOOL)!.handler({ voice: '云希', rate: 20, volume: -15 }, {} as never);
ok('回执说明音色变了', String(tuned).includes('云希'), String(tuned).slice(0, 100));
ok('口语名翻成 ShortName', cfg.voice === 'zh-CN-YunxiNeural', String(cfg.voice));
ok('语速对齐到 +20%', cfg.rate === '+20%', String(cfg.rate));
ok('音量对齐到 -15%', cfg.volume === '-15%', String(cfg.volume));

console.log('speech_tune：念什么 / 切块 / 节奏 / 高级');
const tuned2 = await tool(world, TUNE_TOOL)!.handler(
  { readOptions: false, chunkMinChars: 3, chunkMaxChars: 80, gapMs: 120, prewarm: false, verbose: true },
  {} as never,
);
ok('念选项关掉', cfg.readOptions === false, String(cfg.readOptions));
ok('切块门槛写进去', cfg.chunkMinChars === 3, String(cfg.chunkMinChars));
ok('单块上限写进去', cfg.chunkMaxChars === 80, String(cfg.chunkMaxChars));
ok('块间停顿写进去', cfg.gapMs === 120, String(cfg.gapMs));
ok('预热关掉', cfg.prewarm === false, String(cfg.prewarm));
ok('详细日志打开', cfg.verbose === true, String(cfg.verbose));
ok('回执逐项列了改动', String(tuned2).includes('念选项 开 → 关') && String(tuned2).includes('停顿'), String(tuned2).slice(0, 120));
ok('两次改动各发一个补丁', patches.length === 2, String(patches.length));

console.log('边界：单块上限被给到比门槛还小');
const bumped = await tool(world, TUNE_TOOL)!.handler({ chunkMinChars: 40, chunkMaxChars: 20 }, {} as never);
ok('min 写进去', cfg.chunkMinChars === 40, String(cfg.chunkMinChars));
ok('max 被抬到不小于 min', cfg.chunkMaxChars === 40, `min=${cfg.chunkMinChars} max=${cfg.chunkMaxChars}`);
ok('回执说明了这件事', String(bumped).includes('抬到门槛'), String(bumped).slice(0, 120));

console.log('非法输入');
const badVoice = await tool(world, TUNE_TOOL)!.handler({ voice: '林黛玉' }, {} as never);
ok('不认识的音色被拒', typeof badVoice === 'object' && badVoice.failed === true);
ok('拒绝时提示可用音色', String((badVoice as { text: string }).text).includes('晓晓'));
const empty = await tool(world, TUNE_TOOL)!.handler({}, {} as never);
ok('空参数不改配置', patches.length === 3 && String(empty).includes('什么都没改'));

console.log('speech_silence');
const quiet = await tool(world, SILENCE_TOOL)!.handler({}, {} as never);
ok('没在念时如实说不用停', String(quiet).includes('不用停'), String(quiet));

console.log('总开关');
const offWorld = makeWorld();
const off = await tool(offWorld.world, TUNE_TOOL)!.handler({ enabled: false }, {} as never);
ok('enabled 写进配置', offWorld.cfg.enabled === false);
ok('回执提醒要人工恢复', String(off).includes('主人在控制台'), String(off).slice(-90));
ok('关掉后工具表清空', offWorld.world.tools().length === 0, String(offWorld.world.tools().length));

console.log('关掉 allowSelfTuning');
const locked = makeWorld({ allowSelfTuning: false });
ok('工具表只剩 2 个', locked.world.tools().length === 2, locked.world.tools().map((t) => t.name).join(','));
ok('speech_tune 消失', !tool(locked.world, TUNE_TOOL));
ok('状态与停止还在', !!tool(locked.world, STATUS_TOOL) && !!tool(locked.world, SILENCE_TOOL));

console.log('环境提示词');
{
  const tpl = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
  const fresh = makeWorld();
  const vars = fresh.world.envPromptVars();
  const placeholders = [...new Set([...tpl.matchAll(/\{\{\s*([\w.]+)\s*(?:\|[^}]*)?\}\}/g)].map((m) => m[1]!))];
  ok('模板里有占位符', placeholders.length > 0, String(placeholders.length));
  const missingVars = placeholders.filter((p) => !(p in vars));
  ok('每个占位符都有变量', missingVars.length === 0, missingVars.join(','));
  const extraVars = Object.keys(vars).filter((k) => !placeholders.includes(k));
  ok('没有用不上的变量', extraVars.length === 0, extraVars.join(','));

  const rendered = tpl.replace(
    /\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g,
    (whole, name: string, fallback?: string) => (name in vars ? vars[name] || (fallback ?? '') : whole),
  );
  ok('渲染后没有残留占位符', !rendered.includes('{{'), (rendered.match(/\{\{[^}]*\}\}/g) ?? []).join(','));
  ok('渲染结果带当前音色', rendered.includes('zh-CN-XiaoxiaoNeural'));
  ok('渲染结果带工具名', rendered.includes('speech_tune') && rendered.includes('speech_silence'));

  const docs = fresh.world.webUi('zh').promptDocs ?? [];
  const envDoc = docs.find((d) => d.role === 'envPrompt');
  ok('声明了 envPrompt 提示词', !!envDoc);
  ok('模板文件真实存在', !!envDoc && existsSync(envDoc.path), envDoc?.path);
  ok('提示词 key 按惯例带 World 前缀', envDoc?.key === 'worlds.streamvoice.env', envDoc?.key);
  ok('声明的变量与模板一致', (envDoc?.vars ?? []).every((v) => placeholders.includes(v.name)));

  const lockedVars = makeWorld({ allowSelfTuning: false }).world.envPromptVars();
  ok('关掉调参后提示词改说「不能改」', String(lockedVars['streamvoice.canTune']).includes('不在你的工具表里'));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
