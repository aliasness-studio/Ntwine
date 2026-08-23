# Ntwine

Ntwine is a desktop browser for an orphaned Splice sample library: search, filter,
preview, and drag samples straight into your DAW — no subscription required.

## Status

v1, macOS and Windows (Linux later — nothing in the design bakes in platform-specific
assumptions). Both have been built and QA'd against a real Splice library, and both are
covered by the CI matrix. Private/personal tooling for now.

## Prerequisites

- Node ≥ 22 for `yarn install` (`better-sqlite3`'s `engines` field hard-fails yarn below that).
  After install, the app and test suite run under Electron's own bundled Node, so the host Node
  version stops mattering — see [Verification](#verification).
- yarn (classic)
- macOS or Windows. On Windows, prefer Node 24: `better-sqlite3`'s install runs an
  (always-no-op) `node-gyp rebuild`, and gyp configure still has to *find* Visual Studio —
  the node-gyp bundled with Node 22's npm can't parse VS 2026 and the install fails.

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

## Verification

Four gates: `yarn test` (Vitest), `yarn typecheck` (`tsc --noEmit`), `yarn lint` (ESLint), and
`yarn e2e` (Playwright). `yarn e2e` runs `electron-forge package` and then drives the resulting
production build with Playwright under Electron's own Node — a real packaged app, not a dev
server.

```bash
yarn e2e         # package + run the full Playwright suite (default project)
yarn e2e:only    # re-run Playwright against the existing .vite/build, no repackage
yarn e2e:real    # opt-in: import your real Splice library instead of the fixture
```

`yarn e2e:only` re-runs Playwright against whatever's already built, so it's only valid
immediately after a `yarn e2e` (or a bare `electron-forge package`). The harness guards this
itself before every launch, two ways: it refuses a **dev** build left behind by `yarn start`
(`.vite/build/main.js` still points at the Vite dev server) and it refuses a **stale** build
(`.vite/build/main.js` older than anything under `src/`). The dev-build error names `yarn package`
as the fix; the stale-build error names either `yarn package` or `yarn e2e`.

`yarn e2e:real` (`NTWINE_E2E_REAL=1`, baked into the script) runs one opt-in spec against your
actual Splice library over the network instead of the synthetic fixture, so it needs a real
library on disk. It's excluded from `yarn e2e`/`yarn e2e:only`'s default project and must be run
by name.

**Fresh clone:** run `yarn e2e` or `yarn start` once *before* `yarn test`. Either one triggers
Forge's native-module rebuild, which puts `better-sqlite3` on Electron's ABI; `yarn test` never
does that rebuild itself, so running it first fails on the ABI mismatch. Note the install floor
above too — `yarn` (install) needs Node ≥ 22; the gates themselves run under Electron's bundled
Node regardless of host Node version once `node_modules` exists.

CI (`.github/workflows/e2e.yml`) runs all four gates on macOS and Windows, but is
`workflow_dispatch`-only for now — trigger it by hand from the Actions tab; it does not run on
every push or pull request.

## Import flow

First launch detects the Splice database and the library root automatically. One
click imports: snapshot the database → build Ntwine's own catalog → stat every
sample file → download pack cover art → kick off a background waveform pass. From
there it's the library view — a pack rail down the left, filters for
type/key/BPM/tags, full-text search across filename/tags/pack name, waveform
thumbnails that fill in as the background pass catches up, click-or-arrow-key
preview, and drag-out straight to a DAW, Finder, or File Explorer.

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
