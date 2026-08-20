# Ntwine v1 — Design Spec

**Date:** 2026-08-16 · **Status:** mirror-panel reviewed (Claude + Codex + agy), consensus applied — ready for the implementation plan · **Repo:** `aliasness-studio/Ntwine`

## 1. What and why

Ntwine is a cross-platform desktop sample browser for people who left Splice but kept
their downloaded library. The Splice folder structure is painful to browse in Finder or
a DAW's file tree; the Splice client made it pleasant but requires the app and (in
spirit) the subscription. Ntwine makes the orphaned library browsable, searchable,
previewable, and drag-and-droppable into any DAW — without Splice installed.

v1 targets exactly one library: the owner's `~/Splice` folder, on macOS. Nothing in the
design may bake in macOS-only assumptions; Windows/Linux are later, not never.

## 2. Source data (verified firsthand, 2026-08-16)

### 2.1 The folder

`/Users/<user>/Splice` — 5.9 GB, 609 pack folders, 4,197 audio files (4,181 `.wav`,
16 `.aif`).

```
Splice/
  sounds/packs/<Pack Name>/<arbitrary vendor-defined nesting>/<sample>.(wav|aif)
  presets/            # ~670 Serum (.fxp) / Massive (.nmsv) presets — OUT OF SCOPE v1
  .splice             # 6-byte ASCII id file, no useful metadata
```

Non-audio clutter present among the samples: `.asd` (Ableton analysis), `.reapeaks`
(Reaper peaks), `.DS_Store`, stray `.zpw`/`.zpa`. The importer must ignore non-audio
files rather than error on them.

### 2.2 The metadata database

Splice's desktop app left a SQLite database behind:

```
~/Library/Application Support/com.splice.Splice/users/default/<splice-user>/sounds.db
```

Tables that matter (schema read firsthand):

- **`samples`** — `local_path` (absolute), `file_hash` (UNIQUE), `filename`,
  `pack_uuid` → packs, `sample_type` (`'oneshot'` | `'loop'`, no other values in the
  data), `bpm` (INTEGER, 0 = none), `audio_key` (lowercase pitch class; exactly the 12
  values `a a# b c c# d d# e f f# g g#`, sharps only; SQL NULL ×2977 = none), `chord_type`
  (SQL NULL ×3737 | `'major'` ×40 | `'minor'` ×420), `duration` (INTEGER,
  **milliseconds** — verified against decoded audio length on 4 samples), `tags`
  (comma-separated text), `purchased_at`, `waveform_url` (remote), `provider_name`.
  (The none-markers above were originally recorded as `''`: the sqlite3 CLI prints
  NULL as an empty string, so the first probe conflated them. The first REAL import
  (Task 13) failed on the actual NULLs; the importer now maps both NULL and `''`
  to catalog NULL, and the fixture builder can represent real NULLs.)
- **`packs`** — `uuid` (UNIQUE), `name`, `description`, `genre`, `provider_name`,
  `cover_url` (remote Cloudinary URL), `permalink`.

Coverage, measured: 4,197 sample rows (matches disk exactly), 612 pack rows vs 609
pack folders on disk — a handful of packs have DB rows but no surviving folder. The
importer must tolerate pack rows whose samples are all absent; the UI hides packs
with zero present samples. Tags on 100% of samples, bpm > 0 on 1,390, key on 1,220,
2,825 oneshots + 1,372 loops.

A timestamped copy already exists at `Ntwine/.local/sounds.db.snapshot-2026-08-16`
(gitignored). The original survives until Splice.app is uninstalled — after Ntwine's
first-run import, uninstalling is safe.

### 2.3 Facts an implementer must not re-derive wrong

- `duration` is milliseconds (verified firsthand: db `1395` ↔ 1.395 s, `9600` ↔
  9.600 s, `12830` ↔ 12.83 s). The importer still pins this with a fixture test so a
  future Splice-DB variant can't silently change units.
- Key display combines two columns: `audio_key` + `chord_type` (e.g. `c#` + `minor` →
  "C♯ min"). 460 samples have a chord type; the rest show the bare pitch class.
