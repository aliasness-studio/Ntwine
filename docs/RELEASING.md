# Releasing Ntwine

How a macOS build gets signed and notarized. No identity, team id or credential lives in this
repository: the build reads them from the environment only.

## Signing environment

`forge.config.ts` spreads `resolveSigning(process.env)` (`scripts/signing.mjs`) into
`packagerConfig`. These are the only variables it reads; an empty string counts as unset.

| Variable                                                   | Meaning                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NTWINE_SIGN_IDENTITY`                                     | The codesign identity string, `Developer ID Application: … (TEAMID)`. Unset ⇒ an unsigned build. |
| `NTWINE_NOTARY_KEYCHAIN_PROFILE`                           | A `xcrun notarytool store-credentials` profile name. Local builds use `AliasNess`.               |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization by Apple ID instead (CI). All three, or none.                                       |

With `NTWINE_SIGN_IDENTITY` set, one complete credential form is mandatory: the keychain profile,
or all three `APPLE_*` variables. Anything less throws when Forge loads its config, naming what is
missing — never a silent unsigned build, never a failure ten minutes in at notarization. A
credential without the identity throws too.

Signed builds use the hardened runtime with `build/entitlements.mac.plist`
(`allow-jit`, `allow-unsigned-executable-memory`) on every binary.

## Signed build on a Mac with the keychain

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
waits for the verdict: anywhere from a few minutes to most of an hour (the first one took 37).
Run it where it will not be interrupted. Output:

- `out/Ntwine-darwin-universal/Ntwine.app`
- `out/make/zip/darwin/universal/Ntwine-darwin-universal-0.1.0.zip`

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
