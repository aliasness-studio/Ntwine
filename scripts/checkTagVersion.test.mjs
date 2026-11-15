import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRcTag, tagMatchesVersion } from './checkTagVersion.mjs';

describe('tagMatchesVersion', () => {
  it('accepts a v-prefixed tag equal to the version', () => {
    expect(tagMatchesVersion('v0.1.0', '0.1.0')).toBe(true);
  });

  it('accepts a release candidate of the version', () => {
    expect(tagMatchesVersion('v0.1.0-rc.1', '0.1.0')).toBe(true);
  });

  it('rejects a tag for a different version', () => {
    expect(tagMatchesVersion('v0.2.0', '0.1.0')).toBe(false);
  });

  it('rejects a tag without the v prefix', () => {
    expect(tagMatchesVersion('0.1.0', '0.1.0')).toBe(false);
  });

  // Only `-rc.N` is a release channel; any other suffix is a typo'd or unplanned tag.
  it('rejects prerelease suffixes other than -rc.N', () => {
    expect(tagMatchesVersion('v0.1.0-beta.1', '0.1.0')).toBe(false);
  });
});

describe('isRcTag', () => {
  it('is true for a -rc.N tag', () => {
    expect(isRcTag('v0.1.0-rc.1')).toBe(true);
  });

  it('is false for a plain release tag', () => {
    expect(isRcTag('v0.1.0')).toBe(false);
  });
});

// The CLI is what the release workflow's guard job actually runs, so it is exercised as a real
// child process. `process.execPath` is Electron under `yarn test`; ELECTRON_RUN_AS_NODE=1 makes it
// run the script as plain Node (and is ignored by a real Node binary).
describe('checkTagVersion CLI', () => {
  const script = fileURLToPath(new URL('./checkTagVersion.mjs', import.meta.url));
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  /** @param {string[]} args */
  const run = (args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

  it('prints prerelease=false for a release tag matching package.json', () => {
    const result = run([`v${version}`]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('prerelease=false\n');
  });

  it('prints prerelease=true for a release candidate of the package.json version', () => {
    const result = run([`v${version}-rc.2`]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('prerelease=true\n');
  });

  it('exits 1 naming the tag and the package.json version on a mismatch', () => {
    const result = run(['v999.0.0']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('v999.0.0');
    expect(result.stderr).toContain(version);
  });

  it('exits 1 with usage when no tag is given', () => {
    const result = run([]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage/i);
  });
});
