import { statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from '../src/edge-tts/index.ts';
import { VOICE_OPTIONS } from '../src/voices.ts';

const sample = (id: string): string => {
  if (id.startsWith('en-')) return 'Hello, this is a quick voice test.';
  if (id.startsWith('ja-')) return 'こんにちは、声のテストです。';
  if (id.startsWith('ko-')) return '안녕하세요, 목소리 테스트입니다.';
  return '你好，试一下音色。';
};

const bad: string[] = [];
for (const v of VOICE_OPTIONS) {
  const tts = new MsEdgeTTS({ enableLogger: false });
  const dir = await mkdtemp(join(tmpdir(), 'voicetest-'));
  try {
    await tts.setMetadata(v.id, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(dir, sample(v.id), { rate: '+15%', volume: '+20%', pitch: '+10Hz' });
    console.log(v.id.padEnd(34), 'ok', statSync(audioFilePath).size);
  } catch (e) {
    bad.push(v.id);
    console.log(v.id.padEnd(34), 'FAIL', (e as Error).message);
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}
console.log('可用', VOICE_OPTIONS.length - bad.length, '/', VOICE_OPTIONS.length, bad.length ? `失败：${bad.join(', ')}` : '全部可用');
