// Which drawing serves which frame, for every icon container scripts/build-icons.mjs writes.
//
// Kept apart from build-icons.mjs, and free of side effects, because that script imports
// `electron` and boots an app on load — the icon test could not import a table from it under
// ELECTRON_RUN_AS_NODE. This file is data only, so both can share one source of truth.
//
// 32 is the crossover, established by rendering both drawings at both sizes magnified: at 32px the
// detailed mark is thin but crisp and its A still has a counter, at 24px that counter closes to a
// speck and the strokes wash out. Below the crossover the blunter, crossbar-free drawing is the
// one that stays legible (see icon-small.svg).

/** Windows .ico: every size the shell picks between, smallest first. */
export const FRAMES = [
  { size: 16, source: 'icon-small.svg' },
  { size: 24, source: 'icon-small.svg' },
  { size: 32, source: 'icon.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 64, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
  { size: 256, source: 'icon.svg' },
];

/**
 * macOS .icns: exactly the pixel sizes ICNS has an OSType for (scripts/icns.mjs), which is why
 * there is no 24 or 48 here. 1024 is the 512pt@2x frame a Retina Finder and Dock draw from.
 */
export const ICNS_FRAMES = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon.svg' },
  { size: 64, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
  { size: 256, source: 'icon.svg' },
  { size: 512, source: 'icon.svg' },
  { size: 1024, source: 'icon.svg' },
];
