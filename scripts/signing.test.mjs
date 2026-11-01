import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined for both when no identity is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveSigning({})).toEqual({ osxSign: undefined, osxNotarize: undefined });
    // CI exposes an unset secret as an empty string, which must read as "not configured".
    expect(resolveSigning({ NTWINE_SIGN_IDENTITY: '' })).toEqual({
      osxSign: undefined,
      osxNotarize: undefined,
    });
    // A clean unsigned build says nothing.
    expect(warn).not.toHaveBeenCalled();
  });

  // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are electron-builder and fastlane names a
  // contributor may well have exported for another project. Without an identity they cannot mean
  // "sign Ntwine", so they are ignored — with one warning — rather than breaking `yarn make`.
  it('ignores the Apple ID variables without an identity, warning once with each name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveSigning({ ...APPLE_ID_TRIPLE })).toEqual({
      osxSign: undefined,
      osxNotarize: undefined,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    for (const name of Object.keys(APPLE_ID_TRIPLE)) expect(message).toContain(name);
  });

  it('names only the Apple ID variables that are actually set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveSigning({ APPLE_ID: 'x', APPLE_TEAM_ID: '' })).toEqual({
      osxSign: undefined,
      osxNotarize: undefined,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('APPLE_ID');
    expect(message).not.toContain('APPLE_TEAM_ID');
    expect(message).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
  });

  // NTWINE_NOTARY_KEYCHAIN_PROFILE is Ntwine's own name: setting it can only mean "notarize this
  // build", which needs a signed app — so without an identity it is a broken release setup.
  it('throws on a keychain profile without an identity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = 'NTWINE_SIGN_IDENTITY is required when NTWINE_NOTARY_KEYCHAIN_PROFILE is set';

    expect(() => resolveSigning({ NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine' })).toThrow(message);
    expect(() =>
      resolveSigning({ NTWINE_NOTARY_KEYCHAIN_PROFILE: 'ntwine', ...APPLE_ID_TRIPLE }),
    ).toThrow(message);
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
