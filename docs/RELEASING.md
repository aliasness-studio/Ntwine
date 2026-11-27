# Releasing Ntwine

Pushing a `v*` tag builds a Developer ID signed and notarized universal macOS zip and an unsigned
Windows installer, then publishes both as a GitHub Release (`.github/workflows/release.yml`). No
identity, team id or credential lives in this repository: CI reads them from repository secrets,
a local build from the environment.

**First time?** Do §3 (secrets, once), then §2 (a release-candidate dry run), then §1. A tag only
releases if the commit it points at contains the workflow and is on `main`, so tag `main` after
the workflow has been merged.

1. [Cut a release](#1-cut-a-release)
2. [Dry run with a release candidate](#2-dry-run-with-a-release-candidate)
3. [One-time setup: repository secrets](#3-one-time-setup-repository-secrets)
4. [Certificate rotation (before 2027-02-01)](#4-certificate-rotation-before-2027-02-01)
5. [Local signed build](#5-local-signed-build)
6. [Why `gh`, not `publisher-github`](#6-why-gh-not-publisher-github)
7. [Owner QA notes](#7-owner-qa-notes)

## 1. Cut a release

Needs §3 done once, and `gh` logged in (`gh auth status`). The examples ship `0.1.0`, the first
release; substitute the version you are shipping.

**Step 1 — bump the version in a PR.** Skip this for `0.1.0`: `package.json` already says it. For
a later release, say `0.2.0`:

```bash
git switch main && git pull && git switch -c release/v0.2.0
yarn version --new-version 0.2.0 --no-git-tag-version
git commit -am "chore(release): 0.2.0" && git push -u origin HEAD && gh pr create --fill
```

Merge the PR once CI is green.

**Step 2 — tag the merged commit on `main`.** The middle command is the same guard the workflow
runs first; it prints `prerelease=false` or says why the tag is refused.

```bash
git switch main && git pull
node scripts/checkTagVersion.mjs v0.1.0
git tag v0.1.0 && git push origin v0.1.0
```

**Step 3 — watch the workflow.** Pick the `release` run from the list (or open the repository's
Actions tab):

```bash
gh run watch
```

Expect about ten minutes: the first two CI runs each finished in about six. Apple's notarization
is the variable part (one local run took ~37 minutes), so a `mac` job that sits in notarization
for up to an hour is slow, not hung. The jobs:

- **`guard`** (ubuntu, seconds): `node scripts/checkTagVersion.mjs <tag>`, then a check that the
  tagged commit is on `main`. Fails if the tag's version is not `package.json`'s or the commit is
  not on `main`; nothing else runs.
- **`mac`** (macOS, Apple silicon; 120 min timeout): imports the certificate into a throwaway
  keychain, runs `yarn make:mac` (sign, notarize, staple), then checks `codesign --verify`,
  `spctl` reporting `source=Notarized Developer ID`, `stapler validate`, both `x86_64` and `arm64`
  slices, the packaged boot probe, and an Intel-slice boot probe under Rosetta. Uploads the zip.
- **`win`** (Windows, in parallel with `mac`): `yarn make:win`, the unsigned Squirrel
  `Setup.exe`, `RELEASES` and the full `.nupkg`.
- **`publish`** (ubuntu): only after both builds pass, one `gh release create` with all assets
  and generated release notes.

The Release title is `Ntwine v0.1.0 (beta)` while the major version is 0, and `Ntwine v1.0.0` from
1.0 on. An `-rc.N` tag is marked as a pre-release (§2).

**Step 4 — check the Release.**

```bash
gh release view v0.1.0
```

Expect the title above, not marked pre-release, and four assets: the
`Ntwine-darwin-universal-0.1.0.zip`, the `Setup.exe`, `RELEASES` and the `.nupkg`.

Installed copies do not see the release straight away. The update feed (update.electronjs.org)
caches its answer, so allow ten minutes or more after publishing before an app's next check
offers the new version. An app checks 30 seconds after launch and every four hours after that.

### When a run fails

- **`guard` failed:** the tag names the wrong version, or points at a commit not on `main`.
  Delete the tag (below), fix `package.json` via a PR if needed, tag the merged commit on `main`.
- **`mac` or `win` failed:** nothing was published. Transient (Apple's service, a runner
  hiccup): re-run the failed jobs (below). A real bug: fix it on `main` via a PR, delete the tag,
  tag the new commit.
- **`publish` failed:** `gh` may have left a **draft** Release behind. Delete the Release but
  keep the tag, then re-run the failed jobs; the built artifacts are reused and the tag does not
  need re-pushing.

Re-run only the failed jobs of the latest release run (or "Re-run failed jobs" in the Actions tab):

```bash
gh run rerun $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId') --failed
```

Delete a Release but keep its tag (the `publish` case; or delete the draft on the Releases page).
List the Releases first: a leftover draft shows as `Draft`.

```bash
gh release list
```

```bash
gh release delete v0.1.0 --yes
```

Delete a tag, locally and on GitHub (the `guard` and real-bug cases):

```bash
git push origin :refs/tags/v0.1.0 && git tag -d v0.1.0
```

A plain `git push` of a tag that already exists on GitHub is rejected and starts nothing. Only
deleting the tag and tagging again (or a force push) starts a second run; if the first is still
going, the second queues behind it rather than racing it.

## 2. Dry run with a release candidate

An `-rc.N` tag runs the whole pipeline — secrets, signing, notarization, both builds, the Release —
but the Release is marked **pre-release**, so installed apps never see it: update.electronjs.org
skips pre-releases and `/releases/latest` ignores them. Use it the first time and after every
change to the secrets or the workflow.

The guard accepts `v<version>-rc.N` against `package.json`'s `<version>` (so `v0.1.0-rc.1` against
`0.1.0`) and prints `prerelease=true`. Any other suffix (`-beta.1`, `-rc1`) is refused.

```bash
git switch main && git pull
node scripts/checkTagVersion.mjs v0.1.0-rc.1
git tag v0.1.0-rc.1 && git push origin v0.1.0-rc.1
```

Watch it as in §1 step 3, then check `gh release view v0.1.0-rc.1` says pre-release. You can
download the zip from it and install by hand. Afterwards delete the Release and the tag, so the
real `v0.1.0` is the only one left:

```bash
gh release delete v0.1.0-rc.1 --yes --cleanup-tag
git tag -d v0.1.0-rc.1
```

The next dry run of the same version is `v0.1.0-rc.2`.

## 3. One-time setup: repository secrets

The workflow reads exactly six secrets. Set them once; they are only needed again on certificate
rotation (§4). Needs the Developer ID Application certificate in your login keychain (it is there
if a local signed build works, §5) and `gh` logged in with admin rights on the repository.

| Secret                        | Value                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `MACOS_CERT_P12_BASE64`       | The Developer ID certificate and its private key, exported as `.p12`, base64-encoded (step 1–2). |
| `MACOS_CERT_PASSWORD`         | The password you set on that `.p12` export.                                                      |
| `MACOS_SIGN_IDENTITY`         | The full identity string, `Developer ID Application: <name> (<TEAMID>)`.                         |
| `APPLE_ID`                    | `<apple id>`: the email of the Apple developer account.                                          |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID, `xxxx-xxxx-xxxx-xxxx` (step 4).                      |
| `APPLE_TEAM_ID`               | `<TEAMID>`: the 10-character id in parentheses at the end of the identity string.                |

Each `gh secret set` below either reads the value from a pipe or prompts for it with hidden input,
so no secret lands in your shell history. Setting a secret again overwrites it.

**Step 1 — export the certificate as `.p12`.** Keychain Access → **login** keychain → **My
Certificates** → right-click `Developer ID Application: <name> (<TEAMID>)` → **Export…** → format
**Personal Information Exchange (.p12)** → save as `ntwine-devid.p12` on the Desktop → set a
strong password (keep it for step 2) → allow access with your Mac login password. Use **My
Certificates**, not Certificates: only there does the export include the private key.

**Step 2 — the two certificate secrets.** The first pipes the file straight in; the second
prompts for the `.p12` password.

```bash
base64 -i ~/Desktop/ntwine-devid.p12 | gh secret set MACOS_CERT_P12_BASE64 -R aliasness-studio/Ntwine
```

```bash
gh secret set MACOS_CERT_PASSWORD -R aliasness-studio/Ntwine
```

**Step 3 — the identity and team id.** Print the identity string; it is the quoted part of the
line containing `Developer ID Application`:

```bash
security find-identity -v -p codesigning
```

Set the secrets, pasting the identity string without the quotes, then the 10 characters inside its
parentheses:

```bash
gh secret set MACOS_SIGN_IDENTITY -R aliasness-studio/Ntwine
```

```bash
gh secret set APPLE_TEAM_ID -R aliasness-studio/Ntwine
```

**Step 4 — Apple ID and app-specific password.** Generate a password for CI at
[appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific
Passwords** → **+**, label it `Ntwine CI`. It is the same kind of password as the one behind your
local `AliasNess` notarytool profile (§5), but a separate one, so either can be revoked alone.
Apple shows it once; paste it straight into the second prompt:

```bash
gh secret set APPLE_ID -R aliasness-studio/Ntwine
```

```bash
gh secret set APPLE_APP_SPECIFIC_PASSWORD -R aliasness-studio/Ntwine
```

**Step 5 — check, then delete the `.p12`.** The list must show all six names; values are never
shown.

```bash
gh secret list -R aliasness-studio/Ntwine
```

```bash
rm ~/Desktop/ntwine-devid.p12
```

**Alternative: the web UI.** github.com/aliasness-studio/Ntwine → **Settings** → **Secrets and
variables** → **Actions** → **New repository secret**, once per name above. For the certificate,
copy the base64 to the clipboard, paste it as the value, then clear the clipboard:

```bash
base64 -i ~/Desktop/ntwine-devid.p12 | pbcopy
```

```bash
pbcopy < /dev/null
```

Then run a dry run (§2): a wrong secret shows up there, not in a real release.

## 4. Certificate rotation (before 2027-02-01)

The Developer ID Application certificate expires on **2027-02-01**. After that CI cannot sign, so
no release can ship until it is renewed. Copies already installed keep working: their signature
is timestamped and notarized. Renew in January 2027.

1. **New CSR.** Keychain Access → menu **Keychain Access** → **Certificate Assistant** → **Request
   a Certificate From a Certificate Authority…** → your email and name, **Saved to disk**.
2. **New certificate.** [developer.apple.com/account](https://developer.apple.com/account) →
   **Certificates, IDs & Profiles** → **Certificates** → **+** → **Developer ID Application** →
   upload the CSR → download the `.cer`.
3. **Install.** Double-click the `.cer`; it joins its private key in the login keychain. Check
   with `security find-identity -v -p codesigning`. The old and new certificates have the same
   name, so a local build may call the identity ambiguous while both are there. Deleting the old
   one in Keychain Access (My Certificates, the earlier expiry date) can wait until a build with
   the new one has succeeded (a local build, or the dry run in step 5): until then it is your rollback.
4. **Re-export and replace the two certificate secrets:** §3 steps 1, 2 and the `rm` in step 5.
   `MACOS_CERT_P12_BASE64` and `MACOS_CERT_PASSWORD` are the only secrets that change.
5. **Dry run** (§2) before the next real release.

The identity string, and so `MACOS_SIGN_IDENTITY`, changes only if the team or name changes.
Then also replace `MACOS_SIGN_IDENTITY` and `APPLE_TEAM_ID`, and recreate the local notarytool
profile. Only a **team** change affects users: installed Macs cannot auto-update across a
change of signing team, so the app shows a link to download the new version instead, and each
user reinstalls once. A same-team renewal does not: updates keep flowing.

## 5. Local signed build

The same signing CI does, from your own Mac's keychain. CI never needs this; use it to debug
signing or notarization without pushing a tag.

### Signing environment

`forge.config.ts` spreads `resolveSigning(process.env)` (`scripts/signing.mjs`) into
`packagerConfig`. These are the only variables it reads; an empty string counts as unset.

| Variable                                                   | Meaning                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `NTWINE_SIGN_IDENTITY`                                     | The codesign identity string, `Developer ID Application: … (TEAMID)`. Unset ⇒ an unsigned build.          |
| `NTWINE_NOTARY_KEYCHAIN_PROFILE`                           | A `xcrun notarytool store-credentials` profile name. Local builds use `AliasNess`. Requires the identity. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization by Apple ID instead (CI). All three, or none. Ignored, with a warning, without the identity. |

The `AliasNess` profile is created once per Mac; `notarytool` prompts for an app-specific password
and keeps it in the login keychain, so the build never sees it:

```bash
xcrun notarytool store-credentials AliasNess --apple-id <apple id> --team-id <TEAMID>
```

With `NTWINE_SIGN_IDENTITY` set, one complete credential form is mandatory: the keychain profile,
or all three `APPLE_*` variables. Anything less throws when Forge loads its config, naming what is
missing — never a silent unsigned build, never a failure ten minutes in at notarization.

Without the identity the build is unsigned. `NTWINE_NOTARY_KEYCHAIN_PROFILE` then throws
(`NTWINE_SIGN_IDENTITY is required when NTWINE_NOTARY_KEYCHAIN_PROFILE is set`): it is Ntwine's
own variable and can only mean a half-configured release. The `APPLE_*` variables are only
ignored, with one warning naming them: electron-builder and fastlane read the same names, so a
contributor may have them exported for another project, and that must not break `yarn make`.

Signed builds use the hardened runtime with `build/entitlements.mac.plist`
(`allow-jit`, `allow-unsigned-executable-memory`) on every binary.

### Signed build on a Mac with the keychain

Needs Xcode (for `notarytool`/`stapler`), the Developer ID Application identity in the login
keychain, and the `AliasNess` notarytool profile. Find the identity string with:

```bash
security find-identity -v -p codesigning   # the line containing "Developer ID Application"
```

Build — sign, notarize, staple, zip:

```bash
NTWINE_SIGN_IDENTITY="<Developer ID Application identity>" \
NTWINE_NOTARY_KEYCHAIN_PROFILE=AliasNess \
yarn make:mac
```

`yarn make:mac` builds one universal (`x86_64 arm64`) app. Notarization uploads to Apple and
waits for the verdict: anywhere from a few minutes to most of an hour (the first one took ~37
minutes). Run it where it will not be interrupted. Output:

- `out/Ntwine-darwin-universal/Ntwine.app`
- `out/make/zip/darwin/universal/Ntwine-darwin-universal-<version>.zip`

Verify before shipping:

```bash
codesign --verify --deep --strict --verbose=2 out/Ntwine-darwin-universal/Ntwine.app
spctl --assess --type execute -vv out/Ntwine-darwin-universal/Ntwine.app
xcrun stapler validate out/Ntwine-darwin-universal/Ntwine.app
lipo -archs out/Ntwine-darwin-universal/Ntwine.app/Contents/MacOS/Ntwine
NTWINE_PACKAGED_DIR=$PWD/out/Ntwine-darwin-universal yarn e2e:only --grep packaged
```

Expect "valid on disk" and "satisfies its Designated Requirement"; `accepted` with
`source=Notarized Developer ID`; "The validate action worked!"; `x86_64 arm64`; the packaged boot
probe passing. `codesign -dv` on the app reports `Identifier=com.aliasness.ntwine`.

`NTWINE_PACKAGED_DIR` points the packaged probe at the universal output; without it the probe
looks for the host-arch `out/Ntwine-darwin-<arch>` that `yarn package` produces.

A failed notarization prints the submission id. Apple's log says why:

```bash
xcrun notarytool log <submission-id> --keychain-profile AliasNess
```

## 6. Why `gh`, not `publisher-github`

Electron Forge's `publisher-github` publishes from the job that built the artifact. With a `mac`
job and a `win` job, both would try to create the same Release at the same time, and one loses
the race. Instead the `publish` job runs once, after both builds pass, downloads both platforms'
artifacts and creates the Release with one `gh release create --verify-tag`. The GitHub CLI ships
on the runner, so this adds no dependency, and a failed build publishes nothing. `--verify-tag`
refuses to create a Release whose tag is missing, rather than inventing one. Forge has no
publisher configured; the `publish` script in `package.json` is not part of releasing.

## 7. Owner QA notes

**The updater is silent until two things are true:** the repository is public, and at least one
non-pre-release Release exists. Before then update.electronjs.org answers 404, which the app logs
and retries every 4 hours without showing anything. A dry run (§2) never satisfies this. Check
the feed by asking it for an update from an old version: `404` means not live yet, `200` means an
update would be offered, `204` means none is newer:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://update.electronjs.org/aliasness-studio/Ntwine/darwin-universal/0.0.1
```

**Updates on a Mac need the app in `/Applications`.** On first launch from anywhere else the app
offers to move itself there; declining is remembered. To see the prompt again, quit Ntwine, then
clear the remembered answer (`sqlite3` ships with macOS):

```bash
osascript -e 'quit app "Ntwine"'
```

```bash
sqlite3 ~/Library/Application\ Support/Ntwine/ntwine-data/catalog.db "DELETE FROM meta WHERE key='move_to_applications_declined';"
```

**Windows is unsigned.** SmartScreen warns about an unknown publisher: **More info** → **Run
anyway**.
