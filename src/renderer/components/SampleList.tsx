// The virtualized sample list (Task 13 brief, Steps 2-3). TanStack Virtual keeps the DOM node
// count bounded to roughly the viewport + overscan regardless of `library.rows.length` (up to
// 4,197 in the real library) — that bound is what makes "never jank" (spec §7) achievable at all.
import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import styled from 'styled-components';
import type { SampleRow as SampleRowData, Scope } from '../../shared/ipcTypes';
import { api } from '../stores/api';
import { emptyStateText } from '../emptyState';
import { menuItemsFor, type RowMenuItemId } from '../rowMenu';
import { doesPopoverFitBelowRow, isRowFullyVisible } from '../scrollSnap';
import { CollectionPopover } from './CollectionPopover';
import { RowContextMenu } from './RowContextMenu';
import { TagsPopover } from './TagsPopover';
import { useStores } from './StoreContext';
import { ROW_HEIGHT, SampleRow } from './SampleRow';

const OVERSCAN = 12;
// How long to wait after the LAST 'waveforms'-phase progress tick in a burst before re-checking
// the visible range for newly-decoded peaks (the "peaks progressive-fill gotcha" — see the
// dedicated effect below). Ticks arrive once per settled sample, i.e. up to ~4,197 times per
// import; without coalescing this would fire one IPC batch per tick.
const WAVEFORM_TICK_COALESCE_MS = 300;
// Safety-net poll interval for the same recheck — see the doc comment on the effect below for why
// ticks alone aren't sufficient. Coarse on purpose: this only ever does real work (an IPC call)
// when the visible range actually has an uncached, not-missing, not-failed row, which is false the
// overwhelming majority of the time this timer fires.
const WAVEFORM_POLL_MS = 1500;
// Task 11 fix round 1 (Important 2): a fixed estimate, not a DOM measurement — mirrors ROW_HEIGHT/
// SampleRow.tsx's own FILENAME_TRUNCATE_MAX precedent of a fixed budget over pixel-measurement,
// and lets the below-the-fold check run BEFORE the popover's first paint (measuring the real
// rendered popover and correcting afterward would risk a visible post-open jump — spec §7's "never
// jank" bar). Sized roomier than either popover's typical content (a short input plus a handful of
// chips/suggestions/collection rows) needs, deliberately: a false "doesn't fit" just scrolls a bit
// further than strictly necessary, while a false "fits" is the actual bug this constant exists to
// avoid re-introducing.
const POPOVER_ESTIMATED_HEIGHT = 220;

const Scroller = styled.div`
  grid-area: list;
  position: relative;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  outline: none;
  background: ${(p) => p.theme.color.bg};
`;

const Inner = styled.div<{ $height: number }>`
  position: relative;
  width: 100%;
  height: ${(p) => p.$height}px;
`;

