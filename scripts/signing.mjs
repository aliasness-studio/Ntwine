// @ts-check
// Developer ID signing + notarization for the macOS build, driven entirely by environment
// variables so no identity, team id or credential ever lives in the repository.
// forge.config.ts spreads `resolveSigning(process.env)` into `packagerConfig`.
//
// No NTWINE_SIGN_IDENTITY ⇒ an unsigned build, exactly as before (local dev, Linux, Windows).
// An identity ⇒ hardened-runtime signing, and notarization credentials become mandatory: a signed
// but un-notarized Developer ID build is Gatekeeper-blocked on every other Mac, so a half-configured
// release environment fails here, loudly, instead of producing an installer nobody can open.
//
// Notarization credentials, in order of preference:
//   NTWINE_NOTARY_KEYCHAIN_PROFILE — a `xcrun notarytool store-credentials` profile (local release)
//   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID — all three, or none (CI secrets)
// Empty strings count as unset: that is how CI exposes a secret that was never configured.

import { fileURLToPath } from 'node:url';

/** @typedef {import('@electron-forge/shared-types').ForgePackagerOptions} PackagerOptions */
/** @typedef {Exclude<PackagerOptions['osxSign'], true | undefined>} OsxSignOptions */
/** @typedef {NonNullable<PackagerOptions['osxNotarize']>} OsxNotarizeOptions */

/** Resolved from this file, not the cwd, so `forge` run from anywhere finds the checked-in plist. */
const DEFAULT_ENTITLEMENTS = fileURLToPath(
  new URL('../build/entitlements.mac.plist', import.meta.url),
);

const APPLE_ID_VARS = /** @type {const} */ ([
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]);

/**
 * @param {Record<string, string | undefined>} env usually `process.env`
 * @param {{ entitlements?: string }} [opts] `entitlements` overrides the plist path (tests)
 * @returns {{ osxSign: OsxSignOptions | undefined, osxNotarize: OsxNotarizeOptions | undefined }}
 */
export function resolveSigning(env, opts = {}) {
  /** @param {string} name */
  const read = (name) => env[name] || undefined;

  const identity = read('NTWINE_SIGN_IDENTITY');
  const keychainProfile = read('NTWINE_NOTARY_KEYCHAIN_PROFILE');

  if (identity === undefined) {
    if (keychainProfile !== undefined || APPLE_ID_VARS.some((name) => read(name) !== undefined)) {
      throw new Error('NTWINE_SIGN_IDENTITY is required when notarization credentials are set');
    }
    return { osxSign: undefined, osxNotarize: undefined };
  }

  const entitlements = opts.entitlements ?? DEFAULT_ENTITLEMENTS;
  /** @type {OsxSignOptions} */
  const osxSign = {
    identity,
    // The same entitlements for every file: Electron's main binary, its helpers and the unpacked
    // better-sqlite3 .node all run under the hardened runtime and need the same exceptions.
    optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
  };

  if (keychainProfile !== undefined) {
    return { osxSign, osxNotarize: { keychainProfile } };
  }

  const [appleId, appleIdPassword, teamId] = APPLE_ID_VARS.map(read);
  if (appleId === undefined || appleIdPassword === undefined || teamId === undefined) {
    const missing = APPLE_ID_VARS.filter((name) => read(name) === undefined);
    throw new Error(
      `NTWINE_SIGN_IDENTITY is set but notarization credentials are incomplete: missing ` +
        `${missing.join(', ')} (or set NTWINE_NOTARY_KEYCHAIN_PROFILE instead)`,
    );
  }
  return { osxSign, osxNotarize: { appleId, appleIdPassword, teamId } };
}
