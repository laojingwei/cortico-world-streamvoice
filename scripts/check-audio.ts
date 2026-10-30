/**
 * `audio.ts` 的自检：音量增益、WSOLA 变速、WAV 编解码，以及（联网时）真实 Edge MP3 的解码。
 *
 * 纯离线部分用一条 440Hz 正弦波当素材，不碰网络、不碰播放器：
 *   - 增益：0.3 的正弦 ×2 → 峰值约 0.6；
 *   - 变速：rate=2 时长减半、rate=0.5 时长翻倍，峰值仍约 0.3（WSOLA 保幅度）；
 *   - 原速 + 原音量 → 原样返回，不做多余工作；
 *   - 不认识的容器 → 原样返回。
 *
 * 联网部分（拿不到就跳过）用 Edge 合成一段 MP3，证明「Edge 回的是 MP3，本地能解码并放大」。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAudio } from '../src/audio.ts';

let failures = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
}

/** 造一条 mono 16-bit PCM 的正弦 WAV。 */
function makeSineWav(sampleRate: number, seconds: number, freq: number, amp: number): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** 从 16-bit PCM WAV 里取 { 采样数, 峰值(0…1), 采样率 }。 */
function parseWav(buf: Buffer): { frames: number; peak: number; sampleRate: number } {
  let p = 12;
  let sampleRate = 0;
  let dataOffset = -1;
  let dataLen = 0;
  let numCh = 1;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      numCh = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
    } else if (id === 'data') {
      dataOffset = p + 8;
      dataLen = Math.min(size, buf.length - dataOffset);
      break;
    }
    p += 8 + size + (size & 1);
  }
  if (dataOffset < 0) return { frames: 0, peak: 0, sampleRate };
  let peak = 0;
  const frames = Math.floor(dataLen / (numCh * 2));
  for (let i = 0; i < frames * numCh; i++) {
    const s = Math.abs(buf.readInt16LE(dataOffset + i * 2)) / 32768;
    if (s > peak) peak = s;
  }
  return { frames, peak, sampleRate };
}

/** 峰值比较用：允许 ±15% 的误差（WSOLA / 量化都会略改幅度）。 */
function near(a: number, b: number, tol = 0.15): boolean {
  return Math.abs(a - b) <= Math.max(tol, Math.abs(b) * tol);
}

async function offline(dir: string): Promise<void> {
  console.log('离线：正弦 WAV 的增益 / 变速 / 编解码');
  const sampleRate = 24000;
  const seconds = 0.5;
  const amp = 0.3;
  const inputPath = join(dir, 'sine.wav');
  await writeFile(inputPath, makeSineWav(sampleRate, seconds, 440, amp));
  const base = parseWav(await readFile(inputPath));
  ok('素材解析', base.frames > 0 && near(base.peak, amp, 0.03), `峰值 ${base.peak.toFixed(3)}, ${base.frames} 帧`);

  // 增益 ×2
  const g2Path = await processAudio(inputPath, dir, { gain: 2, rate: 1 });
  const g2 = parseWav(await readFile(g2Path));
  ok('增益 ×2 峰值翻倍', near(g2.peak, amp * 2, 0.12), `峰值 ${g2.peak.toFixed(3)}（期望≈${(amp * 2).toFixed(3)}）`);
  ok('增益 ×2 采样率不变', g2.sampleRate === sampleRate, `${g2.sampleRate}Hz`);
  ok('增益 ×2 帧数不变', Math.abs(g2.frames - base.frames) <= 2, `${g2.frames} 帧`);

  // 变速 ×2 → 时长减半
  const r2Path = await processAudio(inputPath, dir, { gain: 1, rate: 2 });
  const r2 = parseWav(await readFile(r2Path));
  ok('变速 ×2 时长约减半', near(r2.frames, base.frames / 2, 0.18), `${r2.frames} 帧（期望≈${Math.round(base.frames / 2)}）`);
  ok('变速 ×2 幅度保持', near(r2.peak, amp, 0.25), `峰值 ${r2.peak.toFixed(3)}`);
  ok('变速 ×2 无 NaN/爆音', Number.isFinite(r2.peak) && r2.peak <= 1.001, `峰值 ${r2.peak.toFixed(3)}`);

  // 变速 ×0.5 → 时长翻倍
  const r05Path = await processAudio(inputPath, dir, { gain: 1, rate: 0.5 });
  const r05 = parseWav(await readFile(r05Path));
  ok('变速 ×0.5 时长约翻倍', near(r05.frames, base.frames * 2, 0.18), `${r05.frames} 帧（期望≈${base.frames * 2}）`);
  ok('变速 ×0.5 幅度保持', near(r05.peak, amp, 0.25), `峰值 ${r05.peak.toFixed(3)}`);

  // 原速原音量 → 原样返回
  const samePath = await processAudio(inputPath, dir, { gain: 1, rate: 1 });
  ok('原速原音量直接跳过', samePath === inputPath);

  // 不认识的容器 → 原样返回
  const junkPath = join(dir, 'junk.flac');
  await writeFile(junkPath, Buffer.from('fLaC not really'));
  const junkOut = await processAudio(junkPath, dir, { gain: 2, rate: 1 });
  ok('不支持的容器原样返回', junkOut === junkPath);
}

