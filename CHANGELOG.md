# 更新日志

## 未发布

### 语速与音量统一在前端处理

- 两条引擎都不再把语速 / 音量塞进合成请求：Edge 的 SSML 只带音色与音高（语速固定原速），
  API 的 `speed` 字段不再发送。合成拿回来的是干净的原声，变速与音量在本地做完再交给播放器。
  以前音量最大只能到 1（再大就由后端截断），现在 0.1–5 都作数。
- 新增 `src/audio.ts`：解码 → 变速 → 增益 → 重编码成 16 bit PCM WAV。默认值（语速 1、音量 1）
  原样返回原文件，一点算力都不花。
- **变速走 WSOLA**（波形相似重叠相加）：40 ms 一帧、50% 重叠、汉宁窗、±¼ 帧的相似度搜索，
  末了按「原长 ÷ 倍率」裁齐并加 64 采样淡入淡出。改快改慢都不跑调，也不会像重采样那样变尖变闷。
- **音量是纯乘法增益**，最后钳到 `[-1, 1]`——5 倍是「顶到满刻度」，不是溢出成噪音。
- Edge 的音量以前靠 SSML 的 `volume`，天花板就是原音量；现在 SSML 里固定 `+0%`，响度全交给本地增益。
- 旧配置照旧能读：`+15%` 认成 1.15，`100` 认成 1，`200` 认成 2。

### Edge 回到 MP3

- 上一版把 Edge 的输出格式改成 `riff-24khz-16bit-mono-pcm`，想省掉解码这一步，结果试听直接报
  「这个音色没能合成出来」——Edge 的朗读接口**只回 MP3 或 WebM(Opus)**，要 PCM 的请求一律
  断开 socket（`no turn.end received`）。用官方 `edge_tts` 要 `.wav` 实测，回来的字节和 MP3
  完全一致（MD5 相同），确认是接口行为，不是参数写错。
- 输出格式改回 `AUDIO_24KHZ_48KBITRATE_MONO_MP3`，解码交给 `mpg123-decoder`（WASM 版
  libmpg123，自带 76 KB 的 `EmscriptenWasm.js`，`npm install` 完就能用，不用额外装什么或编译）。
  WASM 堆里的视图在 `free()` 之后就失效了，所以解码出的采样先拷出来再用。
- 播放器按扩展名选 MCI 设备（`.wav` 用 `waveaudio`，其余 `mpegvideo`），音量一律传 100——
  要轻要响已经在音频里烤好了。

### 控件改成滑动条

- 「语速」「音量」「API 语速」「API 音量」四项从档位下拉改成滑动条：最小 0.1、最大 5、步进 0.05，
  默认 1 就是原本的语速 / 音量，数值显示成 `1.2×`。
- 面板框架原本只认 `boolean / select / number / text / password`，没有滑动条，于是在随扩展发布的
  `dist/webui.js` 里补了 `slider` 这一种：拖动时实时回显倍率，切页签回来也不会把其它页正在填的
  值盖掉。取值范围仍由 `config.ts` 下发，前端不认识任何字段名。
- `speech_tune` 的 `rate` / `volume` / `apiSpeedFactor` / `apiVolume` 同步换成 0.1–5 的倍率
  （以前是 `+20%`、`0–100` 这类厂商单位），模型调参与面板改的是同一套数。

## 0.5.0

### 两套引擎，各占一个页签

- 新增 **API 引擎**：`engine` 选 `api` 后，合成改走任何 OpenAI 兼容的 `/v1/audio/speech` 服务
  （本机 WSL 里的 Qwen3-TTS、CosyVoice、GPT-SoVITS、vLLM 起的都行）。切块、排队、打断、试听
  两条引擎共用，`engine` 改完下一句就换。默认 `edge`，行为与之前一致。
- 世界页顶部现在是「流式语音播报 / Edge 语音 / API 语音 / 配置 / 环境提示词」。以前 Edge 和 API
  的参数并排挤在「配置」里，看不出哪一组此刻生效；现在想用哪套就点哪一页，每页顶上只有一个
  「启用」开关，开一边另一边自动关上。
- 「配置」页签只留跟引擎无关的项：念什么、切块与节奏、高级（预热 / 日志 / 允许模型自己调）。
- 两个语音页由扩展自己画（`panels`），字段标题、说明、取值范围、下拉候选全部由 `config.ts`
  下发给前端，前端不认识任何字段名——加参数只改后端一处。
- 保存不走 `/api/config`（框架只认「配置」页签里声明过的组），改为页签自己的 `save` 方法，
  校验规则与原来写在 schema 里的一致：枚举档位、数值范围、地址规范化。
