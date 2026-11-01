# Ntwine Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `git push --tags` on `v<semver>` yields a GitHub Release with a notarized universal macOS zip and an unsigned Windows Squirrel installer, and installed copies update themselves through `update.electronjs.org`.

**Architecture:** Signing/notarization stay inside Forge's packager config, fed by a small tested helper that reads env vars and returns nothing when they are absent (unsigned builds are unchanged). The updater is a pure state machine in `src/main/updater.ts` driven by Electron's built-in `autoUpdater`, surfaced to the renderer over one new broadcast channel and three invokes, rendered as a single badge in the rail footer. A `release.yml` workflow builds both platforms on GitHub-hosted runners and attaches the outputs with the GitHub CLI.

**Tech Stack:** Electron Forge 7.11.2 (packager `osxSign`/`osxNotarize`, `--arch universal` via `@electron/universal` 3.x), `@electron/osx-sign` + `@electron/notarize` (already transitive), Electron 43 `autoUpdater` (Squirrel.Mac / Squirrel.Windows), GitHub Actions `macos-latest` + `windows-latest`, `gh` CLI, Vitest (existing runner), hand-rolled ICNS packer beside the existing ICO packer.

**Spec:** `docs/superpowers/specs/2026-11-01-ntwine-release-pipeline-design.md`. Parent: `docs/superpowers/specs/2026-08-17-ntwine-e2e-backstop-design.md`.

## Global Constraints

- **Bundle id** `com.aliasness.ntwine` (spec C1). **Version** `0.1.0` now (C2); tags are `v<semver>` and the release workflow refuses a tag whose version core differs from `package.json`.
- **Env contract for signing (C6)** — the only names the build reads: `NTWINE_SIGN_IDENTITY` (the codesign identity string; absent ⇒ unsigned build, config byte-identical to today), `NTWINE_NOTARY_KEYCHAIN_PROFILE` (local: `AliasNess`), `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (CI). Identity set with neither credential form complete ⇒ **throw at config load** listing the missing names, never a silent unsigned build. Identity unset: `NTWINE_NOTARY_KEYCHAIN_PROFILE` ⇒ throw (`NTWINE_SIGN_IDENTITY is required when NTWINE_NOTARY_KEYCHAIN_PROFILE is set`); `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` ⇒ **ignored** with one `console.warn` naming them, both keys `undefined` (they are electron-builder/fastlane names a contributor may have exported for another project).
- **Team/identity strings appear once**: in the env (CI secrets, the owner's shell). Nothing under version control contains the real team id or the owner's name — docs use `<TEAMID>` and `"Developer ID Application: <name> (<TEAMID>)"` (D4).
- **No secrets in the tree or history.** `.p12`, passwords, app-specific passwords only ever live in GitHub secrets or the owner's keychain.
- **Updater (C4):** first check 30 s after ready, then every 4 h; silent download; dismissible "Restart to update"; never force. Off when `!app.isPackaged` or `NTWINE_E2E === '1'`. Only a code-signature mismatch (D7) surfaces as an error to the user; every other failure is logged and retried next interval.
- **Update feed:** `https://update.electronjs.org/aliasness-studio/Ntwine/<platform>-<arch>/<version>`. Releases are **not** GitHub prereleases (spec §3.5) except rc tags (`v*-rc.*`), which are, so a dry run is invisible to the updater and to `/releases/latest`.
- **Asset names** the update service routes on: `Ntwine-darwin-universal-<version>.zip` (MakerZIP already emits this), `Ntwine-<version>-win32-x64-Setup.exe`, plus `RELEASES` and the `.nupkg` as Squirrel emits them.
- **Load-bearing config stays:** `packagerConfig.ignore`, `rebuildConfig: { onlyModules: [] }`, the plugin order, every fuse (spec §2).
- **Gates on every commit:** `yarn test && yarn typecheck && yarn lint` green; `yarn e2e` (packages first) whenever anything under `src/` changed, else `yarn e2e:only` is acceptable. Commit author `AliasNess Studio <aliasness.studio@proton.me>`. One PR per section below; never amend/rebase/force-push.
- **Cross-platform scripts:** `scripts/*.mjs` run on the owner's Windows box too (`yarn icons`), so no macOS-only tool (`iconutil`, `sips`) inside a script; macOS tools are allowed in `release.yml`'s darwin job and in manual verification steps.
- **Cert expiry 2027-02-01** is written into `RELEASING.md` with the rotation steps (Task 14).

## Review Focus

