# 流式语音播报（cortico-world-streamvoice）

宠物还在写，第一句已经出声了。

本扩展**独立工作**：音色、语速、音调、音量、念哪些内容、切块长短、块间停顿，全是它自己的配置
（`worlds.streamvoice`），不读任何别的扩展的设置，也不依赖别的包才能跑。装上去、开起来，就有声音。

![面板](docs/panel.png)

旧的整段朗读要等台词全部写完、记进事件库，再靠轮询捞出来，整段合成、整段播放。
这个扩展换了个口子：World 可以声明 `outputTap()`，框架把主 session 的模型输出增量直接扇过来，
于是第一句一写完就能去合成，后面的句子边生成边排队，播放器一块接一块地说。

## 它怎么工作

```
模型输出增量
  └─ response.output_item.added         认出 pet_say / pet_ask / pet_quiet
       └─ …function_call_arguments.delta  JSON 碎片 → args.ts 抠出 script
            └─ clean.ts                  【动作】<表情> 标记去掉，表情/网址/Markdown 去掉
                 └─ chunker.ts           按句切块：短句并下一句，超长在逗号处再切
                      └─ speaker.ts      立刻合成（与播放流水线并行）→ 播放器按顺序连播
```

- **订阅的是函数调用参数，不是正文。** 这个 bot 从不用 assistant 正文说话：说出来的一切都在
  `pet_say` 的 `script` 参数里（`pet_ask` 的 `question` 同理）。所以增量得从
  `response.function_call_arguments.delta` 里增量解 JSON，见 `src/args.ts`。
- **切块**：句末（。！？；换行 / 英文 `.!?;`）切一刀；短于 `chunkMinChars` 的句子并到下一句；
  一块超过 `chunkMaxChars` 就在靠后的逗号处再切，没标点就硬切。
- **合成与播放是两条流水线**：每块一进队就开始合成（互相串行，一条 Edge 连接），播放器只按顺序放。
  第 1 块在说的时候，第 2 块早就合成好了，块与块之间没有等待（实测衔接 0–30ms）。
- **预热**：Edge TTS 一条连接上的第一趟要 2–3.5 秒，热了以后只要几百毫秒。所以模型开始想第一句时
  先空打一发合成，把链路焐热，结果丢掉（可用 `prewarm` 关掉）。
- **清空队列**：新的一批送达（新回复）或被打断（`onAbort`）时，`hush()` 把代次加一：排队的块丢掉，
  正在合成的结果回来也丢掉，正在放的那一片杀掉播放器。模型调 `pet_quiet` 时同样清空；
  面板上的「立即静音」也走这条路。

## 装

三种装法，效果一样：扩展是纯 TS 源码 + 一份预构建的面板产物，**没有构建步骤**，
运行期只有一个依赖（`ws`，装的时候会一起下来）。

**最常见（从扩展市场）：** 打开控制台「World 扩展」页，搜「流式语音播报」或
`cortico-world-streamvoice`，点安装。市场按 npm 上的 `cortico-world` 关键字自动收录，
收录后卡片会带上图标、截图和「Voice」标签。

**给别人用（从 GitHub 拉）：**

```bash
cd <部署目录>/data/extensions
pnpm add github:laojingwei/cortico-world-streamvoice
```

**自己改（源码就在本机）：**

```bash
# 用 link: 装进去，改完重启 Core 就是新的
cd <部署目录>/data/extensions
pnpm add link:D:/dsh/workbuddy/extensions/cortico-world-streamvoice
```

`<部署目录>` 一般就是 Coopanion 的安装目录，比如 `E:/software/coopanion`。

然后打开它（`<部署目录>/data/home/companion/config.json` 里 `worlds.streamvoice.enabled` = true，
或在控制台「流式语音播报」页打开）。**只需要这一个开关**，别的扩展装不装、开不开都不影响。

