# 盯盯窗口 · Watch Window

[中文](#中文) · [English](#english)

把桌面上的一个窗口当成视频流给 Coo 看。
Lets Coo watch one desktop window as a video stream.

## 中文

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 World(id `watch-window`)。选中一个窗口后,窗口画面按时间拼成分镜图,定时送进主会话,说不说话由 Coo 自己定。适合让 Coo 陪你看视频、看你打游戏。支持 Windows、macOS 与 Linux 的 X11 会话。

### 功能

- 在 World 页签里点选要盯的窗口,或者按「3 秒后盯前台窗口」后切到那个窗口。
- Coo 也能自己列出能看的窗口(标题、程序、大小、哪个在前台),按编号、标题或程序名选一个,换窗口或停下(`watch_window_pick`、`watch_window_stop`)。
- 盯着的时候,每隔一段时间把这段画面挑几格拼成一张分镜图(1 到 9 格,标出画面切换与黑场,窗口标题变了也写上)送给 Coo;画面一直没变就不送。
- Coo 看不清时可以取一张窗口当前的大图,也可以只放大一块区域(`watch_window_look`)。
- 选中窗口时,窗口边缘闪一圈白光,告诉你盯的是哪个。这圈光不会进到观察帧里。
- 界面上选窗口或停止,窗口关掉、最小化、恢复或抓不到画面,Coo 都会收到通知。

### 安装

在 Cortico 或 Coopanion 的扩展页搜 `cortico-world-watch-window` 安装,重启后在 World 总览里启用「盯盯窗口」。

命令行装法:

```bash
cd <Cortico>/extensions
corepack pnpm add cortico-world-watch-window
corepack pnpm approve-builds koffi
```

依赖 `koffi` 带原生模块,扩展页安装时会自动批准它的构建;命令行安装后要手动跑上面的 `approve-builds`。

各平台要注意的:

- **Windows**:装好就能用。
- **macOS**:要「屏幕录制」权限。在「系统设置 → 隐私与安全性 → 录屏与系统录音」里允许运行 Cortico 的应用(Coopanion 或终端),再重启它。没给权限时列不出窗口标题,World 页签和工具回执会提示。
- **Linux**:只支持 X11(Xorg)会话,要用到系统的 `libX11` 与 `libXext`。Wayland 会话看不到别的程序的窗口,启用时会提示改用 X11 会话登录。

### 使用

1. 主模型要能看图。当前主模型不收图片时,观察帧暂停,World 页签的「看图」灯变红;换成能识图的模型后自动继续。
2. 打开 World 页签的「盯着的窗口」面板,在列表里对要盯的窗口点「选择」。列表里标出了「前台」和「已最小化」的窗口,「刷新」重新列一遍。
3. 要盯的窗口不好在列表里找时,点「3 秒后盯前台窗口」,3 秒内切到那个窗口。
4. 之后 Coo 每隔约 20 秒收到一张观察帧,想说就说。面板上显示正在盯的窗口和「最近一张观察帧」。
5. 点「停止」不再盯。也可以直接让 Coo 换一个窗口或者停下。

### 配置

常用项在 World 页签的配置里,也可以写在部署 `config.json` 的 `worlds.watch-window`。

| 键 | 默认 | 说明 |
|---|---|---|
| `observe.minIntervalSec` | 20 | 两张观察帧之间最短的间隔(秒);越短越费 token |
| `observe.frameDensity` | 0.3 | 每秒取几帧进拼图,格数 = 间隔 × 密度 |
| `observe.maxFrames` | 9 | 格数上限 |
| `observe.captureFps` | 1 | 每秒抓几帧进候选池,改后重新选窗口生效 |
| `observe.cellWidth` / `cellHeight` | 512 / 288 | 单格大小 |
| `observe.skipStill` | true | 画面不动就不送 |
| `look.maxWidth` / `maxHeight` | 1600 / 1200 | 大图的上限 |
| `flash` | true | 选中时闪边 |

其余见 [`src/config.ts`](https://github.com/Phantivia/cortico-world-watch-window/blob/main/src/config.ts)。挑帧、各平台怎么抓图、闪边怎么画,见 [docs/internals.md](https://github.com/Phantivia/cortico-world-watch-window/blob/main/docs/internals.md)。

### 限制与常见问题

- 每张观察帧都让主会话跑一轮,间隔越短越费 token。
- 观察帧会把窗口画面发给你配置的模型服务。盯着聊天、邮件这类窗口前想清楚。
- 观察帧是抽出来的几格,不是连续的视频,最新一格也比此刻早几秒。
- 最小化的窗口没有画面,恢复后继续。
- Windows 上被别的窗口挡住也能抓。少数全屏游戏抓出来是黑的,这时只在它位于前台时能抓;独占全屏的游戏切到后台后抓不到,改成无边框窗口可以。
- Linux 上没开合成器时,只能抓到窗口在屏幕上露出来的部分,闪边也改成一圈细白条。
- macOS 版本还没有在真机上验过。

## English

A World for [Cortico](https://github.com/Pal-AI-Lab/Cortico) (id `watch-window`). Once a window is picked, its frames are laid out as a timed grid and sent to the main conversation at intervals, and Coo decides whether to say anything. Use it to have Coo watch a video or your game with you. Works on Windows, macOS and Linux X11 sessions.

### Features

- Pick the window in the World tab, or click "Watch the front window in 3 s" and switch to it.
- Coo can also list the windows it can watch (title, app, size, which is in front), pick one by number, title or app name, switch, or stop (`watch_window_pick`, `watch_window_stop`).
- While watching, a few frames from each stretch are laid out as a grid of 1 to 9 cells (cuts and black frames noted, title changes too) and sent to Coo. A stretch where nothing changed is skipped.
- When Coo needs a closer look, it can take a large image of the window now, or zoom into one region (`watch_window_look`).
- The window's edge flashes white when it is picked, so you can see which one Coo is watching. The glow never shows up in the observations.
- Coo is told when a window is picked or stopped from the WebUI, and when the window is closed, minimized, restored or gives no picture.

### Install

Search for `cortico-world-watch-window` on the Extensions page of Cortico or Coopanion, install it, restart, and enable "Watch Window" in the World overview.

From the command line:

```bash
cd <Cortico>/extensions
corepack pnpm add cortico-world-watch-window
corepack pnpm approve-builds koffi
```

The `koffi` dependency has a native module. The Extensions page approves its build automatically; after a command-line install, run the `approve-builds` line above.

Per platform:

- **Windows:** works right after install.
- **macOS:** needs the Screen Recording permission. Allow the app that runs Cortico (Coopanion or the terminal) under System Settings → Privacy & Security → Screen & System Audio Recording, then restart it. Without it, window titles cannot be listed, and the World tab and tool results say so.
- **Linux:** X11 (Xorg) sessions only, using the system's `libX11` and `libXext`. A Wayland session cannot see other applications' windows; enabling the World there tells you to log in with an X11 session.

### Usage

1. The main model must accept images. If it does not, observations pause and the "Images" lamp in the World tab turns red; they resume once a model that reads images is selected.
2. Open the "Watched window" panel in the World tab and click "Pick" next to the window. The list marks the "front" and "minimized" windows; "Refresh" lists them again.
3. If the window is hard to find in the list, click "Watch the front window in 3 s" and switch to it within 3 seconds.
4. Coo then gets an observation about every 20 seconds and speaks when it has something to say. The panel shows the watched window and the "Latest observation".
5. Click "Stop" to stop watching. You can also ask Coo to switch windows or stop.

### Configuration

Common keys are in the World tab's settings, or under `worlds.watch-window` in the deployment's `config.json`.

| Key | Default | Meaning |
|---|---|---|
| `observe.minIntervalSec` | 20 | Shortest gap between two observations, in seconds; shorter uses more tokens |
| `observe.frameDensity` | 0.3 | Frames per second that go into a grid; cells = interval × density |
| `observe.maxFrames` | 9 | Most cells in a grid |
| `observe.captureFps` | 1 | Frames captured per second into the pool; takes effect when a window is picked again |
| `observe.cellWidth` / `cellHeight` | 512 / 288 | Cell size |
| `observe.skipStill` | true | Skip observations when nothing changed |
| `look.maxWidth` / `maxHeight` | 1600 / 1200 | Largest size of a close-up image |
| `flash` | true | Flash the edge when a window is picked |

The rest is in [`src/config.ts`](https://github.com/Phantivia/cortico-world-watch-window/blob/main/src/config.ts). How frames are chosen, how each platform captures windows and how the glow is drawn are in [docs/internals.md](https://github.com/Phantivia/cortico-world-watch-window/blob/main/docs/internals.md) (Chinese).

### Limits and FAQ

- Every observation runs a round of the main conversation, so a shorter interval uses more tokens.
- Observations send the window's picture to your configured model endpoint. Think before watching chat or mail windows.
- An observation is a few sampled frames, not continuous video, and its newest frame is a few seconds old.
- A minimized window has no picture; watching resumes when it is restored.
- On Windows a covered window can still be captured. A few full-screen games come out black; those are captured only while in front. An exclusive full-screen game cannot be captured in the background; switch it to borderless windowed.
- On Linux without a compositing manager, only the part of the window visible on screen can be captured, and the glow becomes a thin white band.
- The macOS build has not been tested on a real Mac yet.

## 开发 · Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:webui
```

## 许可 · License

MIT
