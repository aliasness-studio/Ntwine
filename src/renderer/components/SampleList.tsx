// The virtualized sample list (Task 13 brief, Steps 2-3). TanStack Virtual keeps the DOM node
// count bounded to roughly the viewport + overscan regardless of `library.rows.length` (up to
// 4,197 in the real library) — that bound is what makes "never jank" (spec §7) achievable at all.
import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
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
  const { library, player } = useStores();
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      player.moveSelection(1, visibleIds);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      player.moveSelection(-1, visibleIds);
    } else if (e.key === 'ArrowLeft' || e.key === ' ' || e.code === 'Space') {
      // ArrowLeft = Splice muscle memory for "retrigger the current sample": same action Space
      // already had — previewPlayer's per-voice gain ramp silences the sounding voice and
      // restarts from the top. Selection never moves.
      e.preventDefault();
      player.replay();
    }
  };

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
    >
      {library.rows.length === 0 && !library.loading && (
        <EmptyState>No samples match the current filters</EmptyState>
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
            />
          );
        })}
      </Inner>
    </Scroller>
  );
});
