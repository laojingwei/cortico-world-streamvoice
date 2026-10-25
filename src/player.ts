/**
 * 出声的那一头：一片 mp3 交给播放器，等它说完。
 *
 * Windows 上常驻一个 PowerShell，用 winmm 的 MCI 一片一片地 `play … wait`。常驻是为了
 * 省掉每片一次的 PowerShell 启动时间——流式播报里两块之间的空隙全靠这个压住；打断就
 * 直接杀进程（MCI 设备随进程一起没），下一次 play 时再起一个。
 *
 * macOS 上用系统自带的 afplay，同样阻塞到放完。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export type PlayResult = 'played' | 'cut' | 'failed';

export interface Player {
  /** 预启动播放器并把脚本落在 dir 里，省掉第一片的启动时间。 */
  warm(dir: string): Promise<void>;
  /**
   * 放一片，resolve 时声音已经结束（或被 cut、或失败）。
   *
   * `volume` 是 0–100 的播放音量：API 引擎回来的音频是成品，调不了合成参数，
   * 只能在这里把声音放轻；Edge 引擎已经在合成时带了音量，这里传 100 即可。
   */
  play(clip: string, volume?: number): Promise<PlayResult>;
  /** 立刻停下正在放的一片。 */
  hush(): void;
  stop(): Promise<void>;
}

/** 一片最多等这么久；MCI 万一卡住，不能把整条队列吊死。 */
const CLIP_TIMEOUT_MS = 60_000;
/** 等播放器就绪的时间。 */
const READY_TIMEOUT_MS = 8_000;

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport(\"winmm.dll\", CharSet = CharSet.Auto)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr hwnd);'",
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  if ($line -eq 'QUIT') { break }",
  '  # 每行是「音量<TAB>路径」；音量是 0–1000 的 MCI 刻度',
  '  $vol = 1000',
  '  $file = $line',
  '  $tab = $line.IndexOf([char]9)',
  '  if ($tab -ge 0) {',
  '    $vol = [int]$line.Substring(0, $tab)',
  '    $file = $line.Substring($tab + 1)',
  '  }',
  "  [WinMM.MCI]::mciSendString(\"open `\"$file`\" type mpegvideo alias svplay\", $null, 0, [System.IntPtr]::Zero) | Out-Null",
  '  [WinMM.MCI]::mciSendString("setaudio svplay volume to $vol", $null, 0, [System.IntPtr]::Zero) | Out-Null',
  '  [WinMM.MCI]::mciSendString(\'play svplay wait\', $null, 0, [System.IntPtr]::Zero) | Out-Null',
  "  [WinMM.MCI]::mciSendString('close svplay', $null, 0, [System.IntPtr]::Zero) | Out-Null",
  "  [Console]::Out.WriteLine('DONE')",
  '  [Console]::Out.Flush()',
  '}',
].join('\r\n');

class WindowsPlayer implements Player {
  private child: ChildProcess | null = null;
  private readied: Promise<boolean> | null = null;
  private pending: ((r: PlayResult) => void) | null = null;
  private scriptPath: string | null = null;
  private dir: string | null = null;
  private tail = '';

  constructor(private readonly log: (line: string) => void) {}

  async warm(dir: string): Promise<void> {
    this.dir = dir;
    await this.ensure();
  }

  private async ensure(): Promise<boolean> {
    if (this.child) return this.readied ?? true;
    const dir = this.dir;
    if (!dir) return false;
    if (!this.scriptPath) {
      this.scriptPath = join(dir, 'player.ps1');
      await writeFile(this.scriptPath, PS_SCRIPT, 'utf8');
    }
    const scriptPath = this.scriptPath;
    let mark: (ok: boolean) => void = () => {};
    this.readied = new Promise<boolean>((resolve) => { mark = resolve; });

    let child: ChildProcess;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (err) {
      this.log(`播放器启动失败：${(err as Error).message}`);
      this.readied = null;
      return false;
    }
    this.child = child;
    this.tail = '';

    const timer = setTimeout(() => mark(false), READY_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.tail += chunk;
      let nl = this.tail.indexOf('\n');
      while (nl >= 0) {
        const line = this.tail.slice(0, nl).trim();
        this.tail = this.tail.slice(nl + 1);
        if (line === 'READY') {
          clearTimeout(timer);
          mark(true);
        } else if (line === 'DONE') {
          const p = this.pending;
          this.pending = null;
          p?.('played');
        }
        nl = this.tail.indexOf('\n');
      }
    });
    child.once('error', (err) => {
      this.log(`播放器出错：${err.message}`);
      clearTimeout(timer);
      mark(false);
      this.drop(child, 'failed');
    });
    child.once('exit', () => {
      clearTimeout(timer);
      mark(false);
      this.drop(child, 'failed');
    });
    return this.readied;
  }

  /** 进程没了：把等着的那一片放掉，别让队列吊在这里。 */
  private drop(child: ChildProcess, result: PlayResult): void {
    if (this.child !== child) return;
    this.child = null;
    this.readied = null;
    const p = this.pending;
    this.pending = null;
    p?.(result);
  }

  async play(clip: string, volume = 100): Promise<PlayResult> {
    const ok = this.child ? true : await this.ensure();
    const child = this.child;
    if (!ok || !child || !child.stdin?.writable) return 'failed';
    // MCI 的音量刻度是 0–1000
    const level = Math.round(Math.min(100, Math.max(0, volume)) * 10);
    return new Promise<PlayResult>((resolve) => {
      let settled = false;
      const finish = (r: PlayResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.pending === finish) this.pending = null;
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.log('这一片超过一分钟还没放完，重启播放器');
        this.hush();
        finish('cut');
      }, CLIP_TIMEOUT_MS);
      this.pending = finish;
      // MCI 认反斜杠；路径里不会有换行，第一段是音量
      child.stdin.write(`${level}\t${clip}\n`, 'utf8', (err) => {
        if (err) finish('failed');
      });
    });
  }

  hush(): void {
    const child = this.child;
    if (!child) return;
    const p = this.pending;
    this.pending = null;
    this.child = null;
    this.readied = null;
    try { child.kill(); } catch { /* 已经没了 */ }
    p?.('cut');
  }

  async stop(): Promise<void> {
    this.hush();
    if (this.scriptPath) {
      await rm(this.scriptPath, { force: true }).catch(() => {});
      this.scriptPath = null;
    }
  }
}

class MacPlayer implements Player {
  private current: ChildProcess | null = null;

  async warm(): Promise<void> {}

  play(clip: string, volume = 100): Promise<PlayResult> {
    return new Promise((resolve) => {
      const level = Math.min(100, Math.max(0, volume)) / 100;
      const child = spawn('afplay', ['-v', String(level), clip], { stdio: 'ignore' });
      this.current = child;
      let settled = false;
      const finish = (r: PlayResult): void => {
        if (settled) return;
        settled = true;
        if (this.current === child) this.current = null;
        resolve(r);
      };
      child.once('exit', (code) => finish(code === 0 ? 'played' : 'cut'));
      child.once('error', () => finish('failed'));
    });
  }

  hush(): void {
    const child = this.current;
    this.current = null;
    try { child?.kill(); } catch { /* 已经没了 */ }
  }

  async stop(): Promise<void> {
    this.hush();
  }
}

export function createPlayer(log: (line: string) => void): Player {
  if (process.platform === 'win32') return new WindowsPlayer(log);
  return new MacPlayer();
}
