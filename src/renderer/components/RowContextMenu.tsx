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
// back via `onAction`/`onClose` and never touches a store directly — `platform` arrives as a prop
// for the same reason. Re-derives `menuItemsFor(row, scope, platform)` itself rather than trusting a pre-filtered caller — same "don't
// trust the caller got it right" posture SampleRow.tsx's own doc comment states for
// `row.missing`/`row.peaksFailed` — so this renders nothing for an empty entry list even if a
// future caller forgets the empty-menu gate.
//
// Submenus (rowMenu.ts's `submenu` entries, one level deep) render their child menu as a DOM
// descendant of the parent item's wrapper, absolutely positioned flush against it with no gap.
// That makes "the pointer is over the parent OR the child" a single `mouseenter`/`mouseleave`
// pair on the wrapper — no hover-intent timers — and keeps the child inside `menuRef` for the
// click-away check below.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import styled, { css } from 'styled-components';
import type { SampleRow, Scope } from '../../shared/ipcTypes';
import {
  menuItemsFor,
  submenuPlacement,
  type RowMenuEntry,
  type RowMenuItem,
  type RowMenuItemId,
  type RowMenuSubmenu,
} from '../rowMenu';

// Viewport-clamp constants for the fixed-position menu and its submenus. `point.x`/`point.y`
// would otherwise place the box's TOP-LEFT corner unconditionally, so a right-click near the
// window's bottom/right edge would render items off-screen. No DOM measurement (same "fixed
// estimate over pixel-measurement" call `POPOVER_ESTIMATED_HEIGHT` makes in SampleList.tsx, for
// the same reason: correcting after the real box paints would risk a visible post-open jump).
// Width is a flat estimate — every label is short and one line, and the longest ("Remove from
// this collection") never comes close to wrapping at this font-size, so entry count doesn't move
// it. Height is computed FROM the actual entries instead of a flat worst-case estimate: unlike
// the popover case, this box's real height is already knowable here (the entry list is in hand
// before the first paint), and a flat max-entry estimate would clamp a short (2-item) menu away
// from an edge it doesn't actually overhang. A separator is counted at its own, shorter height.
const MENU_ESTIMATED_WIDTH = 220;
const MENU_ITEM_HEIGHT = 28; // one item's content box plus the `gap: 2px` before the next entry
const MENU_SEPARATOR_HEIGHT = 9; // Separator's 1px line + 3px margin above and below + the gap
const MENU_PADDING = 10; // a menu box's own 4px padding (top+bottom) + 1px border (top+bottom)
// A submenu sits this far above its parent item so its first item lines up with the parent: the
// submenu box's own top padding + top border.
const SUBMENU_TOP_OFFSET = MENU_PADDING / 2;

function estimatedHeight(entries: RowMenuEntry[]): number {
  return entries.reduce(
    (h, e) => h + (e.kind === 'separator' ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT),
    MENU_PADDING,
  );
}

// The box styling the top-level menu and every submenu share.
const menuSurface = css`
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

const MenuBox = styled.div<{ $x: number; $y: number }>`
  position: fixed;
  top: ${(p) => p.$y}px;
  left: ${(p) => p.$x}px;
  z-index: 100;
  ${menuSurface}
`;

// Flush against the parent item's wrapper (`left: 100%` / `right: 100%`, no margin), so the
// pointer never crosses a gap that belongs to neither. It overlaps the top-level box's own
// padding and border by a few pixels on that side, which is what closes the gap.
const SubmenuBox = styled.div<{ $side: 'left' | 'right'; $top: number }>`
  position: absolute;
  top: ${(p) => p.$top}px;
  ${(p) => (p.$side === 'right' ? 'left: 100%;' : 'right: 100%;')}
  z-index: 1;
  ${menuSurface}
`;

const SubmenuWrapper = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
`;

const Separator = styled.div`
  height: 1px;
  margin: 3px 4px;
  background: ${(p) => p.theme.color.borderStrong};
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

  &:hover:not(:disabled) {
    background: ${(p) => p.theme.color.bgRowHover};
  }

  /* Same dimmed, non-interactive look as NavBar's disabled buttons. */
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
`;

const SubmenuParentButton = styled(MenuItemButton)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  /* Stays highlighted while its submenu is open, so the path to the child reads as one. */
  &[aria-expanded='true'] {
    background: ${(p) => p.theme.color.bgRowHover};
  }
