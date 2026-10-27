/** Config section `worlds.watch-window`, defaults and the WebUI config group. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';
import { uiText } from './strings.ts';

export const WATCH_WINDOW_ID = 'watch-window';

export interface WatchWindowConfigSection extends WorldSection {
  observe: {
    /** Shortest gap between two observations; a longer model round stretches it. */
    minIntervalSec: number;
    /** Frames per second of the span an observation covers; the grid grows with the gap. */
    frameDensity: number;
    /** Grid cap, 1–9. */
    maxFrames: number;
    cellWidth: number;
    cellHeight: number;
    /** Frames taken from the window per second, the pool an observation picks from. */
    captureFps: number;
    /** Geometric ratio of sampling positions measured back from the newest frame. */
    ratio: number;
    /** dHash Hamming distance under which two frames count as the same picture. */
    dedupeHamming: number;
    /** Jump in mean luma difference (0–255) between successive samples that counts as a cut. */
    cutThreshold: number;
    /** Mean luma (0–255) under which a sample counts as black. */
    blackLuma: number;
    /** JPEG quality 0–1 of frames and grids. */
    jpegQuality: number;
    /** No observation when every frame since the last one is the same picture as its newest frame. */
    skipStill: boolean;
  };
  look: {
    maxWidth: number;
    maxHeight: number;
  };
  /** The white glow around a window when it is picked. */
  flash: boolean;
}

export const WATCH_WINDOW_DEFAULTS: WatchWindowConfigSection = {
  enabled: false,
  observe: {
    minIntervalSec: 20,
    frameDensity: 0.3,
    maxFrames: 9,
    cellWidth: 512,
    cellHeight: 288,
    captureFps: 1,
    ratio: 0.618,
    dedupeHamming: 6,
    cutThreshold: 40,
    blackLuma: 16,
    jpegQuality: 0.8,
    skipStill: true,
  },
  look: { maxWidth: 1600, maxHeight: 1200 },
  flash: true,
};

const K = `worlds.${WATCH_WINDOW_ID}`;

export function watchWindowConfigGroup(language?: string): ConfigGroup {
  const t = uiText(language);
  return {
    id: `world:${WATCH_WINDOW_ID}`,
    owner: `world:${WATCH_WINDOW_ID}`,
    schema: {
      type: 'object',
      title: t.label,
      properties: {
        [`${K}.observe.minIntervalSec`]: { type: 'number', title: t.cfgInterval, minimum: 5, maximum: 600, 'x-suffix': 's', description: t.cfgIntervalDesc, 'x-hot': true },
        [`${K}.observe.frameDensity`]: { type: 'number', title: t.cfgDensity, minimum: 0.05, maximum: 2, 'x-suffix': 'fps', description: t.cfgDensityDesc, 'x-hot': true },
        [`${K}.observe.maxFrames`]: { type: 'integer', title: t.cfgMaxFrames, minimum: 1, maximum: 9, 'x-hot': true },
        [`${K}.observe.captureFps`]: { type: 'number', title: t.cfgFps, minimum: 0.2, maximum: 4, 'x-suffix': 'fps', description: t.cfgFpsDesc },
        [`${K}.observe.cellWidth`]: { type: 'integer', title: t.cfgCellWidth, minimum: 160, maximum: 1920, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.observe.cellHeight`]: { type: 'integer', title: t.cfgCellHeight, minimum: 90, maximum: 1080, 'x-suffix': 'px', 'x-hot': true },
        [`${K}.observe.skipStill`]: { type: 'boolean', title: t.cfgSkipStill, description: t.cfgSkipStillDesc, 'x-hot': true },
        [`${K}.flash`]: { type: 'boolean', title: t.cfgFlash, description: t.cfgFlashDesc, 'x-hot': true },
      },
    },
  };
}
