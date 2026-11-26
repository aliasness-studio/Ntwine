// RowContextMenu: the in-app row context menu — a React menu,
// not a native OS `Menu`, so it's stylable and Playwright-drivable via `role="menu"`/
// `role="menuitem"`. `position: fixed` at the cursor point, no portal: nothing between here and
// `<body>` (App.tsx's Grid/Rail/Scroller/Inner chain) sets a `transform`/`filter`/`will-change`
// that would rebase a fixed-position descendant's containing block off the viewport — confirmed
// by inspection before choosing this over a portal (no portal unless one is physically
// required) — so a plain fixed div anchors correctly from anywhere in the tree.
//
// Presentational only, same "no store reads" posture as SampleRow.tsx: `SampleList` owns the
// open/closed state (which row, scope, point) and the action dispatcher; this component reports
// back via `onAction`/`onClose` and never touches a store directly. Re-derives
// `menuItemsFor(row, scope)` itself rather than trusting a pre-filtered caller — same "don't
// trust the caller got it right" posture SampleRow.tsx's own doc comment states for
// `row.missing`/`row.peaksFailed` — so this renders nothing even if a future caller forgets the
// empty-menu gate.
import { useEffect, useRef } from 'react';
import styled from 'styled-components';
import type { SampleRow, Scope } from '../../shared/ipcTypes';
import { menuItemsFor, type RowMenuItemId } from '../rowMenu';

// Viewport-clamp constants for the fixed-position
// menu — a right-click near the window's bottom/right edge previously rendered items off-screen,
// since `point.x`/`point.y` place the box's TOP-LEFT corner unconditionally. No DOM measurement
// (same "fixed estimate over pixel-measurement" call `POPOVER_ESTIMATED_HEIGHT` makes in
// SampleList.tsx, for the same reason: correcting after the real box paints would risk a visible
// post-open jump). Width is a flat estimate — every label is short and one line, and the longest
// ("Remove from this collection") never comes close to wrapping at this font-size, so item count
// doesn't move it. Height is computed FROM the actual item count instead of a flat worst-case
// estimate: unlike the popover case, this box's real height is already knowable here
// (`items.length` is in hand before the first paint), and a flat max-item estimate would clamp a
// short (2-item) menu away from an edge it doesn't actually overhang.
const MENU_ESTIMATED_WIDTH = 220;
const MENU_ITEM_HEIGHT = 28; // one item's content box plus the `gap: 2px` before the next item
const MENU_PADDING = 10; // MenuBox's own 4px padding (top+bottom) + 1px border (top+bottom)

const MenuBox = styled.div<{ $x: number; $y: number }>`
  position: fixed;
  top: ${(p) => p.$y}px;
  left: ${(p) => p.$x}px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  min-width: 170px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.borderStrong};
  background: ${(p) => p.theme.color.bgPanel};
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
`;

const MenuItemButton = styled.button`
  padding: 6px 8px;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: transparent;
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
  }
`;

export interface RowContextMenuProps {
  row: SampleRow;
  scope: Scope | undefined;
  point: { x: number; y: number };
  onAction: (id: RowMenuItemId) => void;
  onClose: () => void;
}

export function RowContextMenu({ row, scope, point, onAction, onClose }: RowContextMenuProps) {
  const items = menuItemsFor(row, scope);
  const menuRef = useRef<HTMLDivElement>(null);

  // Esc / click-away (closes on Esc, click-away, or choosing an action — LibraryRail's own
  // two-button collection menu is the simpler stopgap, see that file's comment). Document-level listeners, not a full-screen backdrop: a
  // context menu shouldn't dim the app the way SettingsSheet's modal does, and a click that lands
  // on, say, a different row should both close this menu AND act on that row in one gesture — a
  // backdrop `onClick` intercepting the click would swallow that second half. Capture phase (the
  // `true` third arg) on both so this fires before any other handler could stop the event's
  // propagation and leave the menu stuck open behind it. Skipped entirely when there are no items
  // — nothing renders below in that case, so there is nothing to click away from or Esc out of.
  useEffect(() => {
    if (items.length === 0) return;
    const handlePointerDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [items.length, onClose]);

  // No menu at all when there are no items — never an empty box (the missing-row
  // no-click rule, already enforced once inside `menuItemsFor` itself).
  if (items.length === 0) return null;

  // See the constants' own comment above for why width is a flat estimate and height is computed
  // from the real item count.
  const estimatedHeight = items.length * MENU_ITEM_HEIGHT + MENU_PADDING;
  const x = Math.max(0, Math.min(point.x, window.innerWidth - MENU_ESTIMATED_WIDTH));
  const y = Math.max(0, Math.min(point.y, window.innerHeight - estimatedHeight));

  return (
    <MenuBox ref={menuRef} role="menu" aria-label="Row actions" $x={x} $y={y}>
      {items.map((item) => (
        <MenuItemButton
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => {
            onAction(item.id);
            onClose();
          }}
        >
          {item.label}
        </MenuItemButton>
      ))}
    </MenuBox>
  );
}