1. **App launched from `~/Downloads` on macOS** (quarantined ⇒ App Translocation): the user expects the move-to-Applications offer, and if the move itself fails, a plain instruction to drag the app to Applications, not a silent no-op and not a crash. Pinned in Task 10.
2. **No network / update server down**: the user expects nothing to appear; the app must not show an error badge, must not retry in a tight loop, and must check again at the next interval. Pinned in Task 6.
3. **Partial signing env** (identity set, credentials incomplete, or the inverse): the engineer running `yarn make` expects an immediate error naming the missing variable, not a build that silently ships unsigned or fails 10 minutes in at notarization. Pinned in Task 3.
4. **Tag that does not match `package.json`**, including `v0.1.0-rc.1` against `0.1.0` (allowed, prerelease) and `v0.2.0` against `0.1.0` (refused): the owner expects the workflow to stop before any build. Pinned in Task 12.
5. **Clean checkout with no env** must produce exactly today's unsigned ad-hoc build and keep the packaged e2e probe green. Pinned in Task 4 (helper returns `undefined` for both keys; `yarn e2e` run after the config change).

---

## File structure

```
scripts/icns.mjs                    packIcns / readIcnsTypes (pure; tested)      [Task 1]
scripts/icns.test.mjs
scripts/build-icons.mjs             + assets/icon.icns output                    [Task 2]
assets/icon.icns                    committed output
scripts/signing.mjs                 resolveSigning(env) → { osxSign, osxNotarize } (pure; tested) [Task 3]
scripts/signing.test.mjs
build/entitlements.mac.plist        hardened-runtime entitlements               [Task 3]
forge.config.ts                     appBundleId, appCategoryType, signing spread, Info.plist hook, Squirrel names [Task 4]
package.json                        version 0.1.0; make:mac / make:win scripts  [Task 4]
tests/e2e/harness/packaged.ts       + NTWINE_PACKAGED_DIR override              [Task 4]
docs/RELEASING.md                   local signed build (Task 5) → full procedure (Task 14)
src/shared/ipcTypes.ts              UpdateState; NtwineApi + 4 methods          [Task 6/7]
src/main/updater.ts                 feedUrlFor, shouldRunUpdater, classifyUpdateError, createUpdater, registerUpdaterIpc [Task 6/7]
src/main/updater.test.ts
src/main.ts                         updater + move-prompt wiring                [Task 7/10]
src/preload.ts                      4 bridge methods                            [Task 7]
src/renderer/stores/UpdateStore.ts  observable mirror + actions (tested)        [Task 8]
src/renderer/stores/UpdateStore.test.ts
src/renderer/components/StoreContext.ts   + update store
src/renderer.tsx                    constructs UpdateStore
src/renderer/components/UpdateBadge.tsx   rail-footer affordance                [Task 9]
src/renderer/components/App.tsx     renders UpdateBadge in RailFooter
src/renderer/components/SettingsSheet.tsx  Version row                          [Task 9]
src/main/moveToApplications.ts      shouldOfferMove (pure; tested) + offerMove  [Task 10]
src/main/moveToApplications.test.ts
scripts/checkTagVersion.mjs         tagMatchesVersion / isRcTag (pure; tested)  [Task 12]
scripts/checkTagVersion.test.mjs
.github/workflows/release.yml                                                   [Task 13]
LICENSE, README.md                                                              [Task 16]
```

---

# PR 1 — signed local build (`feat/mac-signing`)

### Task 1: ICNS packer

**Files:**
- Create: `scripts/icns.mjs`, `scripts/icns.test.mjs`

**Interfaces:**
- Produces: `packIcns(frames: { size: number, png: Buffer }[]): Buffer` and `readIcnsTypes(buf: Buffer): string[]` (the 4-char OSTypes in file order). Size → type table, fixed, in file order: `16:['icp4'], 32:['icp5','ic11'], 64:['ic12'], 128:['ic07'], 256:['ic08','ic13'], 512:['ic09','ic14'], 1024:['ic10']`. The second type is the @2x slot of half the size (`ic11` 16@2x, `ic12` 32@2x, `ic13` 128@2x, `ic14` 256@2x). 64 has no 1x slot — Apple reads `icp6` as 48px — so it is written only as `ic12`. Unknown size ⇒ throw. Empty input ⇒ throw.

- [ ] **Step 1: Write the failing tests** in `scripts/icns.test.mjs`, same style as `scripts/ico.test.mjs`:

```js
it('writes the icns magic and total length', ...)      // bytes 0-3 === 'icns', readUInt32BE(4) === buf.length
it('maps sizes to OSTypes and duplicates retina types', ...) // frames [16,32,64,256,512] → ['icp4','icp5','ic11','ic12','ic08','ic13','ic09','ic14']
it('embeds each PNG verbatim after an 8-byte entry header whose length includes the header', ...)
it('throws on an unsupported size and on no frames', ...)   // 48 → /unsupported/, [] → /no frames/
```

- [ ] **Step 2: Run** `yarn test scripts/icns.test.mjs` — expected: FAIL, module not found.
- [ ] **Step 3: Implement** `scripts/icns.mjs` with the header comment style of `ico.mjs` (why hand-rolled: same supply-chain reasoning).
- [ ] **Step 4: Run** `yarn test scripts/icns.test.mjs` — expected: PASS.
- [ ] **Step 5: Commit** `feat(icons): hand-rolled ICNS packer`.

### Task 2: `yarn icons` emits `assets/icon.icns`

