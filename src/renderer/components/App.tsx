// The three-region window: a CSS grid with a 240px rail
// spanning both rows, a 48px top bar, and the list filling the rest. The rail itself is two
// independent sections: a packs scroller that takes all spare height, and a
// filter dock pinned below it that is always on screen — collapsible down to its header row so
// the packs scroller can have the full rail. Also owns the top-level FirstRun/library switch
// plus the settings-sheet and dock-collapsed booleans — none of which belong
// in a store (they're one-shot UI wiring, not browsing/playback/import STATE).
import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
import type { NtwineApi } from '../../shared/ipcTypes';
import { FilterPanel } from './FilterPanel';
import { FirstRun } from './FirstRun';
import { LibraryRail } from './LibraryRail';
import { NavBar } from './NavBar';
import { PackRail } from './PackRail';
import { SampleList, type SampleListHandle } from './SampleList';
import { SettingsSheet } from './SettingsSheet';
import { TransportControls } from './TransportControls';
import { UpdateBanner } from './UpdateBanner';
import { useStores } from './StoreContext';
import { TopBar, type TopBarHandle } from './TopBar';

type GetStateResult = Awaited<ReturnType<NtwineApi['getState']>>;
type LoadState =
  { kind: 'loading' } | { kind: 'firstRun'; state: GetStateResult } | { kind: 'library' };

// `safe` + `overflow: auto`: a card taller (or wider) than the window overflows toward the end
// and scrolls, instead of being centred off the top edge where it can't be reached.
const Centered = styled.div`
  width: 100%;
  height: 100%;
  overflow: auto;
  display: flex;
  align-items: safe center;
  justify-content: safe center;
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.textMuted};
  font-family: ${(p) => p.theme.font.family};
`;

// The `crumbs` row is `auto`: NavBar renders null whenever there's no history and no active
// filter, which collapses that row to zero height — the default view keeps every pixel it had
// before this bar existed, and the list only gives up space while something is narrowing it.
// The `banner` row above the top bar works the same way for UpdateBanner, which renders only
// while an undismissed update notice is pending.
const Grid = styled.div`
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 48px auto 1fr;
  grid-template-areas:
    'rail banner'
    'rail topbar'
    'rail crumbs'
    'rail list';
  width: 100%;
  height: 100%;
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.text};
  font-family: ${(p) => p.theme.font.family};
`;

const Rail = styled.div`
  grid-area: rail;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: ${(p) => p.theme.color.bgRail};
  border-right: 1px solid ${(p) => p.theme.color.border};
`;

const PacksScroll = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
`;

// Never taller than 55% of the rail: the filter panel's natural height (four sections, a tag
// chip cloud) would otherwise crush the packs section to nothing on a short window. The body
// scrolls internally when the cap bites, so both sections stay usable at any window height.
const FilterDock = styled.div`
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 55%;
  border-top: 1px solid ${(p) => p.theme.color.border};
`;

const FilterDockHeader = styled.button`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

const FilterDockBody = styled.div`
  min-height: 0;
  overflow-y: auto;
`;

// Same inline-SVG reasoning as GearIcon below: the collapse affordance shouldn't depend on how a
// system font renders a triangle dingbat. Points down when open, right when collapsed.
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? undefined : 'rotate(-90deg)' }}
    >
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// localStorage (renderer-local, persisted under userData like the rest of the web storage) rather
// than the catalog: which rail sections are open is a per-machine UI preference, not library
// state — nothing in main needs to know it, so no IPC round-trip is warranted.
const FILTERS_COLLAPSED_KEY = 'ntwine.filtersCollapsed';

const RailFooter = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  /* Was flex-end when the gear was the only occupant. The transport dock takes the left edge and
     the gear stays pinned right, so the settings affordance doesn't move from where it has always
     been (a small gear at the bottom of the rail). */
  justify-content: space-between;
  gap: 8px;
  padding: 8px;
  border-top: 1px solid ${(p) => p.theme.color.border};
`;

const GearButton = styled.button`
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: transparent;
  color: ${(p) => p.theme.color.textMuted};
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

