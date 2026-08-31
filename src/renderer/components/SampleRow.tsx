// One virtualized list row (Task 13 brief). Fixed 40px height — `ROW_HEIGHT` is exported so
// SampleList's `useVirtualizer({ estimateSize: () => ROW_HEIGHT })` and this file's own CSS read
// the SAME literal instead of two independently-maintained "40"s. Prop-driven only (no
// `observer`, no store reads) — SampleList (itself an `observer`) already resolves `row`/
// `selected`/`peaks` from the stores before they reach here, so a plain re-render on new props is
// enough; wrapping this in `observer` too would just be inert overhead.
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import styled, { css, useTheme } from 'styled-components';
import { formatDuration, formatKey } from '../../shared/keyDisplay';
import type { SampleRow as SampleRowData } from '../../shared/ipcTypes';
import { sharedCoverCache } from '../coverCache';
import { dragCardMeta, renderDragCard } from '../dragImage';
import { armDragSource, clearDragSource } from '../dragSource';
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

// Nickname inline editor (Task 11 brief / design spec §5.3) — replaces `Filename` in place when
// `editingNickname` is true. `flex: 2; min-width: 0;` mirrors `Filename`'s own sizing so swapping
// between display/edit never shifts the row's other columns. Colors match `LibraryRail`'s own
// `TextInput` (its rename/create editors) for one consistent "editing" look app-wide.
//
// Drag-hazard guards: this input sits INSIDE `Row`, which is `draggable` and arms its native HTML5
// drag on mousedown+move — a path separate from `click`/`keydown` (the same hazard `HeartButton`
// above documents and guards against). `-webkit-user-drag: none` here plus `draggable={false}` and
// `onMouseDown` stopPropagation in the JSX usage below are that same three-layer pattern. A FOURTH
// guard beyond `HeartButton`'s three: `onClick` stopPropagation, so a click landing inside the
// input to place the caret doesn't bubble to `Row`'s own `onClick` and re-trigger `onSelect`
// (HeartButton never needed this — its own `onClick` already calls `stopPropagation` as part of
// toggling favorite; a text input has no such handler of its own to piggyback on). `onKeyDown`
// also stops propagation unconditionally, not just for Enter/Escape: the list container (out of
// this file's scope) binds ArrowLeft to `player.replay()` and ArrowUp/ArrowDown to selection
// movement, so moving the text cursor while editing would otherwise retrigger preview playback or
// walk the selection out from under the edit — the same "editing never re-triggers row
// selection/preview" contract the click guard exists for, extended to keyboard bubbling.
const NicknameInput = styled.input`
  flex: 2;
  min-width: 0;
  padding: 2px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.accent};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.text};
  font-size: 13px;
  -webkit-user-drag: none;
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

// Cross-navigation cells (QoL round 2, 2026-08-20): pack / key / bpm / tag read as plain text but
// behave as links — click one and the browse state follows it. Styled to be VISUALLY identical to
// the span they replace (`font: inherit`, no chrome) so a row still reads as a row, with the
// affordance appearing on hover only; a row full of obviously-buttonish cells would be noise at
// 40px tall.
//
// `-webkit-user-drag: none` is the first of the same three drag guards HeartButton documents in
// full: `Row` is `draggable` and arms a native OS file-drag on mousedown+move, a path entirely
// separate from `click`. Without them, a click with slight cursor drift starts a real file drag
// instead of following the link, and Chromium then suppresses the click that would have. The
// other two (`draggable={false}`, `onMouseDown` stopPropagation) ride on every usage below via
// `linkProps`.
const cellLink = css`
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: inherit;
  cursor: pointer;
  -webkit-user-drag: none;

  &:hover {
    color: ${(p) => p.theme.color.accentStrong};
    text-decoration: underline;
  }
`;

// The pack column is wide and its name usually short, so the LINK hugs its text and the cell
// around it stays inert: clicking the empty space to the right of a pack name still selects the
// row (and previews it), the way clicking any other blank part of the row does. Only the name
// itself navigates.
const PackCell = styled.span`
  flex: 1;
  min-width: 0;
  display: flex;
`;

const PackLink = styled.button`
  ${cellLink}
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 12px;
`;

const KeyLink = styled.button`
  ${cellLink}
  width: 44px;
  flex-shrink: 0;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
  text-align: left;
`;

const BpmLink = styled.button`
  ${cellLink}
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

const chipShape = css`
  padding: 1px 6px;
  border-radius: ${(p) => p.theme.radius.pill};
  font-size: 10px;
  white-space: nowrap;
`;

// The +N overflow indicator — the one chip that stays inert, because "3 more tags" isn't a tag
// anything could filter by.
const Chip = styled.span`
  ${chipShape}
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.textMuted};
`;

// Splice tag chips, clickable since QoL round 2: one click adds the tag to the active filter (and
// a second removes it — `toggleTag`). Same drag guards as the cell links above.
const ChipButton = styled.button`
  ${chipShape}
  border: none;
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.textMuted};
  font-family: inherit;
  cursor: pointer;
  -webkit-user-drag: none;

  &:hover {
    color: ${(p) => p.theme.color.text};
  }
`;