`;

// Inline SVG for the same reason as TransportControls' icons and NavBar's BackIcon: a system-font
// dingbat (▸, ›) renders at different weights and baselines across platforms. `currentColor`
// follows the item's own text colour.
function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M4.5 2 L8.5 6 L4.5 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Which submenu is open and where, relative to its parent item's wrapper. */
interface OpenSubmenu {
  label: string;
  side: 'left' | 'right';
  top: number;
  /** Opened from the keyboard: move focus onto the submenu's first enabled item. */
  focusFirst: boolean;
}

interface ActionButtonProps {
  item: RowMenuItem;
  onChoose: (id: RowMenuItemId) => void;
  onMouseEnter?: () => void;
}

function ActionButton({ item, onChoose, onMouseEnter }: ActionButtonProps) {
  return (
    <MenuItemButton
      type="button"
      role="menuitem"
      // A real `disabled` button: no click, no focus, announced as unavailable. The early
      // return keeps a disabled item from closing the menu even if a click got through.
      disabled={item.disabled}
      onMouseEnter={onMouseEnter}
      onClick={() => {
        if (item.disabled) return;
        onChoose(item.id);
      }}
    >
      {item.label}
    </MenuItemButton>
  );
}

interface SubmenuEntryProps {
  entry: RowMenuSubmenu;
  open: OpenSubmenu | null;
  onOpen: (open: OpenSubmenu) => void;
  onDismiss: () => void;
  onChoose: (id: RowMenuItemId) => void;
}

// One submenu parent item plus its child menu. Opens on pointer enter, on click (which never
// closes the surrounding menu), and from the keyboard on ArrowRight or Enter/Space; ArrowLeft
// inside the child closes it and returns focus to the parent. Both arrow keys stop propagating so
// they never reach SampleList's own list keymap, where ArrowLeft retriggers the selected sample.
function SubmenuEntry({ entry, open, onOpen, onDismiss, onChoose }: SubmenuEntryProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLButtonElement>(null);
  const childRef = useRef<HTMLDivElement>(null);

  // Placement is decided from the parent item's real, already-painted box — so a flip or upward
  // shift is right on the first frame — and the child's estimated size.
  const openHere = (focusFirst: boolean): void => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    const rect = wrapper.getBoundingClientRect();
    const placement = submenuPlacement(
      { right: rect.right, top: rect.top - SUBMENU_TOP_OFFSET },
      { width: MENU_ESTIMATED_WIDTH, height: estimatedHeight(entry.items) },
      { width: window.innerWidth, height: window.innerHeight },
    );
    onOpen({
      label: entry.label,
      side: placement.side,
      top: placement.top - rect.top,
      focusFirst,
    });
  };

  useEffect(() => {
    if (!open?.focusFirst) return;
    childRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  const handleParentKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    openHere(true);
  };

  const handleChildKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    onDismiss();
    parentRef.current?.focus();
  };

  return (
    <SubmenuWrapper ref={wrapperRef} onMouseEnter={() => openHere(false)} onMouseLeave={onDismiss}>
      <SubmenuParentButton
        ref={parentRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onKeyDown={handleParentKeyDown}
        // `detail === 0` is a keyboard-activated click (Enter/Space), which also moves focus
        // into the submenu; a pointer click leaves focus where it is.
        onClick={(e) => openHere(e.detail === 0)}
      >
        {entry.label}
        <ChevronIcon />
      </SubmenuParentButton>
      {open && (
        <SubmenuBox
          ref={childRef}
          role="menu"
          aria-label={entry.label}
          $side={open.side}
          $top={open.top}
          onKeyDown={handleChildKeyDown}
        >
          {entry.items.map((item) => (
            <ActionButton key={item.id} item={item} onChoose={onChoose} />
          ))}
        </SubmenuBox>
      )}
    </SubmenuWrapper>
  );
}

export interface RowContextMenuProps {
  row: SampleRow;
  scope: Scope | undefined;
  point: { x: number; y: number };
  platform: string;
  onAction: (id: RowMenuItemId) => void;
  onClose: () => void;
}

export function RowContextMenu({
  row,
  scope,
  point,
  platform,
  onAction,
  onClose,
}: RowContextMenuProps) {
  const entries = menuItemsFor(row, scope, platform);
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<OpenSubmenu | null>(null);

  // Esc / click-away (closes on Esc, click-away, or choosing an action — LibraryRail's own
  // two-button collection menu is the simpler stopgap, see that file's comment). Document-level listeners, not a full-screen backdrop: a
  // context menu shouldn't dim the app the way SettingsSheet's modal does, and a click that lands
  // on, say, a different row should both close this menu AND act on that row in one gesture — a
  // backdrop `onClick` intercepting the click would swallow that second half. Capture phase (the
  // `true` third arg) on both so this fires before any other handler could stop the event's
  // propagation and leave the menu stuck open behind it. An open submenu is a DOM descendant of
  // `menuRef`, so a click inside it counts as inside the menu. Skipped entirely when there are no
  // entries — nothing renders below in that case, so there is nothing to click away from or Esc
  // out of.
  useEffect(() => {
    if (entries.length === 0) return;
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
  }, [entries.length, onClose]);

  // No menu at all when there are no entries — never an empty box. `menuItemsFor` returns a
  // non-empty list for every row; this stays as the cheap defensive gate.
  if (entries.length === 0) return null;

  // See the constants' own comment above for why width is a flat estimate and height is computed
  // from the real entries.
  const x = Math.max(0, Math.min(point.x, window.innerWidth - MENU_ESTIMATED_WIDTH));
  const y = Math.max(0, Math.min(point.y, window.innerHeight - estimatedHeight(entries)));

  const choose = (id: RowMenuItemId): void => {
    onAction(id);
    onClose();
  };
  const closeSubmenu = (): void => setOpenSubmenu(null);

  return (
    <MenuBox ref={menuRef} role="menu" aria-label="Row actions" $x={x} $y={y}>
      {entries.map((entry, i) => {
        switch (entry.kind) {
          case 'separator':
            return <Separator key={`separator-${i}`} role="separator" />;
          case 'submenu':
            return (
              <SubmenuEntry
                key={`submenu-${entry.label}`}
                entry={entry}
                open={openSubmenu?.label === entry.label ? openSubmenu : null}
                onOpen={setOpenSubmenu}
                onDismiss={closeSubmenu}
                onChoose={choose}
              />
            );
          case 'item':
            return (
              <ActionButton
                key={entry.id}
                item={entry}
                onChoose={choose}
                // Pointing at another top-level item closes any open submenu, including one
                // opened from the keyboard while the pointer was elsewhere.
                onMouseEnter={closeSubmenu}
              />
            );
        }
      })}
    </MenuBox>
  );
}
