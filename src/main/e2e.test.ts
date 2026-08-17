import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { E2EConfigError, makeE2EEmitter, readE2EConfig } from './e2e';

// Windows-safe absolute: the brief's `/tmp/...` literals are POSIX-only absolutes, and
// `readE2EConfig` checks `isAbsolute`, which a POSIX literal fails on Windows.
const ABS = path.resolve('e2e-tmp');

describe('readE2EConfig', () => {
  it('is null when NTWINE_E2E is unset (the app is v1)', () => {
    expect(readE2EConfig({})).toBeNull();
    expect(readE2EConfig({ NTWINE_USER_DATA: ABS })).toBeNull(); // overrides alone do nothing
  });
  it('is null when NTWINE_E2E is any value but "1"', () => {
    expect(readE2EConfig({ NTWINE_E2E: 'true', NTWINE_USER_DATA: ABS })).toBeNull();
  });
  it('refuses to arm without an absolute NTWINE_USER_DATA', () => {
    expect(() => readE2EConfig({ NTWINE_E2E: '1' })).toThrow(E2EConfigError);
    expect(() => readE2EConfig({ NTWINE_E2E: '1', NTWINE_USER_DATA: 'relative/dir' })).toThrow(
      /NTWINE_USER_DATA/,
    );
  });
  it('reads the full contract when armed', () => {
    const cfg = readE2EConfig({
      NTWINE_E2E: '1',
      NTWINE_USER_DATA: path.join(ABS, 'ud'),
      NTWINE_APP_DATA: path.join(ABS, 'ad'),
      NTWINE_LIBRARY_ROOT: path.join(ABS, 'lib'),
      NTWINE_E2E_BOOT_MARKER: path.join(ABS, 'marker'),
    });
    expect(cfg).toStrictEqual({
      userData: path.join(ABS, 'ud'),
      appData: path.join(ABS, 'ad'),
      libraryRoot: path.join(ABS, 'lib'),
      bootMarker: path.join(ABS, 'marker'),
    });
  });
  it('leaves optional overrides null when absent', () => {
    expect(readE2EConfig({ NTWINE_E2E: '1', NTWINE_USER_DATA: path.join(ABS, 'ud') })).toStrictEqual(
      { userData: path.join(ABS, 'ud'), appData: null, libraryRoot: null, bootMarker: null },
    );
  });
  it('refuses a SUPPLIED optional override that is not absolute (a typo must not run against cwd-relative data)', () => {
    for (const key of ['NTWINE_APP_DATA', 'NTWINE_LIBRARY_ROOT', 'NTWINE_E2E_BOOT_MARKER'] as const) {
      expect(() =>
        readE2EConfig({ NTWINE_E2E: '1', NTWINE_USER_DATA: path.join(ABS, 'ud'), [key]: 'relative/path' }),
      ).toThrow(new RegExp(key));
    }
  });
});

describe('makeE2EEmitter', () => {
  it('is null when unarmed — no hook can be installed', () => {
    const app = { emit: vi.fn() };
    expect(makeE2EEmitter(app, null)).toBeNull();
    expect(app.emit).not.toHaveBeenCalled();
  });
  it('forwards (event, payload) to app.emit when armed', () => {
    const app = { emit: vi.fn(() => true) };
    const emit = makeE2EEmitter(app, {
      userData: path.join(ABS, 'ud'),
      appData: null,
      libraryRoot: null,
      bootMarker: null,
    });
    emit!('ntwine:e2e:drag', { sampleId: 3, file: null });
    expect(app.emit).toHaveBeenCalledWith('ntwine:e2e:drag', { sampleId: 3, file: null });
  });
});
