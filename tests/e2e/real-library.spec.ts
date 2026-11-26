import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSpliceDbCandidates } from '../../src/main/paths';
import { importAndWait, readCount } from './harness/actions';
import { launchNtwine } from './harness/launch';

const realAppData = (): string | null =>
  process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
  : process.platform === 'win32' ? (process.env.APPDATA ?? null)
  : null;

// Opt-in real-library smoke: imports the developer's actual
// Splice library end-to-end and asserts the top-bar count against a live `select count(*)` from
// the real sounds.db. Excluded from the `default` Playwright project by its `@real` title
// (playwright.config.ts grepInvert); the in-body `test.skip` below is a second, independent gate
// against running for real without deliberately setting NTWINE_E2E_REAL=1 (defense in depth
// against `--project real` being invoked directly, bypassing the `yarn e2e:real` script).
//
// Safety: `appData`/`libraryRoot` passed to launchNtwine are the REAL Application Support dir and
// the REAL ~/Splice — both read-only inputs (glob-detected DB path, sample files on disk).
// `userData` is a fresh mkdtemp dir and is the ONLY place this run ever writes (catalog, snapshot
// copy, covers, waveforms); the real sounds.db itself is opened `{ readonly: true }` here for the
// expected count and never touched through the app.
test('@real the real Splice library imports completely', async () => {
  test.skip(process.env.NTWINE_E2E_REAL !== '1', 'set NTWINE_E2E_REAL=1');
  const appData = realAppData();
  const db = appData ? resolveSpliceDbCandidates(appData)[0] : undefined;
  test.skip(!db, 'no Splice sounds.db detected on this machine');
  // local_path IS NOT NULL: the app deliberately skips rows Splice hasn't downloaded yet
  // (buildCatalog) — mid-sync, the DB really contains such rows, and the imported count must be
  // compared against what the app CONTRACTS to import, not the raw row count.
  const expected = (new Database(db!, { readonly: true }).prepare('select count(*) as c from samples where local_path is not null').get() as { c: number }).c;
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-real-'));
  const l = await launchNtwine({ userData: join(root, 'ud'), appData: appData!, libraryRoot: process.env.NTWINE_E2E_REAL_LIBRARY_ROOT ?? join(homedir(), 'Splice') });
  try {
    // FirstRun.tsx withholds the library view until snapshot+catalog+stat+COVERS all finish,
    // and 612 sequential live `net.fetch` cover fetches routinely exceed Playwright's 30s
    // default action timeout — measured first-hand (`locator.waitFor: Timeout 30000ms exceeded`)
    // against this exact real library before this line existed. `page.setDefaultTimeout` is
    // scoped to THIS test's own Page instance (from this test's own `launchNtwine` call above),
    // so it changes nothing for any other spec's `importAndWait`/`readCount` calls — 13 minutes
    // leaves 2 of the `real` project's 15-minute test budget for the assertion + teardown below.
    l.page.setDefaultTimeout(13 * 60_000);
    await importAndWait(l.page);            // network-bound: ~612 sequential cover fetches
    await expect.poll(() => readCount(l.page)).toBe(expected);
  } finally { await l.close(); rmSync(root, { recursive: true, force: true }); }
});
