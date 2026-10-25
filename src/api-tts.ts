/**
 * 走 HTTP 合成的那一头：把一块字交给一个 OpenAI 兼容的语音服务，换回一段音频文件。
 *
 * 为什么不复用 Edge 那条连接：本地/自建的后端（CosyVoice、GPT-SoVITS、vLLM 起出来的 TTS、
 * 各家云厂商）大多只给 HTTP 接口，协议基本都抄了 OpenAI 那一套：`input` + `voice` +
 * `response_format`，可选 `model` / `instructions` / `language` / `speed`。
 *
 * 配置里只填**根地址**（OpenAI 说的 `base_url`，形如 `http://host:8091/v1`），
 * 具体路径按规范自己拼：`/audio/speech`、`/models`、`/audio/voices`。
 * 用户把整条 `/v1/audio/speech` 贴进来也能用，`normalizeBase()` 会拆回根地址。
 *
 * 合成结果落成文件再交给播放器：整条链路（切块、排队、打断）都建立在「一块对应一个文件」上。
 *
 * 错误一律翻成人话：连不上、超时、HTTP 状态、服务把错误包在 JSON 里但回了 200，面板上都要能看懂。
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 后端支持的容器；`pcm` 是无头裸流，MCI 播不了，留着只为少数自建服务。 */
export const API_FORMATS = ['mp3', 'wav', 'flac', 'opus', 'pcm'] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

/** 根地址默认指向本机 WSL 里那套服务；换后端只改这一项。 */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8091/v1';
export const DEFAULT_API_VOICE = 'vivian';
export const DEFAULT_API_FORMAT: ApiFormat = 'mp3';

export const API_TIMEOUT_DEFAULT = 30_000;
export const API_TIMEOUT_MIN = 1_000;
export const API_TIMEOUT_MAX = 300_000;

/** 语速倍率：1 = 原速，按 OpenAI 的 speed 范围取值。 */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_STEP = 0.05;
export const SPEED_DEFAULT = 1;

/** 一次 API 合成要的全部参数（不含文本）。 */
export interface ApiSpeech {
  /** 服务根地址（base_url），如 `http://127.0.0.1:8091/v1`。 */
  base: string;
  /** Bearer 令牌；留空则不带头。 */
  key: string;
  /** OpenAI 的 `model` 字段；留空不发。 */
  model: string;
  /** 后端自己的音色名，如 `vivian`。 */
  voice: string;
  format: ApiFormat;
  /** 语气指令，如「用开心的语气说」；留空不发。 */
  instructions: string;
  /** `Chinese` / `English`…；留空不发。 */
  language: string;
  timeoutMs: number;
  /** 语速倍率 0.25–4；等于 1 时按原速处理，不发 speed。 */
  speed: number;
  /** 播放音量 0–100：后端回来的音频是成品，只能在前端播放器上调。 */
  volume: number;
}

const EXTENSION: Record<ApiFormat, string> = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  opus: 'opus',
  pcm: 'pcm',
};

export function isApiFormat(value: unknown): value is ApiFormat {
  return typeof value === 'string' && (API_FORMATS as readonly string[]).includes(value);
}

/** 把配置里的值夹进 0.25–4，并去掉浮点尾巴。 */
export function clampSpeed(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return SPEED_DEFAULT;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
  return Math.round(clamped * 100) / 100;
}

/**
 * 用户填的地址 → 规范化的根地址；认不出来返回空串。
 *
 * - 没写协议就补 `http://`（本机服务最常见）
 * - 把整条端点拆回根地址：`…/v1/audio/speech`、`…/v1/audio`、`…/v1` 都归到 `…/v1`
 * - 只写了主机名时补上 `/v1`（OpenAI 的约定），其余路径原样保留
 */
