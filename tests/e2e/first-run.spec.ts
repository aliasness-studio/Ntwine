import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAndWait, readCount } from './harness/actions';
import { buildFixtureLibrary } from './fixture/library';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

test('first run detects the fixture DB, imports, and lands on the library with every sample', async ({ ntwine }) => {
  const { page, fixture } = ntwine;
  await expect(page.getByTestId('detected-splice-db')).toHaveText('found');
  await importAndWait(page);
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12
  await expect(page.getByTestId('result-count')).toHaveText(`${fixture.totalSamples} samples`);
});

test('the same detection reads "not found" against an empty appData (the glob is live)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-nodb-'));
  const l = await launchNtwine({ userData: join(root, 'ud'), appData: join(root, 'empty-appdata') });
  try {
    await expect(l.page.getByTestId('detected-splice-db')).toHaveText('not found');
  } finally {
    await l.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The first-run library-root picker (Option A, 2026-08-20): the DEFAULT root (~/Splice) is wrong
// on machines where Splice puts samples elsewhere (the owner's real Windows box: Documents\
// Splice\Samples), and Settings' picker only exists AFTER a successful import — without this
// button a wrong default wedges first-run entirely (normalizeSample refuses out-of-root paths).
// Launched WITHOUT the NTWINE_LIBRARY_ROOT override on purpose: this drives the exact flow a real
// user performs — see the wrong default, change it, import successfully.
test('the Change… button re-points the library root pre-import, and the import then lands the full fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-rootpick-'));
  const fixture = buildFixtureLibrary(join(root, 'fixture'));
  const l = await launchNtwine({ userData: fixture.userData, appData: fixture.appData });
  try {
    const { page, app } = l;
    await expect(page.getByTestId('first-run-library-root')).toHaveText('~/Splice (default)');
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, fixture.libraryRoot);
    await page.getByRole('button', { name: 'Change…' }).click();
    await expect(page.getByTestId('first-run-library-root')).toHaveText(fixture.libraryRoot);
    await importAndWait(page);
    await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  } finally {
    await l.close();
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
});
