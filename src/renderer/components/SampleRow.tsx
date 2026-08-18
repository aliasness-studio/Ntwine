// One virtualized list row (Task 13 brief). Fixed 40px height — `ROW_HEIGHT` is exported so
// SampleList's `useVirtualizer({ estimateSize: () => ROW_HEIGHT })` and this file's own CSS read
// the SAME literal instead of two independently-maintained "40"s. Prop-driven only (no
// `observer`, no store reads) — SampleList (itself an `observer`) already resolves `row`/
// `selected`/`peaks` from the stores before they reach here, so a plain re-render on new props is
// enough; wrapping this in `observer` too would just be inert overhead.
import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import styled from 'styled-components';
import { formatDuration, formatKey } from '../../shared/keyDisplay';
import type { SampleRow as SampleRowData } from '../../shared/ipcTypes';
import { api } from '../stores/api';
import { WaveformThumb } from './WaveformThumb';

export const ROW_HEIGHT = 40;

const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 32;
const MAX_INLINE_TAGS = 3;
// Task 15 (spec §8: "Drag of missing file -> Drag refused, row flashes its badge"). A missing
// row is never actually draggable (see `draggable={!row.missing}` below), so this handler mostly
// exists for defense-in-depth and for a synthetically-dispatched `dragstart` (e.g.
// `element.dispatchEvent`, which invokes listeners regardless of the `draggable` attribute) —
// the only way to drive an "attempt" mechanically. 220ms is long enough to read as a deliberate
// pulse, short enough to still feel like a refusal rather than a state change.
const BADGE_FLASH_MS = 220;
// Character-count heuristic, not a pixel-measured truncation: spec §7 calls filenames out as
// "middle-truncated" but doesn't specify HOW. True pixel-accurate middle truncation needs a
// ResizeObserver + text measurement per row, which is real complexity/perf risk in a virtualized
// list whose #1 requirement is "never jank" (spec §7's feel bar) — a fixed character budget gets
// the same "keep the extension/tail visible" shape at zero measurement cost. Flagged in the task
// report as a place a future pass could upgrade to pixel-accurate truncation if it matters.
const FILENAME_TRUNCATE_MAX = 42;

function middleTruncate(name: string, max: number = FILENAME_TRUNCATE_MAX): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

const Row = styled.div<{ $top: number; $selected: boolean; $missing: boolean }>`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: ${ROW_HEIGHT}px;
  transform: translateY(${(p) => p.$top}px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  box-sizing: border-box;
  cursor: ${(p) => (p.$missing ? 'default' : 'pointer')};
  opacity: ${(p) => (p.$missing ? 0.4 : 1)};
  background: ${(p) => (p.$selected ? p.theme.color.bgRowSelected : 'transparent')};
  border-bottom: 1px solid ${(p) => p.theme.color.border};

  &:hover {
    background: ${(p) =>
      p.$missing
        ? 'transparent'
        : p.$selected
          ? p.theme.color.bgRowSelected
          : p.theme.color.bgRowHover};
  }
`;

const ThumbWrap = styled.div`
  position: relative;
  flex-shrink: 0;
  width: ${THUMB_WIDTH}px;
  height: ${THUMB_HEIGHT}px;
`;

const CorruptBadge = styled.span`
  position: absolute;
  top: -4px;
  right: -4px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: ${(p) => p.theme.color.danger};
  color: ${(p) => p.theme.color.bg};
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-weight: 700;
`;

const Filename = styled.span`
  flex: 2;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  font-size: 13px;
`;

// The real filename, shown dimmed-small after a nickname (design spec §5.2: "reappears
// dimmed-small after the nickname where width allows"). No separate width-measurement logic
// needed for the "where width allows" part — Filename's own `overflow: hidden; white-space:
// nowrap` already clips this trailing inline span exactly when there isn't room.
const DimmedReal = styled.span`
  margin-left: 6px;
  color: ${(p) => p.theme.color.textFaint};
  font-size: 11px;
`;

const PackName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 12px;
`;

const KeyCell = styled.span`
  width: 44px;
  flex-shrink: 0;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
