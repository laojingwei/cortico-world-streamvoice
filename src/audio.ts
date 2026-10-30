/**
 * 把合成出来的音频在交给播放器之前，按「音量增益」和「语速」重新算一遍。
 *
 * 为什么要有这一道：
 * - 播放器（Windows MCI / macOS afplay）的音量刻度封顶在 100%，没法把声音放大；
 *   Edge 的 SSML <prosody volume> 也撑死 +50%。要「比原声更响」，只能在播放前自己改 PCM 采样点。
 * - 语速也一样：后端（Edge 的 SSML rate / OpenAI 的 speed）调语速往往连带音调发飘，
 *   而且各后端支持程度不一。统一放到本地用 WSOLA 变速（保音调），两套引擎行为就一致了。
 *
 * 于是无论哪套引擎合成出来的是什么容器，都先解码成 16-bit 浮点 PCM，再：
 *   1) 需要变速就做 WSOLA 时间伸缩（时长变、音调不变）；
 *   2) 需要增益就把每个采样乘上倍率并夹回 [-1, 1]；
 *   3) 编回 16-bit PCM 的 WAV 交给播放器。
 *
 * 解码只覆盖两套引擎实际会产出的容器：
 *   - WAV（API 引擎默认 wav）：自己解析 RIFF 头，零依赖；
 *   - MP3（Edge 引擎）：用 mpg123 的 WASM 解码（`mpg123-decoder`，纯 WASM、无原生二进制）。
 * 其它容器（flac/opus/pcm 等）或解码失败一律原样放过，按原音量原速播放，绝不拖垮整片。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { MPEGDecoder } from 'mpg123-decoder';

/** 解码后的一小段 PCM：每条通道一份 Float32 采样（范围 -1…1），采样率统一。 */
export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

export interface ProcessOptions {
  /** 音量倍率：1 = 原声，2 = 两倍响，0.5 = 一半。 */
  gain?: number;
  /** 语速倍率：1 = 原速，2 = 两倍快（时长减半），0.5 = 一半慢。 */
  rate?: number;
}

/** 增益离 1 多近算「没调」，直接跳过。 */
const GAIN_EPS = 0.02;
/** 语速离 1 多近算「没调」。 */
const RATE_EPS = 0.01;

/**
 * 统一入口：解码 → 变速 → 增益 → 重新编码成 WAV。
 *
 * @param input 合成出来的音频文件（.wav 或 .mp3）
 * @param dir   输出目录（和输入同一片临时目录，随整片一起清理）
 * @param opts  `gain` / `rate`，都为 1（或省略）时原样返回输入，不做任何多余工作
 * @returns 处理完的文件路径；无需处理、容器不支持或任何一步失败时，回退为原文件
 */
export async function processAudio(input: string, dir: string, opts: ProcessOptions = {}): Promise<string> {
  const gain = Number.isFinite(opts.gain) ? (opts.gain as number) : 1;
  const rate = Number.isFinite(opts.rate) ? (opts.rate as number) : 1;
  const needGain = Math.abs(gain - 1) >= GAIN_EPS;
  const needRate = Math.abs(rate - 1) >= RATE_EPS;
  if (!needGain && !needRate) return input;

  let decoded: DecodedAudio | null;
  try {
    const buf = await readFile(input);
    decoded = await decodeAudio(buf);
  } catch {
    return input;
  }
  if (!decoded || !decoded.channels.length || !decoded.channels[0]?.length) return input;

  try {
    let channels = decoded.channels;
    const sampleRate = decoded.sampleRate;
    if (needRate) channels = timeStretch(channels, sampleRate, rate);
    if (needGain) applyGain(channels, gain);
    const wav = encodeWav(channels, sampleRate);
    const path = `${dir.replace(/[/\\]$/, '')}/proc-${process.pid}-${Date.now().toString(36)}.wav`;
    await writeFile(path, wav);
    return path;
  } catch {
    return input;
  }
}

/**
 * 解码一段音频到 PCM。认 WAV（RIFF）与 MP3；其它一律返回 null。
 * 失败不抛，返回 null 交给上层按原文件播放。
 */
