/**
 * React root. Instantiates the MobX stores once with the real `api`/`PlayPort`, and renders the
 * app inside a store context
 * provider + styled-components ThemeProvider.
 *
 * To learn more about the differences between the "main" and the "renderer" context in Electron,
 * visit: https://electronjs.org/docs/tutorial/process-model
 */
import { toJS } from 'mobx';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components';
import './index.css';
import { createPreviewPlayer } from './renderer/audio/previewPlayer';
import { App } from './renderer/components/App';
import { StoreContext, type Stores } from './renderer/components/StoreContext';
import { theme } from './renderer/components/theme';
import { installE2ESnapshot, wrapPlayPort } from './renderer/e2eSnapshot';
import { api } from './renderer/stores/api';
import { ImportStore } from './renderer/stores/ImportStore';
import { LibraryStore } from './renderer/stores/LibraryStore';
import { PlayerStore } from './renderer/stores/PlayerStore';
import { UpdateStore } from './renderer/stores/UpdateStore';
import { UserLayerStore } from './renderer/stores/UserLayerStore';

// The real WebAudio PlayPort. `fetchBytes` is the one production implementation — `sample://` is
// fetch-privileged (protocol.ts's PRIVILEGES has `supportFetchAPI: true`), so a plain renderer
// `fetch()` is all a real sample byte-fetch needs; not-ok responses are turned into a rejection so
// previewPlayer.ts's decode-failure path (-> decodeFallback) covers this too, not just a genuine
// decode error. `decodeFallback`/`sampleUrl` wire straight to the matching `api` methods — both
// are plain arrow functions on `window.ntwine` (preload.ts), so detaching them from `api` here is
// safe (no `this` to lose). `ctx` is left undefined so previewPlayer.ts lazily constructs a real
// `AudioContext` on first play(); only previewPlayer.test.ts ever injects a stub.
const fetchBytes = (url: string): Promise<ArrayBuffer> =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`previewPlayer: fetch ${url} responded ${r.status}`);
    return r.arrayBuffer();
  });

const e2eArmed = window.ntwineE2E === true;
const basePort = createPreviewPlayer({
  fetchBytes,
  decodeFallback: api.decodePreviewPcm,
  sampleUrl: api.sampleUrl,
});
const { port: playPort, counters } = wrapPlayPort(basePort, e2eArmed);

// Constructed as a local, not inline in `stores` below, so `UserLayerStore` — DI'd with
// BOTH `api` and this same `library` instance, the same pattern its own constructor doc-comments
// — can reference it without reaching back into `stores.library`.
const library = new LibraryStore(api);
const stores: Stores = {
  library,
  player: new PlayerStore(playPort),
  importStore: new ImportStore(api),
  userLayer: new UserLayerStore(api, library),
  update: new UpdateStore(api),
};

// Fire-and-forget, same posture as `library.init()`'s own call site (App.tsx) — a rejection here
// is a real IPC failure, not a validation error a caller needs to react to, so it's left to
// surface as an unhandled rejection/console error rather than swallowed. Unlike `library.init()`
// (gated behind FirstRun completion, since browsing UI has nothing to show before an import),
// `userLayer.init()` runs unconditionally at startup: `openUserDb` (main.ts) opens user.db on
// EVERY launch regardless of import state, so `listLibraryRail()`/`listUserTags()` are always
// answerable — pre-import they just resolve to the zero values (an empty user.db is a
// valid, fully-migrated database, not a missing one).
void stores.userLayer.init();
// Self-update: same unconditional, fire-and-forget posture — main answers
// the update bridge in every run mode (dev/e2e/Linux just report a permanent `idle`).
void stores.update.init();

// Synchronous, before any async work — the harness waits on typeof === 'function'.
installE2ESnapshot(window, e2eArmed, () => ({
  rows: stores.library.rows.length,
  resultCount: stores.library.resultCount,
  selectedId: stores.player.selectedId,
  volume: stores.player.volume,
  filters: toJS(stores.library.filters) as Record<string, unknown>,
  importPhase: stores.importStore.phase,
  running: stores.importStore.running,
  peaksCached: stores.library.peaksCache.size,
  autoplay: stores.player.autoplay,
  ...counters(),
}));

const container = document.getElementById('app');
if (!container) {
  throw new Error('renderer.tsx: #app root element not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <StoreContext.Provider value={stores}>
      <ThemeProvider theme={theme}>
        <App />
      </ThemeProvider>
    </StoreContext.Provider>
  </StrictMode>,
);
