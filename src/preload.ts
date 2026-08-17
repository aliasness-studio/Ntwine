// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ImportProgress, NtwineApi, QueryFilters } from './shared/ipcTypes';

// THE typed IPC bridge (Task 11 — grown from the Task 2 spike's bare `startDrag`). Every method
// but three is a plain `ipcMain.handle`/`ipcRenderer.invoke` round-trip on the `ntwine:<method>`
// channel ipc.ts registers. The three exceptions:
//  - `startDrag` stays on the pre-existing `ntwine:drag-start` `ipcRenderer.send` (fire-and-forget,
//    not invoke) — drag.ts's `ipcMain.on` channel, unchanged since Task 2.
//  - `onImportProgress` wraps `ipcRenderer.on` for the 'ntwine:import-progress' broadcast
//    (ipc.ts's `sendProgress` -> `webContents.send`) rather than invoke/handle, since main
//    pushes multiple events over the lifetime of one import, not a single request/response.
//  - `sampleUrl`/`coverUrl` are pure template-string helpers with no IPC round-trip at all — the
//    renderer already knows the URL shape (`sample://s/<id>`, `cover://p/<id>`); asking main
//    would just be a wasted hop for a string it can build here.
const api: NtwineApi = {
  getState: () => ipcRenderer.invoke('ntwine:getState'),

  runImport: () => ipcRenderer.invoke('ntwine:runImport'),

  onImportProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, p: ImportProgress) => cb(p);
    ipcRenderer.on('ntwine:import-progress', listener);
    return () => ipcRenderer.removeListener('ntwine:import-progress', listener);
  },

  pickLibraryRoot: () => ipcRenderer.invoke('ntwine:pickLibraryRoot'),

  listPacks: () => ipcRenderer.invoke('ntwine:listPacks'),

  listTags: () => ipcRenderer.invoke('ntwine:listTags'),

  querySamples: (f: QueryFilters) => ipcRenderer.invoke('ntwine:querySamples', f),

  getPeaks: (sampleIds: number[]) => ipcRenderer.invoke('ntwine:getPeaks', sampleIds),

  decodePreviewPcm: (sampleId: number) => ipcRenderer.invoke('ntwine:decodePreviewPcm', sampleId),

  startDrag: (sampleId: number) => ipcRenderer.send('ntwine:drag-start', sampleId),

  sampleUrl: (sampleId: number) => `sample://s/${sampleId}`,

  coverUrl: (packId: number) => `cover://p/${packId}`,
};

contextBridge.exposeInMainWorld('ntwine', api);
