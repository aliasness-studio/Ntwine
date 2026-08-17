# Ntwine

Ntwine is a desktop browser for an orphaned Splice sample library: search, filter,
preview, and drag samples straight into your DAW — no subscription required.

## Status

v1, macOS-first (Windows/Linux later — nothing in the design bakes in macOS-only
assumptions, but only macOS has been built and QA'd so far). Private/personal tooling
for now.

## Prerequisites

- Node ≥ 22
- yarn (classic)
- macOS

The first-run import reads the Splice desktop app's leftover `sounds.db`
(auto-detected) plus the sample folder itself — you need a real Splice library on
disk, or its leftovers, for the app to have anything to show.

## Commands

```bash
yarn         # install
yarn start   # run the app (dev)
yarn test    # Vitest, run under Electron's own Node
```

`yarn test` runs Vitest under `ELECTRON_RUN_AS_NODE=1 electron`, not plain Node, so
the app and the test suite share one compiled ABI for the native `better-sqlite3`
module instead of fighting over two.

## Import flow

First launch detects the Splice database and the library root automatically. One
click imports: snapshot the database → build Ntwine's own catalog → stat every
sample file → download pack cover art → kick off a background waveform pass. From
there it's the library view — a pack rail down the left, filters for
type/key/BPM/tags, full-text search across filename/tags/pack name, waveform
thumbnails that fill in as the background pass catches up, click-or-arrow-key
preview, and drag-out straight to a DAW or Finder.

## Where data lives

Everything Ntwine writes — the catalog SQLite database and the cover-art cache —
lives in its own Electron `userData` directory. Your sample library and Splice's
`sounds.db` are read from, and never written to.

## Tech

Electron Forge + Vite, React 19, MobX 6, styled-components, better-sqlite3 (FTS5),
TanStack Virtual, WebAudio. TypeScript strict; ESLint 9 + Prettier.

## Docs

- [Design spec](docs/superpowers/specs/2026-08-16-ntwine-v1-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-16-ntwine-v1.md)