- `local_path` is absolute and machine-specific. Ntwine stores paths **relative to the
  library root** and keeps the root as a setting, so the library can move (or mount on
  another OS) without re-import.
- `cover_url` / `waveform_url` point at Splice's CDN. Covers get downloaded once at
  import while the URLs still resolve. Waveform URLs are **never used** — waveforms are
  computed locally from the audio files.

## 3. Product scope

### 3.1 v1 delivers

1. **First-run import** (§5): snapshot Splice's DB, build Ntwine's own catalog, cache
   cover art, start background waveform computation. Re-runnable, idempotent.
2. **Browse**: left rail of packs (cover, name) + "All Samples"; filters for
   sample type (one-shot/loop), key, BPM range, and tags. An active BPM or key
   filter **excludes** samples whose value is unknown — and unknowns are the
   majority (§2.2) — so the result count must make the shrinkage visible.
3. **Search**: one text box, instant-as-you-type, matching filename, tags, and pack
   name, combined with active filters.
4. **Preview**: click a row → it plays immediately. Arrow keys move selection and
   auto-play on landing. Space replays. Global volume control.
5. **Drag-out**: drag any row into a DAW/Finder; the OS receives the real file path.
   This is the app's reason to exist.
6. **Missing-file honesty**: rows whose file is gone are shown grayed with a badge,
   never crash, and are excluded from preview/drag.

### 3.2 v1 explicitly does NOT deliver

- Favorites, ratings, or user-defined tags (schema leaves room; see §6).
- Non-Splice libraries (NI expansions etc.). The importer is behind a
  `LibraryImporter` interface so a second strategy slots in without surgery.
- Preset browsing (`presets/` folder), file editing, renaming, or any write to the
  sample library. **Ntwine treats `~/Splice` as read-only, always.**
- Windows/Linux builds (kept possible, not shipped).
- Auto-updates, installers, signing/notarization — v1 is a locally built artifact.

## 4. Architecture

**Stack:** Electron (Forge + Vite template) · React · TypeScript · **MobX** ·
styled-components · yarn. Versions pinned in §9 from the research pass.

### 4.1 Stack alignment with AliasNess_Web (owner ruling, 2026-08-16)

Ntwine and AliasNess_Web share one frontend standard. Where a convention already
exists in AliasNess_Web, Ntwine **copies it rather than inventing**:

