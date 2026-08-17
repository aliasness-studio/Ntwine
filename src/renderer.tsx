/**
 * React root (Task 13 — replaces the Task 2 drag spike). Instantiates the three MobX stores
 * (Task 12) once with the real `api`/`PlayPort`, and renders the app inside a store context
 * provider + styled-components ThemeProvider.
 *
 * To learn more about the differences between the "main" and the "renderer" context in Electron,
 * visit: https://electronjs.org/docs/tutorial/process-model
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'styled-components';
import './index.css';
import { App } from './renderer/components/App';
import { StoreContext, type Stores } from './renderer/components/StoreContext';
import { theme } from './renderer/components/theme';
import { api } from './renderer/stores/api';
import { ImportStore } from './renderer/stores/ImportStore';
import { LibraryStore } from './renderer/stores/LibraryStore';
import { PlayerStore, type PlayPort } from './renderer/stores/PlayerStore';

// Task 14 replaces this with the WebAudio previewPlayer (`createPreviewPlayer(...)` in
// src/renderer/audio/previewPlayer.ts). PlayerStore requires a PlayPort at construction, and the
// real implementation doesn't exist yet — this no-op stub keeps every selection/keyboard/volume
// action in this task's UI wired through PlayerStore exactly as it will be once playback is real;
// Task 14 only has to swap this one object, not touch a single component.
const playPort: PlayPort = {
  play: () => {},
  stop: () => {},
  setVolume: () => {},
};

const stores: Stores = {
  library: new LibraryStore(api),
  player: new PlayerStore(playPort),
  importStore: new ImportStore(api),
};

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
