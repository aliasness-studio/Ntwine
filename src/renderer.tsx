/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

import './index.css';

console.log(
  '👋 This message is being logged by "renderer.ts", included via Vite',
);

// Task 2 spike — replaced in Task 13. No React root exists yet (that lands in
// Task 13), so this is plain DOM rather than JSX. Proves ipcRenderer.send ->
// ipcMain.on -> webContents.startDrag before the catalog/UI exist.
const dragSpike = document.createElement('div');
dragSpike.textContent = 'Drag me -> Finder / Reaper (Task 2 spike)';
dragSpike.draggable = true;
dragSpike.style.cssText =
  'width: 240px; height: 48px; margin: 16px; display: flex; align-items: center; justify-content: center; background: #302c28; color: #fff; font-family: sans-serif; cursor: grab; user-select: none;';
dragSpike.addEventListener('dragstart', (event) => {
  event.preventDefault();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spike only; Task 11 types the preload bridge (window.ntwine) properly.
  (window as any).ntwine.startDrag(1);
});
document.body.appendChild(dragSpike);
