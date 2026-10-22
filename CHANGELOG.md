# 更新日志

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
