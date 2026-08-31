// The picture that hangs off the cursor while you drag a sample out of Ntwine into a DAW or a
// file manager (2026-08-31). Before this module, `webContents.startDrag` got `makeDragIcon()`'s
// 24x24 flat brown square (src/main/drag.ts) — an icon that exists only because macOS refuses an
// empty one, and which tells you nothing about what you grabbed.
//
// Why the RENDERER draws it: `startDrag`'s `icon` is a `NativeImage` built in main, and main has
// no text shaping, no image compositing and no theme. The renderer already has all three plus the
// exact ingredients — waveform peaks (`LibraryStore.peaksCache`), pack cover art (`cover://p/<id>`,
// warmed by coverCache.ts) and every metadata field — so it paints a 2D canvas, hands main a PNG
// data URL, and main only decodes it (`resolveDragIcon`, drag.ts).
//
// Testability seam: the node test environment (`vitest.config.ts`, `environment: 'node'`) has no
// canvas at all, so the drawing is split in two. `drawDragCard` takes a `DragCardCtx` — a
// structural subset of `CanvasRenderingContext2D`, which a real context satisfies — and is
// exercised in dragImage.test.ts against a recording fake. `renderDragCard` is the untestable
// three-line wrapper that makes the canvas and reads the pixels back out.
import type { SampleRow } from '../shared/ipcTypes';
import { formatDuration, formatKey } from '../shared/keyDisplay';
import { theme } from './components/theme';

/**
 * Card geometry in DEVICE pixels — the bitmap is drawn 1:1 at these numbers, and `renderDragCard`
 * tags it with the display's own scale factor so the OS draws it at exactly this pixel size.
 *
 * WIDTH IS A HARD CONSTRAINT, NOT A TASTE DECISION. Windows clips the drag image to roughly 210
 * device pixels wide; height it leaves alone (measured at 85, 93 and 136px across three real
 * drags). A wider card is not shown smaller, it is shown CUT — centred, losing the cover art off
 * one side and the meta off the other. This was diagnosed by shipping a build whose card carried a
 * magenta outline and a printed ruler, then reading which ruler marks survived a real drag
 * (2026-08-31): a 224-wide card was drawn at 336 and chopped to the middle 207. Nothing on either
 * side of the IPC bridge can see this happen, so 192 is chosen with headroom under the limit and
 * MUST NOT be raised without repeating that measurement.
 *
 * The layout answers the constraint by growing downward instead: title, pack, and bpm/key/duration
 * stack as three short lines beside the cover, and the waveform gets a full-width, 38px-tall band
 * underneath — considerably more waveform than the 12px strip the wide card could afford.
 */
export const DRAG_CARD = {
  width: 192,
  height: 96,
  pad: 6,
  radius: 8,
  coverSize: 36,
  coverRadius: 5,
  gap: 8,
  titleBaseline: 19,
  subtitleBaseline: 32,
  metaBaseline: 44,
  waveTop: 52,
  waveHeight: 38,
} as const;

/** Left edge of the stacked text lines: past the cover thumbnail and its gap. */
const CONTENT_X = DRAG_CARD.pad + DRAG_CARD.coverSize + DRAG_CARD.gap;
/** Right edge of the card's content box. */
const CONTENT_RIGHT = DRAG_CARD.width - DRAG_CARD.pad;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_X;
/** The waveform is the one element that ignores the cover column and spans the whole card. */
const WAVE_X = DRAG_CARD.pad;
const WAVE_WIDTH = CONTENT_RIGHT - WAVE_X;

const TITLE_FONT = `600 12px ${theme.font.family}`;
const SUBTITLE_FONT = `10px ${theme.font.family}`;
const META_FONT = `10px ${theme.font.family}`;
const INITIAL_FONT = `600 18px ${theme.font.family}`;

/**
 * The card's third line: bpm, key, duration — only the ones this sample actually has.
 * Deliberately NOT `formatKey`/`formatDuration`'s own em-dash "unknown" output, which is the right
 * answer for a fixed-width table column (SampleRow) and the wrong one here: a card reading
 * "— · — · —" spends its scarcest resource, width, saying nothing. An absent part is simply absent,
 * and a sample with none of the three gets an empty line rather than a row of placeholders.
 */
export function dragCardMeta(row: SampleRow): string {
  const parts: string[] = [];
  if (row.bpm !== null) parts.push(String(row.bpm));
  if (row.audioKey !== null) parts.push(formatKey(row.audioKey, row.chordType));
  if (row.durationMs !== null) parts.push(formatDuration(row.durationMs));
  return parts.join(' · ');
}