export function normalizeBase(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  let path = url.pathname.replace(/\/+$/, '');
  // 贴的是整条端点：一层层往回退到版本根
  path = path.replace(/\/audio\/speech$/i, '');
  path = path.replace(/\/audio$/i, '');
  // 只写了主机（或只写了 /）时按 OpenAI 约定补 /v1
  if (!path) path = '/v1';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** 合成端点：`<base>/audio/speech`。 */
export function speechUrl(base: string): string {
  return `${stripSlash(base)}/audio/speech`;
}

/** 模型清单：`<base>/models`。 */
export function modelsUrl(base: string): string {
  return `${stripSlash(base)}/models`;
}

/** 音色清单：`<base>/audio/voices`（不是标准端点，认不出来的后端就当没有）。 */
export function voicesUrl(base: string): string {
  return `${stripSlash(base)}/audio/voices`;
}

/** 合成结果：文件落在调用方给的空目录里。 */
export interface ApiSpeechOut {
  file: string;
  bytes: number;
  contentType: string;
  ms: number;
}

/**
 * 合成一块字，写到 `dir` 里的 `speech.<ext>`，返回路径。
 *
 * 失败抛 Error，`message` 已经是能直接给用户看的中文。
 */
export async function speechToFile(
  text: string,
  api: ApiSpeech,
  dir: string,
  signal?: AbortSignal,
): Promise<ApiSpeechOut> {
  const started = Date.now();
  const url = speechUrl(api.base);
  const body: Record<string, unknown> = {
    input: text,
    voice: api.voice,
    response_format: api.format,
  };
  if (api.model) body.model = api.model;
  if (api.instructions) body.instructions = api.instructions;
  if (api.language) body.language = api.language;
  // 原速就不发：有的后端见到 speed 就走变速路径，白白损失音质
  if (api.speed !== SPEED_DEFAULT) body.speed = clampSpeed(api.speed);

  // 自己超时：后端卡住时不能把整条队列吊死
  const timeout = AbortSignal.timeout(api.timeoutMs);
  const aborted = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(api),
      body: JSON.stringify(body),
      signal: aborted,
    });
  } catch (err) {
    throw new Error(connectError(err, url, api.timeoutMs));
  }

  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail(raw)}`);
  }
  // 有的服务出错时回 200 + JSON，这里认出来，别把 JSON 当音频存下来
  if (type.includes('json')) {
    const raw = await res.text().catch(() => '');
    throw new Error(`服务返回的不是音频而是 JSON${detail(raw)}`);
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(connectError(err, url, api.timeoutMs));
  }
  if (!buf.length) throw new Error('服务返回了空音频（0 字节）');

  const file = join(dir, `speech.${EXTENSION[api.format]}`);
  await writeFile(file, buf);
  return { file, bytes: buf.length, contentType: type, ms: Date.now() - started };
}

/** 连接测试的结果：服务通没通、它有哪些模型与音色。 */
export interface ApiProbe {
  ok: boolean;
  /** 规范化之后的根地址与真正的合成端点，回执里给用户看。 */
  base: string;
  speechUrl: string;
  models: string[];
  voices: string[];
  ms: number;
  /** 整体不通时的原因。 */
  error?: string;
  /** 通了但这两个清单没拿到（后端没实现），照实说，不算失败。 */
  modelsError?: string;
  voicesError?: string;
}

/**
 * 连接测试：照规范问一遍 `/models` 与 `/audio/voices`，把能用的模型和音色带回来。
 *
 * 两个都失败才算不通；只有一个 404 说明后端没实现那个端点，仍然算连通——
 * 面板据此把音色/模型填成下拉，拿不到的保持手填。
 */
export async function probeApi(
  base: string,
  key: string,
  timeoutMs = 8_000,
  signal?: AbortSignal,
): Promise<ApiProbe> {
  const started = Date.now();
  const root = normalizeBase(base);
  const out: ApiProbe = { ok: false, base: root, speechUrl: root ? speechUrl(root) : '', models: [], voices: [], ms: 0 };
  if (!root) {
    out.error = '地址填得不对：要形如 http://127.0.0.1:8091/v1 的根地址。';
    return out;
  }

  const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  const get = async (url: string): Promise<{ data?: unknown; error?: string }> => {
    const timer = AbortSignal.timeout(Math.min(timeoutMs, 10_000));
    try {
      const res = await fetch(url, {
        headers: { ...auth, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timer]) : timer,
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { data: await res.json() };
    } catch (err) {
      return { error: connectError(err, url, Math.min(timeoutMs, 10_000)) };
    }
  };

  const [models, voices] = await Promise.all([get(modelsUrl(root)), get(voicesUrl(root))]);
  out.models = pickModels(models.data);
  out.voices = pickVoices(voices.data);
  out.ms = Date.now() - started;

  if (models.error) out.modelsError = models.error;
  if (voices.error) out.voicesError = voices.error;
  out.ok = !(models.error && voices.error);
  if (!out.ok) out.error = models.error;
  else if (!out.voices.length && !out.models.length) {
    // 两个端点都答了 200 却是空的：能连上，但拿不到清单
    out.error = undefined;
  }
  return out;
}

/** `{object:'list', data:[{id}]}`（OpenAI 规范）；也认 `{models:[...]}` 这种变体。 */
function pickModels(data: unknown): string[] {
  const bag = data as { data?: unknown; models?: unknown } | null;
  const list = Array.isArray(bag?.data) ? bag!.data : Array.isArray(bag?.models) ? bag!.models : [];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof (item as { id?: unknown }).id === 'string') names.push((item as { id: string }).id);
  }
  return names.filter((v) => !!v.trim());
}

/** `{voices:['vivian',…]}`；也认 `[{name}]` / `[{id}]` 这种变体。 */
function pickVoices(data: unknown): string[] {
  const bag = data as { voices?: unknown; data?: unknown } | null;
  const list = Array.isArray(bag?.voices) ? bag!.voices : Array.isArray(bag?.data) ? bag!.data : [];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') names.push(item);
    else if (item && typeof item === 'object') {
      const rec = item as { name?: unknown; id?: unknown; short_name?: unknown };
      const picked = [rec.name, rec.id, rec.short_name].find((v) => typeof v === 'string' && v.trim());
      if (typeof picked === 'string') names.push(picked);
    }
  }
  return names.filter((v) => !!v.trim());
}

function stripSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

function headers(api: ApiSpeech): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'audio/*',
  };
  if (api.key) out.authorization = `Bearer ${api.key}`;
  return out;
}

/** 把服务回的报错正文压成一句：优先取 `error.message`，其次 `detail`，再不行就截原文。 */
function detail(raw: string): string {
  const text = raw.trim();
  if (!text) return '（服务没有说明原因）';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    const err = parsed.error;
    const message = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : undefined;
    const picked = message
      ?? (typeof parsed.detail === 'string' ? parsed.detail : undefined)
      ?? (typeof parsed.message === 'string' ? parsed.message : undefined);
    if (picked) return `：${clip(picked)}`;
  } catch {
    // 不是 JSON，往下走
  }
  return `：${clip(text)}`;
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 网络层的错翻成人话，把地址带上，省得用户猜是哪台机器。 */
function connectError(err: unknown, url: string, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? '';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return `请求超时（${timeoutMs}ms）：${url} 没有在限定时间内返回。服务在忙、或它加载模型很慢时可以调大超时。`;
  }
  if (code === 'ECONNREFUSED') return `连不上 ${url}：那边的服务没起，或者端口不对。`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `解析不了 ${url} 的主机名：地址写错了，或者 DNS/网络不通。`;
  if (code === 'ECONNRESET' || /socket hang up/i.test(e?.message ?? '')) {
    return `连接被 ${url} 断开了：服务可能刚崩，或者显存不够。`;
  }
  return `请求 ${url} 失败：${e?.cause?.message ?? e?.message ?? String(err)}`;
}
