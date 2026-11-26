// Pure-function tests for keyDisplay.ts. `formatKey`/`formatDuration` feed SampleRow's key/duration
// columns; `PITCH_CLASSES` feeds FilterPanel's key <select> so the filter dropdown and the
// display formatter share one definition of "the 12 keys" instead of two independently
// maintained lists that could drift (Splice's exact vocabulary).
import { describe, expect, it } from 'vitest';
import { formatDuration, formatKey, PITCH_CLASSES } from './keyDisplay';

describe('formatKey', () => {
  // Round-trips pin EVERY pitch class, not a representative one (house rule) — Splice's
  // vocabulary is exactly these 12 lowercase, sharps-only values.
  it('formats every pitch class with no chord type', () => {
    const expected: Record<string, string> = {
      a: 'A',
      'a#': 'A♯',
      b: 'B',
      c: 'C',
      'c#': 'C♯',
      d: 'D',
      'd#': 'D♯',
      e: 'E',
      f: 'F',
      'f#': 'F♯',
      g: 'G',
      'g#': 'G♯',
    };
    for (const [key, label] of Object.entries(expected)) {
      expect(formatKey(key, null)).toBe(label);
    }
  });

  it('combines a sharp pitch class with a minor chord type', () => {
    expect(formatKey('c#', 'minor')).toBe('C♯ min');
  });

  it('a bare pitch class with no chord type', () => {
    expect(formatKey('a', null)).toBe('A');
  });

  it('both unknown', () => {
    expect(formatKey(null, null)).toBe('—');
  });

  it('appends "maj" for a major chord type (460-sample chord-type population)', () => {
    expect(formatKey('g', 'major')).toBe('G maj');
  });

  it('a minor chord type on a natural (non-sharp) pitch class', () => {
    expect(formatKey('e', 'minor')).toBe('E min');
  });

  it('a null audioKey wins regardless of chordType — no pitch to qualify', () => {
    expect(formatKey(null, 'minor')).toBe('—');
    expect(formatKey(null, 'major')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('rounds ms to one decimal second', () => {
    expect(formatDuration(1395)).toBe('1.4s');
  });

  it('unknown duration', () => {
    expect(formatDuration(null)).toBe('—');
  });

  it('matches the duration examples verified against a real library', () => {
    expect(formatDuration(9600)).toBe('9.6s');
    expect(formatDuration(12830)).toBe('12.8s');
  });

  it('rounds down when the second decimal digit is below 5', () => {
    expect(formatDuration(340)).toBe('0.3s');
  });

  it('rounds up when the second decimal digit is 5 or above', () => {
    expect(formatDuration(360)).toBe('0.4s');
  });

  it('rounds up across a whole-second boundary', () => {
    expect(formatDuration(999)).toBe('1.0s');
  });

  it('formats a zero duration', () => {
    expect(formatDuration(0)).toBe('0.0s');
  });
});

describe('PITCH_CLASSES', () => {
  it('is exactly the Splice 12-value vocabulary, lowercase, sharps only, in order', () => {
    expect(PITCH_CLASSES).toEqual([
      'a',
      'a#',
      'b',
      'c',
      'c#',
      'd',
      'd#',
      'e',
      'f',
      'f#',
      'g',
      'g#',
    ]);
  });
});
