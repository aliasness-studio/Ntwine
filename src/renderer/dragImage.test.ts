import { describe, expect, it } from 'vitest';
import type { SampleRow } from '../shared/ipcTypes';
import { DRAG_CARD_STYLES } from './dragCardStyle';
import {
  DRAG_CARD,
  DRAG_CARD_LAYOUTS,
  dragCardMeta,
  drawDragCard,
  fitText,
  type DragCardCtx,
} from './dragImage';

function row(over: Partial<SampleRow> = {}): SampleRow {
  return {
    id: 1,
    filename: 'AD_Kick_01.wav',
    relPath: 'Astral Drums/AD_Kick_01.wav',
    packId: 7,
    packName: 'Astral Drums',
    sampleType: 'oneshot',
    bpm: null,
    audioKey: null,
    chordType: null,
    durationMs: null,
    missing: false,
    tags: [],
    hasPeaks: false,
    peaksFailed: false,
    favorite: false,
    nickname: null,
    userTags: [],
    ...over,
  };
}

// Every draw call this card makes, in order, as `[method, ...args]` — plus the style properties
// captured AT THE MOMENT of each call, since `fillStyle` is a mutable cursor on a real 2D context
// and "what color was this bar" is otherwise unanswerable after the fact. Assertions below read
// this log rather than pixels: the node test environment has no canvas, and the thing actually
// worth pinning is the DECISIONS (cover vs. lettered fallback, bars vs. placeholder line, what
// text lands on the card) rather than antialiasing.
interface Call {
  method: string;
  args: unknown[];
  fillStyle: string;
}

function recordingCtx(charWidth = 6): { ctx: DragCardCtx; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: text.length * charWidth }),
  } as unknown as DragCardCtx;
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args, fillStyle: (ctx as { fillStyle: string }).fillStyle });
    };
  for (const method of [
    'save',
    'restore',
    'beginPath',
    'closePath',
    'moveTo',
    'lineTo',
    'roundRect',
    'clip',
    'fill',
    'stroke',
    'fillRect',
    'fillText',
    'drawImage',
  ]) {
    (ctx as unknown as Record<string, unknown>)[method] = record(method);
  }
  return { ctx, calls };
}

const COLORS = {
  bg: '#211d18',
  border: '#332e27',
  borderStrong: '#463f34',
  text: '#ece6da',
  textMuted: '#a39a8c',
  textFaint: '#655d51',
  accent: '#e0a458',
} as const;

function input(over: Partial<Parameters<typeof drawDragCard>[1]> = {}) {
  return {
    title: 'AD_Kick_01.wav',
    subtitle: 'Astral Drums',
    meta: '',
    peaks: null,
    cover: null,
    colors: COLORS,
    ...over,
  };
}

/** 200 min/max Int8 pairs, the exact shape `computePeaks` writes and `WaveformThumb` reads. */
function peaksOf(buckets: number): ArrayBuffer {
  const view = new Int8Array(buckets * 2);
  for (let i = 0; i < buckets; i++) {
    view[i * 2] = -60;
    view[i * 2 + 1] = 60;
  }
  return view.buffer;
}

function textDrawn(calls: Call[]): string[] {
  return calls.filter((c) => c.method === 'fillText').map((c) => String(c.args[0]));
}

describe('dragCardMeta', () => {
  it('joins bpm, key and duration with a middle dot', () => {
    const meta = dragCardMeta(row({ bpm: 120, audioKey: 'c#', chordType: 'minor', durationMs: 1200 }));

    expect(meta).toBe('120 · C♯ min · 1.2s');
  });

  it('omits the parts the sample does not have rather than showing an em dash for them', () => {
    expect(dragCardMeta(row({ bpm: 90 }))).toBe('90');
    expect(dragCardMeta(row({ audioKey: 'a', durationMs: 500 }))).toBe('A · 0.5s');
  });

  it('is empty when the sample has no bpm, key or duration at all', () => {
    expect(dragCardMeta(row())).toBe('');
  });
});