- 试听下放到两个语音页，并且**按页签选引擎**：在「API 语音」页点「试听这句」就用 API，
  「Edge 语音」页就用 Edge，不必先启用，也不会改动当前引擎——两页可以来回比对音色，
  谁在生效始终由开关决定。

### Edge 引擎

- 修 Edge 完全不出声：日志里是 `Edge TTS WebSocket error: Unexpected server response: 200`。
  原因是微软在 2026-10 换了朗读接口的校验——令牌从「一个 SHA-256」变成
  `<CS64 16 位>-<SHA256 64 位>` 两段拼接，版本号从 `1-` 变 `2-`，端点也从
  `api.msedgeservices.com` 回到 `speech.platform.bing.com`。旧的握手被网关回了 HTTP 200
  空响应（不是 101 升级），于是永远连不上。
- `src/edge-tts/drm.ts` 是新的令牌算法，逐行移植自上游 edge-tts 7.3.x 的 `drm.py`
  （它的 SHA-256 不是标准实现，前 7 个字节单独喂给初态，别用 `crypto.subtle` 替换）。
  已用上游样例交叉验证：三个固定时间戳算出的令牌逐字节一致。
- 握手请求补齐 `Cookie: muid=…`、`Accept-Language`、`Pragma` 等头，与官方客户端一致。
- 时钟校正从「毫秒偏移」改为「秒偏移」，与令牌的 5 分钟窗口对齐。
- 握手被拒时错误信息会说明下一步（200＝校验参数过期，403＝时钟偏差或出口被限流），
  不再只甩一个状态码。

### API 引擎

- 新增配置项：`apiBase`、`apiKey`、`apiModel`、`apiVoice`、`apiFormat`、`apiInstructions`
  （整段语气指令）、`apiLanguage`、`apiSpeedFactor`、`apiTimeoutMs`、`apiVolume`。
- **地址只填根地址**：`apiBase` 是 OpenAI 的 `base_url`（如 `http://127.0.0.1:8091/v1`），
  合成、模型清单、音色清单的路径由扩展按规范自己拼（`/audio/speech`、`/models`、`/audio/voices`）。
  只写主机名会自动补 `/v1`；把整条 `/v1/audio/speech` 贴进来也能认，会截回根地址。旧配置里的
  `apiUrl` 仍当兜底读，不用手改。
- **语速走 `speed`**：`apiSpeedFactor` 是倍率（0.25–4，1 = 原速）。等于 1 时不发送这一项，
  避免后端白走变速路径。
- **令牌不进配置页**：`apiKey` 只在面板上以密码框出现（掩着、不回显，留空＝不改，可一键清除）。
  它仍在 `config.json` 里，`speech_tune` 也能设。
- **面板有「连接测试」**：拿面板上此刻填的地址与令牌现问 `<base>/models` 与 `<base>/audio/voices`，
  通了就把音色与模型变成真正的下拉（末项「其它（手填）」换回输入框），并回填被规范化后的地址；
  某个端点 404 不算失败。
- **探测结果有缓存**：`worlds.streamvoice.apiCatalog` 记住最近一次清单，面板打开就能选，
  并注明「用的是 N 分钟前的清单」；地址改了缓存自动作废并重探。
- 下拉里的名字带说明：`serena — 温暖、柔和的年轻女声 · 中文`；当前值不在新清单里时不悄悄换成
  第一个，而是补一行「xxx · 自定义」留着。
- **播放音量**：`apiVolume`（0–100）。API 回来的音频是成品，音量在播放器这边调
  （Windows 走 MCI `setaudio volume`，macOS 走 `afplay -v`），不影响音色、也不发给后端。
- `src/api-tts.ts` 按 OpenAI 协议发请求、落盘，把连不上 / 超时 / HTTP 状态 / 200+JSON 这类失败
  翻成人话。
- API 引擎下 `prewarm` 不再空打一发（HTTP 没有长连接冷启动，省一次推理）。

### 面板

- 运行状态读数、立即静音、音色试听（改完参数就地按一句，不用先保存、可直接写入配置）。
- API 页多一行「当前引擎」与「语气指令」，Edge 的参数在 API 页不显示，反之亦然。
- 修勾选框与文字没对齐：原生勾选框的大小跟着字号走、位置跟着框架的 `.check` 样式走，字号一换
  就比文字中心高出一截。现在尺寸（16px）、标签行盒（18px）、控件行（18px）都写死，三者共用
  同一把尺；那个空 span 的白占位也去掉了。

