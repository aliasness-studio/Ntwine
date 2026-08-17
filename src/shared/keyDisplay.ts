// Pure display-formatting helpers shared by the renderer (Task 13's SampleRow/FilterPanel) and
// tested without any React/DOM dependency (Vitest's plain `environment: 'node'` config already
// covers this — no renderer-specific test setup needed). Lives in `src/shared/` — not
// `src/renderer/` — for the same reason `ipcTypes.ts` does: nothing here imports React or touches
// `window`, so it stays trivially importable from anywhere the shapes are needed later.

/**
 * Splice's `audio_key` vocabulary (spec §2.2, verified firsthand): exactly these 12 lowercase,
 * sharps-only pitch classes. Exported so FilterPanel's key `<select>` builds its option list from
 * the SAME array `formatKey` below reads display labels from — one definition, not two
 * independently maintained lists that could silently drift apart.
 */
export const PITCH_CLASSES = [
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
] as const;

export type PitchClass = (typeof PITCH_CLASSES)[number];

/**
 * Combines `samples.audio_key` + `samples.chord_type` into the one label the UI shows (spec
 * §2.3: "e.g. c# + minor -> 'C♯ min'"). `audioKey === null` means "unknown" and always wins —
 * chordType is meaningless without a pitch class to qualify, regardless of what it holds.
 * `chordType === null` (the majority — only 460 of 4,197 samples carry a chord type) shows the
 * bare pitch class with no suffix.
 */
export function formatKey(audioKey: string | null, chordType: 'major' | 'minor' | null): string {
  if (audioKey === null) return '—';
  const pitch = audioKey.replace('#', '♯').toUpperCase();
  if (chordType === 'minor') return `${pitch} min`;
  if (chordType === 'major') return `${pitch} maj`;
  return pitch;
}

/**
 * `samples.duration_ms` (integer milliseconds, spec §2.3's verified-firsthand unit pin) as a
 * one-decimal-second label. `null` means unknown duration.
 */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  return `${(durationMs / 1000).toFixed(1)}s`;
}
