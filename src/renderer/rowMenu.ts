// Pure row context-menu layout derivation. Split out as its own
// unit-testable module so the branching (favorite label flip, scope-gated `removefrom`,
// missing-row reduction, platform-named reveal, the System submenu) is pinned without mounting
// RowContextMenu's DOM — same "pure helper beside its component" split as
// emptyState.ts/scrollSnap.ts.
//
// Layout: the app's own sample actions sit at the top level; the two file-system actions (reveal,
// copy path) sit one level down in a "System" submenu behind a separator, so the everyday items
// stay one click away and the OS-facing ones stay grouped together.
//
// "Add to collection" is not a submenu: it fires the action that opens the add-to-collection
// popover (CollectionPopover.tsx) — one surface instead of two — so its label carries the same
// "…" popover-opens convention `nickname`/`tags` use below rather than a submenu chevron.
import type { SampleRow, Scope } from '../shared/ipcTypes';

export type RowMenuItemId =
  | 'favorite'
  | 'nickname'
  | 'tags'
  | 'addto'
  | 'removefrom'
  | 'reveal'
  | 'copypath';

/** The System submenu's label — the one place it is spelled, so tests and renames go through it. */
export const SYSTEM_SUBMENU_LABEL = 'System';

/** An action the user can choose. `RowMenuItemId` names actions only; structure has no id. */
export interface RowMenuItem {
  kind: 'item';
  id: RowMenuItemId;
  label: string;
  /** Shown but not clickable — RowContextMenu renders it as a real `disabled` button. */
  disabled?: boolean;
}

/** A thin divider between groups of top-level entries. */
export interface RowMenuSeparator {
  kind: 'separator';
}

/** A labelled parent entry that opens a nested menu of actions (one level deep, no nesting). */
export interface RowMenuSubmenu {
  kind: 'submenu';
  label: string;
  items: RowMenuItem[];
}

/** One top-level menu entry. */
export type RowMenuEntry = RowMenuItem | RowMenuSeparator | RowMenuSubmenu;

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
 * here. They keep the two file items, flat at the top level rather than inside a submenu that
 * would be the menu's only entry: reveal shown disabled (there is nothing on disk to show),
 * copy-path enabled (it copies where the file should be). Every row therefore gets a non-empty
 * menu; callers still treat `[]` as "no menu" defensively.
 */
export function menuItemsFor(
  row: SampleRow,
  scope: Scope | undefined,
  platform: string,
): RowMenuEntry[] {
  const reveal: RowMenuItem = { kind: 'item', id: 'reveal', label: revealLabel(platform) };
  const copyPath: RowMenuItem = { kind: 'item', id: 'copypath', label: 'Copy full path' };

  if (row.missing) return [{ ...reveal, disabled: true }, copyPath];

  const entries: RowMenuEntry[] = [
    { kind: 'item', id: 'favorite', label: row.favorite ? 'Unfavorite' : 'Favorite' },
    { kind: 'item', id: 'nickname', label: 'Nickname…' },
    { kind: 'item', id: 'tags', label: 'Tags…' },
    { kind: 'item', id: 'addto', label: 'Add to collection…' },
  ];

  // "Remove from this collection" appears only under a collection scope.
  if (scope?.kind === 'collection') {
    entries.push({ kind: 'item', id: 'removefrom', label: 'Remove from this collection' });
  }

  entries.push(
    { kind: 'separator' },
    { kind: 'submenu', label: SYSTEM_SUBMENU_LABEL, items: [reveal, copyPath] },
  );
  return entries;
}

/**
 * Where a submenu opens beside its parent item, in viewport coordinates. `anchor.right` is the
 * parent item's right edge (the submenu's left edge when it opens rightward) and `anchor.top` is
 * the top the submenu would take with no clamping. It opens to the right unless that would cross
 * the window's right edge, then to the left; vertically it moves up just far enough to keep its
 * bottom inside the window, and never above the window's top. `size` is an estimate — the
 * caller decides before the submenu has painted, so it cannot be measured without a visible jump.
 */
export function submenuPlacement(
  anchor: { right: number; top: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { side: 'right' | 'left'; top: number } {
  const side = anchor.right + size.width <= viewport.width ? 'right' : 'left';
  const top = Math.max(0, Math.min(anchor.top, viewport.height - size.height));
  return { side, top };
}
