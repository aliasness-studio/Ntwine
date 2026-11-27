// Pure row context-menu item derivation. Split out as its own
// unit-testable module so the branching (favorite label flip, scope-gated `removefrom`,
// missing-row reduction, platform-named reveal) is pinned without mounting RowContextMenu's DOM — same "pure helper
// beside its component" split as emptyState.ts/scrollSnap.ts.
//
// Deliberate design choice: instead of an "Add to collection ▸" submenu (collection list +
// "New collection…"), "Add to collection" opens the add-to-collection popover
// (CollectionPopover.tsx) — one surface instead of two. `addto` here just fires the action that
// opens that popover, so its label drops the "▸" submenu glyph (which would now point at nothing)
// in favor of the same "…" popover-opens convention `nickname`/`tags` already use below.
import type { SampleRow, Scope } from '../shared/ipcTypes';

export type RowMenuItemId =
  | 'favorite'
  | 'nickname'
  | 'tags'
  | 'addto'
  | 'removefrom'
  | 'reveal'
  | 'copypath';

export interface RowMenuItem {
  id: RowMenuItemId;
  label: string;
  /** Shown but not clickable — RowContextMenu renders it as a real `disabled` button. */
  disabled?: boolean;
}

/** The OS file manager's own name, so the item reads the way the platform's other apps do. */
function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Show in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

/**
 * `row`/`scope` mirror `SampleList`'s own row data and `library.filters.scope` exactly;
 * `platform` is `process.platform` as the preload bridge reports it (`NtwineApi.platform`),
 * passed in so this stays pure.
 *
 * Missing rows are read-only for the user layer — no heart, and none of the user-layer items
 * here. They keep the two file items: reveal shown disabled (there is nothing on disk to show),
 * copy-path enabled (it copies where the file should be). Every row therefore gets a non-empty
 * menu; callers still treat `[]` as "no menu" defensively.
 */
export function menuItemsFor(
  row: SampleRow,
  scope: Scope | undefined,
  platform: string,
): RowMenuItem[] {
  const reveal: RowMenuItem = { id: 'reveal', label: revealLabel(platform) };
  const copyPath: RowMenuItem = { id: 'copypath', label: 'Copy full path' };

  if (row.missing) return [{ ...reveal, disabled: true }, copyPath];

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

  items.push(reveal, copyPath);
  return items;
}