describe('fitText', () => {
  const measure = (t: string) => t.length * 6;

  it('returns the text unchanged when it already fits', () => {
    expect(fitText('short.wav', 200, measure)).toBe('short.wav');
  });

  it('drops characters and appends an ellipsis until the text fits', () => {
    const fitted = fitText('a_very_long_sample_filename.wav', 60, measure);

    expect(measure(fitted)).toBeLessThanOrEqual(60);
    expect(fitted.endsWith('…')).toBe(true);
    expect('a_very_long_sample_filename.wav'.startsWith(fitted.slice(0, -1))).toBe(true);
  });

  it('returns an empty string rather than a bare ellipsis when nothing fits', () => {
    expect(fitText('anything', 3, measure)).toBe('');
  });
});

describe('drawDragCard', () => {
  it('draws the supplied cover art into the card thumbnail slot', () => {
    const cover = { tag: 'cover-image' } as unknown as CanvasImageSource;
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ cover }));

    const drawn = calls.filter((c) => c.method === 'drawImage');
    expect(drawn).toHaveLength(1);
    expect(drawn[0].args).toEqual([
      cover,
      DRAG_CARD.pad,
      DRAG_CARD.pad,
      DRAG_CARD.coverSize,
      DRAG_CARD.coverSize,
    ]);
  });

  it('falls back to a tile lettered with the pack initial when there is no cover', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ cover: null, subtitle: 'astral drums' }));

    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
    expect(textDrawn(calls)).toContain('A');
  });

  it('draws one waveform bar per peak bucket, in the accent color', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ peaks: peaksOf(200) }));

    const bars = calls.filter((c) => c.method === 'fillRect' && c.fillStyle === COLORS.accent);
    expect(bars).toHaveLength(200);
  });

  it('draws a flat placeholder line instead of bars when the sample has no peaks yet', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ peaks: null }));

    expect(calls.some((c) => c.method === 'fillRect' && c.fillStyle === COLORS.accent)).toBe(false);
    expect(calls.some((c) => c.method === 'lineTo')).toBe(true);
  });

  it('writes the title, the subtitle and the meta line onto the card', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ title: 'kick.wav', subtitle: 'Astral Drums', meta: '120 · A' }));

    expect(textDrawn(calls)).toEqual(expect.arrayContaining(['kick.wav', 'Astral Drums', '120 · A']));
  });

  // Pack name and meta each own a full-width line. On the earlier 60px-tall card they shared one,
  // right-aligned against each other, and a 52px meta budget truncated a perfectly ordinary
  // "128 · A min" to "128 · A m…". The tall card has the room not to ration it.
  it('gives the pack name and the meta line a full-width line each', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ subtitle: 'Astral Drums', meta: '128 · A min · 2.0s' }));

    const written = textDrawn(calls);
    expect(written).toContain('128 · A min · 2.0s');
    expect(written).toContain('Astral Drums');
  });

  it('spans the waveform across the whole card, past the cover column', () => {
    const { ctx, calls } = recordingCtx();

    drawDragCard(ctx, input({ peaks: peaksOf(2) }));

    const bars = calls.filter((c) => c.method === 'fillRect' && c.fillStyle === COLORS.accent);
    const [firstX] = bars[0].args as number[];
    const [lastX, , lastW] = bars[1].args as number[];
    const rightEdge = DRAG_CARD.width - DRAG_CARD.pad;
    // Starts at the card's own padding, NOT at the text column — the waveform is the one element
    // that ignores the cover and uses the full width, which is where its detail comes from.
    expect(firstX).toBe(DRAG_CARD.pad);
    // Reaches the right edge without crossing it. Not exact: every bar is drawn 0.5px narrower
    // than its pitch, which is the gap that keeps adjacent bars legible as bars.
    expect(lastX + lastW).toBeGreaterThan(rightEdge - 1);
    expect(lastX + lastW).toBeLessThanOrEqual(rightEdge);
  });

});

