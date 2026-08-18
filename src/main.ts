import { app, BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import started from 'electron-squirrel-startup';
import { openCatalog } from './main/catalog/db';
import { computeDefaultBounds } from './main/defaultBounds';
import { registerDragHandler } from './main/drag';
import { makeE2EEmitter, readE2EConfig, type E2EConfig } from './main/e2e';
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

// E2E mode (e2e spec §3.1). Read BEFORE whenReady: app.setPath must precede any getPath, and a
// config error must never reach Electron's "JavaScript error in main process" dialog (a modal
// that would hang a headless run) — log and exit instead.
let e2e: E2EConfig | null = null;
try {
  e2e = readE2EConfig(process.env);
  if (e2e) {
    // app.setPath throws when the directory does not exist (Electron docs) — create first.
    mkdirSync(e2e.userData, { recursive: true });
    app.setPath('userData', e2e.userData);
    if (e2e.appData) {
      mkdirSync(e2e.appData, { recursive: true });
      app.setPath('appData', e2e.appData);
    }
  }
} catch (err) {
  console.error(String(err));
  app.exit(2);
}
const e2eEmit = makeE2EEmitter(app, e2e);

let mainWindow: BrowserWindow | null = null;

const createWindow = (): BrowserWindow => {
  // 90% of the work area, centered (BrowserWindow centers itself when x/y are omitted). Only
  // callable after app ready — the `screen` module throws before that, and createWindow's one
  // call site is inside whenReady() below.
  const { width, height } = computeDefaultBounds(screen.getPrimaryDisplay().workAreaSize);
  const win = new BrowserWindow({
    width,
    height,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: e2e ? ['--ntwine-e2e'] : [],
    },
  });

  // macOS keeps the app process alive after its one-and-only window closes (see
  // window-all-closed below) — a background pass (e.g. the waveform peaks queue, queue.ts) can
  // easily still be mid-flight at that point and deliver another worker reply afterwards. Null
  // out the module-level ref here so sendProgress's isDestroyed() guard below has "no window" to
  // check against, instead of a dangling reference to a destroyed BrowserWindow. Guarded against
  // a second window's 'closed' racing an already-newer `mainWindow` (activate can recreate one).
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  const indexPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(indexPath);
  }

  // Fuse-safe packaged boot probe (e2e spec §4 packaged.spec): the packaged binary's fuses disable
  // the Node inspector Playwright's driver needs, so the probe is "boot, load, write a marker, quit".
  if (e2e?.bootMarker) {
    const marker = e2e.bootMarker;
    win.webContents.once('did-finish-load', () => {
      writeFileSync(marker, app.getPath('userData'));
      app.quit();
    });
  }

  // Enforces protocol.ts's `corsEnabled: true` invariant (see the trip-wire comment beside it):
  // sample://cover:// become fetchable cross-origin by ANY origin this BrowserWindow ever
  // renders, so this app must never render remote/untrusted content. No popup/new-window feature
  // exists, so every window.open is denied outright.
  win.webContents.setWindowOpenHandler(({ url }) => {
    e2eEmit?.('ntwine:e2e:window-open-denied', { url });
    return { action: 'deny' };
  });

  // Same invariant, for top-level navigation (a stray external <a href>, a compromised
  // dependency setting location.href, ...) — denies anything that isn't the app's own single
  // page. Dev and packaged loads are compared differently on purpose: the Vite dev server is a
  // real http origin (`URL#origin` is meaningful there), but a packaged file:// load has an
  // OPAQUE origin per the URL spec (`.origin` is the literal string "null" for every file: URL,
  // which would make an origin compare wrongly treat ANY local file as "the app") — the packaged
  // case compares the exact decoded path instead.
  win.webContents.on('will-navigate', (event) => {
    // `event.url` (the modern `Event<WebContentsWillNavigateEventParams>` merged-object form),
    // not the legacy second positional `url` argument electron.d.ts marks `@deprecated`.
    const target = new URL(event.url);
    const isAppOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? target.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
      : target.protocol === 'file:' && fileURLToPath(target) === indexPath;
    if (!isAppOrigin) {
      event.preventDefault();
      e2eEmit?.('ntwine:e2e:nav-denied', { url: event.url });
    }
  });

  // No devtools auto-open, even on dev-server loads (owner call, 2026-08-17): they ate half the
  // window on every `yarn start`. Cmd+Option+I / the View menu toggles them on demand.
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
  const getLibraryRoot = () => currentLibraryRoot(catalog, e2e?.libraryRoot ?? undefined);

  mainWindow = createWindow();

  registerProtocols({ catalog, getLibraryRoot, coversDir, e2eEmit });

  // Re-points Task 2's hardcoded resolvePath at the real catalog lookup (drag.ts's own doc
  // comment has the full rationale) — registerDragHandler itself is not temporary and doesn't
  // change.
  registerDragHandler((sampleId) => resolveSampleAbsPath(catalog, getLibraryRoot(), sampleId), e2eEmit);

  registerIpc({
    catalog,
    snapshotDir,
    coversDir,
    defaultLibraryRoot: e2e?.libraryRoot ?? undefined,
    e2eEmit,
    // Guarded, not a bare `mainWindow?.webContents.send(...)`: a still-running background pass
    // (e.g. queue.ts's peaks queue) can deliver a worker reply well after the window is gone —
    // closing the WINDOW on macOS leaves the app (and this callback) alive, and `.webContents` on
    // a destroyed BrowserWindow throws. Uncaught inside a worker-message callback, that would
    // wedge runPeaksQueue: it never resolves, workers never get killed, 'done' never fires.
    sendProgress: (p: ImportProgress) => {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ntwine:import-progress', p);
      }
    },
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
