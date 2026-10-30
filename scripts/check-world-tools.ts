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
const tuned = await tool(world, TUNE_TOOL)!.handler({ voice: '云希', rate: 1.2, volume: 0.85 }, {} as never);
ok('回执说明音色变了', String(tuned).includes('云希'), String(tuned).slice(0, 100));
ok('口语名翻成 ShortName', cfg.voice === 'zh-CN-YunxiNeural', String(cfg.voice));
ok('语速写成 1.2×', cfg.rate === 1.2, String(cfg.rate));
ok('音量写成 0.85×', cfg.volume === 0.85, String(cfg.volume));

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

console.log('speech_tune：引擎与 API');
const apiWorld = makeWorld();
const apiTuned = await tool(apiWorld.world, TUNE_TOOL)!.handler({
  engine: 'api',
  apiBase: 'http://127.0.0.1:8091/v1/audio/speech',
  apiVoice: 'serena',
  apiFormat: 'wav',
  apiInstructions: '用开心的语气说',
  apiSpeedFactor: 1.35,
  apiTimeoutMs: 20000,
}, {} as never);
ok('engine 写进配置', apiWorld.cfg.engine === 'api', String(apiWorld.cfg.engine));
ok('整条端点被截成根地址', apiWorld.cfg.apiBase === 'http://127.0.0.1:8091/v1', String(apiWorld.cfg.apiBase));
ok('API 音色写进配置', apiWorld.cfg.apiVoice === 'serena', String(apiWorld.cfg.apiVoice));
ok('音频格式写进配置', apiWorld.cfg.apiFormat === 'wav', String(apiWorld.cfg.apiFormat));
ok('语气指令写进配置', apiWorld.cfg.apiInstructions === '用开心的语气说', String(apiWorld.cfg.apiInstructions));
ok('语速倍率写进配置', apiWorld.cfg.apiSpeedFactor === 1.35, String(apiWorld.cfg.apiSpeedFactor));
ok('超时写进配置', apiWorld.cfg.apiTimeoutMs === 20000, String(apiWorld.cfg.apiTimeoutMs));
ok('回执说清引擎换了', String(apiTuned).includes('引擎 Edge 朗读 → API 服务'), String(apiTuned).slice(0, 120));
ok('回执里的音色是后端名字', String(apiTuned).includes('serena'), String(apiTuned).slice(0, 200));

console.log('页签：配置页只剩通用项');
const apiGroups = apiWorld.world.webUi('zh').config ?? [];
ok('两套引擎不再摆在配置页', !apiGroups.some((g) => g.id === 'world:streamvoice.voice'
  || g.id === 'world:streamvoice.api'), apiGroups.map((g) => g.id).join(','));
ok('配置页留着念什么 / 切块 / 高级', ['content', 'chunks', 'advanced'].every(
  (k) => apiGroups.some((g) => g.id === `world:streamvoice.${k}`),
), apiGroups.map((g) => g.id).join(','));
ok('令牌不进配置页', !apiGroups.some((g) => Object.keys(g.schema.properties).includes('worlds.streamvoice.apiKey')));

console.log('页签：Edge 语音 / API 语音 各一页');
const decl = apiWorld.world.webUi('zh');
const panels = decl.panels ?? [];
ok('三个页签：运行状态 + Edge + API', panels.map((p) => p.id).join(',') === 'stream,edge-voice,api-voice',
  panels.map((p) => `${p.id}:${p.title}`).join(' / '));
ok('页签标题就是两组的中文名', panels[1]?.title === 'Edge 语音' && panels[2]?.title === 'API 语音',
  panels.map((p) => p.title).join(' / '));

type FieldSpec = { key: string; type: string; value?: unknown; options?: Array<{ value: string; label: string }>; placeholder?: string };
const invokePanel = async (panel: string, method: string, args: unknown[] = []) =>
  (await decl.invoke!(panel, method, args)) as { fields: FieldSpec[]; ok?: boolean; text?: string; error?: string };

const edgeSpec = await invokePanel('edge-voice', 'fields');
ok('Edge 页有启用开关与全部嗓音参数', ['useEdge', 'voice', 'rate', 'pitch', 'volume'].every(
  (k) => edgeSpec.fields.some((f) => f.key === k),
), edgeSpec.fields.map((f) => f.key).join(','));
ok('Edge 音色是下拉、带人话标签', (edgeSpec.fields.find((f) => f.key === 'voice')?.options ?? [])
  .some((o) => o.value === 'zh-CN-XiaoxiaoNeural' && o.label.includes('女')), '');
