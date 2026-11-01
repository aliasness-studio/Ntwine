# Ntwine — signed builds, auto-update and a tag-driven release pipeline — design

**Status:** brainstormed with the owner 2026-10-31/11-01, builder-checked, owner answers applied (D6, D7) ·
**Baseline:** `main` @ `a2fc15c` (PR #19, app icon) · **Parent:**
`docs/superpowers/specs/2026-08-17-ntwine-e2e-backstop-design.md`

## 0. Intent and the why

Ntwine replaces the Splice desktop app for the owner day to day, and is then given away: a
free, MIT-licensed community tool and the first thing people download from the AliasNess
website before paid products exist. Today the only way to run it is `yarn package` on a dev
box, which yields an ad-hoc-signed `Ntwine.app` with Electron's stock icon and the bundle id
`com.electron.ntwine`. Nobody but the owner can run that, and the owner cannot tell which
build is installed.

This lane turns "cut a release" into **one git tag**: CI builds macOS and Windows, signs and
notarizes the Mac build, attaches everything to a GitHub Release, and installed copies update
themselves. It also makes the repository fit to be public.

Owner decisions taken in the brainstorm (binding):

- **D1 — Free, public, zero recurring cost.** Ntwine is not a for-sale product. The repo goes
  **public** on GitHub so Electron's free update service can serve it. No paid service may be
  added for this lane beyond the Apple Developer membership the owner already has.
- **D2 — Platforms on day one:** macOS (Developer ID signed, notarized, stapled) **and**
  Windows **unsigned**. The SmartScreen "unknown publisher" click-through on Windows is
  accepted; Windows code signing is explicitly out of scope until it is free or the product
  takes money.
- **D3 — Builds run on GitHub-hosted runners**, not the owner's spare Windows machines
  (self-hosted runners on a public repo let fork PRs run code on them). The Developer ID
  certificate (`.p12`) and the notarization app-specific password live in **GitHub repository
  secrets**. The spare machines are for manual installer/import QA.
- **D4 — Signing identity is the individual team** `<team-id>` ("Developer ID Application:
  <owner>"). Entity/LLC questions are deferred until something takes money; nothing in this
  lane may make the later identity-string change painful.
- **D5 — Day-to-day:** the owner installs the same artifact users get and receives updates the
  same way. No separate "owner build".
- **D6 — First launch on macOS:** the app offers to move itself to `/Applications` on first
  launch (`app.moveToApplicationsFolder()` behind a prompt; declining is remembered). Reason:
  an app run from `~/Downloads` is App-Translocated and Squirrel.Mac cannot update it.
- **D7 — Future identity change is accepted as a one-time manual reinstall** for installed
  Mac copies (Squirrel.Mac rejects updates signed by a different team). The updater must
  recognise that failure and show a "download the new version from the website" link instead
  of retrying. The owner expects to settle the LLC/identity question before anyone but the
  owner has installed a build, so this path is a safety net, not a migration plan.

Orchestrator calls (owner-delegated, each overridable by the owner):

- **C1 — Bundle id** `com.aliasness.ntwine`. Set once, before the first signed build; it is
  baked into signatures and into the macOS user-data path.
- **C2 — Versioning:** `package.json` drops from `1.0.0` to **`0.1.0`** now; `1.0.0` is the
  public launch. Tags are `v<semver>` and must equal `package.json`'s version.
- **C3 — macOS artifact:** a single **universal** (arm64 + x64) `.zip`, because Squirrel.Mac
  (Electron's built-in updater) consumes zips and the audience still includes Intel Macs. A
  DMG is a later nicety, not part of this lane. `better-sqlite3` v13 ships every prebuild in
  its tarball (`prebuilds/darwin-arm64.node` and `darwin-x64.node` both present), so a
  universal merge needs no per-arch rebuild.
- **C4 — Updater behaviour:** check on launch (after a short delay) and every 4 hours;
  download silently; surface an in-app, dismissible "Restart to update" affordance; never
  force a restart. Disabled when not packaged and under `NTWINE_E2E`.
- **C5 — Release notes** are GitHub's auto-generated notes from merged PR titles. No hand-kept
  `CHANGELOG.md`.
- **C6 — Signing is env-gated.** `yarn package` / `yarn make` on a clean checkout, the e2e CI
  workflow, and forks all keep producing unsigned builds exactly as today. Signing and
  notarization happen only when the signing env vars are present.
- **C7 — `yarn icons` gains `.icns`**, and the boilerplate `NSMicrophoneUsageDescription`
  (Electron's default; Ntwine never uses the microphone) is dropped from the bundle.
- **C8 — Going-public checklist** is part of this lane, not a separate project (§6).

## 1. Goals, non-goals, anti-goals

**Goals**
- `git tag v0.1.0 && git push --tags` produces a GitHub Release carrying: a notarized universal
  macOS zip, a Windows Squirrel installer with its `RELEASES` and `.nupkg`, and auto-generated
  notes. No manual step after the push.
- A Mac user double-clicks the extracted `Ntwine.app` and it opens with no Gatekeeper
  complaint and the Ntwine icon in the Dock.
- Installed copies on both platforms pick up the next tag's build on their own.
- The repository can be flipped to public without leaking secrets or embarrassing content.

**Non-goals**
- Windows code signing (D2). Linux releases (the deb/rpm makers stay configured but are not
  built or published by CI). Mac App Store. DMG. A website download page (the website links to
  the GitHub Release's `latest` URL; building that page is the website's lane).
- Any change to how the app itself works. This lane touches build, packaging, CI, the updater
  wiring in `main`, and docs.

**Anti-goals (failure even if it "works")**
- A release that needs the owner's laptop, keychain or a manual notarize command.
- Secrets, the `.p12`, or an app-specific password anywhere in the tree or the git history.
- Breaking the unsigned local/CI build or the e2e suite's `packagedExecutable()` contract.
- An updater that nags, forces restarts, or phones anything but the update service.
- Hardcoding the identity string or team id in more than one place.

## 2. Constraints

- Tooling is what the repo already uses: Electron Forge 7.11.x with the Vite plugin, Fuses
  plugin and AutoUnpackNatives; `@electron/osx-sign` and `@electron/notarize` are already
  transitive dependencies. Add `@electron-forge/publisher-github` and the `update-electron-app`
  package (or equivalent thin wrapper over `autoUpdater` pointed at
  `https://update.electronjs.org`). Nothing bespoke where Forge has a documented knob.
- The existing `forge.config.ts` `ignore` function and `rebuildConfig: { onlyModules: [] }`
  are load-bearing (see their comments) and stay.
- Fuses stay as configured. `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`
  are compatible with Squirrel.Mac/Squirrel.Windows updates.
- Hardened runtime is mandatory for notarization. Electron needs at minimum
  `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`;
  add `com.apple.security.cs.disable-library-validation` only if the signed `better-sqlite3`
  `.node` fails to load without it (it should not: osx-sign signs everything under
  `app.asar.unpacked`).
- `update.electronjs.org` requirements: public repo, GitHub Releases, macOS builds signed.
  Asset names decide routing: the Mac zip must contain `-darwin` and `-universal`; Windows
  Squirrel assets must contain `-win32` (and `-x64`), and the Release must carry `RELEASES`
  and the `.nupkg`. The builder verifies exact naming against the service's README at
  implementation time and makes the makers emit those names.
- GitHub-hosted runners only: `macos-latest` (Apple Silicon; produces the universal build) and
  `windows-latest`. The existing `e2e.yml` conventions (Node 24, `yarn --frozen-lockfile`,
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`) carry over.
- TDD applies to anything unit-testable: the icns packing step, the env-gating logic in
  `forge.config.ts` (extract it to a tested helper), the updater wiring's guards (packaged,
  `NTWINE_E2E`, interval). Notarization itself is verified by CI running
  `spctl --assess` and `stapler validate` on the artifact.
- Developer ID cert expires **2027-02-01**. The pipeline must fail loudly (not silently ship
  unsigned) when the identity is missing or expired.

## 3. The release flow (decided)

1. Owner merges PRs to `main` as today. Owner bumps `package.json` version in a PR (or a
   `yarn version` script does it; builder's choice), merges, then tags `v<version>` on `main`
   and pushes the tag.
2. A new workflow `release.yml` triggers on `push: tags: ['v*']`. A guard job asserts the tag
   equals `package.json`'s version and fails otherwise.
3. Matrix job, `macos-latest`:
   - import the `.p12` from secrets into a temporary keychain (standard
     `security create-keychain` / `import` / `set-key-partition-list` dance; builder may use
     a well-known action for it as long as it is pinned by SHA);
   - export `NTWINE_SIGN_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
     from secrets;
   - `yarn make --platform darwin --arch universal` with signing on (C6), which signs,
     notarizes (`@electron/notarize` with the Apple-ID triple from env; locally the owner may
     instead use the `AliasNess` keychain profile — the config supports both), and staples;
   - post-check: `codesign --verify --deep --strict`, `spctl --assess --type execute`,
     `xcrun stapler validate`, and the existing packaged boot probe
     (`tests/e2e/packaged.spec.ts` logic or a cheap equivalent) against the **signed** app.
4. Matrix job, `windows-latest`: `yarn make --platform win32 --arch x64` (unsigned; D2).
5. Publish job: `electron-forge publish` with `publisher-github` (or upload the make
   outputs with the GitHub CLI; builder's choice, publisher-github preferred) to a Release
   named after the tag, **draft: false, prerelease: false** (the update service and GitHub's
   `/releases/latest` URL both skip prereleases; "beta" goes in the release title until
   1.0.0), with `generate_release_notes: true`.
6. Installed apps: `update-electron-app` (or equivalent) targets
   `https://update.electronjs.org/aliasness-studio/Ntwine/<platform>-<arch>/<version>`; C4
   governs UX. Windows first-run: `electron-squirrel-startup` is already wired in `main.ts`.

## 4. Repo changes (decided shape, details to the builder)

- `forge.config.ts`: `packagerConfig.appBundleId = 'com.aliasness.ntwine'`,
  `appCategoryType = 'public.app-category.music'`, `osxSign` + `osxNotarize` populated from a
  small tested helper (`scripts/signing.ts` or similar) that returns `undefined` for both
  when `NTWINE_SIGN_IDENTITY` is unset, and throws if it is set but notarization credentials
  are incomplete. Entitlements file at `build/entitlements.mac.plist`. `extendInfo` removes
  the mic usage string and sets `LSMinimumSystemVersion` sensibly (builder picks; 12.0 is the
  current default and fine).
- `MakerZIP` already emits `Ntwine-darwin-universal-<version>.zip`, which the update
  service's matcher accepts; no rename needed (verified at spec time).
  `MakerSquirrel` gains `name: 'Ntwine'`, `authors`, and `iconUrl` now that a stable public
  URL exists (raw GitHub URL to `assets/icon.ico` on `main`).
- `scripts/build-icons.mjs`: emit `assets/icon.icns` (the `.iconset` → `iconutil` route on
  macOS, or a pure-JS icns packer so the script stays cross-platform; builder's choice, but
  the output is **committed** like `.ico`/`.png`).
- `src/main.ts` (or a new `src/main/updater.ts`): updater wiring per C4, guarded by
  `app.isPackaged && !process.env.NTWINE_E2E`; the D6 move-to-Applications prompt; the D7
  signature-mismatch fallback (surface a link to the website/Release page, stop polling).
- `.github/workflows/release.yml` as in §3. `e2e.yml` untouched except it may gain a
  `pull_request` trigger if the owner flips D2 of the e2e spec; not this lane's call.
- `README.md`: a short end-user section (download link, Gatekeeper/SmartScreen expectations,
  where the Splice library is read from, how updates work) above the developer section.
- `docs/`: a `RELEASING.md` (or README section) with the tag procedure, how to rotate the
  cert in **2027-01** (export `.p12`, replace the secret), and how to run a signed build
  locally with the keychain profile.

## 5. Verification (what "done" looks like)

- Unit: new helpers green under `yarn test`; `yarn typecheck`, `yarn lint` green.
- Local: `yarn package` with no env → ad-hoc build, e2e suite unchanged and green.
  `NTWINE_SIGN_IDENTITY="Developer ID Application: <owner> (<team-id>)"` plus the
  keychain profile → `yarn make --arch universal` yields a stapled app that passes
  `spctl --assess` on the owner's Mac.
- CI: a `v0.1.0` tag on `main` produces a Release with the macOS zip, the Windows
  `Setup.exe`, `RELEASES`, `.nupkg`, and generated notes; both CI post-checks pass.
- Update path: install `v0.1.0` (accepting the move to `/Applications` on Mac), tag
  `v0.1.1`, confirm the installed app offers the restart on both platforms. This is the owner's first-hand QA gate (spare Windows box + the owner's
  Mac), in the same spirit as the e2e spec's D2.

## 6. Going-public checklist (part of this lane)

Executed as the last PR of the lane, before the repo setting is flipped:

- Secret scan of the full history (`gitleaks` or `trufflehog` locally; nothing is installed
  as a recurring service). Any hit → rewrite history or rotate, owner decides.
- Review `docs/superpowers/**`, test fixtures and comments for personal paths, real library
  contents, or anything the owner would not publish. The real-library e2e project reads
  `~/Splice` by env only; confirm no fixture embeds real sample names.
- Naming review: Ntwine reads a Splice-created library; copy must say it is unaffiliated with
  Splice and does not download from or talk to Splice. Builder drafts the sentence; owner
  approves wording.
- `LICENSE` file present (MIT, "AliasNess Studio") — package.json says MIT but the tree has
  no LICENSE file today.
- Issue/PR templates: not required; skip unless trivial.
- Flip to public **after** secrets are stored (secrets are not exposed by visibility) and
  the first release workflow has been dry-run on a `v0.1.0-rc` tag against the private repo.
  (`update.electronjs.org` only works once public; the rc run validates everything else.)

## 7. Left to the builder

- Exact entitlements beyond the two mandatory ones (§2), chosen by testing the signed app.
- Keychain-import mechanics in CI; `.p12` export instructions for the owner go in
  `RELEASING.md`.
- Whether `publisher-github` or `gh release upload` attaches artifacts.
- Icns packing route (iconutil vs pure JS).
- Where the updater's "Restart to update" affordance lives in the renderer (suggest: the rail
  footer next to the transport, consistent with existing status surfaces) and the IPC shape.
- Version-bump ergonomics (manual PR vs `yarn version` script).
- Splitting into PRs. Suggested order, one PR each, each green on CI and e2e:
  1. bundle id, icns, entitlements, env-gated `osxSign`/`osxNotarize`, local signed build
     works on the owner's Mac;
  2. updater wiring + tests;
  3. `release.yml` + publisher + `RELEASING.md`, validated on an rc tag;
  4. going-public checklist + README, then the owner flips visibility and tags `v0.1.0`.
