/** Messages between WatchWindowWorld and the engine child process (fork IPC, advanced serialization). */

/** Desktop coordinates of the platform: physical pixels on Windows, points on macOS. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A top-level window that can be watched. `handle` is opaque and stays valid while the window lives. */
export interface WindowEntry {
  handle: string;
  title: string;
  /** Executable or app name. */
  app: string;
  rect: Rect;
  minimized: boolean;
  foreground: boolean;
}

/** Why a window gave no picture this time. */
export type Unavailable = 'gone' | 'minimized' | 'blank' | 'permission';

export interface Sample {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** 64×36 gray thumbnail, row-major, for cut detection and the difference hash. */
  gray: Uint8Array;
}

export type EngineRequest =
  | { op: 'windows' }
  | { op: 'foreground' }
  | { op: 'info'; handle: string }
  /** The window scaled to fit `maxWidth`×`maxHeight` (never enlarged), optionally cropped first to a 0–1 region. */
  | { op: 'sample'; handle: string; maxWidth: number; maxHeight: number; quality: number; region?: Rect }
  /** JPEG cells laid out row-major on a `cols`×`rows` grid of `cellWidth`×`cellHeight`. */
  | { op: 'montage'; jpegs: Uint8Array[]; cols: number; rows: number; cellWidth: number; cellHeight: number; quality: number }
  /** A white glow around the window's edge that fades in and out; resolves when it is gone. */
  | { op: 'flash'; handle: string };

export type SampleResult = { ok: true; sample: Sample } | { ok: false; reason: Unavailable; detail?: string };

export type MainToChild = { id: number; req: EngineRequest };
export type ChildToMain = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
