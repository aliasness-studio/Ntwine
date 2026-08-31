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
 * Card geometry in CSS pixels. The bitmap is drawn at `scaleFactor x` this (renderDragCard) and
 * main tags it with the same factor, so the OS still lays the drag image out at THESE numbers.
 *
 * Three stacked lines to the right of the cover: title, then pack name with the bpm/key/duration
 * line right-aligned ALONGSIDE it, then the waveform across the full content width. Pairing the
 * two small text lines is what buys the waveform its width — the first cut gave the waveform 96px
 * (`SampleRow`'s `THUMB_WIDTH`) and put the meta beside it, which left the meta 52px and truncated
 * a perfectly ordinary "128 · A min" to "128 · A m…". The waveform is the most useful thing on the
 * card, so it gets the whole line.
 */
export const DRAG_CARD = {
  width: 224,
  height: 60,
  pad: 6,
  radius: 8,
  coverSize: 48,
  coverRadius: 6,
  gap: 8,
  titleBaseline: 22,
  /** Pack name (left) and meta (right) share this baseline. */
  subtitleBaseline: 36,
  waveTop: 42,
  waveHeight: 12,
} as const;

/** Left edge of every text/waveform element: past the cover thumbnail and its gap. */
const CONTENT_X = DRAG_CARD.pad + DRAG_CARD.coverSize + DRAG_CARD.gap;
/** Right edge of the card's content box — where right-aligned text lands. */
const CONTENT_RIGHT = DRAG_CARD.width - DRAG_CARD.pad;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_X;

const TITLE_FONT = `600 12px ${theme.font.family}`;
const SUBTITLE_FONT = `10px ${theme.font.family}`;
const META_FONT = `10px ${theme.font.family}`;
const INITIAL_FONT = `600 20px ${theme.font.family}`;

/**
 * The right-aligned facts line: bpm, key, duration — only the ones this sample actually has.
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
  /** `dragCardMeta`'s output; `''` draws nothing at all rather than an empty right-aligned slot. */
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
    ctx.moveTo(CONTENT_X, centre);
    ctx.lineTo(CONTENT_RIGHT, centre);
    ctx.stroke();
    return;
  }

  const view = new Int8Array(peaks);
  const buckets = Math.floor(view.length / 2);
  if (buckets <= 0) return;

  const barPitch = CONTENT_WIDTH / buckets;
  ctx.fillStyle = colors.accent;
  for (let i = 0; i < buckets; i++) {
    const min = view[i * 2];
    const max = view[i * 2 + 1];
    const yTop = centre - (max / 127) * (waveHeight / 2);
    const yBottom = centre - (min / 127) * (waveHeight / 2);
    ctx.fillRect(CONTENT_X + i * barPitch, yTop, Math.max(1, barPitch - 0.5), Math.max(1, yBottom - yTop));
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

  // The meta line is laid out FIRST even though it is drawn second: bpm/key/duration is a short,
  // bounded, high-value string, whereas a pack name is arbitrarily long and the least missable
  // thing on the card (the cover art already says which pack this is). So meta takes the width it
  // needs and the pack name gets what's left — never the other way round.
  const meta = input.meta === '' ? '' : fitText(input.meta, CONTENT_WIDTH, measureWith(META_FONT));
  const metaWidth = meta === '' ? 0 : measureWith(META_FONT)(meta);

  if (input.subtitle !== '') {
    const subtitleBudget = CONTENT_WIDTH - (metaWidth === 0 ? 0 : metaWidth + DRAG_CARD.gap);
    ctx.font = SUBTITLE_FONT;
    ctx.fillStyle = input.colors.textMuted;
    ctx.fillText(
      fitText(input.subtitle, subtitleBudget, measureWith(SUBTITLE_FONT)),
      CONTENT_X,
      DRAG_CARD.subtitleBaseline,
    );
  }

  if (meta !== '') {
    ctx.font = META_FONT;
    ctx.fillStyle = input.colors.textFaint;
    ctx.textAlign = 'right';
    ctx.fillText(meta, CONTENT_RIGHT, DRAG_CARD.subtitleBaseline);
    ctx.textAlign = 'left';
  }
}

/** Paints the whole card. Draw order is back-to-front: panel, cover, waveform, then text. */
export function drawDragCard(ctx: DragCardCtx, input: DragCardInput): void {
  drawBackground(ctx, input.colors);
  drawCover(ctx, input);
  drawWaveform(ctx, input.peaks, input.colors);
  drawText(ctx, input);
}

/**
 * Renders the card to a PNG data URL, `pixelRatio` device pixels per unit of the CSS geometry
 * above. Returns `null` when the canvas has no 2D context (`startDrag` then falls back to main's
 * generated icon).
 *
 * The bitmap is handed over as plain pixels with NO scale factor attached, and that is the whole
 * trick: an OS drag image is laid out at its LOGICAL size but blitted from its raw pixels, so any
 * image claiming to be smaller than it is gets clipped. Drawing at `pixelRatio` and declaring
 * nothing means the card occupies `width x pixelRatio` DEVICE pixels — which is exactly its
 * intended CSS size on that display, and crisp, because it was drawn at that resolution. See
 * `resolveDragIcon` (src/main/drag.ts) for the failure this replaced.
 */
export function renderDragCard(input: DragCardInput, pixelRatio: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(DRAG_CARD.width * pixelRatio);
  canvas.height = Math.round(DRAG_CARD.height * pixelRatio);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  drawDragCard(ctx, input);
  return canvas.toDataURL('image/png');
}
