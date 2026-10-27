# cortico-world-watch-window

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 World(id `watch-window`,市场名「盯盯窗口」):把桌面上的一个窗口当成视频流给 Coo 看。

选中一个窗口后,窗口画面按固定帧率抽进候选池;每隔一段时间,从这段时间的帧里挑几格拼成一张分镜图,作为观察帧送进主会话,说不说话由 Coo 自己定。选中窗口的那一刻,窗口边缘闪一圈白光。

支持 Windows、macOS 与 Linux 的 X11 会话。

## 选窗口

- **World 页签**:列出现在能看的窗口(标题、程序、大小,标出前台与最小化的),点「选择」开始盯;「3 秒后盯前台窗口」按下后切到要盯的窗口,3 秒后盯住当时在前台的那个。「停止」不再盯。
- **Coo 自己选**:`watch_window_pick` 不带参数列出窗口,带编号、标题或程序名里的一段文字就开始盯,`front` 是前台窗口。

界面上选和停会投一条 `watch-window.state` 事件告诉 Coo;Coo 自己选的在工具回执里。

## 观察帧

盯着窗口时,每隔 `observe.minIntervalSec`(默认 20 秒)投一条 `watch-window.scene`,在投递那一刻生成(`pushDeferred`),上一轮模型跑得久,这一张就覆盖更长的一段:

1. 以 `observe.captureFps`(默认 1)抓窗口画面进候选池,每帧一张单格 JPEG 和 64×36 亮度图。
2. 格数 = 间隔 × `frameDensity`(默认 0.3),封顶 `maxFrames`;采样点从最新帧往回按公比 `ratio` 等比排布,吸附到画面切换,dHash 相近的帧只留一张。剩几帧用几格(1×1、2×1、2×2、3×2、3×3),行优先按时间排。
3. 正文写窗口、时间段、每格的时刻、检测到的画面切换与黑场;窗口标题变了也写上。

挑帧的做法取自 [cortico-world-bilibili-video](https://www.npmjs.com/package/cortico-world-bilibili-video)。

- `observe.skipStill` 开着(默认)时,这段时间画面一直没变就不送这一张。
- 当前主模型不收图片(`modelFacts.accepts('image/jpeg')` 为假)时不送观察帧,World 页签的「看图」灯变红;换成能识图的模型后自动继续。
- 每张观察帧都让主会话跑一轮,间隔越短越费 token。

`watch_window_look` 取盯着的窗口现在的一张大图(默认最长边 1600),可以给 0–1 的区域放大局部。

## 抓图

抓图在一个常驻子进程里做(经 [koffi](https://koffi.dev) 调系统接口),一直开到 World 停用。

- **Windows**:窗口客户区经 `PrintWindow(PW_RENDERFULLCONTENT)` 读取,被别的窗口挡住也能读。少数全屏游戏这样读出来是一片黑,这时在它位于前台时改从屏幕上读;独占全屏的游戏切到后台后抓不到,改成无边框窗口可以。最小化的窗口没有画面,恢复后继续。
- **macOS**:用系统的 `screencapture -l <窗口号>` 读单个窗口。要「屏幕录制」权限:在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许运行 Cortico 的应用(Coopanion 或终端),再重启它。没给权限时列不出窗口标题,World 页签和工具回执会说明。
- **Linux(X11)**:窗口列表取窗口管理器的 `_NET_CLIENT_LIST_STACKING`,画面用 `XGetImage` 读窗口本身。开着合成器(大多数桌面默认开)时被挡住也能读;没有合成器时只能读到屏幕上露出来的部分。Wayland 会话看不到别的程序的窗口,启用时会提示改用 X11(Xorg)会话登录。

## 闪边

选中窗口时,沿窗口边缘往里画一圈白色渐变光,两下闪烁,约 1.5 秒。这个窗口透明、鼠标穿透、置顶,并排除在截图之外(Windows 用 `WDA_EXCLUDEFROMCAPTURE`,macOS 用 `NSWindowSharingNone`),不会出现在观察帧里。X11 没有排除截图的办法,闪光期间暂停抓帧;没有合成器时 X11 画不了半透明,改成沿边缘闪一圈细白条。`flash` 设为 false 关掉。

## 配置

部署 `config.json` 的 `worlds.watch-window`,常用项也在 World 页签的配置里:

| 键 | 默认 | 说明 |
|---|---|---|
| `observe.minIntervalSec` | 20 | 两张观察帧之间最短的间隔(秒) |
| `observe.frameDensity` | 0.3 | 每秒取几帧进拼图 |
| `observe.maxFrames` | 9 | 格数上限 |
| `observe.captureFps` | 1 | 每秒抓几帧进候选池,改后重新选窗口生效 |
| `observe.cellWidth` / `cellHeight` | 512 / 288 | 单格大小 |
| `observe.skipStill` | true | 画面不动就不送 |
| `look.maxWidth` / `maxHeight` | 1600 / 1200 | 大图的上限 |
| `flash` | true | 选中时闪边 |

`observe.ratio`、`dedupeHamming`、`cutThreshold`、`blackLuma`、`jpegQuality` 与 bilibili-video 同义。

## 安装

在 Cortico 或 Coopanion 的扩展页搜 `cortico-world-watch-window` 安装,重启后在 World 总览里启用。命令行:

```bash
cd extensions
corepack pnpm add cortico-world-watch-window
```

依赖 `koffi` 带原生模块,扩展页安装时自动批准它的构建;命令行安装后用 `corepack pnpm approve-builds koffi`。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

## 许可

MIT