/**
 * Shortens `text` until `measure` says it fits `maxWidth`, appending an ellipsis when it had to
 * cut. Unlike `SampleRow`'s `middleTruncate` — a character-count heuristic chosen there because
 * per-row text measurement in a virtualized list is a real perf risk — this measures for real:
 * it runs once per drag gesture, on one string, against a canvas context that can measure exactly.
 *
 * Returns `''` rather than a lone `'…'` when even one character plus the ellipsis overruns, so a
 * pathologically narrow box degrades to blank space instead of visible garbage.
 */
export function fitText(text: string, maxWidth: number, measure: (t: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  for (let len = text.length - 1; len > 0; len--) {
    const candidate = `${text.slice(0, len)}…`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  return '';
}

/**
 * The subset of `CanvasRenderingContext2D` this card uses. A real 2D context is structurally
 * assignable to it (see `renderDragCard`); the point of naming the subset is that
 * dragImage.test.ts can supply a recording fake under `environment: 'node'`, where no canvas
 * implementation exists to render against.
 */
export interface DragCardCtx {
  // Widened to the real `CanvasRenderingContext2D` union (this card only ever assigns strings)
  // because these are MUTABLE properties: narrowing them to `string` would make a real context
  // un-assignable to this interface, which is the one thing the subset has to preserve.
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

export interface DragCardColors {
  bg: string;
  border: string;
  /** The card's outline. Stronger than `border` on purpose — see `drawBackground`. */
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
}

export interface DragCardInput {
  /** The name the user sees on the row — nickname when set, filename otherwise. */
  title: string;
  /** Pack name, and the source of the fallback tile's letter when no cover art is available. */
  subtitle: string;
  /** `dragCardMeta`'s output; `''` draws nothing at all rather than an empty line. */
  meta: string;
  /** Same `Int8Array`-backed buffer `WaveformThumb` draws; `null` = not decoded (or undrawable). */
  peaks: ArrayBuffer | null;
  /** A fully-loaded cover image, or `null` to draw the lettered fallback tile instead. */
  cover: CanvasImageSource | null;
  colors: DragCardColors;
}

/**
 * Rounded panel + outline: the card reads as one of the app's own surfaces, not a screenshot.
 *
 * `borderStrong` rather than the `border` a panel inside the app would use. This surface floats
 * over whatever the user is dragging INTO — its own dark list, a DAW, a file manager — with no
 * guarantee of contrast behind it, and the app's hairline border disappeared entirely against
 * Ntwine's own background. The outline is also the thing that makes clipping visible at a glance:
 * if an edge is missing, you can see it is missing.
 */
function drawBackground(ctx: DragCardCtx, colors: DragCardColors): void {
  ctx.beginPath();
  // Inset by half the stroke width so the 1px border lands ON the card edge rather than
  // straddling it and coming out blurry.
  ctx.roundRect(0.5, 0.5, DRAG_CARD.width - 1, DRAG_CARD.height - 1, DRAG_CARD.radius);
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.strokeStyle = colors.borderStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * The cover thumbnail. With art: clipped to a rounded square and drawn to fill the slot. Without:
 * the pack's initial on a muted tile — the same "cover download failed -> generic tile" fallback
 * `PackRail`'s `PackCover` already gives the sidebar, so a pack whose art never downloaded looks
 * deliberate here too. Neither branch uses the accent color, which keeps "an accent fillRect is a
 * waveform bar" true for the whole card.
 */
function drawCover(ctx: DragCardCtx, input: DragCardInput): void {
  const { pad, coverSize, coverRadius } = DRAG_CARD;
  if (input.cover !== null) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad, pad, coverSize, coverSize, coverRadius);
    ctx.clip();
    ctx.drawImage(input.cover, pad, pad, coverSize, coverSize);
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.roundRect(pad, pad, coverSize, coverSize, coverRadius);
  ctx.fillStyle = input.colors.border;
  ctx.fill();

  const initial = (input.subtitle || input.title).trim().charAt(0).toUpperCase();
  if (initial === '') return;
  ctx.font = INITIAL_FONT;
  ctx.fillStyle = input.colors.textMuted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initial, pad + coverSize / 2, pad + coverSize / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/**
 * The waveform strip, drawn from the SAME 200 min/max Int8 pairs and the same +-127 scaling
 * `WaveformThumb` uses, so the silhouette matches the row exactly. `null` peaks (never decoded, or
 * a `peaksFailed` row the caller refused to hand over) get the flat centre line rather than a gap.
 */
function drawWaveform(ctx: DragCardCtx, peaks: ArrayBuffer | null, colors: DragCardColors): void {
  const { waveTop, waveHeight } = DRAG_CARD;
  const centre = waveTop + waveHeight / 2;

  if (peaks === null) {
    ctx.strokeStyle = colors.textFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(WAVE_X, centre);
    ctx.lineTo(CONTENT_RIGHT, centre);
    ctx.stroke();
    return;
  }

  const view = new Int8Array(peaks);
  const buckets = Math.floor(view.length / 2);
  if (buckets <= 0) return;

  const barPitch = WAVE_WIDTH / buckets;
  ctx.fillStyle = colors.accent;
  for (let i = 0; i < buckets; i++) {
    const min = view[i * 2];
    const max = view[i * 2 + 1];
    const yTop = centre - (max / 127) * (waveHeight / 2);
    const yBottom = centre - (min / 127) * (waveHeight / 2);
    ctx.fillRect(WAVE_X + i * barPitch, yTop, Math.max(1, barPitch - 0.5), Math.max(1, yBottom - yTop));
  }
}

/** Title, pack name, and the right-aligned meta line — each measured against the content box. */
function drawText(ctx: DragCardCtx, input: DragCardInput): void {
  const measureWith = (font: string) => (t: string) => {
    ctx.font = font;
    return ctx.measureText(t).width;
  };

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = TITLE_FONT;
  ctx.fillStyle = input.colors.text;
  ctx.fillText(fitText(input.title, CONTENT_WIDTH, measureWith(TITLE_FONT)), CONTENT_X, DRAG_CARD.titleBaseline);

  // Pack name and meta each get their OWN full-width line. They used to share one, right-aligned
  // against each other, which was the best a 60px-tall card could do; the tall card has the room to
  // stop rationing it, and every line now truncates against the same single budget.
  if (input.subtitle !== '') {
    ctx.font = SUBTITLE_FONT;
    ctx.fillStyle = input.colors.textMuted;
    ctx.fillText(
      fitText(input.subtitle, CONTENT_WIDTH, measureWith(SUBTITLE_FONT)),
      CONTENT_X,
      DRAG_CARD.subtitleBaseline,
    );
  }

  if (input.meta !== '') {
    ctx.font = META_FONT;
    ctx.fillStyle = input.colors.textFaint;
    ctx.fillText(
      fitText(input.meta, CONTENT_WIDTH, measureWith(META_FONT)),
      CONTENT_X,
      DRAG_CARD.metaBaseline,
    );
  }
}

/** Paints the whole card. Draw order is back-to-front: panel, cover, waveform, then text. */
export function drawDragCard(ctx: DragCardCtx, input: DragCardInput): void {
  drawBackground(ctx, input.colors);
  drawCover(ctx, input);
  drawWaveform(ctx, input.peaks, input.colors);
  drawText(ctx, input);
}

/** What `startDrag` carries to main: the PNG bytes, and the factor they must be tagged with. */
export interface DragImage {
  dataUrl: string;
  scaleFactor: number;
}

/**
 * Renders the card 1:1 into a `DRAG_CARD.width x DRAG_CARD.height` bitmap and pairs it with
 * `scaleFactor` (the display's `devicePixelRatio`), which main hands to `createFromBuffer`.
 *
 * That pairing is what pins the card's on-screen size, and the reasoning runs backwards from a
 * measurement rather than from the API's intent. What the OS actually draws is
 * `bitmap_pixels x display_scale / tagged_scale`. Tag nothing (scale 1) and a 192px card is drawn
 * at 288 on a 1.5x display — past the ~210px clip. Tag the display's own factor and the two cancel:
 * the card is drawn at exactly its bitmap size, on every display, which is the only variant of this
 * that is predictable enough to size against a hard limit.
 *
 * The cost is honest and small: the bitmap is 1:1 with the screen, so on a hidpi display the card
 * is physically smaller than the same number of CSS pixels elsewhere in the app. It is crisp
 * either way — the alternative is a bigger card with its edges cut off.
 *
 * `null` when the canvas has no 2D context (`startDrag` then falls back to main's generated icon).
 */
export function renderDragCard(input: DragCardInput, scaleFactor: number): DragImage | null {
  const canvas = document.createElement('canvas');
  canvas.width = DRAG_CARD.width;
  canvas.height = DRAG_CARD.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  drawDragCard(ctx, input);
  return { dataUrl: canvas.toDataURL('image/png'), scaleFactor };
}
