import type { Page } from '@playwright/test';
import { importAndWait } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// QoL round 1: the rail is two independent sections — packs in their own scroller, the filter
// panel docked below it, ALWAYS on screen (the old single rail scroll buried the filters under
// the full pack list). The dock collapses to its header row, handing the reclaimed height to the
// packs scroller, and the collapsed/open choice survives a relaunch (localStorage, which lives
// under the e2e run's own userData — the relaunch below reuses that same profile, same pattern
// as persistence.spec).
//
// The window is shrunk so BOTH pressures are real on a 12-row/3-pack fixture: the dock's 55%
// max-height cap bites (its body must scroll internally) and the packs section overflows (its
// scroller must scroll) — which is exactly the state the old layout could not show filters in.
const CONTENT_WIDTH = 900;
const CONTENT_HEIGHT = 320;

/** The packs section's scroll container is PacksScroll, the pack listbox's parent. */
async function packsScrollState(page: Page): Promise<{ clientHeight: number; overflows: boolean }> {
  return page.getByRole('listbox', { name: 'Packs' }).evaluate((el) => {
    const scroller = el.parentElement as HTMLElement;
    return {
      clientHeight: scroller.clientHeight,
      overflows: scroller.scrollHeight > scroller.clientHeight,
    };
  });
}

test('the filter dock stays on screen, collapses to its header, and remembers the choice across launches', async ({
  ntwine,
}) => {
  const { page, app, fixture } = ntwine;
  await importAndWait(page);

  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
  }, { w: CONTENT_WIDTH, h: CONTENT_HEIGHT });

  const dockHeader = page.getByRole('button', { name: 'Filters' });
  const oneShotToggle = page.getByRole('button', { name: 'One-shot' });

  // Open (the default): header and the first filter controls are on screen with NO scrolling,
  // even though the packs section overflows its own scroller right next to them — the exact
  // state the old single-scroll rail buried the filters in.
  await expect(dockHeader).toBeInViewport();
  await expect(dockHeader).toHaveAttribute('aria-expanded', 'true');
  await expect(oneShotToggle).toBeInViewport();
  await expect.poll(async () => (await packsScrollState(page)).overflows).toBe(true);

  // Collapse: controls unmount, only the header row remains, and the packs scroller gets the
  // reclaimed height.
  const openPacksHeight = (await packsScrollState(page)).clientHeight;
  await dockHeader.click();
  await expect(dockHeader).toHaveAttribute('aria-expanded', 'false');
  await expect(oneShotToggle).toBeHidden();
  await expect
    .poll(async () => (await packsScrollState(page)).clientHeight)
    .toBeGreaterThan(openPacksHeight);

  // The choice survives a relaunch against the same profile...
  await ntwine.close();
  const second = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
  });
  try {
    const secondHeader = second.page.getByRole('button', { name: 'Filters' });
    await expect(secondHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(second.page.getByRole('button', { name: 'One-shot' })).toBeHidden();

    // ...and expanding again restores the full panel.
    await secondHeader.click();
    await expect(secondHeader).toHaveAttribute('aria-expanded', 'true');
    await expect(second.page.getByRole('button', { name: 'One-shot' })).toBeVisible();
  } finally {
    await second.close();
  }
});
