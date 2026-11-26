// Dark, dense-but-calm palette + the styled-components
// `DefaultTheme` module augmentation, so every `styled.div` etc. and every `useTheme()` call
// anywhere in the renderer gets full autocomplete/type-checking on `props.theme` for free — the
// canonical styled-components v6 + TypeScript pattern (their own docs recommend augmenting
// `DefaultTheme` exactly this way).
//
// One flat `color` map + a spacing FUNCTION (not a fixed scale array) — `space(n)` returns
// `${n * 4}px` on a 4px grid, which is enough structure for a v1 dense list-browser UI without
// over-building a full design-token system nobody's asked for yet.
export const theme = {
  color: {
    // Backgrounds, darkest to lightest — one ramp so every surface reads as the same material
    // under different amounts of "lift" rather than unrelated colors.
    bg: '#15130f',
    bgRail: '#1b1815',
    bgPanel: '#211d18',
    bgRowHover: '#282320',
    bgRowSelected: '#3a2f22',
    border: '#332e27',
    borderStrong: '#463f34',

    // Text, darkest (least important) to lightest (most important).
    textFaint: '#655d51',
    textMuted: '#a39a8c',
    text: '#ece6da',

    // One warm accent (selection ring, active filter chip, waveform fill, focus ring) — a single
    // hue keeps "what's interactive/active" legible against the neutral backdrop above.
    accent: '#e0a458',
    accentStrong: '#f0b876',

    // Missing-file / corrupt-decode badges — a desaturated red-orange so it reads as
    // "attention" without competing with the accent color for what's interactive.
    danger: '#c9563f',
    dangerBg: '#3a231d',
  },
  space: (n: number): string => `${n * 4}px`,
  radius: { sm: '3px', md: '6px', pill: '999px' },
  font: {
    // System stack only — the app must work fully offline, with no webfont fetches —
    // mirrored in index.html's own font-family (no @font-face/Google Fonts link).
    family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
} as const;

export type AppTheme = typeof theme;

declare module 'styled-components' {
  // Deliberately empty-bodied: this IS the whole augmentation (extend, don't redeclare) — the
  // canonical styled-components + TypeScript pattern for typing `props.theme` everywhere.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface DefaultTheme extends AppTheme {}
}
