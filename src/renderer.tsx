/**
 * React root (Task 13 — replaces the Task 2 drag spike). Instantiates the three MobX stores
 * (Task 12) once with the real `api`/`PlayPort`, and renders the app inside a store context
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

// Task 14: the real WebAudio PlayPort, replacing Task 13's no-op stub. `fetchBytes` is the one
// production implementation the previewPlayer brief names verbatim — `sample://` is
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

const stores: Stores = {
  library: new LibraryStore(api),
  player: new PlayerStore(playPort),
  importStore: new ImportStore(api),
};

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
