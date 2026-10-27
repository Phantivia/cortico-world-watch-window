/** Package entry: the default export is the `WorldDefinition`. */
import { WATCH_WINDOW } from './definition.ts';

export default WATCH_WINDOW;

export { WATCH_WINDOW };
export { WATCH_WINDOW_DEFAULTS, WATCH_WINDOW_ID, watchWindowConfigGroup } from './config.ts';
export type { WatchWindowConfigSection } from './config.ts';
export { WatchWindowWorld, type WatchWindowWorldOptions } from './world.ts';
export { WATCH_WINDOW_TOOL_DECLS } from './tools.ts';
