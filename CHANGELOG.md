# 更新日志

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