| Standard | Both repos use |
|---|---|
| React | 19.x |
| TypeScript | ~5.9, strict, modern features where applicable |
| State management | **MobX ^6.15 + mobx-react-lite ^4** (Web's proven pair; MobX 7.0.0 exists — upgrading is a deliberate joint lane for both repos, not a v1 default) |
| Styling | styled-components ^6 |
| Lint/format | ESLint 9 flat config + Prettier 3, config shape copied from Web |
| Package manager | yarn |

Electron forces two named deviations (acknowledged by the owner): the **main process
stays CJS** and **Vite stays at 5** (Forge 7.x constraints, §9.1) while Web is ESM on
Vite 7. Renderer source is ESM TypeScript under Vite either way, so renderer-side
code and concepts stay shareable. Longer-term direction (not v1 scope): the repos
should be able to share code, and eventually concepts like a common login/backend.

Renderer state lives in MobX stores behind `observer` components:
**LibraryStore** (filters, search text, current pack, result list),
**PlayerStore** (selection, playback state, volume),
**ImportStore** (import/waveform progress). Stores call the typed IPC bridge; React
components read stores only.

```
┌─ Main process (Node) ──────────────────────────────┐
│ catalog.db (SQLite + FTS5, incl. waveform peaks)   │
│ import pipeline → utilityProcess decode workers    │
│ cover cache                  webContents.startDrag │
│ custom protocol: sample:// serves audio by id      │
└──────────────┬─────────────────────────────────────┘
        typed IPC bridge (preload, contextIsolation on)
┌──────────────┴─────────────────────────────────────┐
│ Renderer (React): pack rail · filters · search box │
│ virtualized sample list · waveform thumbnails ·    │
│ preview player · drag initiation                   │
└────────────────────────────────────────────────────┘
```

Rules:

- The renderer never touches the filesystem or SQLite. Everything crosses one typed
  IPC surface (a single `ntwine` API object exposed via the preload script). Its
  method groups: catalog queries (search/filter/list), `getPeaks`,
  `decodePreviewPcm` (the one §9.3 AIFF fallback), `startDrag`, import control +
  progress events, settings (library root). Exact signatures are plan-phase work.
- Audio bytes reach the renderer only through the `sample://` custom protocol (no
  `file://`, `webSecurity` stays on) — with **one** typed exception:
  `decodePreviewPcm(sampleId)`, the AIFF preview fallback (§9.3), size-capped and
  resolved by main, never path-addressed.
- **`sample://` URLs are opaque catalog ids** (`sample://s/<id>`), never paths. Main
  resolves id → absolute path via the catalog, verifies the result stays under the
  library root, and refuses unresolvable or missing-flagged rows. A renderer-supplied
  path must never select a file — that would be filesystem read access with extra
  steps. (`standard: true` case-normalizes the URL host; numeric ids are immune.)
- Drag-out: renderer `onDragStart` → `ipc: drag-start(sampleId)` → main resolves the
  absolute path → `webContents.startDrag`.
- All catalog state lives in a subdirectory of `app.getPath('userData')`:
  `catalog.db`, `splice-snapshot/sounds.db`, `covers/<pack_uuid>.jpg`. Waveform
  peaks live **inside `catalog.db`** (§6 `waveforms` table) — one store, one home.

## 5. Import pipeline

Order matters; each step is resumable and idempotent.

1. **Locate**: the default library root is Splice's own reported folder — the
   `splice_folder` key of the `settings.json` that sits beside `sounds.db`
   (verified on a real Windows install 2026-08-20) — falling back to the
   platform's stock location (`~/Splice` on macOS, `<Documents>\Splice` on
   Windows) when that setting can't be read. A persisted `meta.library_root`
   (import or picker) always wins over both. The Splice DB base directory is
   resolved cross-platform via `app.getPath('appData')` + the Splice app's
   per-OS location (`com.splice.Splice/users/default/*/sounds.db` under appData on
   macOS, §2.2; `SpliceSettings/users/default/*/sounds.db` under LOCAL AppData on
   Windows — both verified on real installs, Windows 2026-08-19; the username
   segment is globbed, never hardcoded).
   Either location can be overridden by a picker. No macOS-only literal paths in
   the resolver.
2. **Snapshot**: copy `sounds.db` into userData before reading anything. If the
   original is already gone but a snapshot exists, import from the snapshot.
3. **Catalog build**: read `samples` + `packs` from the snapshot, write Ntwine's
   schema (§6). Tags split on commas, trimmed, lowercased, deduplicated. Paths
   stored relative to the library root. Upsert keyed on `file_hash` — re-running
   import never duplicates.
4. **Existence check**: stat every sample path; set/clear the `missing` flag.
5. **Covers**: download each pack's `cover_url` to `covers/` (skip existing). Failures
   are logged and non-fatal; missing cover renders a generic tile.
6. **Waveforms**: background queue decodes each audio file and stores fixed-size
   min/max peak buckets per sample (§5.1). UI renders thumbnails as they appear;
   placeholder bar until then.

If the Splice DB cannot be found at all: clear, non-technical error state naming the
path it looked for. (Filename-based fallback import is future work, out of v1.)

### 5.1 Waveform peaks

- Peaks are computed once per sample: decode PCM, downsample to **200 min/max
  buckets** (this line owns the number), store in the §6 `waveforms` table.
- **PCM decode never runs on the main event loop.** Decoding is main-process-*side*
  (§9.3 — Chromium cannot decode AIFF) but executes in a **`utilityProcess`** (or
  worker thread) that main spawns; main only coordinates the bounded queue and
  commits results to SQLite. `audio-decode` is pure JS — synchronous CPU — so
  running it on main would stall every IPC round trip and `sample://` response for
  the whole first-run pass, exactly when the user first browses. The concurrency
  bound (2–4) caps memory, not blocking; placement is what protects the feel bar.
- Invariants: **no network, computed from local audio, cached persistently, computed
  lazily/in background without blocking the UI.**

## 6. Catalog schema (Ntwine's own DB)