如果机器上还装着别的会整段朗读的扩展（比如大肥鱼功能包、桌面宠物的语音库朗读）并且开着，
同一句会被念两遍——本扩展会在日志里点出是谁，面板上多一盏「另一处也在朗读」。把那边关掉即可。
这只是提醒，不是依赖。

## 发版

发版走 GitHub Actions 的 **trusted publishing**（OIDC）：runner 拿一次性令牌去 npm 换发布凭证，
仓库里不存任何 token，也不用管 2FA 验证码。工作流在 `.github/workflows/publish.yml`。

```bash
# 1. 改 package.json 的 version（改了 dist/webui.js 就必须升，面板按版本寻址）
# 2. 在 CHANGELOG.md 顶部加一条
git add -A && git commit -m "0.3.2：…"
git tag v0.3.2
git push origin main --tags        # 推 tag 就会触发发布
```

工作流会先核对 `package.json` 的版本和 tag 是否一致、该版本是否已存在，再 `npm publish --provenance`。
发布成功后 npm 包页面会带一个 provenance 徽章，能点开看到对应的 commit 和 workflow。

**首次配置（只做一次）**：打开 https://www.npmjs.com/package/cortico-world-streamvoice → 右侧
`Settings` → `Trusted Publisher` → 选 **GitHub Actions**，填：

| 字段 | 值 |
|---|---|
| Organization or user | `laojingwei` |
| Repository | `cortico-world-streamvoice` |
| Workflow filename | `publish.yml` |
| Environment name | 留空 |

环境名一旦填了，工作流里也得同步加 `environment: <名字>`，两边必须一致，否则 OIDC 换不到令牌。

应急时仍然可以在本地手发（需要 2FA 验证码）：`npm publish --registry=https://registry.npmjs.org --otp=<6位码>`。

## 试听音色（面板）

「流式语音播报」页签的第二张卡可以**现场试听**：

1. 选音色、语速、音调、音量（下拉就是配置里那几组选项，默认取当前配置）；试听文本也能改；
2. 按「试听」→ 服务端用**同一套合成链路**合成这一句并放出来，返回「可以用 · 彩云 · 合成 1.2s」，
   或者把失败原因写成一句人话（比如「这个音色没能合成出来：Edge 朗读接口没有提供它」）；
3. 满意就按「写入配置」，和配置页是同一份值，下一句立即生效。

因为试听走的就是正式朗读的那条路（同样的音色/语速/音调/音量、同样的播放器），
**它能不能出声就等于正式朗读能不能出声**；`scripts/check-voices.ts` 会把整张音色表跑一遍。

## 让模型自己调嗓音（工具）

除了人去点面板，模型也能自己动手——用户顺口说「说慢点」「声音小一点」「换个男声」的时候，
不必再让用户去翻控制台。本扩展给了三个工具：

| 工具 | 标签 | 作用 |
|---|---|---|
| `speech_status` | read / snapshot | 查当前的完整设置：嗓音四项、念什么、切块与节奏、预热与日志、总开关，以及此刻在不在说、队列几块 |
| `speech_tune` | write | 改**这个扩展的全部可调项**（见下表），和配置页改的是同一份值 |
| `speech_silence` | write | 立刻停掉正在念的和排队的，不改设置、不影响后面的新台词（整轮安静仍用 `pet_quiet`） |

`speech_tune` 的字段与配置项一一对应，一个不漏：

| 分类 | 字段 | 说明 |
|---|---|---|
| 嗓音 | `voice` | 中文名（晓晓、云希…）或 Edge ShortName |
| | `rate` / `pitch` / `volume` | −50…50，语速与音量是 %、音调是 Hz，自动对齐到 5 |
| 念什么 | `readSay` / `readAsk` / `readOptions` | 台词、问句、选项三个开关 |
| 切块与节奏 | `chunkMinChars` / `chunkMaxChars` / `gapMs` | 参数范围与配置页完全一致；上限被给到比门槛小时会自动抬高并在回执里说明 |
| 高级 | `prewarm` / `verbose` | 预热、详细日志 |
| 总开关 | `enabled` | 整个扩展开关。关掉后扩展停止工作，模型自己打不开，得人去控制台恢复 |