const EmptyState = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 13px;
`;

export const SampleList = observer(function SampleList() {
  const { library, player, userLayer } = useStores();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Task 10 (design spec §5.2): the row context menu's open/closed state — which row, the scope
  // that was active when it opened (so `removefrom`'s dispatch target can't drift if something
  // changed it mid-open), and the cursor point the menu renders at. `null` is closed; SampleList
  // is the sole owner (RowContextMenu is presentational — see that file's own doc comment).
  const [contextMenu, setContextMenu] = useState<{
    row: SampleRowData;
    scope: Scope | undefined;
    point: { x: number; y: number };
  } | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: library.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Kept "always current" via a plain render-time assignment (not a `useEffect` — a ref write
  // during render is safe/idiomatic since it doesn't affect this render's output) so the
  // mount-once waveforms-phase subscription below never reads stale closures captured on the
  // render where that effect first ran.
  const rowsRef = useRef(library.rows);
  rowsRef.current = library.rows;
  const peaksCacheRef = useRef(library.peaksCache);
  peaksCacheRef.current = library.peaksCache;
  const virtualItemsRef = useRef(virtualItems);
  virtualItemsRef.current = virtualItems;

  // Step 3: for the virtualizer's visible range, batch-request ids not yet in peaksCache.
  // `missing` rows have no file to decode; `peaksFailed` rows already have their answer (a
  // placeholder blob that must never be drawn — SampleRow enforces that again, independently, on
  // the read side). Depends on the first/last VISIBLE INDEX (primitives), not the `virtualItems`
  // array reference, so this only re-runs when the rendered window actually shifts by a row, not
  // on every sub-pixel scroll re-render.
  const firstIndex = virtualItems[0]?.index;
  const lastIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (firstIndex === undefined || lastIndex === undefined) return;
    const ids: number[] = [];
    for (let i = firstIndex; i <= lastIndex; i++) {
      const row = library.rows[i];
      if (row && !row.missing && !row.peaksFailed && !library.peaksCache.has(row.id)) {
        ids.push(row.id);
      }
    }
    if (ids.length > 0) void library.fetchPeaks(ids);
  }, [firstIndex, lastIndex, library]);

  // Peaks progressive-fill gotcha (Task 13 brief): `hasPeaks`/`peaksCache` are query-time
  // snapshots that go stale mid-import as the background waveform pass keeps writing rows — a
  // sample decoded AFTER its row was queried never gets a peaks row without something re-asking.
  // Re-asking only on visible-range CHANGE (the effect above) would leave rows the user isn't
  // scrolling past stuck on the placeholder forever. Subscribed here via `api` directly — neither
  // LibraryStore nor ImportStore exposes a "waveforms tick" observable, and ImportStore's own
  // subscription only lives for the duration of ITS `run()` call, which would miss a background
  // resume pass that started without FirstRun ever running this session (spec §5 "resumable").
  // `library` is a stable reference for the app's lifetime (created once in renderer.tsx), so this
  // subscription is mount-once, cleaned up on unmount.
  //
  // Ticks alone are not sufficient, discovered via real hand-QA against the full 4,197-sample
  // library (2026-08-17, not reachable through any mocked-`api` unit test): `runWaveformsInBackground`
  // for the startup-resume path (main/ipc.ts, fired synchronously at app.whenReady()) races this
  // component's own mount. A relaunch with only a modest number of ids still pending can finish
  // EVERY 'waveforms' tick — decoding local files has no network latency — before the renderer
  // has booted React and run this effect at all. Electron does not replay a missed
  // `webContents.send` to a listener that subscribes after it fired, so those rows would be stuck
  // on the placeholder for the rest of the session with nothing left to ever re-ask for them.
  // `WAVEFORM_POLL_MS` is the guarantee: it doesn't depend on catching any particular event, only
  // on eventually asking again. Ticks stay wired as the fast path for the common case (a
  // first-ever import, where this component is already mounted and subscribed before the queue
  // starts, so ticks arrive live and the poll mostly finds nothing to do).
  useEffect(() => {
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

    const recheckVisibleRange = (): void => {
      coalesceTimer = null;
      const items = virtualItemsRef.current;
      if (items.length === 0) return;
      const first = items[0].index;
      const last = items[items.length - 1].index;
      const ids: number[] = [];
      for (let i = first; i <= last; i++) {
        const row = rowsRef.current[i];
        if (row && !row.missing && !row.peaksFailed && !peaksCacheRef.current.has(row.id)) {
          ids.push(row.id);
        }
      }
      if (ids.length > 0) void library.fetchPeaks(ids);
    };

    const unsubscribe = api.onImportProgress((p) => {
      if (p.phase !== 'waveforms') return;
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(recheckVisibleRange, WAVEFORM_TICK_COALESCE_MS);
    });

    const pollInterval = setInterval(recheckVisibleRange, WAVEFORM_POLL_MS);

    return () => {
      unsubscribe();
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
      clearInterval(pollInterval);
    };
  }, [library]);

  // Keyboard nav walks every CURRENTLY FILTERED/SEARCHED row (the full `library.rows`, not just
  // the on-screen virtualized window — clamping arrow-key travel to ~20 on-screen rows would make
  // Down stop working the moment the selection reaches the bottom of the initial viewport), with
  // `missing` rows excluded (spec §3.1 item 6: "excluded from preview/drag" — PlayerStore itself
  // has no missing-awareness, so the exclusion has to happen in the `visibleIds` this component
  // hands it).
  const visibleIds = useMemo(
    () => library.rows.filter((r) => !r.missing).map((r) => r.id),
    [library.rows],
  );

  // Snap scroll (QoL round 1): after an arrow key moves the selection, a landing row that isn't
  // fully inside the viewport becomes the TOP row (align 'start' — the Splice paging feel, in
  // both directions), instead of staying off-screen while the audio walks on without you. Runs
  // only on keyboard moves — mouse scrolling and clicks never fight the user. `moveSelection`
  // writes `selectedId` synchronously, so reading it right back here is the post-move value; the
  // index is looked up in the FULL `library.rows` (missing rows included) because that is the
  // coordinate space the virtualizer's offsets are in.
  const snapSelectionIntoView = (): void => {
    const el = scrollRef.current;
    if (el === null || player.selectedId === null) return;
    const index = library.rows.findIndex((r) => r.id === player.selectedId);
    if (index === -1) return;
    if (!isRowFullyVisible(el.scrollTop, el.clientHeight, index, ROW_HEIGHT)) {
      rowVirtualizer.scrollToIndex(index, { align: 'start' });
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      player.moveSelection(1, visibleIds);
      snapSelectionIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      player.moveSelection(-1, visibleIds);
      snapSelectionIntoView();
    } else if (e.key === 'ArrowLeft' || e.key === ' ' || e.code === 'Space') {
      // ArrowLeft = Splice muscle memory for "retrigger the current sample": same action Space
      // already had — previewPlayer's per-voice gain ramp silences the sounding voice and
      // restarts from the top. Selection never moves.
      e.preventDefault();
      player.replay();
    }
  };

  // Task 10 brief / design spec §5.2: right-click opens the in-app row menu at the cursor.
  // `SampleRow` (out of this task's file scope) exposes no per-row DOM identifier for an
  // event-target lookup, so row identity is resolved from the click's Y position instead:
  // `virtualItems` gives every currently-rendered row's fixed `ROW_HEIGHT`-tall band relative to
  // `Inner`'s top, and `scrollRef`'s own bounding rect + `scrollTop` converts the click's
  // viewport-space Y into that same coordinate space — the same `rowIndex * rowHeight` reasoning
  // `scrollSnap.ts` already uses for this fixed-size list. `menuItemsFor` is checked here (not
  // only inside RowContextMenu) so an empty result never opens state at all — no menu, and the
  // native context menu (nothing currently wires one — main has no `context-menu` handler) is
  // left alone. Opening the menu never moves selection or playback: the spec is silent on this
  // for the context menu specifically, so the heart's own "click toggles without changing
  // selection" is the least-surprise precedent to follow.
  const handleContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const relativeY = e.clientY - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const target = virtualItems.find(
      (vi) => relativeY >= vi.start && relativeY < vi.start + ROW_HEIGHT,
    );
    const row = target ? library.rows[target.index] : undefined;
    if (!row) return;
    const scope = library.filters.scope;
    if (menuItemsFor(row, scope).length === 0) return;
    e.preventDefault();
    setContextMenu({ row, scope, point: { x: e.clientX, y: e.clientY } });
  };

  const closeContextMenu = (): void => setContextMenu(null);

  // The dispatcher RowContextMenu's `onAction` calls into. `favorite`/`removefrom` are immediate
  // actions against already-wired, already-tested `UserLayerStore` methods — the exact "fire the
  // write, let refresh() re-sync" posture that store documents for itself. `nickname`/`tags`/
  // `addto` (Task 11) set the store's popover/nickname-edit open-state FOR THE MENU'S ROW —
  // `row.id` here is "whatever row the action targeted" (brief's binding decision on the
  // ambiguity), which today is always the row the context menu opened on; Task 12 additionally
  // reaches these same store actions from the selected row via keyboard.
  const handleRowMenuAction = (id: RowMenuItemId): void => {
    if (!contextMenu) return;
    const { row, scope } = contextMenu;
    switch (id) {
      case 'favorite':
        void userLayer.toggleFavorite(row);
        break;
      case 'removefrom':
        // Only ever present in the menu when `scope?.kind === 'collection'` (menuItemsFor's own
        // gate), but narrowed again here rather than trusting that invariant across the
        // open-menu/click gap.
        if (scope?.kind === 'collection') {
          void userLayer.removeFromCollection(scope.collectionId, row.id);
        }
        break;
      case 'nickname':
        userLayer.startNicknameEdit(row.id);
        break;
      case 'tags':
        userLayer.openTagsPopover(row.id);
        break;
      case 'addto':
        // Ledger Ruling R2 folds the spec's "Add to collection ▸" submenu into this one popover.
        userLayer.openCollectionPopover(row.id);
        break;
    }
  };

  // Task 11 (design spec §5.3): resolves the currently-open tags/collection popover's anchor row
  // and virtual position fresh on every render — no cached index, so a re-query (e.g. after
  // addTag's own refresh()) that shifts row order never anchors against a stale one. `undefined`
  // for either half — row no longer present, or scrolled outside the rendered+overscan range —
  // means "don't render" below, the same defensive posture `handleContextMenu` already takes for
  // a not-found row.
  const openPopover = userLayer.openPopover;
  const popoverRowIndex =
    openPopover === null ? -1 : library.rows.findIndex((r) => r.id === openPopover.sampleId);
  const popoverRow = popoverRowIndex === -1 ? undefined : library.rows[popoverRowIndex];
  const popoverVirtualItem =
    popoverRowIndex === -1 ? undefined : virtualItems.find((vi) => vi.index === popoverRowIndex);

  // Fix round 1 (Important 2, reviewer finding): scroll the anchor row into view when its popover
  // would otherwise render past the fold. Nothing else here moves the scroll position on open, so
  // without this a popover for a row near the viewport's bottom edge was invisible the instant it
  // opened — reachable only by then scrolling manually to go find it. Mirrors the keyboard-nav
  // snap pattern (`snapSelectionIntoView` below): `scrollToIndex(rowIndex, { align: 'start' })`
  // puts the anchor row at the TOP of the viewport, giving the popover the most room below it this
  // viewport can offer — the same alignment `isRowFullyVisible`'s own call site already uses.
  // `doesPopoverFitBelowRow` (scrollSnap.ts) is the pure decision; when the anchor row already has
  // room, it returns true and this deliberately does nothing, so opening a popover never moves a
  // view that didn't need to move. Runs "on openPopover change" specifically (not on every
  // render): `popoverRowIndex` is derived from `openPopover` on the SAME render that produces it,
  // so the closure this effect captures on the render where `openPopover` actually changes always
  // has the matching, up-to-date index.
  useEffect(() => {
    if (openPopover === null) return;
    const scroller = scrollRef.current;
    if (scroller === null || popoverRowIndex === -1) return;
    const fits = doesPopoverFitBelowRow(
      scroller.scrollTop,
      scroller.clientHeight,
      popoverRowIndex,
      ROW_HEIGHT,
      POPOVER_ESTIMATED_HEIGHT,
    );
    if (!fits) {
      rowVirtualizer.scrollToIndex(popoverRowIndex, { align: 'start' });
    }
  }, [openPopover]);

  // Auto-focus on mount so arrow keys work immediately without requiring a click first; refocus
  // on any click within the list so keyboard nav keeps working after a mouse selection (a plain
  // row `<div>` isn't itself focusable, so a click doesn't otherwise return focus to this
  // container).
  useEffect(() => {
    scrollRef.current?.focus();
  }, []);

  return (
    <Scroller
      ref={scrollRef}
      tabIndex={0}
      role="listbox"
      aria-label="Sample list"
      onKeyDown={handleKeyDown}
      onMouseDown={() => scrollRef.current?.focus()}
      onContextMenu={handleContextMenu}
    >
      {library.rows.length === 0 && !library.loading && (
        <EmptyState>{emptyStateText(library.filters.scope)}</EmptyState>
      )}
      <Inner $height={rowVirtualizer.getTotalSize()}>
        {virtualItems.map((vi) => {
          const row = library.rows[vi.index];
          if (!row) return null;
          return (
            <SampleRow
              key={row.id}
              row={row}
              selected={player.selectedId === row.id}
              peaks={library.peaksCache.get(row.id) ?? null}
              top={vi.start}
              onSelect={() => {
                if (!row.missing) player.select(row.id);
              }}
              onToggleFavorite={() => void userLayer.toggleFavorite(row)}
              editingNickname={userLayer.nicknameEditId === row.id}
              onCommitNickname={(nickname) => {
                void userLayer.setNickname(row.id, nickname);
                userLayer.stopNicknameEdit();
              }}
              onCancelNicknameEdit={() => userLayer.stopNicknameEdit()}
            />
          );
        })}
        {openPopover && popoverRow && popoverVirtualItem && openPopover.kind === 'tags' && (
          <TagsPopover
            key={openPopover.sampleId}
            row={popoverRow}
            top={popoverVirtualItem.start + ROW_HEIGHT}
            onClose={() => userLayer.closePopover()}
          />
        )}
        {openPopover && popoverRow && popoverVirtualItem && openPopover.kind === 'collection' && (
          <CollectionPopover
            key={openPopover.sampleId}
            sampleId={openPopover.sampleId}
            top={popoverVirtualItem.start + ROW_HEIGHT}
            onClose={() => userLayer.closePopover()}
          />
        )}
      </Inner>
      {contextMenu && (
        <RowContextMenu
          key={contextMenu.row.id}
          row={contextMenu.row}
          scope={contextMenu.scope}
          point={contextMenu.point}
          onAction={handleRowMenuAction}
          onClose={closeContextMenu}
        />
      )}
    </Scroller>
  );
});