```sql
meta(key TEXT PRIMARY KEY, value TEXT);          -- schema_version, library_root, imported_at
packs(id INTEGER PRIMARY KEY, splice_uuid TEXT UNIQUE, name TEXT, genre TEXT,
      provider_name TEXT, cover_url TEXT, cover_file TEXT);
samples(id INTEGER PRIMARY KEY, file_hash TEXT UNIQUE NOT NULL, rel_path TEXT NOT NULL,
        filename TEXT NOT NULL, pack_id INTEGER REFERENCES packs(id),
        sample_type TEXT NOT NULL CHECK (sample_type IN ('oneshot','loop')),
        bpm INTEGER,            -- NULL = unknown (Splice's 0 maps to NULL)
        audio_key TEXT,         -- lowercase pitch class, NULL = unknown
        chord_type TEXT CHECK (chord_type IN ('major','minor')),  -- NULL = unknown
        duration_ms INTEGER,    -- direct copy; source is ms (§2.3)
        missing INTEGER NOT NULL DEFAULT 0);
tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
sample_tags(sample_id INTEGER REFERENCES samples(id),
            tag_id INTEGER REFERENCES tags(id), PRIMARY KEY (sample_id, tag_id));
waveforms(sample_id INTEGER PRIMARY KEY REFERENCES samples(id),
          peaks BLOB NOT NULL,            -- §5.1: 200 min/max pairs, Int8
          bucket_count INTEGER NOT NULL,
          format INTEGER NOT NULL DEFAULT 1);  -- bump to invalidate/recompute
-- Search: FTS5 table sample_search(filename, pack_name, tag_text,
-- sample_id UNINDEXED) holding denormalized text, rebuilt TRANSACTIONALLY
-- during import. Column order here matches the implemented DDL (db.ts) —
-- FTS5 highlight()/snippet() address columns by absolute index, so the DDL
-- is the one source of truth for order.
-- No live sync triggers in v1 — the catalog only changes at import time, and
-- import-time rebuild is where trigger-desync bugs can't exist.
```

Persisted-enum law (carried from the monorepo): `sample_type` stays TEXT, never a
bare renumberable integer. Room for favorites later = a future `user_meta` table,
not columns bolted onto `samples`. One honest caveat on the §3.2 importer seam:
the `LibraryImporter` *interface* is the easy half — these Splice-shaped
constraints (`file_hash NOT NULL`, the binary `sample_type` CHECK) are where a
non-Splice importer forces schema surgery. Accepted pre-release; noted so nobody
oversells the seam.

## 7. UI

Single window, three regions:

- **Left rail**: "All Samples", then packs sorted A→Z with cover thumbnail + name.
  Clicking scopes the list. Below: filter group — type toggle (one-shot/loop/both),
  key picker, BPM range, tag chips (top tags by count, searchable).
- **Top bar**: search box (instant, debounced ≤50 ms feel), result count, volume.
- **List**: virtualized fixed-height rows: waveform thumbnail, filename (middle-
  truncated), pack name, key, BPM, duration, tag chips. Selected row highlighted;
  keyboard ↑/↓ moves + auto-plays; Space replays; drag anywhere on the row drags the
  file out.
- **Settings affordance** (small gear, bottom of the rail): library-root re-pick
  (§8) and re-run import (§5). This is where those §5/§8 behaviors live in the UI.

Feel bar: scrolling 4,197 rows and typing in search must never jank. That is the
product. Visual design language: dark, dense-but-calm; detailed look developed during
implementation, not specified here.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Splice DB missing, no snapshot | Friendly blocking screen naming the searched path |
| Sample file missing | Grayed row + badge, excluded from preview/drag |
| Cover download fails | Generic tile, log line, import continues |
| Waveform decode fails (corrupt file) | Placeholder bar + badge, import continues |
| Library root moved | Settings screen re-pick → existence re-check (no re-import) |
| Drag of missing file | Drag refused, row flashes its badge |

## 9. Platform facts (research pass, 2026-08-16 — verified against current docs)

### 9.1 Electron / Forge / Vite

- Scaffold: `npx create-electron-app@latest ntwine --template=vite-typescript`.
  Forge **7.11.2** (stable), Electron **43.4.0** (Chromium 150, **Node 24.18.1**).