ok('Edge 页当前值来自活配置', edgeSpec.fields.find((f) => f.key === 'voice')?.value === apiWorld.cfg.voice,
  String(edgeSpec.fields.find((f) => f.key === 'voice')?.value));
ok('Edge 语速/音量是滑动条', ['rate', 'volume'].every(
  (k) => edgeSpec.fields.find((f) => f.key === k)?.type === 'slider',
), edgeSpec.fields.map((f) => `${f.key}:${f.type}`).filter((s) => s.startsWith('rate') || s.startsWith('volume')).join(','));

const apiSpec = await invokePanel('api-voice', 'fields');
ok('API 页有全部项', ['useApi', 'apiBase', 'apiKey', 'apiVoice', 'apiModel', 'apiFormat',
  'apiLanguage', 'apiInstructions', 'apiSpeedFactor', 'apiVolume', 'apiTimeoutMs'].every(
  (k) => apiSpec.fields.some((f) => f.key === k),
), apiSpec.fields.map((f) => f.key).join(','));
const keyField = apiSpec.fields.find((f) => f.key === 'apiKey')!;
ok('令牌框是 password 且不回显', keyField.type === 'password' && keyField.value === '', JSON.stringify(keyField.value));
ok('令牌框说明了有没有设过', typeof keyField.placeholder === 'string' && keyField.placeholder.length > 0,
  String(keyField.placeholder));
ok('API 音色是下拉（无缓存时也留当前值）', (apiSpec.fields.find((f) => f.key === 'apiVoice')?.options ?? []).length > 0);
ok('API 语速/音量是滑动条', ['apiSpeedFactor', 'apiVolume'].every(
  (k) => apiSpec.fields.find((f) => f.key === k)?.type === 'slider',
), apiSpec.fields.map((f) => `${f.key}:${f.type}`).filter((s) => s.startsWith('apiSpeed') || s.startsWith('apiVolume')).join(','));

console.log('页签：保存');
const saved = await invokePanel('api-voice', 'save', [{ apiVoice: 'aiden', apiFormat: 'mp3', apiVolume: 2 }]);
ok('保存写进配置', apiWorld.cfg.apiVoice === 'aiden' && apiWorld.cfg.apiVolume === 2 && apiWorld.cfg.apiFormat === 'mp3',
  `${String(apiWorld.cfg.apiVoice)} / ${String(apiWorld.cfg.apiVolume)}`);
ok('回执列了改动', String(saved.text).includes('aiden'), String(saved.text).slice(0, 100));
const badPanelFormat = await invokePanel('api-voice', 'save', [{ apiFormat: 'ogg' }]);
ok('页签保存拒掉不支持的格式', badPanelFormat.ok === false && String(badPanelFormat.error).includes('mp3'), String(badPanelFormat.error));
ok('被拒后配置没动', apiWorld.cfg.apiFormat === 'mp3', String(apiWorld.cfg.apiFormat));

apiWorld.cfg.engine = 'api';
apiWorld.cfg.useEdge = false;
apiWorld.cfg.useApi = true;
const switchEdge = await invokePanel('edge-voice', 'save', [{ useEdge: true }]);
ok('在 Edge 页打开始用开关 → 引擎切过去并关掉 API', apiWorld.cfg.engine === 'edge'
  && apiWorld.cfg.useEdge === true && apiWorld.cfg.useApi === false,
  `engine=${String(apiWorld.cfg.engine)} useEdge=${String(apiWorld.cfg.useEdge)} useApi=${String(apiWorld.cfg.useApi)}`);
ok('回执说清了引擎切换', String(switchEdge.text).includes('Edge'), String(switchEdge.text).slice(0, 80));
const offEdge = await invokePanel('edge-voice', 'save', [{ useEdge: false }]);
ok('不能把唯一启用的引擎关掉', offEdge.ok === false && apiWorld.cfg.engine === 'edge', String(offEdge.error));
const switchApi = await invokePanel('api-voice', 'save', [{ useApi: true }]);
ok('在 API 页打开始用开关 → 引擎切到 api', apiWorld.cfg.engine === 'api' && apiWorld.cfg.useApi === true,
  `engine=${String(apiWorld.cfg.engine)}`);