`;

const BpmCell = styled.span`
  width: 40px;
  flex-shrink: 0;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
  text-align: right;
`;

const DurationCell = styled.span`
  width: 48px;
  flex-shrink: 0;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
  text-align: right;
`;

const Tags = styled.div`
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  width: 160px;
  overflow: hidden;
`;

const Chip = styled.span`
  padding: 1px 6px;
  border-radius: ${(p) => p.theme.radius.pill};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.textMuted};
  font-size: 10px;
  white-space: nowrap;
`;

// User tags (design spec §5.2: "accent-outlined, after Splice's within the same +N overflow
// budget") — extends Chip's shape/padding/font-size, only the fill/border differ. Same
// outline-on-accent idiom FilterPanel's active `TagChip` already uses for "this chip is
// accent-relevant" (transparent fill, 1px accent border, accentStrong text).
const UserChip = styled(Chip)`
  background: transparent;
  border: 1px solid ${(p) => p.theme.color.accent};
  color: ${(p) => p.theme.color.accentStrong};
`;

const MissingBadge = styled.span<{ $flash: boolean }>`
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  background: ${(p) => (p.$flash ? p.theme.color.danger : p.theme.color.dangerBg)};
  color: ${(p) => (p.$flash ? p.theme.color.bg : p.theme.color.danger)};
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  transition:
    background-color 150ms ease,
    color 150ms ease;
`;

// Design spec §5.2: "a small heart button at the row's right edge... rendered on every
// NON-missing row, filled when favorited, hollow-on-hover otherwise." Occupies the same
// right-edge slot MissingBadge does — the two are mutually exclusive (`!row.missing` /
// `row.missing`), which is the visual expression of "missing rows are read-only for the user
// layer."
//
// Drag-hazard fix (review round 1): `Row` is `draggable` with its own `onDragStart` (native HTML5
// drag, armed on mousedown+move — a SEPARATE event path from `click`). A click on this 20×20
// button with slight cursor drift can resolve as a drag start on `Row` instead of a click on the
// button, kicking off a real OS file-drag from what looked like a favorite click; Chromium then
// typically suppresses the following `click`, so the favorite silently doesn't toggle either.
// `-webkit-user-drag: none` (Electron = Chromium, so this is safe) stops the button itself from
// ever seeding a drag; `draggable={false}` and the `onMouseDown` stopPropagation below (JSX)
// are the other two layers — belt/suspenders since no unit test can drive a native drag gesture.
const HeartButton = styled.button<{ $favorite: boolean }>`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: transparent;
  color: ${(p) => (p.$favorite ? p.theme.color.accent : p.theme.color.textFaint)};
  cursor: pointer;
  -webkit-user-drag: none;

  &:hover {
    color: ${(p) => p.theme.color.accentStrong};
  }
