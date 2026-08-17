import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { openCatalog } from './main/catalog/db';
import { registerDragHandler } from './main/drag';
import { currentLibraryRoot, registerIpc } from './main/ipc';
import { dataDirFrom } from './main/paths';
import { registerProtocols, registerProtocolSchemes, resolveSampleAbsPath } from './main/protocol';
import type { ImportProgress } from './shared/ipcTypes';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// protocol.registerSchemesAsPrivileged has its own hard constraint (Electron: "can only be used
// before the ready event... and can be called only once") — module scope is the only point in
// this file guaranteed to run before app.whenReady(), so it happens here. registerProtocols
// (the REST of the protocol wiring — protocol.handle, which needs a live app) runs down in
// whenReady() below, alongside everything else.
registerProtocolSchemes();

let mainWindow: BrowserWindow | null = null;

const createWindow = (): BrowserWindow => {
  // Create the browser window.
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Open the DevTools.
  win.webContents.openDevTools();
  return win;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // All catalog state lives in a subdirectory of userData (spec §4): catalog.db (incl. waveform
  // peaks, spec §6), the Splice DB snapshot, and downloaded cover art. better-sqlite3's Database
  // constructor does NOT create missing parent directories (unlike snapshotSpliceDb/
  // downloadCovers, which mkdirSync their own target dirs) — discovered via `yarn start`'s Task
  // 11 manual smoke ("Cannot open database because the directory does not exist" on a fresh
  // userData), so this wiring layer is what has to ensure the directory exists first.
  const dataDir = dataDirFrom(app.getPath('userData'));
  mkdirSync(dataDir, { recursive: true });
  const catalog = openCatalog(path.join(dataDir, 'catalog.db'));
  const snapshotDir = path.join(dataDir, 'splice-snapshot');
  const coversDir = path.join(dataDir, 'covers');
  // A getter, not a resolved string: the library root can change at runtime
  // (NtwineApi.pickLibraryRoot), and everything below is wired up once — each consumer re-reads
  // the current value at request time instead of resolving against a startup snapshot.
  const getLibraryRoot = () => currentLibraryRoot(catalog);

  mainWindow = createWindow();

  registerProtocols({ catalog, getLibraryRoot, coversDir });

  // Re-points Task 2's hardcoded resolvePath at the real catalog lookup (drag.ts's own doc
  // comment has the full rationale) — registerDragHandler itself is not temporary and doesn't
  // change.
  registerDragHandler((sampleId) => resolveSampleAbsPath(catalog, getLibraryRoot(), sampleId));

  registerIpc({
    catalog,
    snapshotDir,
    coversDir,
    sendProgress: (p: ImportProgress) => mainWindow?.webContents.send('ntwine:import-progress', p),
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