### 工具与环境提示词

- `speech_tune` 覆盖本扩展**全部**可调项，一项不漏：嗓音四项、念台词 / 问句 / 选项、切块门槛与
  单块上限、块间停顿、预热、详细日志、总开关 `enabled`，以及 API 那十项（含 `apiVolume`）。
  数值在工具里就对齐，落盘走 `ctx.persist()`，和配置页改的是同一份 `worlds.streamvoice`。
- `speech_status` 与试听回执按引擎说事（API 引擎下不再把语速 / 音调 / 音量说成生效项）；
  `speech_silence` 立刻停下当前与队列，不改设置。
- 环境提示词 `src/ENV_PROMPT.md` 共 8 个占位符，新增 `{{ streamvoice.engine }}`；API 引擎下带端点、
  音色、格式，音色清单换成后端那套真实名字（带说明），模型换音色不用猜。
- `allowSelfTuning` 关掉后 `speech_tune` 不再出现在工具表里；查看与停止仍然保留。

### 自测与文档

- 新增 `scripts/check-api.ts`（真打一次本地服务，验 mp3/wav 文件头、地址规范化、连接测试、
  音色清单与错误翻译；服务没起就整体跳过）、`scripts/check-edge-token.ts`（三个固定时间戳钉死
  令牌结果）、`scripts/check-world-tools.ts`（真的 new 一个 World 出来调工具，并校验页签结构、
  字段表、保存与开关联动、提示词占位符）。
- README 补两套引擎的配置说明与「在哪个页试听就用哪个引擎」。

## 0.4.0

- 新增三个工具，模型可以按用户的口语要求自己动手：`speech_status`（查当前设置）、
  `speech_tune`（改设置）、`speech_silence`（立刻停下当前与队列，不改设置）。
- `speech_tune` 覆盖本扩展**全部**可调项，一项不漏：嗓音四项、念台词/问句/选项、
  切块门槛与单块上限、块间停顿、预热、详细日志，以及总开关 `enabled`。
  数值在工具里就对齐（语速/音调/音量按 5，切块与停顿按配置页的上下限），
  落盘走 `ctx.persist()`，和配置页改的是同一份 `worlds.streamvoice`。
- 新增环境提示词 `src/ENV_PROMPT.md`：告诉模型现在是什么嗓音、各项设置意味着什么、
  什么时候该动手、什么时候该先问。7 个占位符由 `envPromptVars()` 实时提供；
  在控制台提示词页改完会写到 `<部署目录>/worlds/streamvoice/ENV_PROMPT.md`，
  优先于包内模板，清空即回落。
- 新增配置 `allowSelfTuning`（默认开）：关掉后 `speech_tune` 不再出现在工具表里，
  模型看不到也就不会反复尝试；查看与停止仍然保留。
- `describe.json` 带上三个工具的声明，扩展市场与 World 页能看到它们。
- 新增自测：`scripts/check-tools.ts`（参数翻译）、`scripts/check-world-tools.ts`
  （真的 new 一个 World 出来调工具，并校验提示词占位符）、`scripts/gen-describe.ts`。

## 0.3.2

- 发版改走 GitHub Actions 的 trusted publishing（OIDC）：推一个 `v*` 标签即自动发布，
  仓库里不再需要任何 token，也不用处理 2FA 验证码。
- 发布时附带 provenance 签名，npm 包页面可以追溯到具体的 commit 与 workflow。
- README 增「发版」一节，写清本地流程与首次配置 Trusted Publisher 的字段。

## 0.3.1

- 首个公开版本。边生成边朗读：订阅主 session 的输出增量，从 `pet_say` / `pet_ask` 的参数里
  增量解析台词，按句切块，第一块立刻合成播放，后面的块边生成边排队、按顺序连播。
- 切块规则可调：短句并下一句（`chunkMinChars`）、超长在逗号处再切（`chunkMaxChars`）、块间停顿（`gapMs`）。
- 嗓音全部独立配置，不读也不依赖别的扩展：29 个音色（中/粤/台/英/日/韩），语速/音调/音量各 21 档。
- 控制台面板：运行状态读数、立即静音、音色试听（联动音色/语速/音调/音量，可直接写入配置）。
- 预热（`prewarm`）把 Edge TTS 的冷启动挡在第一句之前；`verbose` 逐块写合成耗时到日志。
- 新回复或被打断时清空队列，不会把上一轮的话接着念完。
- 授权 AGPL-3.0-or-later；`src/edge-tts/` 为 MIT 的 msedge-tts 客户端拷贝。
