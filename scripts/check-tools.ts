/**
 * 工具层自测：不出声、不连网，纯粹验参数翻译。
 *
 *   node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs scripts/check-tools.ts
 *
 * 验的是模型最容易给出错值的那一段：口语名 → ShortName、37 → +35%、关掉开关后
 * speech_tune 是否真的从工具表里消失。
 */
import {
  PROSODY_STEP,
  SPEECH_TOOL_DECLS,
  SILENCE_TOOL,
  STATUS_TOOL,
  TUNE_TOOL,
  prosodyValue,
  readPatch,
  resolveVoice,
  speechToolDefs,
} from '../src/tools.ts';

let failed = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('声明');
const names = SPEECH_TOOL_DECLS.map((d) => d.name);
ok('三个工具都在', [STATUS_TOOL, TUNE_TOOL, SILENCE_TOOL].every((n) => names.includes(n)), names.join(','));
ok('名字不重复', new Set(names).size === names.length);
ok('每个都有 description 和 parameters', SPEECH_TOOL_DECLS.every((d) => !!d.description && typeof d.parameters === 'object'));
ok('每个都有 tags', SPEECH_TOOL_DECLS.every((d) => d.tags.length > 0));

// 「允许模型自己调的东西，要能覆盖这个扩展的全部功能」——这里就是那句话的守卫
const tuneProps = Object.keys(
  (SPEECH_TOOL_DECLS.find((d) => d.name === TUNE_TOOL)!.parameters as { properties: Record<string, unknown> }).properties,
);
const ALL_SETTINGS = [
  'voice', 'rate', 'pitch', 'volume',
  'readSay', 'readAsk', 'readOptions',
  'chunkMinChars', 'chunkMaxChars', 'gapMs',
  'prewarm', 'verbose', 'enabled',
];
const missing = ALL_SETTINGS.filter((k) => !tuneProps.includes(k));
ok('speech_tune 覆盖全部配置项', missing.length === 0, `缺少 ${missing.join(',')}`);
ok('没有多出来的野字段', tuneProps.every((k) => ALL_SETTINGS.includes(k)), tuneProps.filter((k) => !ALL_SETTINGS.includes(k)).join(','));

console.log('音色翻译');
ok('中文名 → ShortName', resolveVoice('晓晓')?.id === 'zh-CN-XiaoxiaoNeural');
ok('另一个中文名', resolveVoice('云希')?.id === 'zh-CN-YunxiNeural');
ok('ShortName 原样认', resolveVoice('zh-CN-YunxiNeural')?.id === 'zh-CN-YunxiNeural');
ok('大小写不敏感', resolveVoice('ZH-CN-YUNXINEURAL')?.id === 'zh-CN-YunxiNeural');
ok('整段标签也能认', resolveVoice('晓晓 · 女 · 温暖')?.id === 'zh-CN-XiaoxiaoNeural');
ok('粤语音色', resolveVoice('曉佳')?.id === 'zh-HK-HiuGaaiNeural');
ok('不存在的音色返回 null', resolveVoice('林黛玉') === null);
ok('空串返回 null', resolveVoice('   ') === null);

console.log('档位对齐');
ok('37 → +35%', prosodyValue('percent', 37) === '+35%', prosodyValue('percent', 37));
ok('-37 → -35%', prosodyValue('percent', -37) === '-35%', prosodyValue('percent', -37));
ok('0 → +0%', prosodyValue('percent', 0) === '+0%', prosodyValue('percent', 0));
ok('超出上限夹住', prosodyValue('percent', 999) === '+50%', prosodyValue('percent', 999));
ok('超出下限夹住', prosodyValue('hz', -999) === '-50Hz', prosodyValue('hz', -999));
ok('12Hz → +10Hz', prosodyValue('hz', 12) === '+10Hz', prosodyValue('hz', 12));
ok('档位是 5', PROSODY_STEP === 5);

console.log('参数提取');
const patch = readPatch({ voice: ' 晓晓 ', rate: '20', pitch: 7, volume: 'abc' });
ok('字符串数字被认出来', patch.rate === 20);
ok('voice 去空格', patch.voice === '晓晓');
ok('非数字被丢掉', patch.volume === undefined);
ok('空参数给空补丁', Object.keys(readPatch({})).length === 0);

const flags = readPatch({ readSay: false, readAsk: 'false', readOptions: 'true', verbose: true, enabled: 'nope' });
ok('布尔原样认', flags.readSay === false && flags.verbose === true);
ok('字符串布尔也认', flags.readAsk === false && flags.readOptions === true);
ok('认不出的布尔丢掉', flags.enabled === undefined);

const numbers = readPatch({ chunkMinChars: '3', chunkMaxChars: 80, gapMs: '120' });
ok('切块与停顿的数字也认', numbers.chunkMinChars === 3 && numbers.chunkMaxChars === 80 && numbers.gapMs === 120);

console.log('工具表开关');
const opened = speechToolDefs({
  status: () => 's', tune: () => 't', silence: () => 'q', allowTuning: () => true,
});
const closed = speechToolDefs({
  status: () => 's', tune: () => 't', silence: () => 'q', allowTuning: () => false,
});
ok('允许调时 3 个工具', opened.length === 3, opened.map((t) => t.name).join(','));
ok('关掉后 speech_tune 消失', !closed.some((t) => t.name === TUNE_TOOL), closed.map((t) => t.name).join(','));
ok('关掉后仍能查状态与停止', closed.some((t) => t.name === STATUS_TOOL) && closed.some((t) => t.name === SILENCE_TOOL));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
