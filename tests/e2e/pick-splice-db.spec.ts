import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { buildFixtureLibrary } from './fixture/library';
import { importAndWait, readCount } from './harness/actions';
import { launchNtwine } from './harness/launch';

// The Splice-DB picker fallback (Windows-port audit blocker): the win32 detection glob is a
// best-guess — when it misses, the first-run screen must offer a way to point at sounds.db by
// hand, refuse a non-Splice file with a visible reason, and import from the picked file. Driven
// against a REAL fixture library whose sounds.db sits where the detection glob does NOT look
// (an empty appData), so 'not found' comes from the live glob and 'found' can only come from
// the picker.
test('detection misses → a bad pick shows the validation error → picking the real sounds.db flips detection and the import runs from it', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ntwine-e2e-pickdb-'));
  const fixture = buildFixtureLibrary(join(scratch, 'fixture'));
  const emptyAppData = join(scratch, 'empty-appdata');
  mkdirSync(emptyAppData, { recursive: true });
  const realDb = join(fixture.appData, 'com.splice.Splice', 'users', 'default', 'e2e', 'sounds.db');
  const bogus = join(scratch, 'not-a-db.db');
  writeFileSync(bogus, 'plain text pretending to be a database');

  const l = await launchNtwine({
    userData: fixture.userData,
    appData: emptyAppData, // detection sees nothing; the library files themselves stay real
    libraryRoot: fixture.libraryRoot,
  });
  try {
    const { page, app } = l;
    await expect(page.getByTestId('detected-splice-db')).toHaveText('not found');

    // Same main-process dialog-stubbing pattern as settings.spec.ts — patch the module singleton.
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, bogus);
    await page.getByRole('button', { name: 'Locate sounds.db…' }).click();
    await expect(page.getByTestId('pick-splice-db-error')).toContainText(/SQLite|database/i);
    await expect(page.getByTestId('detected-splice-db')).toHaveText('not found'); // refused ≠ accepted

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, realDb);
    await page.getByRole('button', { name: 'Locate sounds.db…' }).click();
    await expect(page.getByTestId('detected-splice-db')).toHaveText('found');
    await expect(page.getByTestId('pick-splice-db-error')).toHaveCount(0); // a new attempt clears the old error

    // The import must actually run FROM the picked file: the full fixture catalog appears.
    await importAndWait(page);
    await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  } finally {
    await l.close();
    for (let i = 0; i < 5; i++) {
      try { rmSync(scratch, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});
