// keymap.ts (Task 12, design spec §5.4): pure keyboard-action resolution for the list container's
// F/T/C/N/Delete bindings, split out from SampleList so the table — including its no-selection
// no-ops and the Delete/Backspace scope gate — is unit-testable without mounting any DOM (this
// repo has no component-mounting test infra: no `@testing-library/react`, and vitest.config.ts
// only globs `src/**/*.test.ts`). Same "pure helper beside its component" split as
// rowMenu.ts/scrollSnap.ts/emptyState.ts. Cmd/Ctrl+F (window-level, App.tsx) and the search box's
// own Esc handling (TopBar.tsx) are deliberately NOT part of this module — spec §5.4 registers
// them at entirely different DOM nodes ("Registration points are split by necessity"), so there is
// no shared event the two would ever both need arbitrating between.
import type { Scope } from '../shared/ipcTypes';

export type ListKeyAction =
  | 'toggleFavorite'
  | 'openTags'
  | 'openCollection'
  | 'editNickname'
  | 'removeFromCollection';

/** The subset of a real KeyboardEvent this module reads — narrow on purpose so a test passes a
 * bare object literal instead of constructing a real (or React synthetic) KeyboardEvent. */
export interface ListKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export interface ListKeyContext {
  /** `player.selectedId !== null` — spec §5.4: "every single-key action is a no-op when nothing
   * is selected." */
  hasSelection: boolean;
  /** `library.filters.scope?.kind`. `undefined` IS "All Samples" — `Scope` (ipcTypes.ts) has no
   * `'all'` variant; its own doc comment explains why absence carries that meaning. */
  scopeKind: Scope['kind'] | undefined;
}

/**
 * Resolves ONE list-container keydown to an action, or `null` for "not ours": an unrecognized
 * key, no selection, a modifier combo reserved elsewhere (today: Cmd/Ctrl+F, window-level), or
 * Delete/Backspace outside a collection scope. Never mutates anything and never decides the
 * selection-follow wrap (§3.1) — that differs per action in ways this flat table can't express
 * (F only follows selection under Favorites scope; Delete never even fires outside a collection
 * scope, so its wrap is unconditional at the one call site that can reach it) — SampleList's
 * dispatcher owns both the store writes and that wrapping.
 */
export function listKeyAction(e: ListKeyEvent, ctx: ListKeyContext): ListKeyAction | null {
  // A held Cmd/Ctrl always means "someone else's binding" (today: Cmd/Ctrl+F, handled at window
  // level) — deferring unconditionally here is what stops a bare `f` match below from ALSO firing
  // toggleFavorite the instant that window-level listener lets the same keydown keep bubbling.
  if (e.metaKey || e.ctrlKey) return null;
  if (!ctx.hasSelection) return null;

  switch (e.key) {
    case 'f':
    case 'F':
      return 'toggleFavorite';
    case 't':
    case 'T':
      return 'openTags';
    case 'c':
    case 'C':
      return 'openCollection';
    case 'n':
    case 'N':
      return 'editNickname';
    case 'Delete':
    case 'Backspace':
      return ctx.scopeKind === 'collection' ? 'removeFromCollection' : null;
    default:
      return null;
  }
}

/**
 * The §3.1 selection-follow next-row rule's pure arithmetic, factored out of
 * `withSelectionFollow` (SampleList.tsx) so it has a real unit test. `before` is the selected
 * row's index in the PRE-write visible-id list (a caller passes -1, or any out-of-range index, for
 * "wasn't findable there" — both clamp the same way as a real in-range index would). `after` is
 * the POST-write visible-id list. Clamping `before` into `after`'s bounds is what makes "remove a
 * middle row -> the row that shifted into its place" and "remove the last row -> the new last row"
 * the same one formula: the removed row's old INDEX is still valid up to the new (shorter) array's
 * last index, so whatever now sits at that index is definitionally "what shifted into the gap" —
 * except at the old last index, where nothing shifts in and the clamp instead lands on the new
 * last row, i.e. the previous row. `null` (never e.g. `-1`) signals "the write emptied the scope"
 * — a real sample id is never negative, but `null` reads unambiguously at every call site instead
 * of relying on that.
 */
export function landingIdAfterRemoval(before: number, after: number[]): number | null {
  if (after.length === 0) return null;
  const index = Math.min(Math.max(before, 0), after.length - 1);
  return after[index];
}
