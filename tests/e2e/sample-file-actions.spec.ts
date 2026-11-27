import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { Page } from '@playwright/test';
import { SYSTEM_SUBMENU_LABEL } from '../../src/renderer/rowMenu';
import { clickRow, importAndWait, rowByFilename, snapshot } from './harness/actions';
import { expect, test } from './harness/fixtures';

// Mirror sampleFile.ts's two emit call sites — no shared exported type, same convention as
// drag.spec.ts's DragPayload.
interface RevealPayload {
  sampleId: number;
  file: string | null;
}
interface CopyPathPayload {
  sampleId: number;
  path: string | null;
}

// rowMenu.ts's platform naming, derived independently so a wrong label fails here.
const REVEAL_LABEL =
  process.platform === 'darwin'
    ? 'Show in Finder'
    : process.platform === 'win32'
      ? 'Show in Explorer'
      : 'Show in file manager';

/** Right-clicks a row on its filename cell — the one cell that is never a link (see clickRow). */
async function openRowMenu(page: Page, filename: string): Promise<void> {
  await rowByFilename(page, filename).locator(`[title="${filename}"]`).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Row actions' }).waitFor();
}

test('the row menu reveals a sample and copies its full path from its System submenu through main, without touching selection or playback, and a missing row keeps both items flat with reveal disabled', async ({
  ntwine,
}) => {
  const { page, seam, fixture } = ntwine;
  await importAndWait(page);
  await seam.arm('ntwine:e2e:reveal');
  await seam.arm('ntwine:e2e:copy-path');

  // A real selection + one play first, on a DIFFERENT row, so "unchanged" below is a claim about
  // live state rather than about nothing having happened yet.
  await clickRow(page, 'AD_Kick_02.wav');
  await expect.poll(async () => (await snapshot(page)).playCount).toBe(1);
  const before = await snapshot(page);
  expect(before.selectedId).not.toBeNull();
  const unchanged = async (): Promise<void> => {
    const now = await snapshot(page);
    expect(now.selectedId).toBe(before.selectedId);
    expect(now.playCount).toBe(before.playCount);
  };

  const menu = page.getByRole('menu', { name: 'Row actions' });
  const reveal = menu.getByRole('menuitem', { name: REVEAL_LABEL, exact: true });
  const copyPath = menu.getByRole('menuitem', { name: 'Copy full path', exact: true });
  const system = menu.getByRole('menuitem', { name: SYSTEM_SUBMENU_LABEL, exact: true });
  const systemMenu = menu.getByRole('menu', { name: SYSTEM_SUBMENU_LABEL, exact: true });
  const tags = menu.getByRole('menuitem', { name: 'Tags…', exact: true });

  // --- a present row: the file items sit behind the System submenu, closed until opened ---
  await openRowMenu(page, 'AD_Kick_01.wav');
  await expect(menu.getByRole('separator')).toHaveCount(1);
  await expect(system).toHaveAttribute('aria-haspopup', 'menu');
  await expect(system).toHaveAttribute('aria-expanded', 'false');
  await expect(systemMenu).toHaveCount(0);
  await expect(reveal).toHaveCount(0);
  await expect(copyPath).toHaveCount(0);

  // Hover opens it beside the parent item, to the right while there is room.
  await system.hover();
  await expect(systemMenu).toBeVisible();
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await expect(reveal).toBeEnabled();
  await expect(copyPath).toBeEnabled();
  const parentBox = (await system.boundingBox())!;
  const childBox = (await systemMenu.boundingBox())!;
  expect(childBox.x).toBeGreaterThan(parentBox.x + parentBox.width / 2);

  // Moving onto a different top-level item closes it; the top-level menu stays.
  await tags.hover();
  await expect(systemMenu).toHaveCount(0);
  await expect(system).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeVisible();
  await unchanged();

  // Copy: main resolves the id to the row's absolute, in-library path. The seam reports it
  // instead of writing the clipboard. The pointer travels parent -> child item, which keeps the
  // submenu open the whole way.
  await system.hover();
  await copyPath.click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => seam.count('ntwine:e2e:copy-path')).toBe(1);
  const [copied] = await seam.drain<CopyPathPayload>('ntwine:e2e:copy-path');
  expect(copied.path).not.toBeNull();
  expect(isAbsolute(copied.path!)).toBe(true);
  expect(basename(copied.path!)).toBe('AD_Kick_01.wav');
  expect(copied.path!.startsWith(fixture.libraryRoot)).toBe(true);
  await unchanged();

  // Clicking the parent opens the submenu without closing the menu around it.
  await openRowMenu(page, 'AD_Kick_01.wav');
  await system.click();
  await expect(menu).toBeVisible();
  await expect(systemMenu).toBeVisible();

  // Keyboard: ArrowRight opens it and focuses its first item; ArrowLeft closes it and hands focus
  // back to the parent; Enter reopens it. None of these keys reach the list's own keymap
  // (ArrowLeft there retriggers the selected sample, which `unchanged` would catch).
  await tags.hover();
  await expect(systemMenu).toHaveCount(0);
  await system.press('ArrowRight');
  await expect(systemMenu).toBeVisible();
  await expect(reveal).toBeFocused();
  await reveal.press('ArrowLeft');
  await expect(systemMenu).toHaveCount(0);
  await expect(system).toBeFocused();
  await system.press('Enter');
  await expect(systemMenu).toBeVisible();
  await expect(reveal).toBeFocused();
  await unchanged();

  // Reveal: the same id resolves to the same, existing file. No file-manager window opens.
  await reveal.click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => seam.count('ntwine:e2e:reveal')).toBe(1);
  expect(await seam.drain<RevealPayload>('ntwine:e2e:reveal')).toEqual([
    { sampleId: copied.sampleId, file: copied.path },
  ]);
  expect(existsSync(copied.path!)).toBe(true);
  await unchanged();

  // --- the missing row: only the two file items, flat (no submenu, no separator); reveal is a
  // real disabled button ---
  await openRowMenu(page, fixture.missingFilename);
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(system).toHaveCount(0);
  await expect(menu.getByRole('separator')).toHaveCount(0);
  await expect(reveal).toBeDisabled();
  await expect(copyPath).toBeEnabled();
  await unchanged();

  // Forcing a click onto the disabled item does nothing: the menu stays open, and the reveal
  // counter stays flat while the copy-path counter below moves.
  await reveal.click({ force: true });
  await expect(menu).toBeVisible();

  // Copy still works and reports where the file should be — a path that isn't on disk.
  await copyPath.click();
  await expect.poll(() => seam.count('ntwine:e2e:copy-path')).toBe(2);
  const [missingCopied] = await seam.drain<CopyPathPayload>('ntwine:e2e:copy-path');
  expect(missingCopied.path).not.toBeNull();
  expect(isAbsolute(missingCopied.path!)).toBe(true);
  expect(basename(missingCopied.path!)).toBe(fixture.missingFilename);
  expect(missingCopied.path!.startsWith(fixture.libraryRoot)).toBe(true);
  expect(existsSync(missingCopied.path!)).toBe(false);
  expect(await seam.count('ntwine:e2e:reveal')).toBe(1);
  await unchanged();
});

test('the System submenu flips to the left of its parent near the window right edge and stays inside the window', async ({
  ntwine,
}) => {
  const { page } = ntwine;
  await importAndWait(page);

  // Right-click the row a few pixels in from the window's right edge: the top-level menu clamps
  // inside the window, leaving no room for the submenu on its right.
  const width = await page.evaluate(() => window.innerWidth);
  const rowBox = (await rowByFilename(page, 'AD_Kick_01.wav').boundingBox())!;
  await page.mouse.click(width - 8, rowBox.y + rowBox.height / 2, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Row actions' });
  await menu.waitFor();

  const system = menu.getByRole('menuitem', { name: SYSTEM_SUBMENU_LABEL, exact: true });
  const systemMenu = menu.getByRole('menu', { name: SYSTEM_SUBMENU_LABEL, exact: true });
  await system.hover();
  await expect(systemMenu).toBeVisible();
  const parentBox = (await system.boundingBox())!;
  const childBox = (await systemMenu.boundingBox())!;
  expect(childBox.x + childBox.width).toBeLessThan(parentBox.x + parentBox.width / 2);
  expect(childBox.x).toBeGreaterThanOrEqual(0);
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(width);
});
