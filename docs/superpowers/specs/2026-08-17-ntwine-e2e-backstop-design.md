# Ntwine — end-to-end regression backstop (Playwright) — design

**Status:** panel-reviewed (Claude + Codex + agy, 2026-08-17), consensus applied ·
**Baseline:** `main` @ `0434526` (v1 merged via PR #1) · **Parent:**
`docs/superpowers/specs/2026-08-16-ntwine-v1-design.md`

## 0. Purpose and owner decisions

v1 works and is merged. Before any feature work, the owner wants a **development backstop**:
an end-to-end suite that pins what PR #1 does today — a *time capsule* of the app's behaviour
— so future PRs can be "slammed" with confidence that the simple things still work. It sits
beside the 190-test unit suite (`yarn test`); it does not replace it.

Owner decisions taken in the brainstorm (binding):

- **D1 — Fixture:** the suite runs against a **synthetic, generated Splice-shaped library**
  (deterministic, portable, runs on a fresh clone) plus an **opt-in real-library smoke** that
  runs only where the owner's `~/Splice` exists.
- **D2 — Gate:** `yarn e2e` run **first-hand locally** (macOS now, the owner's Windows box
  soon) is the merge authority, exactly like the unit gates. A GitHub Actions workflow is
  authored **`workflow_dispatch`-only** — CI-ready with one line to flip later; no billing
  surprises now.
- **D3 — Style:** vanilla, standard, boring tooling. `@playwright/test` with its Electron
  driver; nothing bespoke where a documented Playwright feature exists. The owner delegated
  every remaining detail to this document and the mirror panel.

Orchestrator calls (owner-delegated):

- **C1** — the production build path is `electron-forge package`, therefore the half-wired
  native-module unpacking (final v1 review, "F7") is **fixed in this lane** (one plugin
  registration) and the suite includes **one packaged-app boot smoke** (§4, fuse-safe form).
  The capsule then covers the shippable artifact too, and `yarn package` is proven on both
  platforms before it is needed.
- **C2** — **Linux is out of scope** for the suite. The app cannot import without Splice
  detection (no Linux glob; non-Splice sources are the *next* product feature), so a Linux leg
  would need a bypass code path that exists only to satisfy CI. YAGNI.
- **C3** — **no pre-push hook.** The owner runs gates first-hand; a hook is a one-liner if he
  asks.

## 1. Scope

**In:** an env-gated E2E mode inside the app (data-dir + library-root redirection, a boot
guard, and a handful of observable seam events); a synthetic fixture generator; the
Playwright harness (config, launch helper + fixture, action helpers); the capsule specs (§4);
the `yarn e2e` gate; the dispatch-only workflow; README docs; the F7 fix + packaged boot
smoke; the opt-in real-library smoke; the small refactors §3.1/§3.2 name so the above is
unit-pinnable and reusable.

**Out (non-goals):** visual-regression screenshots (a redesign would churn them; DOM/state
assertions age better); performance assertions; Linux; auto-run CI; a pre-push hook; any new
product feature; any change to v1 behaviour beyond what §3.1 names.

## 2. Ground truth the design load-bears on (verified 2026-08-17)

Verified in the merged code / on the owner's machine unless marked otherwise:

- `src/main.ts` reads `app.getPath('userData')` for the catalog root
  (`dataDirFrom(userData) = <userData>/ntwine-data`); `src/main/ipc.ts` reads
  `app.getPath('appData')` for Splice-DB detection through
  `resolveSpliceDbCandidates(appDataDir)` — a `globSync` of
  `com.splice.Splice/users/default/*/sounds.db` with `cwd = appDataDir` (identical pattern for
  `darwin` and `win32`; the win32 pattern is a best-guess mirror marked TODO in code) — and
  **the library root defaults to `join(homedir(), 'Splice')`** (`DEFAULT_LIBRARY_ROOT`,
  `ipc.ts:15`) unless `meta.library_root` was persisted by `pickLibraryRoot`. The importer
  rejects any sample whose path is outside the library root.
- Electron `app.setPath('userData' | 'appData', p)` overrides those lookups when called before
  `whenReady`; **it throws if the directory does not exist** (Electron docs: "the directory
  should be created with `fs.mkdirSync` or similar"); `userData` is NOT recomputed from a
  changed `appData`, so both are set explicitly.
- Electron passes strings to a preload via `webPreferences.additionalArguments` (they appear
  in the sandboxed preload's `process.argv`) — the documented way to hand main-side flags to a
  preload without widening the IPC contract.
- The renderer is a bridged React app: `window.ntwine` (12 typed methods) is the only main
  access; `contextIsolation`/sandbox defaults on. Rows are TanStack-virtualized 40 px rows;
  the top bar renders `"{n} samples"`; the FirstRun card renders `Splice database:` followed by
  the literal `found` / `not found` (no path); missing rows render at 40 % opacity with a
  badge; the row's visible filename is **middle-truncated at 42 chars while the full name is
  on the element's `title` attribute**; v1 markup already carries `role="listbox"/"option"`
  and `aria-label`s (`Search samples`, `Volume`, `Key filter`, `Minimum BPM`, `Maximum BPM`,
  `Filter tag list`, `Packs`, `Sample list`, `Settings`, `Close settings`) and **no
  `data-testid`s**; `WaveformThumb` is a `<canvas>` with a 1 px-floor bar draw for real peaks
  and a thin centre line for the null placeholder.
- After FirstRun's import resolves, `App.tsx` switches to the library view **and only then**
  runs `library.init()` (`App.tsx:131-149`) — packs, tags and rows load after the view is
  first visible.
- Custom schemes `sample://s/<id>` and `cover://p/<id>` are served by `protocol.handle` via
  `net.fetch(pathToFileURL(...))`; **`net.fetch` reads `file:` URLs** (how covers and audio
  already work in production).
- Covers are downloaded at import through the injected `fetchFn` (`net.fetch(url)` in
  production) **sequentially, one `await` per pack** (`covers.ts:82-104`), for packs where
  `cover_url IS NOT NULL AND splice_uuid IS NOT NULL`, always written as
  `<dataDir>/covers/<uuid>.jpg` regardless of source type; the write path is
  containment-checked.
- Drag: renderer `dragstart` → `preventDefault` → `ipcRenderer.send('ntwine:drag-start', id)`
  → main `registerDragHandler` → shared `resolveSampleAbsPath` (unknown/missing → `null`) →
  `existsSync` → `event.sender.startDrag({file, icon})`. A native `startDrag` opens an OS
  drag session that blocks until mouse-up.
- Preview: `previewPlayer` fetches `sample://s/<id>` **only on a buffer-cache miss** (16
  decoded buffers cached by id, `MAX_CACHED_BUFFERS`); replaying a cached id performs no
  fetch. AIFF: `decodeAudioData` rejects → `api.decodePreviewPcm(id)` (one-shot
  `utilityProcess` decode in main). Retrigger ramps the prior voice's own gain; a generation
  counter discards stale decodes.
- Import: `runImport()` resolves after snapshot → catalog → stat → covers; the waveform pass
  continues in the background (`phase: 'waveforms'` ticks, then `phase: 'done'`). On relaunch
  with `imported = 1`, main resumes any pending peaks.
- Security fences from v1: `setWindowOpenHandler` denies every `window.open`; `will-navigate`
  allows only the app's own origin (dev-server origin / exact packaged `index.html` path);
  scheme privileges include `corsEnabled` — safe *because* of those denials.
- Build/tooling: Electron Forge 7.11 + Vite 5 (CJS main), `electron` 43.4.0 devDependency
  (binary under `node_modules/electron/dist/`). **`.vite/build/main.js` is written by BOTH
  `yarn start` (dev build: `MAIN_WINDOW_VITE_DEV_SERVER_URL` defined, DevTools auto-open,
  dev-origin navigation allowlist) and `electron-forge package` (production build: define
  absent, `loadFile`, exact-path allowlist, plus `.vite/renderer/main_window/index.html` and
  `out/<Ntwine-platform-arch>/…`)** — the file alone does not say which. `forge.config.ts`:
  `asar: true`; `@electron-forge/plugin-auto-unpack-natives` installed but **not registered**
  (F7); the Fuses plugin sets `RunAsNode: false`, `EnableNodeOptionsEnvironmentVariable:
  false`, `EnableNodeCliInspectArguments: false`, `EnableEmbeddedAsarIntegrityValidation:
  true`, `OnlyLoadAppFromAsar: true` on the **packaged** binary (the `node_modules` binary is
  unfused). `better-sqlite3` and `audio-decode` are runtime `dependencies`; `better-sqlite3`
  is externalized in `vite.main.config.ts`. `tsconfig.json` has **no `include`** (everything
  is typed already). Unit tests: Vitest, `include: ['src/**/*.test.ts']`, run under
  `ELECTRON_RUN_AS_NODE=1 electron` because `node_modules/better-sqlite3` is built for
  Electron's ABI (Node 24) by Forge's rebuild, not for the host Node — **a fresh clone's
  `yarn test` needs a Forge `start`/`package` to have run once** (the parent spec's dual-ABI
  section).
- Playwright's Electron driver (`_electron.launch({ args, env, executablePath? })`,
  `firstWindow()` → a normal `Page`, `electronApp.evaluate(...)` in the main process) boots
  **this exact app on this exact `node_modules` Electron** — proven during the v1 final fix
  wave. The driver attaches to the main process through the Node inspector (`--inspect`
  family), which the packaged binary's fuses disable. No browser download is needed for
  Electron targets. macOS Accessibility / Screen Recording permissions are NOT available to
  automation on this machine — the Electron driver is the reliable path, not GUI scripting.
- `scripts/gen-fixture-audio.mjs` is a fixed 100 ms / 440 Hz mono sine writer to two
  hardcoded paths — a script, not a reusable generator.
- The owner's real library: `~/Splice`, 4,197 files (16 `.aif`), 612 packs, Splice DB at
  `~/Library/Application Support/com.splice.Splice/users/default/<user>/sounds.db`, real SQL
  `NULL` for absent `audio_key`/`chord_type`. Nothing may write into `~/Splice`. The
  developer catalog lives at `~/Library/Application Support/Ntwine/ntwine-data/`; the suite
  must never touch it (D1 → temp dirs only; §3.1's boot guard makes that structural).

## 3. Architecture

Five units, each independently understandable:

```
tests/e2e/fixture/   builds a Splice-shaped library + sounds.db in a temp dir   (Node, Electron-ABI)
tests/e2e/harness/   launchNtwine() + Playwright fixture + action helpers       (Playwright)
tests/e2e/*.spec.ts  the capsule — one file per flow group                      (Playwright)
src/main/e2e.ts      pure module: read the E2E env contract, install seam hooks (app, unit-pinned)
src/main.ts (+4)     wiring: honour the contract before whenReady               (app)
```

### 3.1 The app's E2E mode (the only product-code change)

A new pure module `src/main/e2e.ts` exports `readE2EConfig(env: NodeJS.ProcessEnv):
E2EConfig | null` and `installE2EHooks(app: EventEmitterLike, cfg: E2EConfig)`; `main.ts`
calls them **before** `app.whenReady()`. **Nothing below is honoured unless
`NTWINE_E2E=1`**; with it unset `readE2EConfig` returns `null`, no path is overridden and no
hook is installed — the app is byte-for-byte v1. Both branches are unit-pinned in
`src/main/e2e.test.ts` (importable under Vitest because the module touches no Electron API;
`main.ts` stays wiring only).

| Variable (all require `NTWINE_E2E=1`) | Effect |
|---|---|
| `NTWINE_USER_DATA=<abs dir>` | **required in E2E mode — the app refuses to boot without it** (a missed override on the packaged binary would otherwise write into the developer's real `…/Ntwine/ntwine-data`); `mkdirSync(dir, {recursive: true})` then `app.setPath('userData', dir)` |
| `NTWINE_APP_DATA=<abs dir>` | `mkdirSync` then `app.setPath('appData', dir)` — Splice-DB detection globs under this root; the fixture places its `sounds.db` at `<dir>/com.splice.Splice/users/default/e2e/sounds.db`, so **the real detection glob is exercised unmodified** |
| `NTWINE_LIBRARY_ROOT=<abs dir>` | replaces `DEFAULT_LIBRARY_ROOT` (`~/Splice`) as the default library root; a persisted `meta.library_root` still wins, exactly as in production, so persistence stays testable |
| `NTWINE_E2E_BOOT_MARKER=<abs file>` | after the first window's `did-finish-load`, write the file (contents: the resolved `userData` path) and `app.quit()` — the fuse-safe packaged-boot probe (§4 `packaged.spec.ts`) |

Seam events (emitted on the `app` object in main; observed with `electronApp.evaluate(({app})
=> new Promise(r => app.once('<name>', r)))`, wrapped by the harness's `seam` helper which
also keeps per-event **counters** so "did not fire" is asserted as a counter that stays flat
while a sibling action increments it — never as silence):

| Event | Payload | Emitted from |
|---|---|---|
| `ntwine:e2e:drag` | `{ sampleId, file: string \| null }` | `registerDragHandler`, after resolution + `existsSync`; **in E2E mode the native `startDrag` is skipped** — the payload is exactly what `startDrag` would have received; `file: null` on refusal |
| `ntwine:e2e:protocol` | `{ scheme: 'sample' \| 'cover', id: number \| null, hit: boolean }` | the `protocol.handle` callbacks, after `resolveProtocolRequest` |
| `ntwine:e2e:preview-pcm` | `{ sampleId, ok: boolean }` | the `decodePreviewPcm` IPC handler, on settle |
| `ntwine:e2e:nav-denied` | `{ url }` | the `will-navigate` handler when it `preventDefault()`s |
| `ntwine:e2e:window-open-denied` | `{ url }` | the `setWindowOpenHandler` callback |

Renderer side: when armed, main adds `--ntwine-e2e` to the window's
`webPreferences.additionalArguments`; the preload sees it in `process.argv` and exposes
`contextBridge.exposeInMainWorld('ntwineE2E', true)` — **the production `NtwineApi`/`getState`
contract is untouched**. `src/renderer.tsx`, when `window.ntwineE2E === true`, (a) wraps the
`PlayPort` it hands `PlayerStore` so every `play(id)` increments an E2E-only counter and
records `lastPlayedId` before delegating (zero change to the player), and (b) attaches
`window.__ntwineE2E`, a **read-only snapshot function** `() => ({ rows, resultCount,
selectedId, volume, filters, importPhase, running, peaksCached, playCount, lastPlayedId })`.
It is attached **synchronously at module execution**, before any async work, so a harness
`waitForFunction` on it cannot race. Snapshots are used only where the DOM carries no signal
(playback, cache convergence, filter object shape); everything else asserts **what the user
reads**.

Product files touched, exhaustively: `src/main/e2e.ts` (+ test), `src/main.ts`,
`src/main/drag.ts`, `src/main/protocol.ts`, `src/main/ipc.ts`, `src/preload.ts`,
`src/renderer.tsx`, `src/renderer/global.d.ts`, `forge.config.ts` (F7 plugin), and — the
one licensed renderer-markup change — `data-testid` attributes **only** where §3.3's action
helpers cannot locate an element by role/label/text (`FirstRun` detected-DB row, the
`{n} samples` count, the missing badge, the settings sheet's root line, the pack-rail cover
tile). Attributes only; no behaviour.

### 3.2 The synthetic fixture (`tests/e2e/fixture/`)

`buildFixtureLibrary(root: string): FixtureLibrary` — Node code that must run under
**Electron's ABI** (it imports `src/main/importer/fixtureSpliceDb.ts`, which uses
`better-sqlite3`; see §3.3 for how the runner process satisfies that) — writes under a
caller-supplied temp `root`:

- `root/userData/` (empty; exists so `app.setPath` cannot throw),
  `root/appData/com.splice.Splice/users/default/e2e/sounds.db` — via the existing
  `buildFixtureSpliceDb` (the unit suite's builder; it models real `NULL`s). Rows: **3
  packs**, **12 samples**.
- `root/library/sounds/packs/<Pack>/<vendor>/<file>` — **11 real audio files** written by a
  new shared generator `tests/e2e/fixture/audio.ts` exporting `writeSineWav(path, ms)` /
  `writeSineAiff(path, ms)` — extracted from `scripts/gen-fixture-audio.mjs`, which becomes a
  two-line caller of the same functions so "the same generator" is literally true; **9 wav +
  2 aiff**, durations varied 100 ms–2.5 s (these drive only waveform shape); and **1 DB row
  whose file is deliberately absent** (the missing-row case). All `local_path`s are under
  `root/library`. One filename carries a non-ASCII NFD character (parent §10 case) and must
  be written to disk under that exact name (checked by `statPass` on both APFS and NTFS —
  the first thing to look at on the Windows run).
- Metadata chosen so every filter has a **known expected count**: `sample_type` 8 oneshot /
  4 loop; `bpm` 0 (none) on 5, `90` on 3, `128` on 4; `audio_key` NULL on 4, `c#` on 3, `a`
  on 5; `chord_type` NULL / `major` / `minor` mixed; `tags` such that `kick` matches exactly
  3, `snare` 2, `drums` 6 (case/space variants included to pin `parseTags`);
  **`duration` (ms) in the DB rows is what `formatDuration` renders** — chosen values include
  `1395` (→ `1.4s`) and `NULL` (→ `—`); the audio files' real lengths are unrelated to it.
- Covers: `cover_url = pathToFileURL(join(root, 'covers-src', `${uuid}.png`)).toString()`
  (never a hand-built `file://` string — Windows drive letters and encoding) for 2 packs
  (tiny generated PNGs; `downloadCovers` will store them as `<uuid>.jpg` — Chromium sniffs
  image bytes for `<img>`, so `naturalWidth > 0` holds regardless of the extension, and the
  spec says so where it asserts it), `NULL` for the third (fallback-tile path). Zero network.
- Returns the exact expectations (`totalSamples`, per-filter counts, `missingFilename`,
  `aiffIds`, pack names, covered pack names, `libraryRoot`, `userData`, `appData`) so specs
  assert against **generated truth, not hardcoded literals** — but each spec states the
  concrete number in its assertion message so a drift reads clearly.

The fixture is rebuilt **per test** (milliseconds); no shared state between tests.

### 3.3 The harness (`tests/e2e/harness/`)

- **Runner ABI (binding, decided by the plan's first task).** The fixture builder and the
  real-library smoke import `better-sqlite3`, which in this repo is built for Electron's ABI.
  **Primary strategy:** run the Playwright runner itself under Electron's Node — `e2e:only`
  = `cross-env ELECTRON_RUN_AS_NODE=1 electron ./node_modules/@playwright/test/cli.js test`,
  the exact idiom `yarn test` already uses — and have `launchNtwine` pass the app an env
  from which `ELECTRON_RUN_AS_NODE` has been **deleted** (Playwright's `env` option replaces
  the child environment). **Fallback, if the runner or the launch misbehaves under that
  flag:** keep all SQLite work out of the Playwright process — the fixture DB and the
  real-DB count are produced by a helper CLI (`tests/e2e/fixture/cli.ts`, built by a small
  `vite.e2e.config.ts` into `.vite/e2e/`, executed with `ELECTRON_RUN_AS_NODE=1 electron`)
  that the harness spawns. Either way the choice is proven by a spike task before any spec is
  written, and recorded in the plan.
- `harness/launch.ts` — `launchNtwine({ root, userData, appData, libraryRoot, executablePath?,
  extraEnv? })` returns `{ app, page, seam, close }`: asserts the launch target is a
  **production** artifact (`.vite/renderer/main_window/index.html` exists **and**
  `.vite/build/main.js` contains no `http://localhost:` dev-server define — else fails fast
  with "run `yarn e2e` / `yarn package` first"), calls `_electron.launch({ args:
  ['.vite/build/main.js'], env })` with `NTWINE_E2E=1` + the three dirs and
  `ELECTRON_ENABLE_LOGGING=1`, awaits `firstWindow()`, then
  `page.waitForFunction(() => typeof window.__ntwineE2E === 'function')`. `seam` wraps the
  `evaluate` listener idiom and the per-event counters. Three specs call it directly
  (`persistence` — a second launch on the same root; `real-library` — real `appData`; and it
  is *not* used by `packaged`, see §4).
- `harness/fixtures.ts` — the Playwright fixture `ntwine`: `mkdtemp` → `buildFixtureLibrary`
  → `launchNtwine` → yields `{ app, page, seam, fixture }` → teardown closes the app and
  removes the temp root (best-effort on Windows where WAL handles linger — retry, then leave
  it in `os.tmpdir()`; one leaked dir per failed test is acceptable).
- `harness/actions.ts` — the user-affordance helpers every spec shares: `importAndWait(page)`
  (click Import, wait for the library view), `search`, `clickPack`, `toggleType`, `pickKey`,
  `setBpm`, `toggleTag`, `readCount` (parses `"{n} samples"`), `rowByFilename` (matches the
  `title` attribute — the visible text is middle-truncated), `waitForWaveform(canvas)`
  (pixel-samples real bars vs the centre-line placeholder — v1's hand-QA classifier, made
  reusable). Locators use roles / `aria-label`s / text first, `data-testid` only where §3.1
  licenses one.
- `harness/packaged.ts` — resolves the packaged executable under `out/` per platform
  (`Ntwine.app/Contents/MacOS/Ntwine` on darwin, `Ntwine.exe` on win32).
- `playwright.config.ts` (repo root): `testDir: 'tests/e2e'`, `workers: 1`, `retries: 0`
  locally / `1` in CI, `timeout: 60_000`, reporters `list` + `html` (on failure),
  `trace: 'retain-on-failure'`. Projects: `default` (all specs except `@real`), `real`
  (grep `@real`, `timeout: 15 * 60_000` — see §4, only when `NTWINE_E2E_REAL=1`).

Launch target: **the production build, unpackaged** (`.vite/build/main.js` on the
`node_modules` Electron). `yarn e2e` = `electron-forge package && <e2e:only>`;
`e2e:only` is valid **only immediately after a `package`** — a `yarn start` in between
rewrites `.vite/build/main.js` in dev mode, which the launch guard above catches.

### 3.4 Waiting discipline (binding for every spec)

No `waitForTimeout` sleeps. Every wait is a **condition**: a locator state, a count text, a
seam event, a seam counter, or a snapshot predicate via `expect.poll`. Negatives are
counters that stay flat while a sibling positive increments — never silence. The waveform
wait has a generous ceiling (`30 s`); everything else uses the default. A spec that passes
with its subject deleted is a defect: each spec's task report names the falsifier that was
run once by hand (comment out the guard / hook, watch it fail).

## 4. The capsule (`tests/e2e/*.spec.ts`)

| File | Pins |
|---|---|
| `first-run.spec.ts` | fresh `userData` → FirstRun visible; the `Splice database:` row reads **`found`** with `NTWINE_APP_DATA` at the fixture, and a second launch with `NTWINE_APP_DATA` at an empty dir reads **`not found`** (the real glob, falsified both ways; the exact-path pin stays in `paths.test.ts`); click Import → the library view appears and `"{n} samples"` reads `12 samples`. The flip-only-after-`runImport()`-resolves ordering is **deliberately not e2e-pinned** — the view switch precedes `library.init()` and any retrying assertion would pass either way; it stays where it is falsifiable, `ImportStore.test.ts` (+ the App handler is a literal `await run(); flip`). |
| `persistence.spec.ts` | `close()`, then `launchNtwine` again on the same root → lands directly on the library with the same count; the settings sheet shows the persisted root. |
| `browse.spec.ts` | pack rail lists `All Samples` + the 3 packs; the 2 covered packs render an `<img>` with `naturalWidth > 0` from a `cover://` URL (PNG bytes behind a `.jpg` name — sniffed) and the third shows the fallback tile; clicking a pack scopes the count to that pack's sample count and `All Samples` restores it. |
| `filters.spec.ts` | type toggle → 8 / 4; key `c#` → 3, clear → 12; BPM 100–140 → 4 (unknown-bpm rows excluded); tag `kick` → 3, `kick`+`snare` (AND) → the generated intersection; the tag-chip text filter narrows the chip list; every clear restores 12; snapshot `filters` deep-equals `{}` after touch-then-clear (no phantom keys — the Task 12 fix). |
| `search.spec.ts` | typing `kick` shrinks to 3 (debounced — `expect.poll` on the count); prefix `kic` matches the same 3; a nonsense token → `0 samples`; clearing restores 12; the NFD-named sample's search behaviour (found by an ASCII-folded / NFC / exact query) is **measured once during implementation and pinned exactly as it is today**, the assertion message recording which. |
| `rows.spec.ts` | a known row shows filename (via `title`), pack name, `C♯ min` / `A` / `—`, `128` / `—`, `1.4s` / `—` from the DB `duration`; first 3 tags; the missing row has the missing badge and reduced opacity; the aiff rows render normally. |
| `waveforms.spec.ts` | after import, every visible non-missing row's canvas becomes "real bars" within 30 s; the missing row's canvas stays the placeholder; `peaksCached` converges to `>= visible non-missing count`. |
| `preview.spec.ts` | click a wav row → `ntwine:e2e:protocol {scheme:'sample', id, hit:true}` fires **on the first play of that id** and snapshot `selectedId === id`, `playCount` 1; ArrowDown → next row selected, protocol hit for the new id, `playCount` 2; Space → **`playCount` 3 with `lastPlayedId` unchanged** (replay is served from the buffer cache — no fetch, so the protocol seam is *not* the signal here); click an aiff row → `ntwine:e2e:preview-pcm {ok:true}` (fallback path); volume slider → snapshot `volume` changes. |
| `drag.spec.ts` | dispatch `dragstart` on a real row (`page.dispatchEvent`; HTML5 drags can't be mouse-driven headlessly and v1's hand-QA used the same dispatch) → `ntwine:e2e:drag {sampleId, file}` with `file` an absolute path under the fixture library that exists on disk. Missing-row refusal at **both** v1 layers: (a) renderer — the missing row has `draggable="false"`, and a dispatched `dragstart` on it leaves the drag counter flat while a following real-row drag increments it; (b) main — a bypass `page.evaluate(() => window.ntwine.startDrag(missingId))` yields `{sampleId, file:null}`. |
| `settings.spec.ts` | gear opens the sheet; "re-run import" is idempotent (count unchanged, no duplicate rows); the re-pick button calls `dialog.showOpenDialog`, stubbed via `electronApp.evaluate` to return the same root, and the root persists in the sheet. If the app captured `dialog` by reference at import (checked at implementation), the fallback is an E2E-armed `NTWINE_E2E_PICK_ROOT` override — either way with a test. |
| `security.spec.ts` | `page.evaluate(() => window.open('https://example.com'))` → `ntwine:e2e:window-open-denied` fires and `BrowserWindow.getAllWindows().length` stays 1; `page.evaluate(() => { location.href = 'https://example.com' })` → `ntwine:e2e:nav-denied` fires and `page.url()` is unchanged (positive signals, no settle); `page.evaluate(() => typeof require)` is `'undefined'`; `Object.keys(window.ntwine)` equals the 12-method contract; `window.__ntwineE2E` is a function (armed) — and a unit test pins that it is never attached unarmed. |
| `packaged.spec.ts` | (after `yarn package`) **fuse-safe boot probe, no Playwright driver:** spawn the packaged executable from Node with `NTWINE_E2E=1`, a temp `NTWINE_USER_DATA`, and `NTWINE_E2E_BOOT_MARKER=<tmp file>`; assert the process exits `0` within 30 s and the marker exists with the temp `userData` path inside — the artifact boots, loads the renderer, and its natives (F7) work. Also asserts that spawning it with `NTWINE_E2E=1` **without** `NTWINE_USER_DATA` exits non-zero without creating `…/Ntwine/ntwine-data` under the real app-data root (the boot guard, on the artifact where it matters). |
| `real-library.spec.ts` `@real` | opt-in (`NTWINE_E2E_REAL=1`), 15-minute timeout: temp `userData`, **real** `appData` and library; import → count equals `SELECT COUNT(*) FROM samples` read from the detected DB by the test itself; does not wait for waveforms; skips (not fails) when no DB is detected. **Network-bound by design:** the first import fetches ~612 covers sequentially. |

Unit-side additions in the same lane: `src/main/e2e.test.ts` (config parsing; unarmed →
`null`; armed without `NTWINE_USER_DATA` → refusal; hooks installed only when armed); the
audio generator's WAV/AIFF headers pinned by decoding them with the unit suite's existing
`decodeAudio`.

## 5. Gate, platforms, CI

- **Gate:** `yarn e2e` (package + suite) green **first-hand** on the machine that merges, in
  addition to `yarn test && yarn typecheck && yarn lint`. README gets a "Verification"
  section naming all four, the `@real` opt-in, the `e2e:only` rule (valid only right after a
  `package`), and the fresh-clone note: **run `yarn e2e` (or `yarn start` once) before
  `yarn test`** — Forge's rebuild is what puts `better-sqlite3` on Electron's ABI.
- **Platforms:** macOS (owner's Mac, now) and **Windows** (owner's box, when the library and
  DB are transferred). The suite must be path-agnostic (`path.join`, `os.tmpdir()`,
  `pathToFileURL`/`fileURLToPath`, no `/` literals), and the harness resolves the Electron and
  packaged binaries per platform. **Expected:** the first Windows run will surface app
  defects — the app has never run there; the win32 detection pattern is a documented best
  guess. Those are findings the backstop *earns*, fixed as ordinary follow-ups; they are not
  defects of this lane. Linux: out (C2).
- **CI:** `.github/workflows/e2e.yml` — `on: workflow_dispatch`, matrix `macos-latest` +
  `windows-latest`, steps in this order: checkout → `actions/setup-node@v4` (**Node 22
  LTS** — the host Node only runs yarn/Forge/Vite; app and tests execute under Electron's
  Node) with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` in the job env → `yarn --frozen-lockfile`
  → **`yarn e2e` first** (its `package` step rebuilds `better-sqlite3` for Electron's ABI) →
  `yarn test` → `yarn typecheck` → `yarn lint` → upload the Playwright HTML report + traces
  on failure. `yarn test` before the rebuild would fail on the ABI mismatch — the order is
  load-bearing and the workflow says so in a comment. No auto-trigger; flipping to
  `pull_request` is a one-line change the owner makes deliberately.

## 6. Tooling pins and repo hygiene

- `@playwright/test` (latest 1.x at implementation time; pinned exactly in `package.json`
  like the rest of the dev toolchain), devDependency. `@electron-forge/plugin-auto-unpack-
  natives` registered in `forge.config.ts` (F7).
- Scripts: `e2e` (`electron-forge package && yarn e2e:only`), `e2e:only` (the runner per
  §3.3's decided strategy), `e2e:real` (`cross-env NTWINE_E2E_REAL=1 … --project real`).
- Vitest keeps `include: ['src/**/*.test.ts']`; Playwright owns `tests/e2e/**/*.spec.ts` —
  different roots **and** different suffixes, so neither runner picks up the other's files.
  `tsconfig.json` has no `include`, so `yarn typecheck` already types `tests/e2e/**` — no
  change. ESLint's flat config lints `**/*.ts` — the specs must pass `yarn lint`
  (`eslint-plugin-playwright` is **not** added — boring first).
- Git-ignored: `playwright-report/`, `test-results/`, `.vite/e2e/` (fallback only), plus the
  existing `out/`, `.vite/`.
- Data-leak law unchanged: nothing under `.local/` is ever referenced by the suite; the
  fixture is generated, never copied from real data.

## 7. Risks and unknowns (each has an owner in the plan)

| Risk | Handling |
|---|---|
| Runner-under-Electron strategy (Playwright's own worker processes inherit `ELECTRON_RUN_AS_NODE`; the app launch must not) | the plan's **first task is the spike**: prove runner + fixture + one launch under the primary strategy, else switch to the helper fallback — before any spec |
| Playwright's Electron driver vs Electron 43 on Windows | proven on macOS; the Windows first-run is the owner's gate; the plan front-loads a Windows "boot" smoke so it fails early and loudly |
| `electron-forge package` on Windows / unsigned macOS with `EnableEmbeddedAsarIntegrityValidation` | `package` (not `make`) is all the suite needs; the packager embeds asar hashes without code signing — if the packaged probe fails, read the log for integrity vs native-load before touching F7 |
| Gate wall-time (`package` per `yarn e2e` run) | `e2e:only` for iteration behind the production-artifact guard; `package` stays the gate's build step |
| Headless waveform pass timing on CI runners | 30 s ceiling; condition wait; only *visible* rows required |
| Fixture aiff must be decodable by `audio-decode` | the shared generator's output is decoded by the unit suite's `decodeAudio` in a unit test |
| `dialog.showOpenDialog` stubbing via `evaluate` | falls back to `NTWINE_E2E_PICK_ROOT` if the app captured a reference; test either way |
| Temp-dir cleanup on Windows (WAL handles; catalog not explicitly closed on quit) | close the app, retry-remove, tolerate leftovers |
| The suite becomes the place feature PRs "fix" by weakening assertions | every spec's report names its falsifier; any PR that edits `tests/e2e/` must call out each weakened assertion explicitly in review |

## 8. Definition of done

- `yarn e2e` green first-hand on macOS on the merging tree; every capsule spec in §4 present
  and non-vacuous (falsifier named per spec in its task report); `yarn test`/`typecheck`/
  `lint` still green; F7 landed and the packaged probe green.
- README "Verification" section; the dispatch-only workflow file present, valid YAML, steps
  in the load-bearing order.
- Windows: the suite is **expected** to be run by the owner on his box once the library is
  transferred; a checklist item in the PR body records it as owner-pending, not as done.
- No product behaviour changed outside §3.1; the unarmed app is unit-pinned identical.

## 9. Panel outcome (mirror review, 2026-08-17)

Three reviewers (Claude, Codex, agy), one byte-identical prompt (md5 `fb09a0e2…`). Verdict
NEEDS REVISION → applied above. What changed, and the decisions the owner delegated:

- **3/3** FirstRun asserted a DB *path* the UI never renders → now `found`/`not found` with a
  falsifying control launch. **2/3** the renderer snapshot attaches asynchronously → now
  attached synchronously and awaited by the harness.
- **Codex:** no library-root override (import would reject every fixture row) → `NTWINE_LIBRARY_ROOT`;
  Playwright process is host-Node while `better-sqlite3` is Electron-ABI → the runner
  strategy in §3.3 with a spike-first task and a named fallback; ungated env overrides
  contradicted "unarmed = v1" → everything gated; `file://` strings → `pathToFileURL`.
- **Claude:** `app.setPath` throws on a missing dir → `mkdirSync` first + `root/userData` in the
  fixture; flip-after-covers pin was unfalsifiable → removed, ordering stays unit-level;
  Space-replay can't produce a fetch (buffer cache) → E2E `playCount`/`lastPlayedId` counter;
  packaged binary's fuses block the Playwright inspector attach → fuse-safe boot-marker probe;
  stale dev-mode `.vite/build` would test the wrong branch → production-artifact guard;
  real smoke would time out on 612 sequential cover fetches → 15-min project timeout,
  documented as network-bound; hooks unit-untestable if they lived in `main.ts` → pure
  `src/main/e2e.ts`; CI ran `yarn test` before any Forge rebuild → order fixed + README
  fresh-clone note; navigation "settle" was a sleep → seam events for both denials;
  `launchNtwine` factored under the fixture; the fixture-audio generator made genuinely
  shared; `data-testid` licence reconciled + `title`-attribute matching; boot guard when
  `NTWINE_USER_DATA` is missing; `tsconfig` needs no change; PNG-behind-`.jpg` sniffing and
  DB-`duration` vs audio-length made explicit; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` in CI.
- **agy:** CI Node 22 (host Node runs tooling only).
- **Decided here (delegated):** flag reaches the preload via `additionalArguments`, not a
  widened `getState()` (production contract untouched); packaged smoke is the marker probe,
  not a driver launch; runner ABI = primary-with-fallback, spike decides. Nothing left open.