ok('回执说清了引擎切换（API）', String(switchApi.text).includes('API'), String(switchApi.text).slice(0, 80));

console.log('启用开关联动');
apiWorld.cfg.engine = 'api';
apiWorld.cfg.useEdge = true;
apiWorld.cfg.useApi = false;
apiWorld.world.webUi('zh');
ok('打开 Edge 开关就切到 edge', apiWorld.cfg.engine === 'edge', String(apiWorld.cfg.engine));
ok('并关掉 API 开关', apiWorld.cfg.useApi === false && apiWorld.cfg.useEdge === true,
  `useEdge=${apiWorld.cfg.useEdge} useApi=${apiWorld.cfg.useApi}`);
apiWorld.cfg.useEdge = true;
apiWorld.cfg.useApi = true;
apiWorld.world.webUi('zh');
ok('两个都开着时切到另一边', apiWorld.cfg.engine === 'api', String(apiWorld.cfg.engine));
ok('切换后只剩一个开关', apiWorld.cfg.useEdge === false && apiWorld.cfg.useApi === true);

const apiStatus = await tool(apiWorld.world, STATUS_TOOL)!.handler({}, {} as never);
ok('status 报 API 服务与地址', String(apiStatus).includes('API 服务') && String(apiStatus).includes('127.0.0.1:8091'), String(apiStatus).slice(0, 120));
ok('status 报后端音色', String(apiStatus).includes(String(apiWorld.cfg.apiVoice)), String(apiStatus).slice(0, 160));
ok('API 引擎下 state 的 engine 是 api', apiWorld.world.state().engine === 'api');

const apiVars = apiWorld.world.envPromptVars();
ok('提示词引擎变量带地址', String(apiVars['streamvoice.engine']).includes('8091'), String(apiVars['streamvoice.engine']));
ok('提示词不再点名具体厂商的音色', !String(apiVars['streamvoice.voices']).includes('vivian'), String(apiVars['streamvoice.voices']).slice(0, 60));
ok('提示词里的语速是倍率', String(apiVars['streamvoice.state']).includes('1.35×'), String(apiVars['streamvoice.state']).slice(0, 60));

console.log('非法 API 参数');
const badUrl = await tool(apiWorld.world, TUNE_TOOL)!.handler({ apiBase: 'http://' }, {} as never);
ok('认不出的地址被拒', typeof badUrl === 'object' && badUrl.failed === true);
ok('拒绝后地址不变', apiWorld.cfg.apiBase === 'http://127.0.0.1:8091/v1', String(apiWorld.cfg.apiBase));
const bareHost = await tool(apiWorld.world, TUNE_TOOL)!.handler({ apiBase: '192.168.1.9:8091' }, {} as never);
ok('只写主机名也能收，自动补 /v1', apiWorld.cfg.apiBase === 'http://192.168.1.9:8091/v1', `${String(apiWorld.cfg.apiBase)} / ${String(bareHost).slice(0, 60)}`);
await tool(apiWorld.world, TUNE_TOOL)!.handler({ apiBase: 'http://127.0.0.1:8091/v1' }, {} as never);
const badFormat = await tool(apiWorld.world, TUNE_TOOL)!.handler({ apiFormat: 'ogg' }, {} as never);
ok('不支持的格式被拒', typeof badFormat === 'object' && badFormat.failed === true);
ok('拒绝时列出可选格式', String((badFormat as { text: string }).text).includes('mp3'));
const badEngine = await tool(apiWorld.world, TUNE_TOOL)!.handler({ engine: 'azure' }, {} as never);
ok('不认识的引擎被拒', typeof badEngine === 'object' && badEngine.failed === true);

console.log('切回 Edge');
const backEdge = await tool(apiWorld.world, TUNE_TOOL)!.handler({ engine: 'edge' }, {} as never);
ok('engine 回到 edge', apiWorld.cfg.engine === 'edge', String(apiWorld.cfg.engine));
ok('切回后嗓音还是原来那个 Edge 音色', String(apiWorld.world.state().voice).startsWith('zh-CN-'), String(apiWorld.world.state().voice));
ok('回执说明回到 Edge', String(backEdge).includes('Edge 朗读'), String(backEdge).slice(0, 120));

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