几个刻意的设计：

- **改的是长期配置**：`speech_tune` 走 `ctx.persist()` 写进 `worlds.streamvoice`，下一句就生效，
  重启也还在；配置页上和工具改的是同一份值。
- **档位对齐到 5**：模型给 `rate: 37`，落盘的是 `+35%`——配置页的下拉就是这些值，
  不会留下一个下拉框显示不出来的野值。
- **音色只认名单里的**：说「林黛玉」会被拒，回执里附几个可用的中文音色名让模型自己问清楚，
  免得换成一个合成不出来的音色、把声音搞哑。
- **回执讲清前因后果**：改完告诉模型「音色 晓晓 → 云希，语速 +0% → +20%」，它才知道自己现在是什么声音。

不想让它自作主张：配置 → 高级 → 关掉 **允许模型自己调嗓音**（`allowSelfTuning`）。
关掉后 `speech_tune` 压根不出现在工具表里，模型看不到也就不会反复尝试；查看和停止仍然保留。

### 环境提示词（模型怎么知道自己能干什么）

光有工具声明不够——模型还需要一段环境说明，才知道「现在是什么声音」「这些设置意味着什么」
「什么时候该动手、什么时候该问」。所以包里有 `src/ENV_PROMPT.md`，作为本 World 的
`envPrompt` 模板随每次前缀重建发给模型，里面的值都是实时的：

```
现在的设置：晓晓（zh-CN-XiaoxiaoNeural），语速 +0%，音调 +0Hz，音量 +0%。
念什么：台词开、问句开、选项开。
切块与节奏：短句并下一句的门槛 8 字，单块上限 60 字，块间停顿 0ms。
预热开、详细日志关、总开关开。
```

占位符一共 7 个（`{{ streamvoice.state }}`、`.content`、`.chunks`、`.switches`、`.canTune`、
`.voices`、`.otherReaders`），由 `envPromptVars()` 提供，改完配置下一次重建就是新的。

**可以直接改**：控制台 → 提示词页 → 「环境提示词」，编辑后保存到
`<部署目录>/worlds/streamvoice/ENV_PROMPT.md`，框架优先读这份覆盖文件，清空即回落到包内默认。
想让它更话痨或更寡言、想加自己的语气要求（比如「别老问我要不要换音色」），改这里就行，
不用碰代码。注意占位符要原样留着，删掉它们模型就看不到当前设置了。

自测：`scripts/check-tools.ts` 验参数翻译（口语名、档位对齐、非法值），
`scripts/check-world-tools.ts` 真的 `new` 一个 World 出来调那三个工具，并检查
`ENV_PROMPT.md` 里每个占位符都有值、渲染后没有残留 `{{ }}`。

## 配置（都在控制台「流式语音播报 → 配置」页，改完下一句生效，不用重启）

### 嗓音

| 键 | 默认 | 说明 |
|---|---|---|
| `voice` | `zh-CN-XiaoxiaoNeural` | Edge TTS 音色 ShortName，下拉 29 个（中/粤/台/英/日/韩），都已实测能出声 |
| `rate` | `+0%` | 相对语速，5% 一档，-50%…+50%（21 档） |
| `pitch` | `+0Hz` | 音调，5Hz 一档，-50Hz…+50Hz（21 档）；负数更低沉，正数更明亮 |
| `volume` | `+0%` | 相对音量，5% 一档，-50%…+50%（21 档） |

### 念什么

| 键 | 默认 | 说明 |
|---|---|---|
| `readSay` | `true` | 念 `pet_say` 的台词 |
| `readAsk` | `true` | 念 `pet_ask` 的问题 |
| `readOptions` | `true` | 问句把可选的答案也念出来 |

### 切块与节奏

