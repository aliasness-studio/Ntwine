# Ntwine

Ntwine is a desktop browser for an orphaned Splice sample library: search, filter,
preview, and drag samples straight into your DAW — no subscription required.

Ntwine is an independent project and is not affiliated with or endorsed by Splice. It reads the
library the Splice app left on your disk. It never logs in to Splice or downloads samples; during
import it fetches pack cover art from the image links in Splice's database.

Free and MIT-licensed, for macOS and Windows. Still beta (0.x), so expect rough edges.

## Download

Grab the latest build from
[Releases](https://github.com/aliasness-studio/Ntwine/releases/latest):

- **macOS** — `Ntwine-darwin-universal-<version>.zip` (Apple silicon and Intel; signed and
  notarized). Unzip, open Ntwine, and accept the "Move to Applications" prompt — updates only
  work from Applications. If you declined the prompt, drag Ntwine into Applications yourself.
- **Windows** — download the `Setup.exe` (`Ntwine-<version>-win32-x64-Setup.exe`); the other
  files on the release page are for the updater. The Windows build is unsigned, so SmartScreen
  warns about an "unknown publisher": click **More info → Run anyway**.

Linux is not supported yet.

## What you need

A Splice library on disk: the sample folder, plus the `sounds.db` file the Splice desktop app
leaves behind. Ntwine finds both automatically. The Splice app does not need to be installed or
running, and you do not need a Splice account. Without a library there is nothing for Ntwine to
show.

## Using Ntwine

**First launch.** Ntwine detects the Splice database and your library folder and shows what it
found. If it picked the wrong folder, change it there. One click imports: Ntwine copies the
catalog into its own database, checks every sample file, downloads pack cover art, and starts
drawing waveforms in the background.

**The library view.**

- A pack list down the left.
- Filters for type, key, BPM and tags.
- Full-text search across filenames, tags and pack names.
- Waveform thumbnails, which fill in as the background pass catches up.
- Click a sample, or move with the arrow keys, to preview it.
- Drag a sample straight into your DAW, Finder or File Explorer.

**Updates.** Updates download in the background. When one is ready, an update icon appears at
the bottom of the left rail; click it to restart into the new version. Otherwise the update
applies the next time you quit and reopen Ntwine.

## Privacy and your files

- Your sample library and Splice's `sounds.db` are only ever read, never written to.
- Everything Ntwine writes — its catalog database and the cover-art cache — lives in its own
  application data folder.
- **Network use:** besides the cover art at import, the packaged app checks
  update.electronjs.org (backed by this repo's GitHub Releases) for updates 30 s after launch and
  every 4 hours. Nothing else leaves your machine.

## Problems and feedback

Found a bug? [Open an issue](https://github.com/aliasness-studio/Ntwine/issues/new/choose) and
include your Ntwine version (shown in Settings) and operating system. Please do not attach your
`sounds.db`; it describes your whole library and may contain account details.

For security problems, see [SECURITY.md](SECURITY.md).

## Building from source

Everything below is for developers. You do not need any of it to use Ntwine.

### Prerequisites

- Node ≥ 22 for `yarn install` (`better-sqlite3`'s `engines` field hard-fails yarn below that).
  After install, the app and test suite run under Electron's own bundled Node, so the host Node
  version stops mattering.
- yarn (classic)
- macOS or Windows. On Windows, prefer Node 24: `better-sqlite3`'s install runs an
  (always-no-op) `node-gyp rebuild`, and gyp configure still has to _find_ Visual Studio —
  the node-gyp bundled with Node 22's npm can't parse VS 2026 and the install fails.

### Commands

```bash
yarn         # install
yarn start   # run the app (dev)
yarn test    # Vitest, run under Electron's own Node
```

`yarn test` runs Vitest under `ELECTRON_RUN_AS_NODE=1 electron`, not plain Node, so
the app and the test suite share one compiled ABI for the native `better-sqlite3`
module instead of fighting over two.

**Fresh clone:** run `yarn e2e` or `yarn start` once _before_ `yarn test`. Either one triggers
Forge's native-module rebuild, which puts `better-sqlite3` on Electron's ABI; `yarn test` never
does that rebuild itself, so running it first fails on the ABI mismatch.

### Checks

Four gates: `yarn test` (Vitest), `yarn typecheck` (`tsc --noEmit`), `yarn lint` (ESLint), and
`yarn e2e` (Playwright). `yarn e2e` runs `electron-forge package` and then drives the resulting
production build with Playwright under Electron's own Node — a real packaged app, not a dev
server. The end-to-end tests use a synthetic library, so they need no Splice library or account.

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

CI (`.github/workflows/ci.yml`) runs all four gates on macOS and Windows for every pull request
and every push to `main`. Documentation-only changes are skipped.

### Releasing

Pushing a `v*` tag builds, signs, notarizes and publishes a release. The runbook is
[docs/RELEASING.md](docs/RELEASING.md).

### Tech

Electron Forge + Vite, React 19, MobX 6, styled-components, better-sqlite3 (FTS5),
TanStack Virtual, WebAudio. TypeScript strict; ESLint 9 + Prettier.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE) © 2026 AliasNess Studio
