// Task 13 / design spec §7: the renderer-owned drag-source slot. It is the ONLY way LibraryRail's
// drop targets can tell a real native row drag (SampleRow's `handleDragStart`) from an external
// Finder/Explorer file drag over the app window — once `handleDragStart` calls `preventDefault`,
// there is no HTML5 drag session of our own left, so `dataTransfer` at the drop site looks
// identical either way. A module-level singleton, not store state: it's a one-shot handoff
// between two DOM event handlers in different components, alive only for the span of a single
// drag gesture — not app state anything else needs to observe or react to.
//
// The session TOKEN (not just the sample id) exists because `startDrag`'s invoke can resolve
// LATE relative to the rest of the app: the OS drag session blocks the main process until
// mouse-up (spec §7), so by the time the renderer's `finally` runs, the slot it armed may already
// be empty (a drop consumed it) or may hold a DIFFERENT, newer drag (a second drag started before
// the first's `finally` ran). `clearDragSource` only clears when its token still matches the live
// slot, so a stale `finally` can never clobber a slot it doesn't own.
export interface DragSource {
  sampleId: number;
  token: symbol;
}

let slot: DragSource | null = null;

/**
 * Records `sampleId` as the in-flight drag and returns its session token. Call once per
 * `dragstart`, before invoking `startDrag`. Unconditionally overwrites any previous slot — a
 * fresh drag always wins; the previous drag's own `finally` will find its token stale against the
 * new slot and no-op (see `clearDragSource`).
 */
export function armDragSource(sampleId: number): symbol {
  const token = Symbol('dragSource');
  slot = { sampleId, token };
  return token;
}

/**
 * Reads the current slot without consuming it. Drop-target gating (`dragenter`/`dragover`) uses
 * this to tell an in-flight native row drag from an external file drag: a `null` result means
 * ignore everything about the current drag, per spec §7's discrimination rule.
 */
export function peekDragSource(): DragSource | null {
  return slot;
}

/**
 * Read-and-clear: returns the current slot and empties it in the same call, so a drop can never
 * double-apply and a claimed slot never lingers for a later handler to see.
 */
export function consumeDragSource(): DragSource | null {
  const current = slot;
  slot = null;
  return current;
}

/**
 * Clears the slot only if `token` still matches what's live right now. The `finally` wrapped
 * around `startDrag`'s invoke calls this with the token it armed, so a late resolution never
 * clears a slot that a newer drag or a drop has since claimed. A no-op (never throws) when the
 * slot is already empty or holds a different token.
 */
export function clearDragSource(token: symbol): void {
  if (slot !== null && slot.token === token) {
    slot = null;
  }
}
