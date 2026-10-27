/** Tool declarations; `WatchWindowWorld.tools()` binds the handlers. */
import type { ToolDef } from 'cortico/core/types.ts';

type Decl = Omit<ToolDef, 'handler'>;

export const WATCH_WINDOW_TOOL_DECLS: readonly Decl[] = [
  {
    name: 'watch_window_pick',
    tags: ['act', 'read'],
    description: '选一个桌面窗口来盯着看。不带 target 列出现在能看的窗口(编号、标题、程序、大小、哪个在前台);带 target 就开始盯那个窗口,之后每隔一段时间收到一张观察帧。换窗口直接再选一个。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '上一次列表里的编号(如 "2"),或窗口标题、程序名里的一段文字;"front" 表示现在在前台的窗口' },
      },
      required: [],
    },
  },
  {
    name: 'watch_window_stop',
    tags: ['act'],
    description: '不再盯窗口,观察帧停止。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'watch_window_look',
    tags: ['read', 'snapshot'],
    description: '看清盯着的窗口现在的样子:取一张大图(默认整个窗口,可给区域放大)。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1, description: '区域左上角横坐标,0–1 的比例' },
        y: { type: 'number', minimum: 0, maximum: 1, description: '区域左上角纵坐标,0–1 的比例' },
        width: { type: 'number', minimum: 0.05, maximum: 1, description: '区域宽,0–1 的比例' },
        height: { type: 'number', minimum: 0.05, maximum: 1, description: '区域高,0–1 的比例' },
      },
      required: [],
    },
  },
];
