// The three-region window (Task 13 brief, Step 1 / spec §7): a CSS grid with a 240px rail
// spanning both rows, a 48px top bar, and the list filling the rest. The rail itself is two
// independent sections (QoL round 1): a packs scroller that takes all spare height, and a
// filter dock pinned below it that is always on screen — collapsible down to its header row so
// the packs scroller can have the full rail. Also owns the top-level FirstRun/library switch
// (spec §3.1 item 6) plus the settings-sheet and dock-collapsed booleans — none of which belong
// in a store (they're one-shot UI wiring, not browsing/playback/import STATE).
import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
import type { NtwineApi } from '../../shared/ipcTypes';
import { FilterPanel } from './FilterPanel';
import { FirstRun } from './FirstRun';
import { PackRail } from './PackRail';
import { SampleList } from './SampleList';
import { SettingsSheet } from './SettingsSheet';
import { useStores } from './StoreContext';
import { TopBar } from './TopBar';

type GetStateResult = Awaited<ReturnType<NtwineApi['getState']>>;
type LoadState =
  { kind: 'loading' } | { kind: 'firstRun'; state: GetStateResult } | { kind: 'library' };

const Centered = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.textMuted};
  font-family: ${(p) => p.theme.font.family};
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: 48px 1fr;
  grid-template-areas:
    'rail topbar'
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
  justify-content: flex-end;
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
// affordance (spec §7) doesn't depend on how a particular system font happens to render a dingbat
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
  // is safe to call before an import has ever run too (Task 12: an empty catalog just answers
  // with empty arrays), but there is no reason to query a library shell nobody can see yet.
  useEffect(() => {
    if (load.kind === 'library' && !initedRef.current) {
      initedRef.current = true;
      void library.init();
    }
  }, [load.kind, library]);

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
      <TopBar />
      <SampleList />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
    </Grid>
  );
}
