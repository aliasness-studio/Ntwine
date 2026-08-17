// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Task 2 spike surface — grows into the full typed IPC bridge in Task 11.
contextBridge.exposeInMainWorld('ntwine', {
  startDrag: (id: number) => ipcRenderer.send('ntwine:drag-start', id),
});
