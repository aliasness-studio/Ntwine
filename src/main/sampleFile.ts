import { ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import type { E2EEmit } from './e2e';
import type { SampleFile } from './protocol';

export interface SampleFileDeps {
  /** main.ts points this at protocol.ts's `resolveSampleFile` over the live catalog + root. */
  resolve: (sampleId: number) => SampleFile | null;
  showItemInFolder: (path: string) => void;
  writeClipboardText: (text: string) => void;
  exists?: (path: string) => boolean;
  e2eEmit: E2EEmit | null;
}

/**
 * Wires `ntwine:revealSample` and `ntwine:copySamplePath` (the row menu's "Show in Finder" /
 * "Copy full path"). Both take a sample id, never a path: main resolves it from the catalog, so
 * the renderer can't point either action at an arbitrary file.
 *
 * Reveal needs a file that is actually on disk — the catalog's missing flag can lag a deletion
 * (drag.ts's `existsSync` has the same reasoning). Copy hands out the resolved path even for a
 * missing row: that is where the file should be, which is exactly what someone hunting for it
 * wants. Every refusal is a silent no-op.
 *
 * `e2eEmit`: when armed, reports the decision and returns without touching the shell or the
 * clipboard, so a test run never opens file-manager windows or overwrites the clipboard.
 */
export function registerSampleFileHandlers(deps: SampleFileDeps): void {
  const exists = deps.exists ?? existsSync;

  ipcMain.handle('ntwine:revealSample', async (_event, rawId: number) => {
    const sampleId = Number(rawId);
    const resolved = deps.resolve(sampleId);
    const file = resolved && !resolved.missing && exists(resolved.absPath) ? resolved.absPath : null;
    if (deps.e2eEmit) {
      deps.e2eEmit('ntwine:e2e:reveal', { sampleId, file });
      return;
    }
    if (file) deps.showItemInFolder(file);
  });

  ipcMain.handle('ntwine:copySamplePath', async (_event, rawId: number) => {
    const sampleId = Number(rawId);
    const path = deps.resolve(sampleId)?.absPath ?? null;
    if (deps.e2eEmit) {
      deps.e2eEmit('ntwine:e2e:copy-path', { sampleId, path });
      return;
    }
    if (path) deps.writeClipboardText(path);
  });
}
