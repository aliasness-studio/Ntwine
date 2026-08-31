// Which picture a drag-out carries (2026-08-31): the full card, a bare waveform, or a waveform
// with the sample's name under it. A user preference, not a constant — Ntwine's whole pitch is
// showing the library's own data the way YOU want it, so the drag image is a thing to choose.
//
// `localStorage` rather than the catalog, matching `App.tsx`'s `ntwine.filtersCollapsed`: this is
// a per-machine UI preference that nothing in main needs to know about, so it warrants no IPC
// round-trip and no schema. Unlike `PlayerStore.autoplay` (session-only on purpose) it DOES
// persist — it is a standing taste, not a transient browsing mode.
//
// The storage handle is a parameter rather than a reach for `window`, so this module stays
// importable and testable under `environment: 'node'` (dragCardStyle.test.ts).

/** Every style the drag image can take. Adding one here is most of the work of adding a style. */
export const DRAG_CARD_STYLES = ['card', 'waveform', 'waveform-text'] as const;

export type DragCardStyle = (typeof DRAG_CARD_STYLES)[number];

/** What a user who has never opened Settings gets. */
export const DEFAULT_DRAG_CARD_STYLE: DragCardStyle = 'card';

export const DRAG_CARD_STYLE_KEY = 'ntwine.dragCardStyle';

/** The two `localStorage` methods this module uses. `window.localStorage` satisfies it. */
export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A stored string to a style, defaulting anything unrecognised. A persisted value outlives the
 * code that wrote it — a style dropped in a later version, or a hand-edited key — and the failure
 * mode of trusting it would be a drag with no image at all, so unknown always reads as the default
 * rather than as an error.
 */
export function parseDragCardStyle(raw: string | null): DragCardStyle {
  return DRAG_CARD_STYLES.includes(raw as DragCardStyle)
    ? (raw as DragCardStyle)
    : DEFAULT_DRAG_CARD_STYLE;
}

/**
 * Both accessors swallow storage failures. `localStorage` throws for real — disabled site data,
 * a full quota — and this preference is read inside the `dragstart` handler, where the cost of an
 * exception is a drag that never starts. A missing preference is worth exactly one default value.
 */
export function readDragCardStyle(storage: StyleStorage): DragCardStyle {
  try {
    return parseDragCardStyle(storage.getItem(DRAG_CARD_STYLE_KEY));
  } catch {
    return DEFAULT_DRAG_CARD_STYLE;
  }
}

export function writeDragCardStyle(storage: StyleStorage, style: DragCardStyle): void {
  try {
    storage.setItem(DRAG_CARD_STYLE_KEY, style);
  } catch {
    // A preference that won't persist is still worth honouring for this session — the caller's
    // own state has already changed, and there is nothing useful to tell the user here.
  }
}
