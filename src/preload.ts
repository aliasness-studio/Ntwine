// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DragIcon, ImportProgress, NtwineApi, QueryFilters, UpdateState } from './shared/ipcTypes';

// THE typed IPC bridge. Every method but the exceptions below is a plain
// `ipcMain.handle`/`ipcRenderer.invoke` round-trip on the `ntwine:<method>` channel ipc.ts (or,
// for `startDrag`, drag.ts; for `revealSample`/`copySamplePath`, sampleFile.ts; for the update
// methods, updater.ts's `registerUpdaterIpc`) registers. The exceptions:
//  - `onImportProgress` wraps `ipcRenderer.on` for the 'ntwine:import-progress' broadcast
//    (ipc.ts's `sendProgress` -> `webContents.send`) rather than invoke/handle, since main
//    pushes multiple events over the lifetime of one import, not a single request/response.
//    `onUpdateState` is the same shape for the 'ntwine:update-state' broadcast (updater.ts's
//    `onState`, once per state transition).
//  - `platform` is a plain value — `process.platform`, which a sandboxed preload still has.
//  - `sampleUrl`/`coverUrl` are pure template-string helpers with no IPC round-trip at all — the
//    renderer already knows the URL shape (`sample://s/<id>`, `cover://p/<id>`); asking main
//    would just be a wasted hop for a string it can build here.
// `startDrag` is NOT an exception: it is an `invoke` on the `ntwine:drag-start` channel, not a
// fire-and-forget `ipcRenderer.send` — drag.ts's own doc comment has the full rationale (the
// invoke's resolution is the drag-end signal).
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

  platform: process.platform,

  revealSample: (sampleId: number) => ipcRenderer.invoke('ntwine:revealSample', sampleId),

  copySamplePath: (sampleId: number) => ipcRenderer.invoke('ntwine:copySamplePath', sampleId),

  // User layer — 11 invokes.
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

  // Self-update — 5 methods.
  getUpdateState: () => ipcRenderer.invoke('ntwine:getUpdateState'),

  onUpdateState: (cb) => {
    const listener = (_event: IpcRendererEvent, s: UpdateState) => cb(s);
    ipcRenderer.on('ntwine:update-state', listener);
    return () => ipcRenderer.removeListener('ntwine:update-state', listener);
  },

  installUpdate: () => ipcRenderer.invoke('ntwine:installUpdate'),

  openReleasesPage: () => ipcRenderer.invoke('ntwine:openReleasesPage'),

  getAppVersion: () => ipcRenderer.invoke('ntwine:getAppVersion'),
};

// E2E flag: main appends `--ntwine-e2e` to webPreferences.additionalArguments
// only when armed; a sandboxed preload sees it in process.argv. The production `ntwine` bridge
// is untouched — this is a second, boolean-only exposure.
if (process.argv.includes('--ntwine-e2e')) {
  contextBridge.exposeInMainWorld('ntwineE2E', true);
}

contextBridge.exposeInMainWorld('ntwine', api);