describe('the drag card styles', () => {
  // A guard on a number that cost a diagnostic build to establish. Windows clips the drag image
  // near 210 device pixels wide, and cards are drawn 1:1 at their declared dimensions — so
  // widening one is not a cosmetic change, it silently cuts the cover art off one side of a real
  // drag and the meta off the other, in a place no other test can see. Every style is checked, not
  // just the default, since a new style is exactly where this would be forgotten. Re-measure
  // before raising it.
  it('every style stays clear of the width at which Windows clips a drag image', () => {
    for (const style of DRAG_CARD_STYLES) {
      expect(DRAG_CARD_LAYOUTS[style].width).toBeLessThanOrEqual(200);
    }
  });

  it('offers a layout for every style the preference can hold', () => {
    for (const style of DRAG_CARD_STYLES) {
      expect(typeof DRAG_CARD_LAYOUTS[style]?.draw).toBe('function');
    }
  });

  it('draws the waveform edge to edge in every style, whatever else the style shows', () => {
    for (const style of DRAG_CARD_STYLES) {
      const layout = DRAG_CARD_LAYOUTS[style];
      const { ctx, calls } = recordingCtx();

      layout.draw(ctx, input({ peaks: peaksOf(2) }));

      const bars = calls.filter((c) => c.method === 'fillRect' && c.fillStyle === COLORS.accent);
      const [firstX] = bars[0].args as number[];
      const [lastX, , lastW] = bars[bars.length - 1].args as number[];
      expect(firstX, style).toBe(DRAG_CARD.pad);
      expect(lastX + lastW, style).toBeGreaterThan(layout.width - DRAG_CARD.pad - 1);
    }
  });

  // The point of the bare style: no name, no pack, no art, no numbers — just the shape of the
  // sound. A cover is passed in anyway to prove the style IGNORES it rather than merely coping
  // with its absence.
  it('the waveform style draws nothing but the waveform', () => {
    const cover = { tag: 'cover-image' } as unknown as CanvasImageSource;
    const { ctx, calls } = recordingCtx();

    DRAG_CARD_LAYOUTS.waveform.draw(
      ctx,
      input({ cover, peaks: peaksOf(8), meta: '128 · A min', subtitle: 'Astral Drums' }),
    );

    expect(textDrawn(calls)).toEqual([]);
    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('the waveform-text style adds the sample name, and still no art', () => {
    const cover = { tag: 'cover-image' } as unknown as CanvasImageSource;
    const { ctx, calls } = recordingCtx();

    DRAG_CARD_LAYOUTS['waveform-text'].draw(
      ctx,
      input({ cover, title: 'kick.wav', peaks: peaksOf(8), subtitle: 'Astral Drums' }),
    );

    expect(textDrawn(calls)).toEqual(['kick.wav']);
    expect(calls.some((c) => c.method === 'drawImage')).toBe(false);
  });

  it('the card style is the one that shows everything', () => {
    const cover = { tag: 'cover-image' } as unknown as CanvasImageSource;
    const { ctx, calls } = recordingCtx();

    DRAG_CARD_LAYOUTS.card.draw(
      ctx,
      input({ cover, title: 'kick.wav', subtitle: 'Astral Drums', meta: '128 · A min' }),
    );

    expect(textDrawn(calls)).toEqual(expect.arrayContaining(['kick.wav', 'Astral Drums', '128 · A min']));
    expect(calls.some((c) => c.method === 'drawImage')).toBe(true);
  });

  it('truncates a title too long for the card instead of letting it overrun the edge', () => {
    const { ctx, calls } = recordingCtx();
    const long = 'an_extremely_long_sample_filename_that_will_never_fit.wav';

    drawDragCard(ctx, input({ title: long }));

    const [written] = textDrawn(calls).filter((t) => t.startsWith('an_extremely'));
    expect(written).not.toBe(long);
    expect(written.endsWith('…')).toBe(true);
  });
});
