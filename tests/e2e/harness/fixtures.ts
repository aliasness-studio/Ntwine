import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureLibrary, type FixtureLibrary } from '../fixture/library';
import { launchNtwine, type Launched } from './launch';

export type Ntwine = Launched & { fixture: FixtureLibrary; root: string };

export const test = base.extend<{ ntwine: Ntwine }>({
  ntwine: async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-'));
    const fixture = buildFixtureLibrary(root);
    const launched = await launchNtwine({ userData: fixture.userData, appData: fixture.appData, libraryRoot: fixture.libraryRoot });
    await use({ ...launched, fixture, root });
    await launched.close();
    // Windows: SQLite WAL handles can outlive app.close() briefly — retry, then tolerate.
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  },
});
export { expect };
