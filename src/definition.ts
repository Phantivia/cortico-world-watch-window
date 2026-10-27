import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WATCH_WINDOW_DEFAULTS, WATCH_WINDOW_ID, type WatchWindowConfigSection } from './config.ts';
import { WATCH_WINDOW_TOOL_DECLS } from './tools.ts';
import { WatchWindowWorld } from './world.ts';

export const WATCH_WINDOW: WorldDefinition<WatchWindowConfigSection> = {
  id: WATCH_WINDOW_ID,
  label: '盯盯窗口',
  defaults: () => structuredClone(WATCH_WINDOW_DEFAULTS),
  preflight: () => {
    if (process.platform === 'linux') {
      if (process.env.XDG_SESSION_TYPE === 'wayland') throw new Error('盯盯窗口在 Linux 上只支持 X11 会话:Wayland 下看不到别的程序的窗口。登录时选 X11(Xorg)会话再启用。');
      if (!process.env.DISPLAY) throw new Error('盯盯窗口在 Linux 上要连 X11 显示服务,没有找到 DISPLAY。');
      return;
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('盯盯窗口只支持 Windows、macOS 和 Linux(X11)。');
  },
  // ctx.cfg is the live `worlds.watch-window` section: every key is read at use
  create: (ctx) => new WatchWindowWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(WATCH_WINDOW_TOOL_DECLS, {
      watch_window_pick: { zh: '列出能看的窗口,或选一个开始盯着看。', en: 'Lists the windows that can be watched, or picks one to watch.' },
      watch_window_stop: { zh: '不再盯窗口。', en: 'Stops watching the window.' },
      watch_window_look: { zh: '取盯着的窗口现在的一张大图,可放大局部。', en: 'Takes a large image of the watched window now, optionally zoomed into a region.' },
    }),
    events: [
      {
        type: 'watch-window.scene',
        description: {
          zh: '盯着窗口时定时送来的一张观察帧:这段时间窗口画面的分镜拼图,以及检测到的画面切换。',
          en: 'A periodic observation while a window is watched: a grid of frames from the last stretch, with the detected cuts.',
        },
        trigger: 'debounce',
      },
      {
        type: 'watch-window.state',
        description: {
          zh: '盯看状态变了:界面上选了或停了窗口,窗口关掉、最小化、恢复或抓不到画面。',
          en: 'The watch changed: a window was picked or stopped from the WebUI, or the window was closed, minimized, restored or gave no picture.',
        },
        trigger: 'flush',
      },
    ],
  },
};
