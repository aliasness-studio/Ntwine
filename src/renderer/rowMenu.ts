// Pure row context-menu item derivation. Split out as its own
// unit-testable module so the branching (favorite label flip, scope-gated `removefrom`,
// missing-row suppression) is pinned without mounting RowContextMenu's DOM — same "pure helper
// beside its component" split as emptyState.ts/scrollSnap.ts.
//
// Deliberate design choice: instead of an "Add to collection ▸" submenu (collection list +
// "New collection…"), "Add to collection" opens the add-to-collection popover
// (CollectionPopover.tsx) — one surface instead of two. `addto` here just fires the action that
// opens that popover, so its label drops the "▸" submenu glyph (which would now point at nothing)
// in favor of the same "…" popover-opens convention `nickname`/`tags` already use below.
import type { SampleRow, Scope } from '../shared/ipcTypes';

export type RowMenuItemId = 'favorite' | 'nickname' | 'tags' | 'addto' | 'removefrom';

export interface RowMenuItem {
  id: RowMenuItemId;
  label: string;
}

/**
 * `row`/`scope` mirror `SampleList`'s own row data and `library.filters.scope` exactly.
 *
 * Missing rows are read-only for the user layer — one rule resolving every affordance: no heart,
 * no context menu. `[]` is the one signal both the caller (gating whether to
 * open a menu at all) and `RowContextMenu` (defending its own render) read as "no menu", never an
 * empty box.
 */
export function menuItemsFor(row: SampleRow, scope: Scope | undefined): RowMenuItem[] {
  if (row.missing) return [];

  const items: RowMenuItem[] = [
    { id: 'favorite', label: row.favorite ? 'Unfavorite' : 'Favorite' },
    { id: 'nickname', label: 'Nickname…' },
    { id: 'tags', label: 'Tags…' },
    { id: 'addto', label: 'Add to collection…' },
  ];

  // "Remove from this collection" appears only under a collection scope.
  if (scope?.kind === 'collection') {
    items.push({ id: 'removefrom', label: 'Remove from this collection' });
  }

  return items;
}
