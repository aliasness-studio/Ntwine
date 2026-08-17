import { describe, expect, it } from 'vitest';
import { computePeaks } from './peaks';

const BUCKETS = 200;
const BYTES = BUCKETS * 2; // interleaved [min, max] Int8 pairs — spec §5.1 / db.ts's waveforms.peaks

function constantChannel(value: number, length: number): Float32Array {
  return new Float32Array(length).fill(value);
}

// +1, -1, +1, -1, ... starting at +1 — a period-2 signal, so any bucket boundary that lands on
// an even sample count (every bucket size used below does) sees an equal split of both
// extremes, never a lopsided one.
function alternatingChannel(length: number): Float32Array {
  const ch = new Float32Array(length);
  for (let i = 0; i < length; i++) ch[i] = i % 2 === 0 ? 1 : -1;
  return ch;
}

// Brief's four prose cases (DC 0.5, alternating ±1, short input, stereo fold), plus one added
// case (clamp) that the four don't otherwise exercise — see that test's own comment.
describe('computePeaks', () => {
  it('DC 0.5 signal: every bucket floors to 63 (0.5 * 127 = 63.5)', () => {
    const result = computePeaks([constantChannel(0.5, 2000)], BUCKETS);

    expect(result.length).toBe(BYTES);
    expect(Array.from(result).every((byte) => byte === 63)).toBe(true);
  });

  it('alternating +/-1 signal: every bucket min is -127, max is 127', () => {
    const result = computePeaks([alternatingChannel(2000)], BUCKETS);

    expect(
      Array.from(result).every((byte, i) => (i % 2 === 0 ? byte === -127 : byte === 127)),
    ).toBe(true);
  });

  it('input shorter than 200 samples still yields 400 bytes, with the unfilled tail as zero buckets', () => {
    // 50 samples: the first 50 buckets each get exactly one sample (bucketSize floors to a
    // minimum of 1 once there are fewer samples than buckets); buckets 50..199 never receive a
    // sample and stay at their zero-initialized default — a TRAILING run at the end of the
    // array, not scattered through it the way a proportional (evenly-distributed) bucket
    // boundary formula would leave them.
    const result = computePeaks([constantChannel(0.5, 50)], BUCKETS);

    expect(result.length).toBe(BYTES);
    expect(Array.from(result.slice(0, 100))).toEqual(new Array(100).fill(63)); // 50 populated buckets
    expect(Array.from(result.slice(100))).toEqual(new Array(300).fill(0)); // 150 trailing zero buckets
  });

  it('stereo folds to the louder of the two channels, per bucket', () => {
    const n = 2000;
    // loud: alternating +/-0.8, dominating every bucket's min AND max. quiet: constant 0.05,
    // never approaching loud's excursion in either direction.
    const loudChannel = new Float32Array(n);
    for (let i = 0; i < n; i++) loudChannel[i] = i % 2 === 0 ? 0.8 : -0.8;
    const quietChannel = constantChannel(0.05, n);

    const folded = computePeaks([quietChannel, loudChannel], BUCKETS);

    // Equals exactly what the loud channel alone would produce...
    expect(Array.from(folded)).toEqual(Array.from(computePeaks([loudChannel], BUCKETS)));
    // ...and is not quietly ignoring the second channel, or averaging the two.
    expect(Array.from(folded)).not.toEqual(Array.from(computePeaks([quietChannel], BUCKETS)));
  });

  it('clamps an out-of-range sample to 127 rather than letting Int8Array silently wrap it', () => {
    // Not one of the brief's four named cases, but "clamps to ±127" is its own named property
    // (Interfaces block) that none of the other four happens to exercise: +/-1.0 already floors
    // to exactly +/-127, so a version of computePeaks with NO clamp at all would still pass the
    // alternating-signal test above. 1.5 * 127 = 190.5 -> floors to 190, which IS out of range —
    // and would wrap to -66 if assigned into the Int8Array unclamped (190 - 256 = -66), silently
    // flipping the sign of a loud/over-range sample.
    const result = computePeaks([constantChannel(1.5, BUCKETS)], BUCKETS);

    expect(Array.from(result).every((byte) => byte === 127)).toBe(true);
  });

  it('clamps a negative out-of-range sample to -127 (mirrors the +127 clamp test)', () => {
    // -1.5 * 127 = -190.5 -> floors to -191 (floor rounds toward -Infinity), which would wrap to
    // +65 if assigned into the Int8Array unclamped (-191 + 256 = 65) — flipping the sign the
    // other way. `clampInt8`'s two branches (> PEAKS_CLAMP, < -PEAKS_CLAMP) are genuinely
    // separate code paths; the +1.5 test above only exercises the first one.
    const result = computePeaks([constantChannel(-1.5, BUCKETS)], BUCKETS);

    expect(Array.from(result).every((byte) => byte === -127)).toBe(true);
  });

  it('throws a clear error for buckets <= 0 instead of a RangeError from the Int8Array allocation', () => {
    // `new Int8Array(buckets * 2)` would itself throw an uncontrolled RangeError for a negative
    // buckets count if the allocation ran before this guard — this test pins the CONTROLLED
    // error (matched by message), not just "throws something", since an uncontrolled RangeError
    // would also make a bare `.toThrow()` pass.
    expect(() => computePeaks([constantChannel(0.5, 10)], -1)).toThrow(
      /buckets must be > 0, got -1/,
    );
    expect(() => computePeaks([constantChannel(0.5, 10)], 0)).toThrow(/buckets must be > 0, got 0/);
  });
});
