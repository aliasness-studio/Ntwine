# Ntwine — end-to-end regression backstop (Playwright) — design

**Status:** draft for mirror-panel review · **Date:** 2026-08-17 · **Baseline:** `main` @ `0434526`
(v1 merged via PR #1) · **Parent:** `docs/superpowers/specs/2026-08-16-ntwine-v1-design.md`

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
  driver; nothing bespoke where a documented Playwright feature exists.

Orchestrator calls (owner delegated the details to this doc + the panel):

- **C1** — the production build path is `electron-forge package`, therefore the half-wired
  native-module unpacking (final v1 review, "F7") is **fixed in this lane** (one plugin
  registration) and the suite includes **one packaged-app boot smoke**. The capsule then
  covers the shippable artifact too, and `yarn package` is proven on both platforms before it
  is needed.
- **C2** — **Linux is out of scope** for the suite. The app cannot import without Splice
  detection (no Linux glob; non-Splice sources are the *next* product feature), so a Linux leg
  would need a bypass code path that exists only to satisfy CI. YAGNI.
- **C3** — **no pre-push hook.** The owner runs gates first-hand; a hook is a one-liner if he
  asks.

## 1. Scope

**In:** an env-gated E2E mode inside the app (data-dir redirection + a handful of observable
seam events); a synthetic fixture generator; the Playwright harness (config, launch fixture,
helpers); the capsule specs (§4); the `yarn e2e` gate; the dispatch-only workflow; README
docs; the F7 fix + packaged smoke; the opt-in real-library smoke.

**Out (non-goals):** visual-regression screenshots (a redesign would churn them; DOM/state
assertions age better); performance assertions; Linux; auto-run CI; a pre-push hook; any new
product feature; any change to v1 behaviour beyond what §3.1 names.

## 2. Ground truth the design load-bears on (verified 2026-08-17)

Verified in the merged code / on the owner's machine unless marked otherwise:

- `src/main.ts` reads `app.getPath('userData')` for the catalog root
  (`dataDirFrom(userData) = <userData>/ntwine-data`), and `src/main/ipc.ts` reads
  `app.getPath('appData')` for Splice-DB detection through
  `resolveSpliceDbCandidates(appDataDir)` — a `globSync` of
  `com.splice.Splice/users/default/*/sounds.db` with `cwd = appDataDir` (identical pattern for
  `darwin` and `win32`; the win32 pattern is a best-guess mirror marked TODO in code).
- Electron `app.setPath('userData' | 'appData', p)` overrides those lookups when called before
  `whenReady` (Electron docs; `userData` is NOT recomputed from a changed `appData`, so both
  are set explicitly).
- The renderer is a bridged React app: `window.ntwine` (12 typed methods) is the only main
  access; `contextIsolation`/sandbox defaults on. Rows are TanStack-virtualized 40 px rows;
  the top bar renders `"{n} samples"`; missing rows render at 40 % opacity with a badge;
  failed-decode rows render a placeholder + badge; `WaveformThumb` is a `<canvas>` with a
  1 px-floor bar draw for real peaks and a thin centre line for the null placeholder.
- Custom schemes `sample://s/<id>` and `cover://p/<id>` are served by `protocol.handle` via
  `net.fetch(pathToFileURL(...))`; **`net.fetch` reads `file:` URLs** (this is how covers and
  audio already work in production — verified by v1 hand-QA and RMS-probe playback).
- Covers are downloaded at import through the injected `fetchFn` (`net.fetch(url)` in
  production) for packs where `cover_url IS NOT NULL AND splice_uuid IS NOT NULL`, into
  `<dataDir>/covers/<uuid>.jpg`; the write path is containment-checked.
- Drag: renderer `dragstart` → `preventDefault` → `ipcRenderer.send('ntwine:drag-start', id)`
  → main `registerDragHandler` → shared `resolveSampleAbsPath` (unknown/missing → `null`) →
  `existsSync` → `event.sender.startDrag({file, icon})`. A native `startDrag` opens an OS
  drag session that blocks until mouse-up.
- Preview: `previewPlayer` fetches `sample://s/<id>` and decodes with `decodeAudioData`; on
  rejection (AIFF) it calls `api.decodePreviewPcm(id)` (one-shot `utilityProcess` decode in
  main). Retrigger ramps the prior voice's own gain; a generation counter discards stale
  decodes.
- Import: `runImport()` resolves after snapshot → catalog → stat → covers; the waveform pass
  continues in the background and reports `phase: 'waveforms'` ticks then `phase: 'done'`
  over `onImportProgress`. FirstRun flips to the library **only** on `runImport()` resolving.
  On relaunch with `imported = 1`, main resumes any pending peaks.
- Security fences from v1: `setWindowOpenHandler` denies every `window.open`; `will-navigate`
  allows only the app's own origin (dev-server origin / exact packaged `index.html` path);
  scheme privileges include `corsEnabled` (needed for renderer `fetch()` under Electron 43's
  CORS enforcement) — safe *because* of those denials.
- Build/tooling: Electron Forge 7.11 + Vite 5 (CJS main), `electron` 43.4.0 in
  devDependencies (its binary is `node_modules/electron/dist/...`), production build via
  `electron-forge package` writes `.vite/build/main.js`, `.vite/build/preload.js`,
  `.vite/build/peaksWorker.js`, `.vite/renderer/main_window/index.html` (git-ignored) **and**
  `out/<Ntwine-platform-arch>/…` (git-ignored). `main.ts` loads the renderer from
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html` when the dev-server define is absent.
  `forge.config.ts` has `asar: true` and `@electron-forge/plugin-auto-unpack-natives`
  **installed but not registered** in `plugins` (F7); `better-sqlite3` and `audio-decode`
  are runtime `dependencies` (so they ship in a package). Unit tests: Vitest,
  `include: ['src/**/*.test.ts']`, run under `ELECTRON_RUN_AS_NODE=1 electron`.
- Playwright's Electron driver (`_electron.launch({ args, env, executablePath? })` +
  `electronApp.evaluate(...)` in the main process + `firstWindow()` → a normal `Page`) boots
  **this exact app on this exact Electron** — proven during the v1 final fix wave (a
  throwaway `playwright-core` driver, never committed). No browser download is needed for
  Electron targets. Note for agents: macOS Accessibility / Screen Recording permissions are
  NOT available to automation on this machine — Playwright's Electron driver is the reliable
  path, not GUI scripting.
- The owner's real library: `~/Splice`, 4,197 files (16 `.aif`), Splice DB at
  `~/Library/Application Support/com.splice.Splice/users/default/<user>/sounds.db`, real SQL
  `NULL` for absent `audio_key`/`chord_type`. Nothing may write into `~/Splice`. The
  developer catalog lives at `~/Library/Application Support/Ntwine/ntwine-data/`; the suite
  must never touch it (D1 → temp dirs only).

## 3. Architecture

Four units, each independently understandable:

```
tests/e2e/fixture/   builds a Splice-shaped library + sounds.db in a temp dir   (pure Node)
tests/e2e/harness/   Playwright fixture: build → launch app in E2E mode → page  (Playwright)
tests/e2e/*.spec.ts  the capsule — one file per flow group                      (Playwright)
src/main.ts (+2)     the E2E mode contract the app honours when armed           (app)
```

### 3.1 The app's E2E mode (the only product-code change)

Read once in `src/main.ts` **before** `app.whenReady()`, from `process.env`:

| Variable | Effect |
|---|---|
| `NTWINE_E2E=1` | arms the seam events below; nothing else changes |
| `NTWINE_USER_DATA=<abs dir>` | `app.setPath('userData', dir)` — the catalog/covers/snapshot live under `<dir>/ntwine-data` |
| `NTWINE_APP_DATA=<abs dir>` | `app.setPath('appData', dir)` — Splice-DB detection globs under this root |

Both path overrides are honoured regardless of `NTWINE_E2E`; the events fire **only** when
`NTWINE_E2E=1`. Outside E2E mode the app is byte-for-byte v1 behaviour (a test — unit level —
pins that with `NTWINE_E2E` unset the hooks are not registered).

Seam events (emitted on the `app` object, main process; a test observes them with
`electronApp.evaluate(({app}) => new Promise(r => app.once('<name>', r)))`):

| Event | Payload | Emitted from |
|---|---|---|
| `ntwine:e2e:drag` | `{ sampleId, file: string \| null }` | `registerDragHandler`, after resolution + `existsSync`; **in E2E mode the native `startDrag` is skipped** (an OS drag session would block a headless run) — the payload is exactly what `startDrag` would have received, `file: null` on refusal |
| `ntwine:e2e:protocol` | `{ scheme: 'sample' \| 'cover', id: number \| null, hit: boolean }` | the `protocol.handle` callbacks, after `resolveProtocolRequest` |
| `ntwine:e2e:preview-pcm` | `{ sampleId, ok: boolean }` | the `decodePreviewPcm` IPC handler, on settle |

Renderer side, when `window.ntwine.getState()` reports `e2e: true` (one new boolean on the
existing `getState()` — the preload cannot read main's env in a sandboxed renderer, so main
reports it): `src/renderer.tsx` attaches `window.__ntwineE2E`, a **read-only snapshot
function** `() => ({ rows, resultCount, selectedId, volume, filters, importPhase, running,
peaksCached })` over the three stores. Used only where the DOM carries no signal (playback
selection state, cache convergence). Everything else is asserted **on what the user reads**.

`ipcTypes.ts` gains `e2e: boolean` on the state shape; `global.d.ts` types
`window.__ntwineE2E`. That is the entire product surface: ~30 lines in `main.ts`,
`drag.ts`, `protocol.ts`, `ipc.ts`, `renderer.tsx`, `ipcTypes.ts`.

### 3.2 The synthetic fixture (`tests/e2e/fixture/`)

`buildFixtureLibrary(root: string): FixtureLibrary` — pure Node, no Electron — writes under a
caller-supplied temp `root`:

- `root/appData/com.splice.Splice/users/default/e2e/sounds.db` — via the existing
  `src/main/importer/fixtureSpliceDb.ts#buildFixtureSpliceDb` (the unit suite's builder;
  it already models real `NULL`s). Rows: **3 packs**, **12 samples**.
- `root/library/sounds/packs/<Pack>/<vendor>/<file>` — **11 real audio files** generated by
  the same code path as `scripts/gen-fixture-audio.mjs` (16-bit PCM sines; varied durations
  100 ms–2.5 s so `formatDuration` has known strings; **9 wav + 2 aiff**), and **1 DB row
  whose file is deliberately absent** (the missing-row case). All samples' `local_path`
  values are under `root/library`.
- Metadata chosen so every filter has a **known expected count**: `sample_type` 8 oneshot /
  4 loop; `bpm` 0 (none) on 5, `90` on 3, `128` on 4; `audio_key` NULL on 4, `c#` on 3,
  `a` on 5; `chord_type` NULL / `major` / `minor` mixed; `tags` such that `kick` matches
  exactly 3, `snare` 2, `drums` 6 (case/space variants included to pin `parseTags`); one
  filename contains a non-ASCII NFD character (spec v1 §10 case).
- Covers: `cover_url` = `file://<root>/covers-src/<uuid>.png` for 2 packs (tiny generated
  PNGs — the covers path runs end to end with **zero network**), `NULL` for the third (the
  fallback tile path).
- Returns the exact expectations (`totalSamples`, per-filter counts, `missingFilename`,
  `aiffIds`, pack names, cover pack names) so specs assert against **generated truth, not
  hardcoded literals** — but each spec still states the concrete number in its assertion
  message so a drift reads clearly.

The fixture is rebuilt **per test** (it takes milliseconds); no shared state between tests.

### 3.3 The harness (`tests/e2e/harness/`)

- `playwright.config.ts` (repo root): `testDir: 'tests/e2e'`, `workers: 1` (one Electron
  instance at a time), `retries: 0` locally / `1` in CI, `timeout: 60_000`, reporters `list`
  + `html` (on failure), `trace: 'retain-on-failure'`. Projects: `default` (all specs except
  `@real`), `real` (grep `@real`, only when `NTWINE_E2E_REAL=1`).
- `harness/electronApp.ts` — a Playwright **fixture** `ntwine` that: makes a temp root
  (`fs.mkdtemp`), calls `buildFixtureLibrary`, launches
  `_electron.launch({ args: ['.vite/build/main.js'], env: { ...process.env, NTWINE_E2E: '1',
  NTWINE_USER_DATA, NTWINE_APP_DATA, ELECTRON_ENABLE_LOGGING: '1' } })`, awaits
  `firstWindow()`, waits for `window.ntwine` to be defined, and yields
  `{ app, page, fixture, seam }` where `seam.next('ntwine:e2e:drag')` wraps the
  `electronApp.evaluate` listener idiom; teardown closes the app and removes the temp root
  (best-effort on Windows where file locks linger — retry, then leave it in `os.tmpdir()`).
- `harness/actions.ts` — the user-affordance helpers every spec shares: `importAndWait(page)`
  (click Import, wait for the library view — **never for a progress event**),
  `search(page, text)`, `clickPack`, `toggleType`, `pickKey`, `setBpm`, `toggleTag`,
  `readCount(page)` (parses `"{n} samples"`), `rowByFilename`, `waitForWaveform(canvas)`
  (pixel-samples the canvas: real bars vs the centre-line placeholder — the v1 hand-QA
  classifier, made reusable). Helpers locate elements by **user-facing text / roles /
  `data-testid`**; where v1 markup has no stable handle, the spec adds a `data-testid`
  (renderer-only, no behaviour change).
- `harness/packaged.ts` — resolves the packaged executable under `out/` per platform
  (`Ntwine.app/Contents/MacOS/Ntwine` on darwin, `Ntwine.exe` on win32) for the single
  packaged smoke.

Launch target: **the production build, unpackaged** (`.vite/build/main.js` on the
`node_modules` Electron). `yarn e2e` = `yarn package && playwright test`; `yarn e2e:only`
skips the build for fast iteration. The build step is what makes C1's F7 fix necessary and
what makes the packaged smoke free.

### 3.4 Waiting discipline (binding for every spec)

No `waitForTimeout` sleeps. Every wait is a **condition**: a locator state, a count text, a
seam event, or a store-snapshot predicate via `expect.poll`. The waveform wait has a
generous ceiling (`30 s`) because the background pass is real work; everything else uses the
default. A spec that passes with its subject deleted is a defect (each spec's report names
the falsifier that was run once by hand: comment out the guard / hook, watch it fail).

## 4. The capsule (`tests/e2e/*.spec.ts`)

| File | Pins |
|---|---|
| `first-run.spec.ts` | fresh `userData` → FirstRun visible; the detected DB path shown is the fixture path (proves detection through the real glob); click Import → the library view appears and `"{n} samples"` reads `12 samples`; **flip-after-covers** is pinned by observation, not timing: at the moment the library view is first visible the two cover `<img>`s already resolve (`naturalWidth > 0`) and the count is final. (A 12-sample import completes in well under a second, so intermediate-phase assertions would race — the button-disable and phase-ordering invariants stay pinned at unit level in `ImportStore.test.ts`, which is where they already live.) |
| `persistence.spec.ts` | relaunch the same `userData` (second `_electron.launch`) → lands directly on the library with the same count; the settings sheet shows the persisted root. |
| `browse.spec.ts` | pack rail lists `All Samples` + the 3 packs; the 2 covered packs render an `<img>` with `naturalWidth > 0` from a `cover://` URL and the third shows the fallback tile; clicking a pack scopes the count to that pack's sample count and `All Samples` restores it. |
| `filters.spec.ts` | type toggle → 8 / 4; key `c#` → 3, clear → 12; BPM 100–140 → 4 (unknown-bpm rows excluded); tag `kick` → 3, `kick`+`snare` (AND) → the generated intersection; the tag-chip text filter narrows the chip list; every clear restores 12; the active-filter state has **no phantom keys** (snapshot `filters` deep-equals `{}` after touch-then-clear — the Task 12 fix). |
| `search.spec.ts` | typing `kick` shrinks to 3 (debounced — assert via `expect.poll` on the count, not a sleep); prefix `kic` matches the same 3; a nonsense token → `0 samples`; clearing restores 12; the NFD-named sample's search behaviour (found by an ASCII-folded / NFC / exact query) is **measured once during implementation and pinned exactly as it is today** — that is what a time capsule does; the assertion message records the pinned behaviour. |
| `rows.spec.ts` | a known row shows filename, pack name, `C♯ min` / `A` / `—`, `128` / `—`, `1.4s`-style duration; first 3 tags; the missing row has the missing badge and reduced opacity; the aiff rows are present and drawn normally. |
| `waveforms.spec.ts` | after import, every visible non-missing row's canvas becomes "real bars" within 30 s; the missing row's canvas stays the placeholder; `peaksCached` converges to `>= visible non-missing count`. |
| `preview.spec.ts` | click a wav row → `ntwine:e2e:protocol` fires `{scheme:'sample', id, hit:true}` and snapshot `selectedId === id`; ArrowDown → next row selected + a second protocol hit for that id; Space → a further hit for the same id (replay); click an aiff row → `ntwine:e2e:preview-pcm {ok:true}` fires (fallback path); volume slider drag changes snapshot volume. |
| `drag.spec.ts` | dispatch `dragstart` on a real row (via `page.dispatchEvent` — HTML5 drags can't be mouse-driven headlessly, and v1's own hand-QA used the same dispatch) → `ntwine:e2e:drag` reports `{sampleId, file}` with `file` an absolute path under the fixture library that exists on disk. Missing-row refusal is pinned at **both** layers v1 implements: (a) renderer — the missing row carries `draggable="false"` (assert the attribute; a dispatched `dragstart` on it must not produce a seam event within the seam's short listen window, asserted as a positive `expect.poll` that the drag-event counter stays 0 while a subsequent real-row drag increments it — the counter, not silence, is the evidence); (b) main — a direct bypass `page.evaluate(() => window.ntwine.startDrag(missingId))` produces `ntwine:e2e:drag {sampleId, file:null}` (the resolver refuses regardless of the renderer guard). |
| `settings.spec.ts` | gear opens the sheet; "re-run import" is idempotent (count unchanged, no duplicate rows); the sheet's re-pick button calls `dialog.showOpenDialog` — stubbed via `electronApp.evaluate` to return the same root — and the root persists (settings text). |
| `security.spec.ts` | `page.evaluate(() => window.open('https://example.com'))` → `BrowserWindow.getAllWindows().length` stays 1; `page.evaluate(() => { location.href = 'https://example.com' })` → URL unchanged after a settle; `page.evaluate(() => typeof require)` is `'undefined'` (no node in renderer); `Object.keys(window.ntwine)` equals the 12-method contract. |
| `packaged.spec.ts` | (after `yarn package`) launch the packaged executable with the same env → first window appears, `getState()` answers, FirstRun renders — the artifact boots with natives (F7) working. |
| `real-library.spec.ts` `@real` | opt-in (`NTWINE_E2E_REAL=1`): temp `userData`, **real** `appData` and library; import → count equals `SELECT COUNT(*) FROM samples` read from the detected DB by the test itself; does not wait for waveforms; skips (not fails) when no DB is detected. |

Unit-side additions in the same lane: `resolveSpliceDbCandidates` already has tests; new
unit tests pin the E2E-mode gate (hooks absent when unarmed; present when armed) and the
`getState().e2e` flag.

## 5. Gate, platforms, CI

- **Gate:** `yarn e2e` (build + suite) green **first-hand** on the machine that merges, in
  addition to `yarn test && yarn typecheck && yarn lint`. README gets a "Verification"
  section naming all four and the `@real` opt-in.
- **Platforms:** macOS (owner's Mac, now) and **Windows** (owner's box, when the library and
  DB are transferred). The suite must be path-agnostic (`path.join`, `os.tmpdir()`,
  `fileURLToPath`, no `/` literals), and the harness resolves the Electron/packaged binary
  per platform. **Expected:** the first Windows run will surface app defects — the app has
  never run on Windows; the win32 detection pattern is a documented best guess. Those are
  findings the backstop *earns*, fixed as ordinary follow-ups; they are not defects of this
  lane. Linux: out (C2).
- **CI:** `.github/workflows/e2e.yml` — `on: workflow_dispatch`, matrix `macos-latest` +
  `windows-latest`, steps: checkout, `actions/setup-node@v4` (Node 20 — the demonstrated
  floor), `yarn --frozen-lockfile`, `yarn test`, `yarn e2e`, upload the Playwright HTML
  report + traces on failure. No auto-trigger; flipping to `pull_request` is a one-line
  change the owner makes deliberately.

## 6. Tooling pins and repo hygiene

- `@playwright/test` (latest 1.x at implementation time; pinned exactly in `package.json`
  like the rest of the dev toolchain), devDependency. No `playwright install` step (Electron
  target). `@electron-forge/plugin-auto-unpack-natives` registered in `forge.config.ts`
  (F7).
- Scripts: `e2e` (`electron-forge package && playwright test`), `e2e:only`
  (`playwright test`), `e2e:real` (`cross-env NTWINE_E2E_REAL=1 playwright test --project
  real`).
- Vitest keeps `include: ['src/**/*.test.ts']`; Playwright owns `tests/e2e/**/*.spec.ts` —
  different roots **and** different suffixes, so neither runner ever picks up the other's
  files. `tsconfig.json` `include` covers `tests/e2e/**` (or a `tsconfig.e2e.json` extends
  it) so `yarn typecheck` types the specs; ESLint's flat config already lints `**/*.ts` —
  the specs must pass `yarn lint` (Playwright's recommended `eslint-plugin-playwright` is
  **not** added — boring first).
- Git-ignored: `playwright-report/`, `test-results/`, `out/`, `.vite/` (last two already).
- Data-leak law unchanged: nothing under `.local/` is ever referenced by the suite; the
  fixture is generated, never copied from real data.

## 7. Risks and unknowns (each has an owner in the plan)

| Risk | Handling |
|---|---|
| Playwright's Electron driver vs Electron 43 on Windows | proven on macOS; Windows is the owner's first-run gate; the plan front-loads a "boot on Windows" smoke as its own task so it fails early and loudly |
| `electron-forge package` on Windows (Squirrel maker, native rebuild) | `package` (not `make`) is all the suite needs; makers are untouched |
| Headless waveform pass timing on CI runners | 30 s ceiling; the wait is a condition, not a sleep; only *visible* rows are required |
| Fixture aiff must be decodable by `audio-decode` | the unit suite already decodes the same generated `sine.aiff` — reuse that generator byte-for-byte |
| `dialog.showOpenDialog` stubbing via `evaluate` | Playwright documents main-process evaluation; the stub replaces the function on the imported `dialog` module object for the app's lifetime; if the app captured a reference at import time, the plan's task falls back to a `NTWINE_E2E_PICK_ROOT` env override — **decided at implementation with a test either way** |
| Temp-dir cleanup on Windows (SQLite WAL handles) | close the app, then retry-remove; leftover temp dirs are acceptable |
| The suite becomes the place feature PRs "fix" by weakening assertions | every spec's report names its falsifier; the final review of any PR that edits `tests/e2e/` must call out each weakened assertion explicitly |

## 8. Definition of done

- `yarn e2e` green first-hand on macOS on the merging tree; every capsule spec in §4 present
  and non-vacuous (falsifier named per spec in its task report); `yarn test`/`typecheck`/
  `lint` still green; the F7 fix landed and the packaged smoke green.
- README "Verification" section; the dispatch-only workflow file present and valid YAML.
- Windows: the suite is **expected** to be run by the owner on his box once the library is
  transferred; a checklist item in the PR body records it as owner-pending, not as done.
- No product behaviour changed outside §3.1; the unarmed app is unit-pinned identical.
