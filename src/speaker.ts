/**
 * 一块字变成一段声音，并且按顺序连起来说。
 *
 * 队列只有一条：谁先进来谁先说。合成与播放是两条流水线——每个块一进来就立刻开始合成，
 * 播放器只在上一块说完之后把下一块交过去。所以第 1 块在说的时候，第 2 块已经在合成了，
 * 两块之间的空隙只剩交接时间。
 *
 * `hush()` 把代次（epoch）加一：还在排队的块直接丢掉，正在合成的结果回来了也丢掉，
 * 正在放的那一片杀掉播放器。这是「新回复开始」和「用户停止」唯一的清空方式。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from './edge-tts/index.ts';
import { createPlayer, type Player } from './player.ts';

const MP3 = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

export interface SpeechStyle {
  voice: string;
  rate: string;
  /** 音调，如 `+10Hz`。 */
  pitch: string;
  volume: string;
}

/** 可以随时改的开关；世界每次开口前现写一遍，改配置不用重启。 */
export interface SpeakerOptions {
  /** 一块说完之后额外停这么久再放下块（0 = 紧接着说）。 */
  gapMs?: number;
  /** 模型开始写时先空打一发合成，把链路焐热；不想要这点请求就关掉。 */
  prewarm?: boolean;
  /** 逐块打详细日志。 */
  verbose?: boolean;
}

/** 试听的结果：能不能合成、用了多久、不能的话为什么。 */
export interface AuditionResult {
  ok: boolean;
  /** 从开始到放完的毫秒数。 */
  ms: number;
  /** 合成那一趟的毫秒数。 */
  synthMs?: number;
  error?: string;
}

/** 合成失败后这段时间内不再试，免得限流或断线时刷屏。 */
const COOLDOWN_MS = 10_000;
/** 刚合成过就不用再预热（连接还热）；空这么久没动，对端多半已经把它收了。 */
const PRIME_TTL_MS = 8_000;

interface Job {
  seq: number;
  text: string;
  epoch: number;
  style: SpeechStyle;
  queuedAt: number;
  startedAt: number;
  synthAt: number;
  ready: Promise<void>;
  dir: string | null;
  clip: string | null;
  dead: boolean;
  spokenAt: number;
}

export interface SpeakerStats {
  chunks: number;
  spoken: number;
  failed: number;
  /** 最近一次：第一块从排到队到出声的毫秒数。 */
  firstAudioMs: number | null;
  /** 最近一次：第一块的字数。 */
  firstChunkChars: number | null;
  /** 最近一次：最后一块说完的总耗时。 */
  totalMs: number | null;
}

export class Speaker {
  private tts: MsEdgeTTS | null = null;
  private metadataKey = '';
  private stage: string | null = null;
  private jobs: Job[] = [];
  private current: Job | null = null;
  private epoch = 0;
  private seq = 0;
  private busy = false;
  private synthChain: Promise<void> = Promise.resolve();
  private failedAt = 0;
  private primedAt = 0;
  private priming = false;
  private speakingNow = false;
  private warnedPlatform = false;
  private stats: SpeakerStats = { chunks: 0, spoken: 0, failed: 0, firstAudioMs: null, firstChunkChars: null, totalMs: null };
  private runStart = 0;
  private gapMs = 0;
  private prewarm = true;
  private verbose = false;
  private auditionBusy: Promise<void> | null = null;

  private readonly player: Player = createPlayer((line) => this.log(line));

  constructor(private readonly log: (line: string) => void) {}

  /** 每次开口前把当前配置的开关写进来；代价只是几次赋值。 */
  setOptions(opts: SpeakerOptions): void {
    if (typeof opts.gapMs === 'number' && opts.gapMs >= 0) this.gapMs = Math.min(5_000, Math.round(opts.gapMs));
    if (typeof opts.prewarm === 'boolean') this.prewarm = opts.prewarm;
    if (typeof opts.verbose === 'boolean') this.verbose = opts.verbose;
  }

