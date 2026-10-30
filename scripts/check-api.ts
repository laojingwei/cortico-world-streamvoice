/**
 * API 引擎自测：真的打一次本机语音服务，把「一块字 → 一个音频文件」这条路走通。
 *
 *   node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs scripts/check-api.ts
 *
 * 默认打 `STREAMVOICE_DEFAULTS.apiBase`，也就是本机 8091 上那套服务。
 * 服务没起就整体跳过、不算失败——这是给自己调试后端用的脚本，不进 CI。
 * 只合成与落盘，不播放，跑起来不吵。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_FORMATS,
  DEFAULT_API_BASE,
  SPEED_DEFAULT,
  clampSpeed,
  isApiFormat,
  modelsUrl,
  normalizeBase,
  probeApi,
  speechUrl,
  speechToFile,
  voicesUrl,
} from '../src/api-tts.ts';
import { STREAMVOICE_DEFAULTS, apiOf, engineOf, styleOf } from '../src/config.ts';

let failed = 0;
function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('默认值与换算');
const base = apiOf(STREAMVOICE_DEFAULTS);
ok('默认引擎是 edge', engineOf(STREAMVOICE_DEFAULTS) === 'edge', String(engineOf(STREAMVOICE_DEFAULTS)));
ok('默认地址是本机 8091 的根地址', base.base === DEFAULT_API_BASE, base.base);
ok('默认音色 vivian', base.voice === 'vivian', base.voice);
ok('默认格式 wav', base.format === 'wav', base.format);
ok('默认超时 30s', base.timeoutMs === 30_000, String(base.timeoutMs));
ok('默认语速倍率 1', base.speed === SPEED_DEFAULT, String(base.speed));
ok('语速倍率夹进 0.1–5', clampSpeed(9) === 5 && clampSpeed(0.01) === 0.1 && clampSpeed(1.5) === 1.5,
  `${clampSpeed(9)}/${clampSpeed(0.01)}/${clampSpeed(1.5)}`);
ok('格式白名单', isApiFormat('wav') && !isApiFormat('ogg') && API_FORMATS.length === 5);
const styleApi = styleOf({ ...STREAMVOICE_DEFAULTS, engine: 'api', apiVoice: 'serena' });
ok('API 引擎下 style.voice 是后端音色', styleApi.engine === 'api' && styleApi.voice === 'serena', styleApi.voice);

console.log('地址规范化');
const normalizeCases: Array<[string, string]> = [
  ['http://127.0.0.1:8091/v1', 'http://127.0.0.1:8091/v1'],
  ['http://127.0.0.1:8091/v1/audio/speech', 'http://127.0.0.1:8091/v1'],
  ['http://127.0.0.1:8091/v1/audio', 'http://127.0.0.1:8091/v1'],
  ['127.0.0.1:8091', 'http://127.0.0.1:8091/v1'],
  ['https://api.openai.com', 'https://api.openai.com/v1'],
  ['https://api.openai.com/v1/audio/speech/', 'https://api.openai.com/v1'],
  [' http://h:1/v1/ ', 'http://h:1/v1'],
  ['ftp://h/v1', ''],
  ['http://', ''],
  ['http://a b', ''],
];
for (const [input, want] of normalizeCases) {
  const got = normalizeBase(input);
  ok(`「${input}」→「${want || '（拒绝）'}」`, got === want, got);
}
ok('路径按规范拼', speechUrl('http://h/v1') === 'http://h/v1/audio/speech'
  && modelsUrl('http://h/v1') === 'http://h/v1/models'
  && voicesUrl('http://h/v1') === 'http://h/v1/audio/voices');

console.log('服务可达性');
const probe = await probeApi(base.base, base.key, 3_000).catch((err) => ({ ok: false, error: String(err) }));
if (!probe.ok) {
  console.log(`\n  ! ${base.base} 上没有服务，跳过联调（这不是失败）：${probe.error ?? ''}`);
  console.log(failed ? `\n${failed} 项失败` : '\n静态检查全部通过');
  process.exit(failed ? 1 : 0);
}
console.log(`  服务在线：${probe.base}（探测 ${probe.ms}ms）`);

const dir = await mkdtemp(join(tmpdir(), 'streamvoice-api-'));
try {
  console.log('连接测试拿到清单');
  ok('探测可用', probe.ok);
  ok('列到音色', probe.voices.length > 0, probe.voices.join(','));
  ok('列到模型', probe.models.length > 0, probe.models.join(','));

  console.log('合成 mp3');
  const mp3 = await speechToFile('你好，这是 API 引擎的测试。', { ...base, format: 'mp3' }, dir);
  const mp3Head = (await readFile(mp3.file)).subarray(0, 3);
  ok('出文件且有内容', mp3.bytes > 1_000, `${mp3.bytes}B / ${mp3.ms}ms`);
  ok('文件头像 mp3', (mp3Head[0] === 0x49 && mp3Head[1] === 0x44 && mp3Head[2] === 0x33) || mp3Head[0] === 0xff, mp3Head.toString('hex'));
  ok('文件名按格式取扩展名', mp3.file.endsWith('speech.mp3'), mp3.file);
  ok('content-type 是音频', mp3.contentType.startsWith('audio/'), mp3.contentType);

  console.log('合成 wav');
  const wav = await speechToFile('第二段，换成 wav。', { ...base, format: 'wav' }, dir);
  const wavHead = (await readFile(wav.file)).subarray(0, 4).toString('latin1');
  ok('wav 文件头是 RIFF', wavHead === 'RIFF', wavHead);
  ok('wav 文件名', wav.file.endsWith('speech.wav'), wav.file);

  console.log('原速合成');
  // 语速/音量已改为前端处理（audio.ts，见 check-audio），不再发给后端，所以这里不比较时长。
  const steady = await speechToFile('这句话用来比较语速。', { ...base, format: 'wav', speed: 1 }, dir);
  ok('原速也能正常出声', steady.bytes > 1_000, `${steady.bytes}B`);

  console.log('错误路径');
  try {
    await speechToFile('测试', { ...base, voice: 'nope' }, dir);
    ok('不存在的音色应当抛错', false);
  } catch (err) {
    const msg = (err as Error).message;
    ok('错误带 HTTP 状态', /HTTP 400/.test(msg), msg);
    ok('错误带后端原因', /Invalid voice/i.test(msg), msg);
  }

  try {
    // 端口 1 在 fetch 的禁用端口名单里，会报 bad port；换一个没人监听的普通端口才走得到 ECONNREFUSED
    await speechToFile('测试', { ...base, base: 'http://127.0.0.1:59321/v1', timeoutMs: 2_000 }, dir);
    ok('连不上应当抛错', false);
  } catch (err) {
    ok('连不上翻成人话', /连不上/.test((err as Error).message), (err as Error).message);
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
