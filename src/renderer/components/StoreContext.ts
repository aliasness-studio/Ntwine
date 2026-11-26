// React context wiring for the three MobX stores, instantiated once in renderer.tsx
// and handed down from there via `<StoreContext.Provider>`. Its own file because the context
// OBJECT itself needs one importable home every component can reach without a circular
// dependency: App.tsx renders PackRail/FilterPanel/TopBar/SampleList/SettingsSheet, so defining
// the context IN App.tsx would make every one of those import back
// from the file that imports them. Defining it in renderer.tsx (the entry point) would work at
// runtime — ESM module caching means it's still one instance — but makes every leaf component
// import the file that calls `createRoot(...).render(...)`, a real footgun for whoever adds a
// component test later (importing it outside a real DOM would run that side effect). This file
// is pure plumbing: no JSX, so a plain `.ts` file (not `.tsx`) is correct.
import { createContext, useContext } from 'react';
import type { ImportStore } from '../stores/ImportStore';
import type { LibraryStore } from '../stores/LibraryStore';
import type { PlayerStore } from '../stores/PlayerStore';
import type { UpdateStore } from '../stores/UpdateStore';
import type { UserLayerStore } from '../stores/UserLayerStore';

export interface Stores {
  library: LibraryStore;
  player: PlayerStore;
  importStore: ImportStore;
  userLayer: UserLayerStore;
  update: UpdateStore;
}

export const StoreContext = createContext<Stores | null>(null);

/**
 * Every component in the tree is a descendant of renderer.tsx's `<StoreContext.Provider>`, so a
 * `null` read here means a real wiring bug (a component rendered outside the provider), not a
 * legitimate "no stores yet" state to design a fallback around — hence throwing rather than
 * returning `null`/undefined and pushing the null-check onto every call site.
 */
export function useStores(): Stores {
  const stores = useContext(StoreContext);
  if (stores === null) {
    throw new Error('useStores() called outside <StoreContext.Provider> — check renderer.tsx');
  }
  return stores;
}
