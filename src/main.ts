import { app, BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import started from 'electron-squirrel-startup';
import { openCatalog } from './main/catalog/db';
import { computeDefaultBounds } from './main/defaultBounds';
import { registerDragHandler } from './main/drag';
import { makeE2EEmitter, readE2EConfig, type E2EConfig } from './main/e2e';
import { currentLibraryRoot, libraryRootDeps, registerIpc } from './main/ipc';
import { dataDirFrom } from './main/paths';
import { registerProtocols, registerProtocolSchemes, resolveSampleAbsPath } from './main/protocol';
import { openUserDb } from './main/user/userDb';
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
// Hidden-mode throughput (module scope on purpose: commandLine switches must land before app
// ready). Chromium treats a never-shown window as occluded and BACKGROUNDS its renderer —
// compositor frames drop to ~1/s, and Playwright's actionability check (which waits for a
// stable bounding box across two consecutive animation frames) then costs ~2s per click:
// measured, interaction-heavy specs ran 5-8x slower hidden (filters 3.9s → 24.9s) while
// passive specs were unchanged. webPreferences.backgroundThrottling only governs in-page
// timers/visibility; these process-level switches stop the occlusion/backgrounding itself.
// E2E-hidden only — the production app is untouched.
if (e2e?.hidden) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}
const e2eEmit = makeE2EEmitter(app, e2e);

let mainWindow: BrowserWindow | null = null;

const createWindow = (): BrowserWindow => {
  // 90% of the work area, centered (BrowserWindow centers itself when x/y are omitted). Only
  // callable after app ready — the `screen` module throws before that, and createWindow's one
  // call site is inside whenReady() below.
  const { width, height } = computeDefaultBounds(screen.getPrimaryDisplay().workAreaSize);
  // E2E quiet mode (NTWINE_E2E_HIDDEN=1, e2e.ts): the window must not pop up, steal focus, or
  // make noise while the dev works — WITHOUT costing test fidelity or speed. A plain
  // `show:false` window is NOT usable here: measured on this exact suite, Chromium drops a
  // never-shown window's compositor surface once the post-import library view lands, after
  // which requestAnimationFrame limps at ~1.5 Hz (probe: 482 rAF/2s pre-import → 3/2s after;
  // renderer 99.9% idle in a CPU profile, so it's frame *scheduling*, not load; un-muting,
  // removing canvases, and the backgrounding switches all changed nothing — only show()
  // restored 482/2s). Playwright's actionability check waits for a stable box across two
  // consecutive frames, so at 1.5 Hz EVERY click pays ~2 s (filters spec: 3.9 s → 24.9 s).
  // The strategy that keeps real compositor frames with nothing on screen:
  //   x/y −32000           — parked far off every display (where Windows parks minimized
  //                          windows); can never sit under the cursor or be seen
  //   opacity 0            — belt-and-braces: even a mis-positioned window draws nothing
  //   skipTaskbar          — no taskbar entry flicker per spec launch
  //   showInactive()       — presented WITHOUT activation, so keyboard focus stays wherever
  //                          the dev is typing (probe: isFocused() === false)
  //   backgroundThrottling — off, so in-page timers/rAF never get background-clamped
  //   setAudioMuted        — WebAudio still plays in an unseen window; preview specs would be
  //                          audible without it
  // Measured after the switch: 482 rAF/2s and 204 ms row-clicks — identical to a headed run.
  const win = new BrowserWindow({
    width,
    height,
    // Quiet mode creates unshown then presents via showInactive() below; headed e2e and
    // production keep the default constructor show — the unarmed app stays byte-for-byte v1.
    ...(e2e?.hidden ? { show: false, x: -32000, y: -32000, opacity: 0, skipTaskbar: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: e2e ? ['--ntwine-e2e'] : [],
      ...(e2e?.hidden ? { backgroundThrottling: false } : {}),
    },
  });
  if (e2e?.hidden) {
    win.webContents.setAudioMuted(true);
    // macOS clamps the -32000 placement back onto a display (CI: bounds.x read 0), so there the
    // quiet window sits ON-screen, merely transparent — and a transparent window still hit-tests,
    // i.e. it would swallow the dev's real clicks. Forward OS mouse input straight through it on
    // every platform (belt-and-braces on win32 too). Test input is unaffected: Playwright drives
    // the page via CDP, which bypasses OS hit-testing entirely — verified by the full suite.
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }

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
  // Sidecar user.db (design spec §2.2), ATTACHed onto the SAME connection as catalog.db —
  // precious curation must not share blast radius with importer/FTS-rebuild bugs, and this is
  // the one call site every render of the user layer (Task 6's IPC handlers) depends on running
  // before registerIpc below.
  const userDb = openUserDb(catalog, path.join(dataDir, 'user.db'));
  const snapshotDir = path.join(dataDir, 'splice-snapshot');
  const coversDir = path.join(dataDir, 'covers');
  // A getter, not a resolved string: the library root can change at runtime
  // (NtwineApi.pickLibraryRoot), and everything below is wired up once — each consumer re-reads
  // the current value at request time instead of resolving against a startup snapshot.
  const getLibraryRoot = () => currentLibraryRoot(catalog, libraryRootDeps(e2e?.libraryRoot));

  mainWindow = createWindow();

  registerProtocols({ catalog, getLibraryRoot, coversDir, e2eEmit });

  // Re-points Task 2's hardcoded resolvePath at the real catalog lookup (drag.ts's own doc
  // comment has the full rationale) — registerDragHandler itself is not temporary and doesn't
  // change.
  registerDragHandler((sampleId) => resolveSampleAbsPath(catalog, getLibraryRoot(), sampleId), e2eEmit);

  registerIpc({
    catalog,
    userDb,
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
