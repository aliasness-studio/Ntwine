import { describe, expect, it } from 'vitest';
import {
  DRAG_CARD_STYLES,
  DRAG_CARD_STYLE_KEY,
  parseDragCardStyle,
  readDragCardStyle,
  writeDragCardStyle,
  type DragCardStyle,
} from './dragCardStyle';

/** The two `localStorage` methods this module touches — enough to run it with no DOM. */
function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    storage: {
      getItem: (key: string) => (key === DRAG_CARD_STYLE_KEY ? value : null),
      setItem: (key: string, next: string) => {
        if (key === DRAG_CARD_STYLE_KEY) value = next;
      },
    },
    current: () => value,
  };
}

describe('parseDragCardStyle', () => {
  it('accepts every style the app offers', () => {
    for (const style of DRAG_CARD_STYLES) {
      expect(parseDragCardStyle(style)).toBe(style);
    }
  });

  it('falls back to the full card when nothing has been chosen yet', () => {
    expect(parseDragCardStyle(null)).toBe('card');
  });

  // A stored value outlives the code that wrote it: a style removed in a later version, or a
  // hand-edited key, must not leave the drag image unrenderable. Unknown reads as "default".
  it('falls back to the full card for a value it does not recognise', () => {
    expect(parseDragCardStyle('spectrogram')).toBe('card');
    expect(parseDragCardStyle('')).toBe('card');
  });
});

describe('readDragCardStyle / writeDragCardStyle', () => {
  it('reads back exactly what was written', () => {
    const { storage } = fakeStorage();

    writeDragCardStyle(storage, 'waveform-text');

    expect(readDragCardStyle(storage)).toBe('waveform-text');
  });

  it('reads the default out of empty storage', () => {
    expect(readDragCardStyle(fakeStorage().storage)).toBe('card');
  });

  it('survives storage that throws, rather than taking the drag down with it', () => {
    const hostile = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    };

    expect(readDragCardStyle(hostile)).toBe('card');
    expect(() => writeDragCardStyle(hostile, 'waveform' as DragCardStyle)).not.toThrow();
  });
});