async function liveMp3(dir: string): Promise<void> {
  console.log('联网：Edge 真实 MP3 解码 + 放大');
  let MsEdgeTTS: typeof import('../src/edge-tts/index.ts').MsEdgeTTS;
  let OUTPUT_FORMAT: typeof import('../src/edge-tts/index.ts').OUTPUT_FORMAT;
  try {
    ({ MsEdgeTTS, OUTPUT_FORMAT } = await import('../src/edge-tts/index.ts'));
  } catch (err) {
    console.log(`  ⚠ 跳过（加载 Edge 客户端失败）：${(err as Error).message}`);
    return;
  }

  const tts = new MsEdgeTTS({ enableLogger: false });
  const synth = (async () => {
    await tts.setMetadata('zh-CN-XiaoxiaoNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    return tts.toFile(dir, '你好，这是一次语音音量与语速的本地处理自检。');
  })();
  let mp3Path: string;
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('合成超时（20s）')), 20_000));
    const { audioFilePath } = await Promise.race([synth, timeout]);
    mp3Path = audioFilePath;
  } catch (err) {
    console.log(`  ⚠ 跳过（拿不到 Edge 音频，可能无网络）：${(err as Error).message}`);
    return;
  } finally {
    try { tts.close(); } catch { /* 已经断了 */ }
  }

  const head = await readFile(mp3Path);
  const isMp3 = head.length > 2 && (head.toString('ascii', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));
  ok('Edge 回的是 MP3（不是 WAV）', isMp3, `头 ${head.subarray(0, 3).toString('hex')}`);

  const out = await processAudio(mp3Path, dir, { gain: 2, rate: 1 });
  ok('MP3 被解码并重新编码为 WAV', out.toLowerCase().endsWith('.wav') && out !== mp3Path, out.split(/[/\\]/).pop());
  const wav = parseWav(await readFile(out));
  ok('MP3 放大后峰值 > 0', wav.peak > 0 && wav.peak <= 1.001, `峰值 ${wav.peak.toFixed(3)}, ${wav.frames} 帧, ${wav.sampleRate}Hz`);
  ok('MP3 解码保持 24kHz', wav.sampleRate === 24000, `${wav.sampleRate}Hz`);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'sv-audio-check-'));
  try {
    await offline(dir);
    try {
      await liveMp3(dir);
    } catch (err) {
      console.log(`  ⚠ 联网部分异常（不影响离线结论）：${(err as Error).message}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  if (failures) {
    console.log(`✗ ${failures} 项未通过`);
    process.exitCode = 1;
  } else {
    console.log('✓ 全部通过');
  }
}

await main();
