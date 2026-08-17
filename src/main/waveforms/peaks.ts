// 200 buckets x [min, max] Int8 pairs interleaved = 400 bytes (spec §5.1; db.ts's `waveforms`
// schema comment: "peaks BLOB NOT NULL, -- spec §5.1: 200 min/max pairs, Int8"). Exported so
// callers that need the on-disk shape (byte count, bucket count) can reference this constant
// instead of repeating the literal 200.
export const DEFAULT_PEAKS_BUCKETS = 200;

// Format's clamp bound: Int8Array's native range is -128..127, but the encoded format stays
// symmetric (127 magnitude either direction) so a byte's sign and magnitude read the same way
// regardless of which extreme it came from — -128 has no positive counterpart, which would make
// the format asymmetric for no benefit.
const PEAKS_CLAMP = 127;

function clampInt8(v: number): number {
  if (v > PEAKS_CLAMP) return PEAKS_CLAMP;
  if (v < -PEAKS_CLAMP) return -PEAKS_CLAMP;
  return v;
}

/**
 * Reduces one or more decoded audio channels (Task 3's `decodeAudio` output) to a fixed-size
 * peak-bucket overview for the browse-list waveform thumbnail (spec §5.1): `buckets` buckets
 * (200 by default), each an interleaved [min, max] Int8 pair — 400 bytes at the default bucket
 * count.
 *
 * Multi-channel fold ("mono-fold multi-channel, louder wins per bucket"): per bucket, min/max
 * are taken across EVERY channel's samples in that bucket, pooled together — not each channel's
 * own min/max compared and one channel's whole pair picked as the "winner." The pooled min can
 * never be less extreme, and the pooled max never more extreme, than any single channel's own
 * bucket min/max, so the fold can never under-represent a transient that exists in only one
 * channel (e.g. a bucket whose loudest positive excursion is in the left channel and loudest
 * negative excursion is in the right — a whole-channel-selection scheme would have to pick one
 * side and lose the other). In the common case — one channel much louder than the rest for a
 * stretch — pooling is indistinguishable from "the louder channel wins," which is the
 * observable behavior described above and in the test suite.
 *
 * Bucket sizing: for `n >= buckets` samples, `bucketSize` is `floor(n / buckets)` and bucket `i`
 * spans `[i * bucketSize, (i + 1) * bucketSize)`, with the LAST bucket's end extended to `n` so
 * the tail remainder (up to `bucketSize - 1` samples that plain floor-division would otherwise
 * drop) is still represented instead of silently excluded. For `n < buckets` (fewer samples
 * than buckets), `bucketSize` would floor to 0 — floored up to a minimum of 1 instead, so the
 * first `n` buckets each get exactly one sample and every bucket from index `n` onward has no
 * samples at all: a TRAILING run of zero buckets, not samples scattered evenly across all 200
 * the way a proportional `floor(i * n / buckets)` boundary formula would produce instead.
 *
 * Quantization: `floor(sample * 127)`, then clamped to ±127. Floor (not round) is what
 * reproduces the brief's own worked values exactly — a 0.5 DC signal floors to 63, not 64; a
 * +/-1.0 signal floors to +/-127 exactly, needing no clamp. The clamp itself only matters for a
 * decoded sample outside [-1, 1] (a rare over-range/inter-sample-peak decode): without it,
 * assigning an out-of-range number into an `Int8Array` silently WRAPS (two's-complement
 * truncation), not clamps — which would flip a loud sample's sign in the stored byte instead of
 * pinning it to the format's max magnitude.
 */
export function computePeaks(
  channels: Float32Array[],
  buckets: number = DEFAULT_PEAKS_BUCKETS,
): Int8Array {
  // Guarded BEFORE the allocation below, not after: `new Int8Array(buckets * 2)` with a
  // negative `buckets` throws its own uncontrolled RangeError ("Invalid typed array length"),
  // which would fire first if this check came after the allocation — a real bug caught in
  // review round 1, since a caller-facing contract violation deserves a named, clear error, not
  // whatever message TypedArray's own allocator happens to produce.
  if (buckets <= 0) {
    throw new Error(`computePeaks: buckets must be > 0, got ${buckets}`);
  }

  const out = new Int8Array(buckets * 2);
  if (channels.length === 0) return out;

  const n = channels[0].length;
  const bucketSize = Math.max(1, Math.floor(n / buckets));

  for (let i = 0; i < buckets; i++) {
    const start = i * bucketSize;
    if (start >= n) continue; // trailing zero bucket — `out` is already zero-initialized.
    const end = i === buckets - 1 ? n : Math.min(n, start + bucketSize);

    let min = Infinity;
    let max = -Infinity;
    for (const channel of channels) {
      for (let s = start; s < end; s++) {
        const v = channel[s];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    out[i * 2] = clampInt8(Math.floor(min * PEAKS_CLAMP));
    out[i * 2 + 1] = clampInt8(Math.floor(max * PEAKS_CLAMP));
  }

  return out;
}