async function decodeAudio(buf: Buffer): Promise<DecodedAudio | null> {
  if (isWav(buf)) return decodeWav(buf);
  if (looksLikeMp3(buf)) return decodeMp3(buf);
  // 不认识的容器：不猜，原样放过
  return null;
}

function isWav(buf: Buffer): boolean {
  return buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WAVE';
}

/** MP3 同步字（0xFFEx/0xFFFx）或 ID3 标签开头；没有就大概率不是 MP3。 */
function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.toString('ascii', 0, 3) === 'ID3') return true;
  // 跳过可能存在的 ID3v2 头后看同步字
  return (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
}

/**
 * 解析 16-bit PCM 的 WAV：RIFF/fmt 头读位深与通道数，data 区读采样。
 * 只处理 16-bit、整数 PCM（format=1）；别的一律返回 null。
 */
function decodeWav(buf: Buffer): DecodedAudio | null {
  if (!isWav(buf) || buf.length < 44) return null;

  let p = 12;
  let bitsPerSample = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataLen = 0;

  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && size >= 16) {
      audioFormat = buf.readUInt16LE(p + 8);
      numChannels = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
      bitsPerSample = buf.readUInt16LE(p + 22);
    } else if (id === 'data') {
      dataOffset = p + 8;
      dataLen = Math.min(size, buf.length - dataOffset);
      break;
    }
    // chunk 之间按偶数对齐
    p += 8 + size + (size & 1);
  }

  if (dataOffset < 0 || numChannels <= 0 || sampleRate <= 0) return null;
  // 只处理整数 16-bit PCM；float/24-bit/其它直接放过
  if (audioFormat !== 1 || bitsPerSample !== 16) return null;

  const frameBytes = numChannels * 2;
  const frames = Math.floor(dataLen / frameBytes);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    const base = dataOffset + i * frameBytes;
    for (let c = 0; c < numChannels; c++) {
      // int16 → -1…1
      channels[c][i] = buf.readInt16LE(base + c * 2) / 32768;
    }
  }
  return { channels, sampleRate };
}

/**
 * 用 mpg123 的 WASM 解码 MP3。24kHz 的 Edge MP3 解出来就是 24kHz，和 API 的 WAV 同速率，不用重采样。
 */
async function decodeMp3(buf: Buffer): Promise<DecodedAudio | null> {
  const decoder = new MPEGDecoder();
  try {
    await decoder.ready;
    const result = decoder.decode(new Uint8Array(buf));
    const { channelData, samplesDecoded, sampleRate } = result;
    if (!channelData?.length || !samplesDecoded || !sampleRate) return null;
    // 拷贝出来再 free：channelData 可能是 WASM 堆上的视图，free 之后就不该再引用
    const channels = channelData.map((c) => {
      const n = Math.min(c.length, samplesDecoded);
      const copy = new Float32Array(n);
      copy.set(c.subarray(0, n));
      return copy;
    });
    return { channels, sampleRate };
  } catch {
    return null;
  } finally {
    try { decoder.free(); } catch { /* 已释放 */ }
  }
}

/** 每个采样乘上倍率；放大时夹回 [-1, 1]，避免整数转换处回绕成杂音。 */
function applyGain(channels: Float32Array[], gain: number): void {
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      let v = ch[i] * gain;
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      ch[i] = v;
    }
  }
}

/**
 * WSOLA（Waveform Similarity Overlap-Add）时间伸缩：改时长、不改音调。
 *
 * 做法：按固定的合成跳步把一帧帧 Hann 窗片段叠加到输出；每帧在输入里取的「分析位置」
 * 按 rate 倍速前进（rate>1 跳过更多 → 变快，rate<1 前进更少 → 变慢）。取帧前在 ±tol
 * 的小窗里搜一个使「新帧左半段」与「上一帧右半段」最相关的偏移，保证叠加处波形连贯，
 * 这样变速后不发抖、不劈音。最后按窗叠加和归一，恢复原幅度。
 */