// A small inline SVG rather than a Unicode glyph — a ring + 8 rotated teeth — so the "small gear"
// affordance doesn't depend on how a particular system font happens to render a dingbat
// character. `currentColor` inherits `GearButton`'s own `color`, so the hover state above (and
// dark-theme contrast generally) applies for free.
const GEAR_TEETH_DEGREES = [0, 45, 90, 135, 180, 225, 270, 315];

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="2" />
      {GEAR_TEETH_DEGREES.map((deg) => (
        <rect
          key={deg}
          x="10.5"
          y="0.5"
          width="3"
          height="4"
          rx="1"
          fill="currentColor"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
    </svg>
  );
}

export function App() {
  const { library } = useStores();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(
    () => window.localStorage.getItem(FILTERS_COLLAPSED_KEY) === '1',
  );
  const initedRef = useRef(false);
  // Cross-component focus orchestration: App renders both TopBar and
  // SampleList, so it's the one place that can reach BOTH forwarded handles — neither sibling has
  // any other way to reach the other's DOM node.
  const topBarRef = useRef<TopBarHandle>(null);
  const sampleListRef = useRef<SampleListHandle>(null);

  const toggleFiltersCollapsed = (): void => {
    setFiltersCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(FILTERS_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    void api.getState().then((state) => {
      if (cancelled) return;
      setLoad(state.imported ? { kind: 'library' } : { kind: 'firstRun', state });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fires exactly once, whichever path reaches `{ kind: 'library' }` first — either directly
  // (already imported at launch) or via FirstRun's `onImported` callback below. `library.init()`
  // is safe to call before an import has ever run too (an empty catalog just answers
  // with empty arrays), but there is no reason to query a library shell nobody can see yet.
  useEffect(() => {
    if (load.kind === 'library' && !initedRef.current) {
      initedRef.current = true;
      void library.init();
    }
  }, [load.kind, library]);

  // Cmd/Ctrl+F: window-level, CAPTURE phase —
  // the popover/nickname-editor inputs blanket-`stopPropagation` every keydown on BUBBLE, so
  // a bubble-phase (or React-synthetic, which is bubble-delegated) listener would never see this
  // combo fired from inside one, but Cmd/Ctrl+F must focus search from anywhere,
  // popovers included. Capture always completes top-down before bubble starts, so a `window`
  // capture listener sees every keydown regardless of what a descendant does with it afterward.
  // `topBarRef.current` is null until the library view below actually mounts (the loading/
  // first-run screens render neither TopBar nor SampleList) — the optional call is then just a
  // harmless no-op, not a case this needs to guard separately.
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      // Alt+Left = back, the browser convention, on the same window-level capture listener and for
      // the same reason: it has to work from inside popovers and text inputs, which blanket-
      // stopPropagation on bubble. Checked BEFORE the Cmd/Ctrl+F guard below, which returns early
      // for anything without a meta/ctrl modifier. Bare ArrowLeft is left alone — SampleList binds
      // it to replay.
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        library.back();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      e.preventDefault();
      topBarRef.current?.focusSearch();
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [library]);

  if (load.kind === 'loading') {
    return <Centered>Loading…</Centered>;
  }

  if (load.kind === 'firstRun') {
    return (
      <Centered>
        <FirstRun state={load.state} onImported={() => setLoad({ kind: 'library' })} />
      </Centered>
    );
  }

  return (
    <Grid>
      <Rail>
        <PacksScroll>
          <LibraryRail />
          <PackRail />
        </PacksScroll>
        <FilterDock>
          <FilterDockHeader
            type="button"
            aria-expanded={!filtersCollapsed}
            onClick={toggleFiltersCollapsed}
          >
            <span>Filters</span>
            <ChevronIcon open={!filtersCollapsed} />
          </FilterDockHeader>
          {!filtersCollapsed && (
            <FilterDockBody>
              <FilterPanel />
            </FilterDockBody>
          )}
        </FilterDock>
        <RailFooter>
          <TransportControls />
          <GearButton
            type="button"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
          </GearButton>
        </RailFooter>
      </Rail>
      <UpdateBanner />
      <TopBar ref={topBarRef} onEscEmpty={() => sampleListRef.current?.focusList()} />
      <NavBar />
      <SampleList ref={sampleListRef} />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </Grid>
  );
}
