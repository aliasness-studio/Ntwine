// @ts-check
// The release workflow's guard: a pushed tag may only build a release if it names the version
// package.json already carries, so a tag can never ship an app that reports a different version
// (which would also break the updater's version comparison).
//
//   node scripts/checkTagVersion.mjs v0.1.0        → prints `prerelease=false`
//   node scripts/checkTagVersion.mjs v0.1.0-rc.1   → prints `prerelease=true`
//
// The single stdout line is appended to $GITHUB_OUTPUT by the workflow. Any mismatch exits 1.
//
// The guard job runs on the runner's stock Node with no `yarn install`, so this file imports only
// `node:` builtins. It must also run on Windows: no shell or platform tools.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RC_SUFFIX = /-rc\.\d+$/;

/**
 * True when `tag` is `v<version>` or `v<version>-rc.N`. No other prerelease suffix is accepted.
 * @param {string} tag
 * @param {string} version the package.json version
 * @returns {boolean}
 */
export function tagMatchesVersion(tag, version) {
  return tag.startsWith('v') && tag.slice(1).replace(RC_SUFFIX, '') === version;
}

/**
 * @param {string} tag
 * @returns {boolean}
 */
export function isRcTag(tag) {
  return RC_SUFFIX.test(tag);
}

/** @param {string | undefined} tag */
function main(tag) {
  if (!tag) {
    console.error('usage: node scripts/checkTagVersion.mjs <tag>   (e.g. v0.1.0 or v0.1.0-rc.1)');
    process.exit(1);
  }
  // Resolved from this file, not the cwd, so the guard reads the checked-out package.json.
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!tagMatchesVersion(tag, version)) {
    console.error(
      `tag ${tag} does not match package.json version ${version} ` +
        `(expected v${version} or v${version}-rc.N)`,
    );
    process.exit(1);
  }
  console.log(`prerelease=${isRcTag(tag)}`);
}

// Only when run directly: tests import the pure functions above without triggering the CLI.
// Node's loader realpaths the entry script, so compare against the realpath of argv[1].
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main(process.argv[2]);
}