function timeStretch(channels: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  const inputLen = channels[0]?.length ?? 0;
  // 太短的不值得变速（也不稳），原样返回
  if (inputLen < 1024 || !Number.isFinite(rate) || rate <= 0) return channels;

  // 约 40ms 一帧；50% 合成重叠（周期 Hann 窗在 50% 重叠时叠加和恒为 1）
  let frameSize = Math.round(sampleRate * 0.04);
  frameSize = Math.max(256, frameSize - (frameSize % 2));
  const half = frameSize >> 1;
  const synthHop = half;
  const analysisHop = Math.max(1, Math.round(synthHop * rate));
  const tol = Math.max(1, Math.round(frameSize / 4));

  const window = hann(frameSize);
  const iters = Math.ceil(inputLen / analysisHop) + 2;
  const outAlloc = iters * synthHop + frameSize * 2;

  const accum = channels.map(() => new Float32Array(outAlloc));
  const norm = new Float32Array(outAlloc);
  const base = channels[0];
  let filled = 0;

  let analysisCenter = half; // 分析帧中心（输入坐标）
  let synthCenter = half; // 合成帧中心（输出坐标）
  let prev: Float32Array | null = null; // 上一帧（通道 0），用来做相似度对齐

  while (analysisCenter - half < inputLen) {
    // 在 ±tol 内挑一个让「候选帧左半段」最接得上「上一帧右半段」的位置
    let bestCenter = analysisCenter;
    if (prev) {
      let bestScore = -Infinity;
      for (let c = analysisCenter - tol; c <= analysisCenter + tol; c++) {
        let score = 0;
        for (let k = 0; k < half; k += 2) {
          const si = c - half + k;
          if (si >= 0 && si < inputLen) score += prev[half + k] * base[si];
        }
        if (score > bestScore) {
          bestScore = score;
          bestCenter = c;
        }
      }
    }
    // 这一帧已经整段落在输入之外：没有真实采样可取了，收尾
    if (bestCenter - half >= inputLen) break;

    // 各通道按同一位置叠加
    for (let ci = 0; ci < channels.length; ci++) {
      const src = channels[ci];
      const dst = accum[ci];
      const startIn = bestCenter - half;
      const startOut = synthCenter - half;
      for (let i = 0; i < frameSize; i++) {
        const si = startIn + i;
        const v = si >= 0 && si < inputLen ? src[si] : 0;
        dst[startOut + i] += v * window[i];
      }
    }
    for (let i = 0; i < frameSize; i++) norm[synthCenter - half + i] += window[i];
    if (synthCenter + half > filled) filled = synthCenter + half;

    if (!prev) prev = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      const si = bestCenter - half + i;
      prev[i] = si >= 0 && si < inputLen ? base[si] : 0;
    }

    synthCenter += synthHop;
    analysisCenter += analysisHop;
    if (synthCenter > outAlloc - frameSize) break; // 安全护栏
  }

  if (filled <= 0) return channels;

  // 理论输出时长 = 输入时长 / rate。裁掉末尾多叠出来的半帧，否则实际速度会偏慢几个百分点。
  const target = Math.max(1, Math.round(inputLen / rate));
  const outLen = Math.min(filled, target);

  const out: Float32Array[] = [];
  for (const acc of accum) {
    const ch = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const n = norm[i];
      // 归一化恢复幅度；窗叠加和近 0 的极边缘点直接置 0，避免 0/0 放大噪声
      ch[i] = n > 1e-6 ? acc[i] / n : 0;
    }
    // 首尾各做一个几毫秒的淡入淡出，去掉硬切产生的「咔哒」声
    const fade = Math.min(64, outLen >> 1);
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      ch[i] *= g;
      ch[outLen - 1 - i] *= g;
    }
    out.push(ch);
  }
  return out;
}

/** 周期 Hann 窗；在 50% 重叠时叠加和恒为 1。 */
function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/**
 * 把 Float32 通道编码成 16-bit PCM 的 WAV（单声道/多声道都行）。
 * 采样按帧交错存放；越界值夹回 [-1, 1]。
 */
function encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const numCh = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(numCh, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c]?.[i] ?? 0;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      // ×32767 而不是 32768：正向最大值刚好落在 int16 上限
      buf.writeInt16LE(Math.round(s * 32767), off);
      off += 2;
    }
  }
  return buf;
}
