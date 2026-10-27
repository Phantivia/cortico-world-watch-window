/**
 * Engine child process: owns every call into the operating system, so a native fault takes down
 * this process and not the bot's, and does the pixel work (resize, JPEG, montage) off the main
 * thread. Lives as long as a window is watched. Imports no `cortico/*`.
 */
import type { ChildToMain, EngineRequest, MainToChild, SampleResult } from './engine-ipc.ts';
import { decodeJpeg, encodeJpeg, montage } from './engine/image.ts';

type Os = typeof import('./engine/win32.ts') & { permitted?: () => boolean; requestPermission?: () => boolean };
const os: Os = process.platform === 'darwin' ? await import('./engine/darwin.ts') as unknown as Os : await import('./engine/win32.ts');

async function handle(req: EngineRequest): Promise<unknown> {
  switch (req.op) {
    case 'windows': {
      if (os.requestPermission && !os.requestPermission()) return { windows: os.windows(), permission: false };
      return { windows: os.windows(), permission: true };
    }
    case 'foreground': return os.foreground();
    case 'info': return os.info(req.handle);
    case 'sample': {
      const g = await os.grab(req.handle, req.maxWidth, req.maxHeight, req.region);
      if (!g.ok) return g satisfies SampleResult;
      return { ok: true, sample: { jpeg: encodeJpeg(g.rgba, g.width, g.height, req.quality), width: g.width, height: g.height, gray: g.gray } } satisfies SampleResult;
    }
    case 'montage': {
      const cells = req.jpegs.map((j) => decodeJpeg(j));
      const m = montage(cells, req.cols, req.rows, req.cellWidth, req.cellHeight);
      return { jpeg: encodeJpeg(m.rgba, m.width, m.height, req.quality), width: m.width, height: m.height };
    }
    case 'flash': await os.flash(req.handle); return null;
  }
}

process.on('message', (msg: MainToChild) => {
  handle(msg.req).then(
    (value) => process.send?.({ id: msg.id, ok: true, value } satisfies ChildToMain),
    (err: unknown) => process.send?.({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ChildToMain),
  );
});
process.on('disconnect', () => process.exit(0));