`;

// A local copy of LibraryRail's own HeartIcon, not an import — this task's file scope is
// SampleRow.tsx/SampleList.tsx only, and LibraryRail's isn't exported. The two also differ in
// substance, not just packaging: the rail's glyph is always filled/accent (it marks a fixed
// "Favorites" row), this one toggles filled vs. hollow off `row.favorite` per row. Same
// inline-SVG reasoning as both (and App.tsx's GearIcon/ChevronIcon): a system-font heart dingbat
// renders inconsistently across platforms.
function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export interface SampleRowProps {
  row: SampleRowData;
  selected: boolean;
  /** Already resolved by the caller from `peaksCache` — may be a real decode. This component
   * still independently re-checks `row.missing`/`row.peaksFailed` below before ever handing it to
   * `WaveformThumb`, rather than trusting the caller got that right (the brief's "never try to
   * draw a failed row's blob" is treated as a rule worth enforcing twice, not once). */
  peaks: ArrayBuffer | null;
  top: number;
  onSelect: () => void;
  /** Design spec §5.2: "click toggles without changing selection or playback." This component
   * only renders the button and forwards the click — same "no store reads" posture as `onSelect`
   * above. SampleList supplies `() => userLayer.toggleFavorite(row)`. */
  onToggleFavorite: () => void;
}

export function SampleRow({
  row,
  selected,
  peaks,
  top,
  onSelect,
  onToggleFavorite,
}: SampleRowProps) {
  const drawablePeaks = row.missing || row.peaksFailed ? null : peaks;

  // Splice chips first, then user chips, SLICED TOGETHER against one MAX_INLINE_TAGS budget
  // (design spec §5.2: "after Splice's within the same +N overflow budget") — two independent
  // slices would let a row with 3 Splice tags AND 3 user tags show 6 chips before ever
  // overflowing, silently doubling the row's real budget.
  const spliceChips = row.tags.map((t) => <Chip key={`splice-${t}`}>{t}</Chip>);
  const userChips = row.userTags.map((t) => (
    <UserChip key={`user-${t}`} data-testid="user-tag-chip">
      {t}
    </UserChip>
  ));
  const allChips = [...spliceChips, ...userChips];
  const extraChipCount = allChips.length - MAX_INLINE_TAGS;

  // Local, non-MobX UI state — a transient flash has no business in the stores (per-row,
  // never read by anything else) and doesn't conflict with this component's existing
  // prop-driven-only doc comment (top of file): it's still a pure function of `row`/`peaks`/etc.
  // for RENDER purposes, this just also reacts to its own DOM events.
  const [badgeFlash, setBadgeFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Row instances are recreated per `row.id` (SampleList keys on it), but virtualization can
  // still unmount a row (scrolled out) while its flash timeout is pending — clear it rather than
  // let a stray `setBadgeFlash` fire after unmount.
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current !== null) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  // spec §8 / brief Step 1: cancel the HTML5 drag unconditionally (the documented Electron
  // pattern — `preventDefault` stops the browser's own drag-and-drop so the NATIVE
  // `webContents.startDrag` can take over instead), then either start the real drag or, for a
  // missing row, refuse and flash the badge instead.
  const handleDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (row.missing) {
      setBadgeFlash(true);
      if (flashTimeoutRef.current !== null) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setBadgeFlash(false), BADGE_FLASH_MS);
      return;
    }
    void api.startDrag(row.id);
  };

  // Row's own onClick (below) would otherwise select the row on bubble — favoriting must not
  // move the selection or touch playback (design spec §5.2).
  const handleFavoriteClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onToggleFavorite();
  };

  return (
    <Row
      $top={top}
      $selected={selected}
      $missing={row.missing}
      draggable={!row.missing}
      onDragStart={handleDragStart}
      onClick={row.missing ? undefined : onSelect}
      role="option"
      aria-selected={selected}
    >
      <ThumbWrap>
        <WaveformThumb peaks={drawablePeaks} width={THUMB_WIDTH} height={THUMB_HEIGHT} />
        {!row.missing && row.peaksFailed && <CorruptBadge title="couldn't decode">!</CorruptBadge>}
      </ThumbWrap>
      <Filename title={row.filename}>
        {middleTruncate(row.nickname ?? row.filename)}
        {row.nickname !== null && <DimmedReal>{middleTruncate(row.filename, 24)}</DimmedReal>}
      </Filename>
      <PackName title={row.packName ?? undefined}>{row.packName ?? '—'}</PackName>
      <KeyCell>{formatKey(row.audioKey, row.chordType)}</KeyCell>
      <BpmCell>{row.bpm ?? '—'}</BpmCell>
      <DurationCell>{formatDuration(row.durationMs)}</DurationCell>
      <Tags>
        {allChips.slice(0, MAX_INLINE_TAGS)}
        {extraChipCount > 0 && <Chip>+{extraChipCount}</Chip>}
      </Tags>
      {!row.missing && (
        <HeartButton
          type="button"
          draggable={false}
          $favorite={row.favorite}
          aria-pressed={row.favorite}
          aria-label="Favorite"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleFavoriteClick}
        >
          <HeartIcon filled={row.favorite} />
        </HeartButton>
      )}
      {row.missing && (
        <MissingBadge data-testid="missing-badge" $flash={badgeFlash}>
          missing
        </MissingBadge>
      )}
    </Row>
  );
}