// User tags (design spec §5.2: "accent-outlined, after Splice's within the same +N overflow
// budget") — extends ChipButton's shape/padding/font-size, only the fill/border differ. Same
// outline-on-accent idiom FilterPanel's active `TagChip` already uses for "this chip is
// accent-relevant" (transparent fill, 1px accent border, accentStrong text). Filterable on the
// same footing as a Splice tag: querySamples' `tags` filter matches EITHER source per name.
const UserChip = styled(ChipButton)`
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

/** What a row's clickable cells mean, resolved into browse actions by SampleList (the one place
 * that already holds the stores). A tagged union rather than four separate callback props: the
 * row's job is to say WHICH link was followed, never to know what following it does. */
export type RowLink =
  | { kind: 'pack'; packId: number }
  | { kind: 'key'; audioKey: string }
  | { kind: 'bpm'; bpm: number }
  | { kind: 'tag'; name: string };

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
  /** Task 11 (design spec §5.3): true when this row is mid-nickname-edit
   * (`userLayer.nicknameEditId === row.id`) — pre-resolved by the caller into a boolean, the same
   * shape `selected` above already takes, rather than handing this component the raw id to
   * compare itself. */
  editingNickname: boolean;
  /** Enter in the nickname input calls this with the trimmed value, or `null` for an empty
   * (post-trim) input — design spec §5.3: "empty clears the nickname." SampleList wires this to
   * `userLayer.setNickname(row.id, nickname)` followed by `userLayer.stopNicknameEdit()`. */
  onCommitNickname: (nickname: string | null) => void;
  /** Esc in the nickname input calls this. SampleList wires this to
   * `userLayer.stopNicknameEdit()`. */
  onCancelNicknameEdit: () => void;
  /** A pack/key/bpm/tag cell was clicked. Like `onToggleFavorite`, this never changes selection or
   * playback — following a link is navigation, not a row action. */
  onFollowLink: (link: RowLink) => void;
}

export function SampleRow({
  row,
  selected,
  peaks,
  top,
  onSelect,
  onToggleFavorite,
  editingNickname,
  onCommitNickname,
  onCancelNicknameEdit,
  onFollowLink,
}: SampleRowProps) {
  const drawablePeaks = row.missing || row.peaksFailed ? null : peaks;
  // Read here rather than inside `buildDragIcon` so the drag card is painted in the SAME palette
  // the row is currently rendered in — the card is drawn on a bare canvas with no CSS cascade to
  // inherit from, so every color it uses has to be handed over explicitly.
  const theme = useTheme();

  // The shared wiring every clickable cell needs: follow the link, and don't let the click reach
  // `Row` (whose own onClick selects the row and starts a preview) or seed a native file drag.
  // See `cellLink`'s doc comment for why the drag guards are three layers deep.
  const linkProps = (link: RowLink) => ({
    type: 'button' as const,
    draggable: false,
    onMouseDown: (e: MouseEvent<HTMLButtonElement>) => e.stopPropagation(),
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onFollowLink(link);
    },
  });

  // Splice chips first, then user chips, SLICED TOGETHER against one MAX_INLINE_TAGS budget
  // (design spec §5.2: "after Splice's within the same +N overflow budget") — two independent
  // slices would let a row with 3 Splice tags AND 3 user tags show 6 chips before ever
  // overflowing, silently doubling the row's real budget.
  // Every link below carries an explicit `aria-label` rather than letting its visible text become
  // the accessible name. Two reasons, one of them load-bearing: a chip reading just "bounce" would
  // be indistinguishable by role+name from TagsPopover's own "bounce" suggestion button (an
  // ambiguity that breaks any strict locator addressing either), and "Filter by tag bounce" says
  // what the control DOES, which a bare tag name doesn't.
  const spliceChips = row.tags.map((t) => (
    <ChipButton key={`splice-${t}`} aria-label={`Filter by tag ${t}`} {...linkProps({ kind: 'tag', name: t })}>
      {t}
    </ChipButton>
  ));
  const userChips = row.userTags.map((t) => (
    <UserChip
      key={`user-${t}`}
      data-testid="user-tag-chip"
      aria-label={`Filter by tag ${t}`}
      {...linkProps({ kind: 'tag', name: t })}
    >
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

  // The drag card (dragImage.ts), painted from what this row is ALREADY showing: the same peaks
  // `WaveformThumb` just drew, the same name/pack/bpm/key the cells hold, and the pack art
  // SampleList warmed for the visible range. Everything is read synchronously — by the time an
  // `<img>` could load or an IPC round-trip could answer, the OS drag session has already begun
  // with whatever icon it was handed, so anything not ready right now is simply left off the card
  // (a coverless pack gets the lettered tile, an undecoded sample gets the flat line).
  //
  // Never allowed to break the drag: `renderDragCard` touches `document`/canvas, and a null return
  // just means main uses its own generated square instead (`resolveDragIcon`, drag.ts).
  const buildDragIcon = (): string | null => {
    try {
      return renderDragCard(
        {
          title: row.nickname ?? row.filename,
          subtitle: row.packName ?? '',
          meta: dragCardMeta(row),
          peaks: drawablePeaks,
          cover: row.packId === null ? null : sharedCoverCache().get(row.packId),
          colors: theme.color,
        },
        window.devicePixelRatio || 1,
      );
    } catch (e) {
      // Degrading silently is the right BEHAVIOUR (main's plain square still drags the file), but
      // silently is not the right way to find out: this exact catch hid a canvas-taint failure for
      // a whole debugging session (2026-08-31) because a fallback icon looks identical to a card
      // that was never attempted.
      console.warn('[ntwine] drag card render failed; falling back to the plain icon', e);
      return null;
    }
  };

  // spec §8 / brief Step 1: cancel the HTML5 drag unconditionally (the documented Electron
  // pattern — `preventDefault` stops the browser's own drag-and-drop so the NATIVE
  // `webContents.startDrag` can take over instead), then either start the real drag or, for a
  // missing row, refuse and flash the badge instead.
  //
  // Task 13 / spec §7: a real drag also arms the renderer-owned drag-source slot BEFORE invoking
  // `startDrag` — the only way LibraryRail's drop targets can tell this native row drag from an
  // external Finder/Explorer file drag once `preventDefault` has cancelled our own HTML5 drag
  // session. `startDrag`'s invoke resolves when the OS drag session ends (immediately under e2e —
  // drag.ts's own doc comment); the `finally` clears the slot with the SAME token it armed, so a
  // rejected invoke or a thrown handler can never leave a stale id behind, and a drop that already
  // consumed the slot (or a fast second drag) is never clobbered by this arriving late.
  const handleDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (row.missing) {
      setBadgeFlash(true);
      if (flashTimeoutRef.current !== null) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setBadgeFlash(false), BADGE_FLASH_MS);
      return;
    }
    const token = armDragSource(row.id);
    void (async () => {
      try {
        await api.startDrag(row.id, buildDragIcon());
      } finally {
        clearDragSource(token);
      }
    })();
  };


  // Row's own onClick (below) would otherwise select the row on bubble — favoriting must not
  // move the selection or touch playback (design spec §5.2).
  const handleFavoriteClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onToggleFavorite();
  };

  // Nickname editor commit/cancel (Task 11, design spec §5.3). Uncontrolled input
  // (`defaultValue`, read via `e.currentTarget.value` on Enter) rather than React-controlled
  // state: the input only exists in the tree while `editingNickname` is true (conditional
  // rendering below swaps it in for `Filename`), so it always mounts fresh with the row's CURRENT
  // nickname as its starting value — no separate effect needed to reset a controlled draft when
  // editing starts. `e.stopPropagation()` unconditionally, see `NicknameInput`'s own doc comment
  // above for why this covers more than just Enter/Escape.
  const handleNicknameKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const trimmed = e.currentTarget.value.trim();
      onCommitNickname(trimmed === '' ? null : trimmed);
    } else if (e.key === 'Escape') {
      onCancelNicknameEdit();
    }
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
      {editingNickname ? (
        <NicknameInput
          aria-label="Nickname"
          autoFocus
          defaultValue={row.nickname ?? ''}
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleNicknameKeyDown}
        />
      ) : (
        <Filename title={row.filename}>
          {middleTruncate(row.nickname ?? row.filename)}
          {row.nickname !== null && <DimmedReal>{middleTruncate(row.filename, 24)}</DimmedReal>}
        </Filename>
      )}
      {/* Each cell is a link only when it has something to navigate TO — a sample with no pack,
          no detected key, or no bpm keeps the inert span, so there's never a button that does
          nothing when clicked. */}
      {/* Each cell carries a stable testid on BOTH branches. Cells used to be addressable only by
          child position (`:scope > span` + an index), which stopped working the moment a cell could
          be either a span or a button depending on whether its value exists — the index then means
          different things on different rows. */}
      {row.packId !== null && row.packName !== null ? (
        <PackCell data-testid="row-pack">
          <PackLink
            title={row.packName}
            aria-label={`Show pack ${row.packName}`}
            {...linkProps({ kind: 'pack', packId: row.packId })}
          >
            {row.packName}
          </PackLink>
        </PackCell>
      ) : (
        <PackName data-testid="row-pack">—</PackName>
      )}
      {row.audioKey !== null ? (
        <KeyLink
          data-testid="row-key"
          aria-label={`Filter by key ${formatKey(row.audioKey, null)}`}
          {...linkProps({ kind: 'key', audioKey: row.audioKey })}
        >
          {formatKey(row.audioKey, row.chordType)}
        </KeyLink>
      ) : (
        <KeyCell data-testid="row-key">{formatKey(row.audioKey, row.chordType)}</KeyCell>
      )}
      {row.bpm !== null ? (
        <BpmLink
          data-testid="row-bpm"
          aria-label={`Filter by ${row.bpm} BPM`}
          {...linkProps({ kind: 'bpm', bpm: row.bpm })}
        >
          {row.bpm}
        </BpmLink>
      ) : (
        <BpmCell data-testid="row-bpm">—</BpmCell>
      )}
      <DurationCell data-testid="row-duration">{formatDuration(row.durationMs)}</DurationCell>
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