| 键 | 默认 | 说明 |
|---|---|---|
| `chunkMinChars` | `8` | 短于这么多字的一句并到下一句；调小第一声更快 |
| `chunkMaxChars` | `60` | 一块最多这么多字，超过在逗号处再切 |
| `gapMs` | `0` | 一块说完后额外停多久（0–3000ms），嫌说得太赶可以加几十毫秒 |

### 高级

| 键 | 默认 | 说明 |
|---|---|---|
| `prewarm` | `true` | 模型开始写时先空合成一声预热连接；关掉省一次请求，但第一句会慢 2 秒左右 |
| `verbose` | `false` | 把每一块的合成耗时都写进日志；关掉只留第一块那行 |
| `allowSelfTuning` | `true` | 允许模型用 `speech_tune` 自己改嗓音；关掉后该工具不再出现在工具表里 |

### 挂载开关

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 框架的挂载开关。关掉 = 本扩展完全不工作 |

## 关掉退回原样

```json
"worlds": { "streamvoice": { "enabled": false } }
```

World 不挂载，接收器也就不存在，框架不再把增量扇过来；原来负责朗读的扩展照旧走它自己的路径
（整段台词写完 → 事件库 → 轮询 → 整段合成播放）。

## 面板

控制台「流式语音播报」页签（`dist/webui.js`，手写 ESM，无依赖）有两张卡：

- **运行状态**：待命 / 在说 / 已关、当前嗓音、切块与停顿、第一块出声耗时、本轮块数 / 排队 / 已说 / 失败、
  本轮总耗时，以及「立即静音」；
- **试听音色**：见上文。

顶部两盏灯：流式朗读（待命/正在说/出错）、嗓音（当前用的是哪个）；只有真的还有别人在朗读时，
才多出第三盏「另一处也在朗读」。

> 面板产物是按包版本寻址的（`/assets/extensions/<包>/<版本>/webui.js`），改了 `dist/webui.js`
> 记得同时升 `package.json` 的 `version` 并重启 Core，否则浏览器会拿旧的那份。

## 自测

```bash
TSX="node E:/software/coopanion/resources/app/node_modules/tsx/dist/cli.mjs"

# 切块/参数流/标记清理的单元自测（不出声）
$TSX scripts/check-chunker.ts

# 合成与连播的时序（会真的出声）
$TSX scripts/check-speaker.ts

# 把整张音色表逐个合成一遍，列出哪个不可用（会依次出声）
$TSX scripts/check-voices.ts

# 让 Coo 真的回一段（Coopanion 正在运行时；没设控制台密码时不用登录）
$TSX scripts/send-chat.ts "用一段话说说今天适合做什么"
```

实测看 `data/logs/core.log` 里 `worlds.streamvoice` 的行：`切出第 1 块（… 开写后 Xms）`、
`第 1 块出声（切出后 Yms…）`；试听会留一行 `试听 <音色> <语速> <音调> <音量>：可用/失败`。
第一块出声的时刻早于 `pet_say 写完`，就是提前出声。

## 依赖与授权

- 运行期只依赖一个 `ws`（`src/edge-tts/` 用它连 Edge TTS 的 WebSocket 接口），其余全是 Node 内置模块；
  合成出来的 mp3 走 Windows 的 winmm MCI（常驻 PowerShell）或 macOS 的 `afplay` 播放。
- `src/edge-tts/` 是 msedge-tts v2.1.0 的客户端源码拷贝，MIT，版权 Migushthe2nd：
  上游带 `preinstall: only-allow pnpm`，pnpm 装不上，所以自带一份。**这是代码来源，不是运行期依赖。**
- `scripts/` 下几个自测脚本历史上用 tsx 直接跑 `.ts`；`pnpm check` / `check:speaker` / `check:voices`
  已经把它们包好了，不装 tsx 也可以照下面「自测」里的绝对路径方式跑。
- 扩展本体 AGPL-3.0-or-later。
