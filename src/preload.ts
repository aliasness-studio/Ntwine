// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DragIcon, ImportProgress, NtwineApi, QueryFilters } from './shared/ipcTypes';

// THE typed IPC bridge (Task 11 — grown from the Task 2 spike's bare `startDrag`; Task 6 grows it
// again, 12 -> 23 methods, design spec §4; the Splice-DB picker fallback, 23 -> 24). Every method but two is a plain
// `ipcMain.handle`/`ipcRenderer.invoke` round-trip on the `ntwine:<method>` channel ipc.ts (or,
// for `startDrag`, drag.ts) registers. The two exceptions:
//  - `onImportProgress` wraps `ipcRenderer.on` for the 'ntwine:import-progress' broadcast
//    (ipc.ts's `sendProgress` -> `webContents.send`) rather than invoke/handle, since main
//    pushes multiple events over the lifetime of one import, not a single request/response.
//  - `sampleUrl`/`coverUrl` are pure template-string helpers with no IPC round-trip at all — the
//    renderer already knows the URL shape (`sample://s/<id>`, `cover://p/<id>`); asking main
//    would just be a wasted hop for a string it can build here.
// `startDrag` used to be a third exception (a fire-and-forget `ipcRenderer.send`) until Task 6
// promoted it to `invoke` on the SAME `ntwine:drag-start` channel — drag.ts's own doc comment has
// the full rationale (the invoke's resolution is now the drag-end signal).
const api: NtwineApi = {
  getState: () => ipcRenderer.invoke('ntwine:getState'),

  runImport: () => ipcRenderer.invoke('ntwine:runImport'),

  onImportProgress: (cb) => {
    const listener = (_event: IpcRendererEvent, p: ImportProgress) => cb(p);
    ipcRenderer.on('ntwine:import-progress', listener);
    return () => ipcRenderer.removeListener('ntwine:import-progress', listener);
  },

  pickLibraryRoot: () => ipcRenderer.invoke('ntwine:pickLibraryRoot'),

  pickSpliceDb: () => ipcRenderer.invoke('ntwine:pickSpliceDb'),

  listPacks: () => ipcRenderer.invoke('ntwine:listPacks'),

  listTags: () => ipcRenderer.invoke('ntwine:listTags'),

  querySamples: (f: QueryFilters) => ipcRenderer.invoke('ntwine:querySamples', f),

  getPeaks: (sampleIds: number[]) => ipcRenderer.invoke('ntwine:getPeaks', sampleIds),

  decodePreviewPcm: (sampleId: number) => ipcRenderer.invoke('ntwine:decodePreviewPcm', sampleId),

  startDrag: (sampleId: number, icon?: DragIcon | null) =>
    ipcRenderer.invoke('ntwine:drag-start', sampleId, icon ?? null),

  sampleUrl: (sampleId: number) => `sample://s/${sampleId}`,

  coverUrl: (packId: number) => `cover://p/${packId}`,

  // User layer (Task 6, design spec §4) — 11 new invokes, bridge 12 -> 23.
  setFavorite: (sampleId: number, on: boolean) => ipcRenderer.invoke('ntwine:setFavorite', sampleId, on),

  setNickname: (sampleId: number, nickname: string | null) =>
    ipcRenderer.invoke('ntwine:setNickname', sampleId, nickname),

  listUserTags: () => ipcRenderer.invoke('ntwine:listUserTags'),

  addUserTag: (sampleId: number, name: string) => ipcRenderer.invoke('ntwine:addUserTag', sampleId, name),

  removeUserTag: (sampleId: number, name: string) => ipcRenderer.invoke('ntwine:removeUserTag', sampleId, name),

  listLibraryRail: () => ipcRenderer.invoke('ntwine:listLibraryRail'),

  createCollection: (name: string) => ipcRenderer.invoke('ntwine:createCollection', name),

  renameCollection: (id: string, name: string) => ipcRenderer.invoke('ntwine:renameCollection', id, name),

  deleteCollection: (id: string) => ipcRenderer.invoke('ntwine:deleteCollection', id),

  addToCollection: (collectionId: string, sampleId: number) =>
    ipcRenderer.invoke('ntwine:addToCollection', collectionId, sampleId),

  removeFromCollection: (collectionId: string, sampleId: number) =>
    ipcRenderer.invoke('ntwine:removeFromCollection', collectionId, sampleId),
};

// E2E flag (e2e spec §3.1): main appends `--ntwine-e2e` to webPreferences.additionalArguments
// only when armed; a sandboxed preload sees it in process.argv. The production `ntwine` bridge
// is untouched — this is a second, boolean-only exposure.
if (process.argv.includes('--ntwine-e2e')) {
  contextBridge.exposeInMainWorld('ntwineE2E', true);
}

contextBridge.exposeInMainWorld('ntwine', api);