  /** 预热点：把暂存目录、播放器和一个 Edge TTS 连接先备好，第一块能少等几百毫秒。 */
  async warm(style: SpeechStyle): Promise<void> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    try {
      this.stage ??= await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-'));
      await mkdir(this.stage, { recursive: true });
      await this.player.warm(this.stage);
    } catch (err) {
      this.log(`预热点失败（不影响朗读）：${(err as Error).message}`);
    }
    this.prime(style);
  }

  /**
   * 空转一次合成，把链路焐热。
   *
   * Edge TTS 一条连接上的第一趟要好几秒（本机实测 2–3.5 秒，对端空闲一会儿就收连接），
   * 热了以后一块只要几百毫秒。所以趁模型还在憋第一句的时候先空打一发：结果丢掉，只为了
   * 让第一块真正要念的字赶上一条热链路。
   *
   * 它排在合成流水线的队首，不会与真正的请求抢同一条连接；代价是一次短请求。
   */
  prime(style: SpeechStyle): void {
    if (!this.prewarm) return;
    if (this.priming || this.speakingNow || this.jobs.length) return;
    if (Date.now() - this.primedAt < PRIME_TTL_MS) return;
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    this.priming = true;
    this.synthChain = this.synthChain.then(async () => {
      try {
        await this.prepareTts(style);
        const stage = this.stage ?? (this.stage = await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-')));
        const dir = await mkdtemp(join(stage, 'prime-'));
        try {
          await this.tts!.toFile(dir, '嗯', { rate: style.rate, pitch: style.pitch, volume: style.volume });
          this.primedAt = Date.now();
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // 预热失败就当没做，真正合成时还会重试
      } finally {
        this.priming = false;
      }
    });
  }

  get speaking(): boolean {
    return this.speakingNow;
  }

  /** 还排着几块（不含正在放的）。 */
  get queued(): number {
    return this.jobs.length;
  }

  snapshot(): SpeakerStats & { queued: number; speaking: boolean } {
    return { ...this.stats, queued: this.jobs.length, speaking: this.speakingNow };
  }

  /** 把一块排进队列；返回即走，说的时候在后台。 */
  say(text: string, style: SpeechStyle): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      if (!this.warnedPlatform) {
        this.warnedPlatform = true;
        this.log(`朗读要 Windows 或 macOS；${process.platform} 上跳过`);
      }
      return;
    }
    if (!this.jobs.length && !this.current) {
      this.runStart = Date.now();
      this.stats.firstAudioMs = null;
      this.stats.firstChunkChars = null;
      // 一段话的块号从 1 数起，日志里好认
      this.seq = 0;
    }
    this.stats.chunks++;
    const job: Job = {
      seq: ++this.seq,
      text: trimmed,
      epoch: this.epoch,
      style,
      queuedAt: Date.now(),
      startedAt: 0,
      synthAt: 0,
      ready: Promise.resolve(),
      dir: null,
      clip: null,
      dead: false,
      spokenAt: 0,
    };
    this.jobs.push(job);
    // 合成立刻开始，不等播放轮到它
    job.ready = this.synthChain = this.synthChain
      .then(() => this.synthesise(job))
      .catch((err: unknown) => {
        job.dead = true;
        this.stats.failed++;
        this.log(`合成失败（这一块跳过）：${(err as Error).message}`);
      });
    this.kick();
  }

  /**
   * 试听：按给定嗓音念一句短的，并等它说完。
   *
   * 走的是和正常朗读同一条合成与播放链路（同样的音色 / 语速 / 音调 / 音量），所以它能回答
   * 「这个音色在这台机器上到底能不能出声」——合成失败会把原因原样带回去。
   * 试听优先：先清空队列再试，免得和正在说的那句抢播放器。
   */
  async audition(text: string, style: SpeechStyle): Promise<AuditionResult> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return { ok: false, ms: 0, error: `朗读要 Windows 或 macOS；${process.platform} 上没有播放器` };
    }
    let done: () => void = () => {};
    this.auditionBusy = new Promise<void>((resolve) => { done = resolve; });
    const started = Date.now();
    let dir: string | null = null;
    this.hush();
    try {
      const stage = this.stage ?? (this.stage = await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-')));
      await this.prepareTts(style);
      dir = await mkdtemp(join(stage, 'try-'));
      const { audioFilePath } = await this.tts!.toFile(dir, text, {
        rate: style.rate, pitch: style.pitch, volume: style.volume,
      });
      const synthMs = Date.now() - started;
      this.speakingNow = true;
      const result = await this.player.play(audioFilePath);
      this.speakingNow = false;
      // 播放器刚被 hush 过，重新点一个备用
      void this.player.warm(stage).catch(() => {});
      if (result === 'played') return { ok: true, ms: Date.now() - started, synthMs };
      return { ok: false, ms: Date.now() - started, synthMs, error: '合成出来了，但没能放出来（播放器没响应）' };
    } catch (err) {
      this.speakingNow = false;
      // 断了就重开一条，别把后面的朗读拖下水
      try { this.tts?.close(); } catch { /* 已经断了 */ }
      this.tts = null;
      this.metadataKey = '';
      return { ok: false, ms: Date.now() - started, error: (err as Error).message };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.auditionBusy = null;
      done();
    }
  }

  /** 停下正在说的，丢掉还在排队的。代次一变，早先的结果回来也不再生效。 */
  hush(): void {
    this.epoch++;
    this.jobs = [];
    this.current = null;
    this.speakingNow = false;
    this.player.hush();
    // 下一次开口别等播放器启动：先把新的一个点起来
    const stage = this.stage;
    if (stage) void this.player.warm(stage).catch(() => {});
  }

  async stop(): Promise<void> {
    this.hush();
    await this.player.stop().catch(() => {});
    try { this.tts?.close(); } catch { /* 已经断了 */ }
    this.tts = null;
    this.metadataKey = '';
    if (this.stage) {
      await rm(this.stage, { recursive: true, force: true }).catch(() => {});
      this.stage = null;
    }
  }

  private kick(): void {
    if (this.busy) return;
    this.busy = true;
    void this.run().finally(() => {
      this.busy = false;
      if (this.jobs.length) this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.jobs.length) {
      // 试听在用播放器，等它说完再接着念
      if (this.auditionBusy) await this.auditionBusy;
      const job = this.jobs[0];
      if (job.epoch !== this.epoch) {
        this.take(job);
        await this.discard(job);
        continue;
      }
      this.current = job;
      await job.ready;
      if (job.epoch !== this.epoch) {
        this.current = null;
        this.take(job);
        await this.discard(job);
        continue;
      }
      if (!job.clip || job.dead) {
        this.current = null;
        this.take(job);
        await this.discard(job);
        continue;
      }
      job.spokenAt = Date.now();
      this.speakingNow = true;
      const first = this.stats.firstAudioMs === null;
      if (first) {
        this.stats.firstAudioMs = job.spokenAt - job.queuedAt;
        this.stats.firstChunkChars = job.text.length;
      }
      if (first || this.verbose) {
        this.log(`第 ${job.seq} 块出声（${first ? `切出后 ${this.stats.firstAudioMs}ms，` : ''}合成 ${job.synthAt - job.startedAt}ms，等播放 ${job.spokenAt - job.synthAt}ms）`);
      }
      const result = await this.player.play(job.clip);
      this.speakingNow = false;
      this.current = null;
      this.take(job);
      await this.discard(job);
      if (job.epoch !== this.epoch) continue;
      if (result === 'played') {
        this.stats.spoken++;
      } else if (result === 'failed') {
        this.stats.failed++;
        this.log('这一块没能放出来');
      }
      this.stats.totalMs = Date.now() - this.runStart;
      if (this.gapMs > 0 && this.jobs.length) await sleep(this.gapMs);
      if (this.verbose) {
        this.log(`说完第 ${job.seq} 块（${job.text.length} 字，合成 ${job.synthAt - job.startedAt}ms，本轮共 ${this.stats.totalMs}ms）`);
      }
    }
  }

  /** 把 job 从队列头上拿掉；hush 之后队列可能已经不是原来那条了。 */
  private take(job: Job): void {
    const at = this.jobs.indexOf(job);
    if (at >= 0) this.jobs.splice(at, 1);
  }

  private async discard(job: Job): Promise<void> {
    if (!job.dir) return;
    const dir = job.dir;
    job.dir = null;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  private async prepareTts(style: SpeechStyle): Promise<void> {
    const key = [style.voice, style.rate, style.pitch, style.volume].join('|');
    this.tts ??= new MsEdgeTTS({ enableLogger: false });
    if (key === this.metadataKey) return;
    await this.tts.setMetadata(style.voice, MP3);
    this.metadataKey = key;
  }

  private async synthesise(job: Job): Promise<void> {
    if (job.epoch !== this.epoch) return;
    job.startedAt = Date.now();
    if (Date.now() - this.failedAt < COOLDOWN_MS) {
      job.dead = true;
      return;
    }
    const stage = this.stage ?? (this.stage = await mkdtemp(join(tmpdir(), 'coopanion-streamvoice-')));
    await this.prepareTts(job.style);
    const dir = await mkdtemp(join(stage, `c${job.seq}-`));
    job.dir = dir;
    try {
      const { audioFilePath } = await this.tts!.toFile(dir, job.text, {
        rate: job.style.rate, pitch: job.style.pitch, volume: job.style.volume,
      });
      job.clip = audioFilePath;
      job.synthAt = Date.now();
    } catch (err) {
      this.failedAt = Date.now();
      // 断了就重开一条，别把后面的块全拖下水
      try { this.tts?.close(); } catch { /* 已经断了 */ }
      this.tts = null;
      this.metadataKey = '';
      throw err;
    }
  }
}

/** 等一会儿；块与块之间的停顿用它。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
