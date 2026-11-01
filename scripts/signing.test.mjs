import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSigning } from './signing.mjs';

// Obviously fake values: nothing under version control may carry a real identity or team id.
const IDENTITY = 'Developer ID Application: Example (TEAMID1234)';
const ENTITLEMENTS = '/fake/build/entitlements.mac.plist';
const APPLE_ID_TRIPLE = {
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAMID1234',
};

describe('resolveSigning', () => {
  it('returns undefined for both when no identity is set', () => {
    expect(resolveSigning({})).toEqual({ osxSign: undefined, osxNotarize: undefined });
    // CI exposes an unset secret as an empty string, which must read as "not configured".
    expect(resolveSigning({ NTWINE_SIGN_IDENTITY: '' })).toEqual({
      osxSign: undefined,
      osxNotarize: undefined,
    });

    // Credentials without an identity are a misconfiguration, not an unsigned build: notarizing
    // needs a signed app, so silently dropping them would hide a broken release setup.
    expect(() => resolveSigning({ APPLE_ID: 'x' })).toThrow(
      'NTWINE_SIGN_IDENTITY is required when notarization credentials are set',
    );
    expect(() => resolveSigning({ NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine' })).toThrow(
      'NTWINE_SIGN_IDENTITY is required when notarization credentials are set',
    );
  });

  it('builds osxSign with hardened runtime and the entitlements path', () => {
    const { osxSign } = resolveSigning(
      { NTWINE_SIGN_IDENTITY: IDENTITY, NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine' },
      { entitlements: ENTITLEMENTS },
    );

    expect(osxSign?.identity).toBe(IDENTITY);
    // Every signed file — the main binary, the helpers, the unpacked native addon — gets the
    // same entitlements; hardened runtime is what notarization demands.
    const expected = { entitlements: ENTITLEMENTS, hardenedRuntime: true };
    expect(osxSign?.optionsForFile?.('/x/Ntwine.app/Contents/MacOS/Ntwine')).toEqual(expected);
    expect(osxSign?.optionsForFile?.('/x/better_sqlite3.node')).toEqual(expected);
  });

  it('defaults the entitlements to the absolute path of the checked-in plist', () => {
    const { osxSign } = resolveSigning({
      NTWINE_SIGN_IDENTITY: IDENTITY,
      NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine',
    });

    const entitlements = osxSign?.optionsForFile?.('/x/Ntwine').entitlements;
    expect(typeof entitlements).toBe('string');
    expect(isAbsolute(/** @type {string} */ (entitlements))).toBe(true);
    expect(entitlements).toMatch(/[/\\]build[/\\]entitlements\.mac\.plist$/);
    expect(existsSync(/** @type {string} */ (entitlements))).toBe(true);
  });

  it('prefers the keychain profile over the Apple ID triple', () => {
    const { osxNotarize } = resolveSigning({
      NTWINE_SIGN_IDENTITY: IDENTITY,
      NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine',
      ...APPLE_ID_TRIPLE,
    });

    expect(osxNotarize).toEqual({ keychainProfile: 'ntwine' });
  });

  it('uses the Apple ID triple when no profile is set', () => {
    const { osxNotarize } = resolveSigning({
      NTWINE_SIGN_IDENTITY: IDENTITY,
      NTWINE_NOTARY_KEYCHAIN_PROFILE: '',
      ...APPLE_ID_TRIPLE,
    });

    expect(osxNotarize).toEqual({
      appleId: 'dev@example.com',
      appleIdPassword: 'abcd-efgh-ijkl-mnop',
      teamId: 'TEAMID1234',
    });
  });

  it('throws naming every missing credential variable', () => {
    expect(() => resolveSigning({ NTWINE_SIGN_IDENTITY: IDENTITY, APPLE_ID: 'x' })).toThrow(
      /missing APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID\b/,
    );
    // With nothing set, all three are named — and the error points at the profile alternative.
    expect(() => resolveSigning({ NTWINE_SIGN_IDENTITY: IDENTITY })).toThrow(
      /missing APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID\b.*NTWINE_NOTARY_KEYCHAIN_PROFILE/,
    );
  });
});
