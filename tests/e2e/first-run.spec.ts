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

// Both tests below launch WITHOUT the NTWINE_LIBRARY_ROOT override on purpose — that override is
// exactly what would mask the production default-resolution path they exist to drive.
const withUnoverriddenLaunch = async (
  body: (l: Awaited<ReturnType<typeof launchNtwine>>, fixture: ReturnType<typeof buildFixtureLibrary>) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'ntwine-e2e-rootpick-'));
  const fixture = buildFixtureLibrary(join(root, 'fixture'));
  const l = await launchNtwine({ userData: fixture.userData, appData: fixture.appData });
  try {
    await body(l, fixture);
  } finally {
    await l.close();
    // Windows holds the just-closed app's SQLite handles for a moment — retry the teardown
    // rather than fail the test on a transient EBUSY.
    for (let i = 0; i < 5; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
  }
};

// Library-root auto-detection (2026-08-20): first-run used to show a hardcoded "~/Splice
// (default)", which is wrong on Windows (real install: Documents\Splice) and made the owner's
// first real import refuse EVERY row — normalizeSample throws on any local_path outside the root.
// Main now reads Splice's own `splice_folder` from the settings.json beside sounds.db, which the
// fixture plants like a real install does. No picking, no typing: the shown root is the root the
// import actually uses, and the import lands the whole fixture.
test('the library root is detected from Splice\'s own settings, and importing needs no picking', async () => {
  await withUnoverriddenLaunch(async ({ page }, fixture) => {
    await expect(page.getByTestId('first-run-library-root')).toHaveText(fixture.libraryRoot);
    await importAndWait(page);
    await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  });
});

// The escape hatch for everything detection can't cover (a library Splice doesn't know about, an
// unreadable settings.json). Picks the fixture's PARENT — a different path from the detected one,
// so the assertion can't pass by accident, while still containing every sample so the import that
// follows proves the picked root is the one main actually imported against.
test('the Change… button overrides the detected root pre-import, and the import then lands the full fixture', async () => {
  await withUnoverriddenLaunch(async ({ page, app }, fixture) => {
    await expect(page.getByTestId('first-run-library-root')).toHaveText(fixture.libraryRoot);
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, fixture.root);
    await page.getByRole('button', { name: 'Change…' }).click();
    await expect(page.getByTestId('first-run-library-root')).toHaveText(fixture.root);
    await importAndWait(page);
    await expect.poll(() => readCount(page)).toBe(fixture.totalSamples);
  });
});