**Files:**
- Modify: `scripts/build-icons.mjs`, `scripts/icon.test.mjs` (if it pins the FRAMES table; extend, don't fork)
- Create (generated, committed): `assets/icon.icns`

**Interfaces:**
- Consumes: `packIcns` (Task 1).
- Produces: `assets/icon.icns` with frames 16, 32, 64, 128, 256, 512, 1024 — 1024 rendered from `icon.svg`; frames ≤ 24 other than 16 are not used by icns (keep the ICO table unchanged). Written types, in order (Task 1's table): `icp4` (16), `icp5` + `ic11` (32), `ic12` (64), `ic07` (128), `ic08` + `ic13` (256), `ic09` + `ic14` (512), `ic10` (1024). `iconutil -c iconset assets/icon.icns` must yield exactly `icon_{16,32,128,256,512}x…` and their `@2x` — ten files, no 48.

- [ ] **Step 1:** Add an `ICNS_FRAMES` table beside `FRAMES` (`16→icon-small.svg`, the rest `icon.svg`, sizes above) and a test in `scripts/icon.test.mjs` asserting the table's sizes equal `[16,32,64,128,256,512,1024]` and the 16 uses `icon-small.svg` (the existing crossover rule).
- [ ] **Step 2:** Run the test — FAIL (table missing).
- [ ] **Step 3:** Implement: render each ICNS frame (reuse `render`; the window `extent` must grow to 1024), `writeFileSync(join(ASSETS, 'icon.icns'), packIcns(frames))`, log the types via `readIcnsTypes`.
- [ ] **Step 4:** Run `yarn icons` on macOS; then `file assets/icon.icns` → "Mac OS X icon"; `sips -g pixelWidth assets/icon.icns` → 1024. Commit the regenerated `.ico`/`.png` only if byte-identical or intentionally changed (expected: identical).
- [ ] **Step 5:** `yarn package` and confirm `plutil -p out/Ntwine-darwin-arm64/Ntwine.app/Contents/Info.plist | grep CFBundleIconFile` → `icon.icns`, and the Dock shows the Ntwine mark on `open out/Ntwine-darwin-arm64/Ntwine.app`.
- [ ] **Step 6: Commit** `feat(icons): emit icon.icns; macOS build wears the Ntwine icon`.

### Task 3: signing helper + entitlements

**Files:**
- Create: `scripts/signing.mjs`, `scripts/signing.test.mjs`, `build/entitlements.mac.plist`

**Interfaces:**
- Produces: `resolveSigning(env: Record<string, string | undefined>, opts?: { entitlements?: string }): { osxSign: object | undefined, osxNotarize: object | undefined }`. JSDoc-typed (tsconfig has `allowJs`), so `forge.config.ts` can spread it.
  - `NTWINE_SIGN_IDENTITY` unset/empty ⇒ `{ osxSign: undefined, osxNotarize: undefined }`.
  - Set ⇒ `osxSign = { identity, optionsForFile: () => ({ entitlements: <abs path to build/entitlements.mac.plist>, hardenedRuntime: true }) }`.
  - `osxNotarize`: if `NTWINE_NOTARY_KEYCHAIN_PROFILE` set ⇒ `{ keychainProfile }`; else if all three of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` ⇒ `{ appleId, appleIdPassword, teamId }`; else **throw** `Error` whose message lists the missing names.
  - Identity unset: `NTWINE_NOTARY_KEYCHAIN_PROFILE` set ⇒ throw (`NTWINE_SIGN_IDENTITY is required when NTWINE_NOTARY_KEYCHAIN_PROFILE is set`); any `APPLE_*` set ⇒ ignored, one `console.warn` naming them, both keys `undefined` (Global Constraints, env contract).
- Entitlements file content (exact): `com.apple.security.cs.allow-jit` true, `com.apple.security.cs.allow-unsigned-executable-memory` true. Nothing else unless Task 5 proves the native module needs `disable-library-validation`.

- [ ] **Step 1: Write failing tests** in `scripts/signing.test.mjs`:

```js
it('returns undefined for both when no identity is set', ...)        // {} → both undefined; { APPLE_ID: 'x' } without identity → both undefined + one console.warn naming it
it('builds osxSign with hardened runtime and the entitlements path', ...)
it('prefers the keychain profile over the Apple ID triple', ...)
it('uses the Apple ID triple when no profile is set', ...)
it('throws naming every missing credential variable', ...)         // identity + APPLE_ID only → /APPLE_APP_SPECIFIC_PASSWORD.*APPLE_TEAM_ID/
```

- [ ] **Step 2:** Run `yarn test scripts/signing.test.mjs` — FAIL.
- [ ] **Step 3:** Implement `scripts/signing.mjs` and write `build/entitlements.mac.plist`.
- [ ] **Step 4:** Run — PASS. `yarn lint` (the `scripts/**/*.mjs` ESLint block already declares Node globals).
- [ ] **Step 5: Commit** `feat(build): env-gated signing/notarization config + hardened-runtime entitlements`.

### Task 4: Forge config, bundle identity, version, Squirrel names

**Files:**
- Modify: `forge.config.ts`, `package.json`, `tests/e2e/harness/packaged.ts`

**Interfaces:**
- Consumes: `resolveSigning` (Task 3).
- Produces: `yarn make:mac` = `electron-forge make --platform darwin --arch universal`; `yarn make:win` = `electron-forge make --platform win32 --arch x64`. `packagedExecutable()` honours `NTWINE_PACKAGED_DIR` (absolute path to the `out/Ntwine-<platform>-<arch>` directory) over its computed default.

- [ ] **Step 1:** `package.json`: `"version": "0.1.0"`; add the two `make:*` scripts.
- [ ] **Step 2:** `forge.config.ts` `packagerConfig` gains: `appBundleId: 'com.aliasness.ntwine'`, `appCategoryType: 'public.app-category.music'`, `...resolveSigning(process.env)`. Add `hooks.packageAfterCopy` that, on darwin only, runs `plutil -remove NSMicrophoneUsageDescription` and `-remove NSCameraUsageDescription` on `<buildPath>/../Info.plist`'s bundle (`execFileSync`; ignore "not found" exit for a key already absent). (Camera is my call: same boilerplate, same reason as spec C7.)
- [ ] **Step 3:** `MakerSquirrel` options: `name: 'Ntwine'`, `authors: 'AliasNess Studio'`, `setupExe: \`Ntwine-${version}-win32-x64-Setup.exe\`` (import `version` from `./package.json`), `iconUrl: 'https://raw.githubusercontent.com/aliasness-studio/Ntwine/main/assets/icon.ico'`. Keep `setupIcon`.
- [ ] **Step 4:** `tests/e2e/harness/packaged.ts`: `const dir = process.env.NTWINE_PACKAGED_DIR ?? join(REPO_ROOT, 'out', ...)`.
- [ ] **Step 5: Verify unsigned path unchanged:** with no signing env, `yarn e2e` (packages + full suite) green; `codesign -dv out/Ntwine-darwin-arm64/Ntwine.app 2>&1 | grep -E 'Identifier|Signature'` → `Identifier=com.aliasness.ntwine`, `Signature=adhoc`; `plutil -p .../Info.plist | grep -c UsageDescription` → 0 for mic/camera.
- [ ] **Step 6:** `yarn typecheck && yarn lint` — PASS.
- [ ] **Step 7: Commit** `feat(build): bundle id, 0.1.0, Squirrel asset names, Info.plist cleanup`.

### Task 5: first signed, notarized universal build (owner's Mac) + RELEASING.md seed

**Files:**
- Create: `docs/RELEASING.md` (section "Signed build on a Mac with the keychain")

- [ ] **Step 1:** Run on the owner's Mac (identity string comes from `security find-identity -v -p codesigning`, never written into the repo):

```bash
NTWINE_SIGN_IDENTITY="<Developer ID Application identity>" NTWINE_NOTARY_KEYCHAIN_PROFILE=AliasNess yarn make:mac
```

Expected: Forge logs signing, then "Notarizing…" and stapling; output `out/make/zip/darwin/universal/Ntwine-darwin-universal-0.1.0.zip`.
  Known risk (hit on the first run): `@electron/universal` refuses the thin `prebuilds/darwin-x64.node` / `darwin-arm64.node` pair, because both land byte-identical in both per-arch builds. The glob that worked: `packagerConfig.osxUniversal: { x64ArchFiles: '**/better-sqlite3/prebuilds/darwin-{x64,arm64}.node' }` — **both** thin prebuilds must be listed; naming only `darwin-x64.node` still fails on the arm64 one. `lib/binding.js` picks `prebuilds/darwin-${process.arch}.node` at runtime, so copying them through is correct.
- [ ] **Step 2: Verify:**

```bash
codesign --verify --deep --strict --verbose=2 out/Ntwine-darwin-universal/Ntwine.app
spctl --assess --type execute -vv out/Ntwine-darwin-universal/Ntwine.app
xcrun stapler validate out/Ntwine-darwin-universal/Ntwine.app
lipo -archs out/Ntwine-darwin-universal/Ntwine.app/Contents/MacOS/Ntwine
NTWINE_PACKAGED_DIR=$PWD/out/Ntwine-darwin-universal yarn e2e:only --grep packaged
```

Expected: "valid on disk" / "satisfies its Designated Requirement"; `accepted source=Notarized Developer ID`; "The validate action worked"; `x86_64 arm64`; probe PASS. If the probe hangs on the signed app, add `com.apple.security.cs.disable-library-validation` to the entitlements and re-run (record which).
- [ ] **Step 3:** Open the app from the zip once (`open`), confirm no Gatekeeper dialog beyond the first-run "downloaded from the internet" sheet and the Ntwine icon in the Dock.
- [ ] **Step 4:** Write `docs/RELEASING.md` with the Step 1/2 commands and the env contract from Global Constraints.
- [ ] **Step 5: Commit** `docs(release): local signed build procedure`. Open PR 1; gates green; owner QA = Step 3.

---

# PR 2 — self-update (`feat/auto-update`)

### Task 6: updater state machine (pure)

**Files:**
- Create: `src/main/updater.ts`, `src/main/updater.test.ts`
- Modify: `src/shared/ipcTypes.ts`

**Interfaces:**
- Produces in `src/shared/ipcTypes.ts`:

```ts
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'ready'; version: string }                 // downloaded; restart installs
  | { kind: 'failed'; reason: 'signature'; downloadUrl: string }; // D7 only
export const RELEASES_URL = 'https://github.com/aliasness-studio/Ntwine/releases/latest';
```

- Produces in `src/main/updater.ts`:

```ts
export const UPDATE_INITIAL_DELAY_MS = 30_000;
export const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_REPO = 'aliasness-studio/Ntwine';
export function feedUrlFor(a: { platform: string; arch: string; version: string }): string;
export function shouldRunUpdater(a: { isPackaged: boolean; platform: string; env: NodeJS.ProcessEnv }): boolean; // darwin|win32, packaged, NTWINE_E2E !== '1'
export function classifyUpdateError(err: unknown): 'signature' | 'other';   // /code signature/i on the message → 'signature'
export interface AutoUpdaterLike { setFeedURL(o: { url: string }): void; checkForUpdates(): void; quitAndInstall(): void; on(ev: string, cb: (...a: any[]) => void): this; }
export interface UpdaterDeps { autoUpdater: AutoUpdaterLike; feedUrl: string; onState: (s: UpdateState) => void; setTimeout?: typeof setTimeout; setInterval?: typeof setInterval; log?: (msg: string) => void; }
export interface Updater { start(): void; state(): UpdateState; install(): void; }
export function createUpdater(deps: UpdaterDeps): Updater;
```

  Behaviour: `start()` sets the feed URL, schedules the first `checkForUpdates` after `UPDATE_INITIAL_DELAY_MS`, then every `UPDATE_INTERVAL_MS`. `update-downloaded` (args `(event, notes, name)`) ⇒ state `{ kind:'ready', version: name }` and `onState`. `error` ⇒ `'signature'` ⇒ `{ kind:'failed', reason:'signature', downloadUrl: RELEASES_URL }` and **stop the interval**; `'other'` ⇒ log, state unchanged, interval continues. `install()` calls `quitAndInstall()` only in `ready`. `onState` is called only on change.

- [ ] **Step 1: Write failing tests** (`vi.useFakeTimers()`, a fake `AutoUpdaterLike` built on `EventEmitter`):

```ts
it('feedUrlFor builds the update.electronjs.org URL', ...)   // darwin/universal/0.1.0 → '.../aliasness-studio/Ntwine/darwin-universal/0.1.0'
it('shouldRunUpdater is false unpackaged, under NTWINE_E2E=1, and on linux', ...)
it('checks after the initial delay and then every 4 hours', ...)
it('update-downloaded → ready with the version, reported once', ...)
it('a network error keeps state idle, reports nothing, and the next tick still checks', ...)   // Review Focus 2
it('a code-signature error → failed/signature with RELEASES_URL and no further checks', ...)   // D7
it('install() only quits-and-installs when ready', ...)
```

- [ ] **Step 2:** `yarn test src/main/updater.test.ts` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `yarn typecheck && yarn lint`.
- [ ] **Step 5: Commit** `feat(updater): pure update state machine over Electron autoUpdater`.

### Task 7: wire updater into main, IPC and preload

**Files:**
- Modify: `src/main/updater.ts` (+ `registerUpdaterIpc`), `src/main/updater.test.ts`, `src/main.ts`, `src/preload.ts`, `src/shared/ipcTypes.ts`

**Interfaces:**
- `NtwineApi` gains (append, in this order):

```ts
getUpdateState(): Promise<UpdateState>;
onUpdateState(cb: (s: UpdateState) => void): () => void;   // broadcast channel 'ntwine:update-state'
installUpdate(): Promise<void>;                              // 'ntwine:installUpdate'
openReleasesPage(): Promise<void>;                           // 'ntwine:openReleasesPage' → shell.openExternal(RELEASES_URL)
getAppVersion(): Promise<string>;                            // 'ntwine:getAppVersion' → app.getVersion()
```

- `registerUpdaterIpc(deps: { handle: (channel: string, fn: (...a: any[]) => unknown) => void; updater: Updater | null; openExternal: (url: string) => Promise<void>; version: string })` registers the four invokes; with `updater: null`, `getUpdateState` resolves `{ kind:'idle' }` and `installUpdate` is a no-op.

- [ ] **Step 1: Failing tests** in `updater.test.ts`: the four channels are registered; `openReleasesPage` calls `openExternal` with exactly `RELEASES_URL`; null-updater behaviour.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** `src/main.ts` inside `whenReady`, after `registerIpc`: build `updater` when `shouldRunUpdater({ isPackaged: app.isPackaged, platform: process.platform, env: process.env })` else `null`; `onState` sends `'ntwine:update-state'` through the same destroyed-window guard as `sendProgress`; `registerUpdaterIpc({ handle: ipcMain.handle.bind(ipcMain), updater, openExternal: shell.openExternal, version: app.getVersion() })`; `updater?.start()`. `feedUrl = feedUrlFor({ platform: process.platform, arch: process.arch === 'arm64' || process.arch === 'x64' ? (process.platform === 'darwin' ? 'universal' : process.arch) : process.arch, version: app.getVersion() })` — darwin always asks for the universal feed because that is the only Mac asset published.
- [ ] **Step 4:** `src/preload.ts`: the four methods, `onUpdateState` mirroring `onImportProgress`.
- [ ] **Step 5:** `yarn e2e` (src changed) green — the updater is off under E2E, so the suite must be unchanged. `yarn typecheck && yarn lint`.
- [ ] **Step 6: Commit** `feat(updater): main wiring, IPC and preload bridge (24 → 28 methods)`.

### Task 8: `UpdateStore`

**Files:**
- Create: `src/renderer/stores/UpdateStore.ts`, `src/renderer/stores/UpdateStore.test.ts`
- Modify: `src/renderer/components/StoreContext.ts`, `src/renderer.tsx`

**Interfaces:**
- `class UpdateStore { state: UpdateState; dismissed: boolean; version: string | null; constructor(api: NtwineApi); init(): Promise<void>; dismiss(): void; install(): Promise<void>; openReleases(): Promise<void>; get visible(): boolean }` — `visible` = `!dismissed && state.kind !== 'idle'`. `init()` reads `getAppVersion` + `getUpdateState`, subscribes via `onUpdateState`; a new non-idle state resets `dismissed` to false. Same `makeAutoObservable` + `{ api: false }` idiom as `ImportStore`.

- [ ] **Step 1: Failing tests** with a hand-rolled `NtwineApi` fake (as `ImportStore.test.ts` does): init loads version and state; broadcast updates state; dismiss hides; a later `ready` un-dismisses; `install` calls `api.installUpdate` only when ready.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Add `update: UpdateStore` to `Stores` and construct it in `renderer.tsx` (fire-and-forget `init()` like `library.init()`).
- [ ] **Step 4:** `yarn test && yarn typecheck && yarn lint`.
- [ ] **Step 5: Commit** `feat(updater): UpdateStore mirrors update state for the renderer`.

### Task 9: `UpdateBadge` in the rail footer + Version in Settings

**Files:**
- Create: `src/renderer/components/UpdateBadge.tsx`
- Modify: `src/renderer/components/App.tsx` (RailFooter: `<TransportControls /> <UpdateBadge /> <GearButton …>`), `src/renderer/components/SettingsSheet.tsx`

- [ ] **Step 1:** `UpdateBadge` (observer): renders `null` unless `update.visible`. `ready` ⇒ a `TransportButton`-styled button, `aria-label="Restart to update"`, `title="Ntwine ${version} is ready — restart to update"`, `data-testid="update-restart"`, click ⇒ `update.install()`; an adjacent 16px `×` button `aria-label="Dismiss update notice"` ⇒ `update.dismiss()`. `failed/signature` ⇒ button `aria-label="Download the new version"`, `title="This update must be installed by hand — opens the download page"`, click ⇒ `update.openReleases()`; same dismiss. Inline SVG icons per the file's own convention (an up-arrow in a circle).
- [ ] **Step 2:** `SettingsSheet`: a `FieldRow` "Version" showing `update.version ?? '…'` and, when `update.state.kind === 'ready'`, the hint "Update downloaded — restart to install."
- [ ] **Step 3:** `yarn start`; temporarily force a state in devtools is not possible (store is private) — verify visually by pointing `UpdateStore` at a fake in a scratch branch or accept the owner QA gate (Task 18); the component has no unit test by this repo's convention (components are covered by e2e; the updater is off under e2e).
- [ ] **Step 4:** `yarn e2e` green (footer layout change must not move the gear/transport test ids).
- [ ] **Step 5: Commit** `feat(updater): rail-footer "Restart to update" badge; version in Settings`.

### Task 10: move-to-Applications offer (D6)

**Files:**
- Create: `src/main/moveToApplications.ts`, `src/main/moveToApplications.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
```ts
export const MOVE_DECLINED_META = 'move_to_applications_declined';
export function shouldOfferMove(a: { platform: string; isPackaged: boolean; inApplications: boolean; declined: boolean; e2e: boolean }): boolean;
export interface MoveDeps { ask: () => Promise<'move' | 'later'>; move: () => boolean; remember: () => void; log: (m: string) => void; }
export async function offerMove(deps: MoveDeps): Promise<'moved' | 'declined' | 'failed'>;
```
  `offerMove`: `'later'` ⇒ `remember()` ⇒ `'declined'`; `'move'` ⇒ `move()`; `true` ⇒ `'moved'` (Electron relaunches the app itself); `false`/throw ⇒ `log` and `'failed'` (Review Focus 1: the dialog text for the failed case is a second `ask`-less message: "Ntwine couldn't move itself. Drag Ntwine to your Applications folder and open it from there." — shown by `main.ts`, not by this module).

- [ ] **Step 1: Failing tests:** `shouldOfferMove` false on win32, unpackaged, already in Applications, declined, or e2e; true otherwise. `offerMove` three outcomes, `remember` called only on 'later', a throwing `move` yields 'failed'.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** `src/main.ts` `whenReady`, after `openCatalog` and before `createWindow`: `if (shouldOfferMove({ platform: process.platform, isPackaged: app.isPackaged, inApplications: app.isInApplicationsFolder(), declined: catalog.getMeta(MOVE_DECLINED_META) === '1', e2e: e2e !== null }))` ⇒ `await offerMove({ ask: dialog.showMessageBox({ type:'question', buttons:['Move to Applications','Not now'], defaultId:0, cancelId:1, message:'Move Ntwine to your Applications folder?', detail:'Ntwine updates itself only when it runs from Applications.' })`, `move: () => app.moveToApplicationsFolder({ conflictHandler: () => true })`, `remember: () => catalog.setMeta(MOVE_DECLINED_META, '1')`, `log: console.error })`; on `'moved'` return without creating a window; on `'failed'` show the plain message above, then continue.
- [ ] **Step 4:** Manual: copy the signed app to `~/Downloads`, `xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" Ntwine.app`, open it, accept the move, confirm it relaunches from `/Applications`; repeat choosing "Not now" and confirm no second prompt. Record both in the task report.
- [ ] **Step 5:** `yarn e2e` green (e2e mode never prompts). `yarn test && yarn typecheck && yarn lint`.
- [ ] **Step 6: Commit** `feat(mac): offer to move Ntwine to /Applications on first launch`. Open PR 2.

---

# PR 3 — tag-driven release (`feat/release-workflow`)

### Task 11: GitHub publisher decision — `gh` CLI (my call)

Forge's `publisher-github` would run once per platform job and race on creating the same Release. The publish job instead downloads both platforms' artifacts and uses the GitHub CLI, which the runner ships with. No new dependency. (Record this in `RELEASING.md`, Task 14.)

### Task 12: tag/version guard

**Files:**
- Create: `scripts/checkTagVersion.mjs`, `scripts/checkTagVersion.test.mjs`

**Interfaces:**
- `tagMatchesVersion(tag: string, version: string): boolean` — `v0.1.0`/`0.1.0` true; `v0.1.0-rc.1`/`0.1.0` true; `v0.2.0`/`0.1.0` false; `0.1.0` (no `v`) false.
- `isRcTag(tag: string): boolean` — `/-rc\.\d+$/`.
- CLI: `node scripts/checkTagVersion.mjs <tag>` reads `package.json`, exits 1 with a message on mismatch, prints `prerelease=true|false` on success (the workflow captures it).

- [ ] **Step 1: Failing tests** for the four `tagMatchesVersion` cases and both `isRcTag` cases.
- [ ] **Step 2:** FAIL → implement → PASS → `yarn lint`.
- [ ] **Step 3: Commit** `feat(release): tag/version guard`.

### Task 13: `release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1:** Write the workflow:
  - `on: push: tags: ['v*']`; `permissions: contents: write`.
  - job `guard` (ubuntu): checkout, `node scripts/checkTagVersion.mjs "$GITHUB_REF_NAME"` → output `prerelease`.
  - job `mac` (`macos-latest`, needs guard, `timeout-minutes: 120` — notarization took ~37 min on the first run): setup-node 24 + yarn cache as in `e2e.yml`; import the cert into a throwaway keychain from secrets `MACOS_CERT_P12_BASE64` + `MACOS_CERT_PASSWORD` (pin any marketplace action by full SHA, or do it by hand with `security create-keychain` / `import` / `set-key-partition-list`); export `NTWINE_SIGN_IDENTITY` from secret `MACOS_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` from secrets; `yarn --frozen-lockfile`; `yarn make:mac`; post-checks exactly as Task 5 Step 2 (including the packaged probe with `NTWINE_PACKAGED_DIR`), plus an Intel-slice boot probe `arch -x86_64 <app>/Contents/MacOS/Ntwine` under Rosetta (allow for a first launch beyond 30 s while Rosetta translates); `upload-artifact` of `out/make/zip/darwin/universal/*.zip`; delete the keychain in an `always()` step.
  - job `win` (`windows-latest`, needs guard): setup as `e2e.yml`; `yarn make:win`; `upload-artifact` of `out/make/squirrel.windows/x64/*` (Setup.exe, RELEASES, .nupkg).
  - job `publish` (ubuntu, needs mac+win): download both; `gh release create "$GITHUB_REF_NAME" --title "Ntwine $GITHUB_REF_NAME (beta)" --generate-notes $( [ "$PRERELEASE" = true ] && echo --prerelease ) <files…>`; drop "(beta)" from the title when the tag is `v1.0.0` or later (a one-line shell check on the major).
- [ ] **Step 2:** `yarn lint` is unaffected; validate YAML with `gh workflow view` after push or `actionlint` if installed (optional).
- [ ] **Step 3: Commit** `ci(release): build, sign, notarize and publish on v* tags`.

### Task 14: `RELEASING.md` complete

**Files:**
- Modify: `docs/RELEASING.md`

- [ ] **Step 1:** Sections: (1) cutting a release: bump `package.json` in a PR, merge, `git tag v0.1.0 && git push origin v0.1.0`, watch the workflow, check the Release; (2) rc dry run: `v0.1.0-rc.1` ⇒ marked prerelease, invisible to installed apps, delete the Release and tag afterwards; (3) one-time secrets: how to export the Developer ID identity as `.p12` from Keychain Access (My Certificates → right-click → Export, set a password), `base64 -i ntwine-devid.p12 | pbcopy` → secret `MACOS_CERT_P12_BASE64`, plus `MACOS_CERT_PASSWORD`, `MACOS_SIGN_IDENTITY` (the full "Developer ID Application: … (TEAMID)" string), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; delete the local `.p12` after upload; (4) cert rotation before **2027-02-01**: new CSR/cert, re-export, replace the two cert secrets, note that D7 applies only if the *team* changes, not on a same-team renewal; (5) the local signed build (from Task 5); (6) why `gh` not `publisher-github` (Task 11).
- [ ] **Step 2: Commit** `docs(release): tag procedure, secrets, rotation`. Open PR 3.

### Task 15: rc dry run (owner + implementer)

- [ ] **Step 1 (owner):** enter the six secrets per `RELEASING.md` §3.
- [ ] **Step 2:** merge PR 3; tag `v0.1.0-rc.1` on `main`; push. Expected: all four jobs green; a Release marked pre-release with the zip, Setup.exe, RELEASES, nupkg, generated notes.
- [ ] **Step 3:** download the zip on the owner's Mac, `spctl --assess` passes; run the Setup.exe on a spare Windows box, app installs and launches.
- [ ] **Step 4:** delete the rc Release and tag (`gh release delete v0.1.0-rc.1 --cleanup-tag --yes`). Record results in the PR thread.

---

# PR 4 — going public (`chore/go-public`)

### Task 16: LICENSE, README, Splice wording

**Files:**
- Create: `LICENSE` (MIT, `Copyright (c) 2026 AliasNess Studio`)
- Modify: `README.md`

- [ ] **Step 1:** README gains, above "Prerequisites", a "Download" section: link `https://github.com/aliasness-studio/Ntwine/releases/latest`; macOS: unzip, open, accept the move to Applications; Windows: run the Setup, expect SmartScreen's "unknown publisher" (More info → Run anyway) because the Windows build is unsigned; updates arrive automatically; where the Splice library is read from (unchanged copy from "Prerequisites"). Replace "Private/personal tooling for now." in Status.
- [ ] **Step 2:** Draft, for owner approval in the PR: "Ntwine is an independent project and is not affiliated with or endorsed by Splice. It reads the library the Splice app left on your disk; it does not download from, log in to, or talk to Splice." Place it in README's intro and in the first-run screen's footer only if a one-line string change (otherwise README only).
- [ ] **Step 3: Commit** `docs: LICENSE, end-user README, Splice disclaimer`.

### Task 17: secret and personal-data sweep

- [ ] **Step 1:** `brew install gitleaks` (local tool, not CI); `gitleaks detect --source . --log-opts="--all" --redact` → expected: no leaks. Any finding ⇒ stop and bring it to the owner (rotate or rewrite is their decision).
- [ ] **Step 2:** `git grep -n -i -E '/Users/<user>|C:\\\\Users|<email local part>|<TEAMID>|<owner name>' -- . ':!yarn.lock'`, with the real values substituted in the shell at run time (never written into the tree) → expected: zero hits. The release-pipeline spec and plan already carry only placeholders (`<TEAMID>`, `"Developer ID Application: <name> (<TEAMID>)"`); any older doc still naming them gets the same treatment — commit as part of this task.
- [ ] **Step 3:** Review `docs/superpowers/**` and `tests/e2e/fixture/**` for real sample names or library listings; the fixture is synthetic by design (e2e spec D1) — confirm and note.
- [ ] **Step 4: Commit** `chore: scrub identifiers ahead of going public`. Open PR 4.

### Task 18: flip, release, QA gate (owner)

- [ ] **Step 1:** Merge PR 4. Repo Settings → Danger Zone → Change visibility → Public.
- [ ] **Step 2:** `git tag v0.1.0 && git push origin v0.1.0`; workflow green; Release visible at `/releases/latest`.
- [ ] **Step 3:** Install `v0.1.0` on the owner's Mac (accept the move) and a spare Windows box. Bump to `0.1.1` via PR, merge, tag `v0.1.1`. Within ~30 s of relaunch (or after the 4 h tick), both installs show "Restart to update"; clicking it relaunches on `0.1.1` (Settings → Version). Record in the PR thread; this is the owner's first-hand gate for the whole lane.