- Forge's Vite plugin is pinned to **Vite 5** and is officially "experimental":
  do NOT bump Vite to 6/7 (only the Forge v8 alphas support that), and keep the
  main process **CJS** — `"type": "module"` breaks plugin-vite 7.x.
- **Drag-out** (the make-or-break feature) confirmed: `webContents.startDrag({file,
  icon})`, renderer `ondragstart → preventDefault → IPC → main`. `icon` is required
  and **must be non-empty on macOS** — ship a small drag icon asset. Multi-file drag
  exists via `files: []` (future-proof for multi-select).
- **Audio serving**: register scheme before ready via
  `protocol.registerSchemesAsPrivileged([{scheme:'sample', privileges:{standard,
  secure, supportFetchAPI, corsEnabled, stream: true}}])`, then `protocol.handle('sample', req =>
  net.fetch(pathToFileURL(...)))`. The old `registerFileProtocol` family is
  deprecated. `corsEnabled` was added by Task 14's hand-QA: the renderer's origin
  (dev server / packaged file://) is cross-origin to the scheme, and Electron 43's
  CORS enforcement (CVE-2026-70604 hardening) blocks `fetch()` on a non-CORS scheme.
  It is scheme-wide, so it is safe ONLY while the app loads zero remote content —
  enforced by `setWindowOpenHandler` all-deny + a `will-navigate` origin allowlist
  in main.ts, with a trip-wire comment beside the flag in protocol.ts.
- **Known Electron bug** (open, electron#38749): media served via `protocol.handle`
  does not honor `Range` requests automatically → seeking/scrubbing snaps to 0. v1
  preview is play-from-start so this doesn't block, but the handler must implement
  manual Range responses (206 + `Content-Range` + sliced stream) before any scrub UI
  ships. Noted as a required TODO in the protocol module.
- Data dir: a **subdirectory** of `app.getPath('userData')` (avoid Chromium's own
  files); repoint `sessionData` away from our data.

### 9.2 SQLite + FTS5

- **Choice: `better-sqlite3` 13.0.3** (published 2026-08-05 — actively maintained).
  Bundles its own SQLite 3.53.4 compiled with `SQLITE_ENABLE_FTS5` (plus FTS3/4 and
  JSON1) by default — verified from its compilation docs. Synchronous API suits
  main-process-only use (the renderer never sees SQLite, §4).
- **Rejected: `node:sqlite`** (built into Electron 43's Node 24, "release
  candidate" status, no flag needed) — Node compiles its bundled SQLite **without
  FTS5**, a known upstream gap. Full-text search is core to Ntwine, so this is
  disqualifying today. Worth rechecking whenever Electron's Node bundles FTS5;
  the catalog module should isolate the driver behind one small seam.
- Native-module handling: Electron Forge integrates `electron-rebuild` (listed among
  the tools it unifies), so better-sqlite3 gets rebuilt against Electron's ABI by
  the standard toolchain; add `@electron-forge/plugin-auto-unpack-natives` once
  packaging with asar.
- **The dual-ABI trap (named so it can't stall TDD):** one `node_modules` holds one
  compiled better-sqlite3, but the app runs under Electron's ABI while Vitest runs
  under system Node's — after the first `yarn start`, catalog tests would fail to
  load the module (the well-known better-sqlite3 + Electron + Vitest collision).
  **Strategy: run Vitest under Electron's own Node** (`ELECTRON_RUN_AS_NODE=1
  electron node_modules/vitest/vitest.mjs`, wrapped as `yarn test`) so one ABI
  serves both. Fallback if that fights Vitest: confine `electron-rebuild` to
  start/package and keep tests on a Node-ABI build. Milestone 1 proves the chosen
  path with the first catalog test.

### 9.3 Renderer: list virtualization, waveforms, preview playback

- **List**: `@tanstack/react-virtual` **3.14.9** (headless hook; most popular by 3×,
  API stable 2.5 years, React 19 in peer range; fixed row height is the trivial
  case). Row markup is our own flexbox — table-style columns + a canvas cell.
- **State**: MobX ^6.15 + mobx-react-lite ^4.1 (§4.1; matches AliasNess_Web's pins;
  npm latest is MobX 7.0.0 / lite 5.0.0 — held back deliberately for cross-repo
  parity). Virtualizer + observer compose cleanly: the store owns the filtered id
  list; rows observe per-sample state.
- **Waveform peaks are computed main-process-side, in a `utilityProcess`** — never
  on the main event loop (§5.1), and not in the renderer: **Chromium cannot decode
  AIFF**, and 16 library files are `.aif`. Use **`audio-decode` 3.12.0** (pure JS,
  active, wav+aiff+more): decode → downsample to the 200 min/max `Int8` buckets
  §5.1 owns → store in the §6 `waveforms` table (<2 MB for all 4,197 files) → drop
  the PCM immediately. Concurrency bounded (2–4 in flight) — each in-flight decode
  holds a full Float32 PCM image. **Gate:** the first waveform task decodes one
  real library `.aif` through `audio-decode` in a fixture test *before* the queue
  is built — AIFF support is the one §9 claim not verified firsthand; if it fails,
  the named fallback is a small IFF/AIFF PCM parser (~100 lines) or another
  maintained decoder.
- **Thumbnails**: canvas per row, drawn from cached peak buckets on mount (the
  peaks.js / wavesurfer production pattern). Virtualization caps live canvases at
  ~viewport count. Backing store sized by `devicePixelRatio`. No PNG round-trip.
- **Preview playback**: WebAudio, not `<audio>` — one persistent `AudioContext` →
  shared `GainNode` (volume) → destination; per play, fetch bytes via `sample://`,
  `decodeAudioData`, throwaway `AudioBufferSourceNode.start(0)`. Stop/retrigger via
  ~10 ms gain ramp to zero (hard stops click). Bonus: buffer playback never touches
  the Electron Range-request bug (§9.1) — no streaming element involved.
- **AIFF preview fallback**: renderer `decodeAudioData` will reject the 16 `.aif`
  files → on decode failure, call `decodePreviewPcm(sampleId)` — the single
  sanctioned IPC exception named in §4 — main decodes via `audio-decode`, ships
  Float32 channels (size-capped), renderer constructs the `AudioBuffer`. One code
  path, one fallback, covered by a test.
- `decodeAudioData` detaches its input ArrayBuffer — hand it a copy if the bytes are
  reused. Electron autoplay policy: row-click is a user gesture so the context
  resumes fine; `--autoplay-policy=no-user-gesture-required` is the fallback switch.

## 10. Testing

TDD throughout — test first, watch it fail, then implement. Vitest for all logic:

- **Importer**: runs against a small fixture `sounds.db` (a few packs/samples with
  edge cases: empty tags casing, bpm 0, missing file, re-run idempotency, **and a
  unicode/NFD filename + pack name** — APFS normalization and tag lower-casing
  diverge exactly there). Fixture is built by a checked-in script, checked into
  the repo.
- **Tag parsing / key + BPM normalization / duration-unit pin (§2.3)**: pure-function
  tests. Round-trips pin **every** enum member, not a representative one.
- **Catalog queries**: search + filter combinations against the fixture catalog,
  including FTS behavior.
- **IPC contract**: the preload API surface type-checked end to end.
- **MobX stores**: plain classes, unit-tested without React (filter composition,
  selection/auto-play transitions). AliasNess_Web has no unit framework today;
  Vitest here is the candidate shared standard, not a divergence.
- Renderer components: thin; hand-QA in the running app is the v1 bar (the "loop for
  a while" phase). No Playwright in v1.
- **Drag-out is proven first, not last.** Milestone 1 opens with a walking-skeleton
  spike: `webContents.startDrag` of one hardcoded file (with the §9.1 drag icon),
  dropped into Reaper and Finder. Its failure modes are external (macOS icon rule,
  DAW acceptance) and cost the most when discovered after the catalog and UI exist.
  From then on, a short **scripted manual drag gate** (drag one wav + one aif into
  Reaper) runs in every QA round — type checks cannot see this wiring.

Definition of done for v1: import completes on the real library; search/filter/preview
feel instant; a sample dragged from Ntwine lands in Reaper (the scripted drag gate);
missing-file row behaves; all tests green.
