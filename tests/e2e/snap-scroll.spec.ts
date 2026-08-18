import type { Locator, Page } from '@playwright/test';
import { importAndWait } from './harness/actions';
import { expect, test } from './harness/fixtures';

// QoL round 1: arrow-key navigation snaps an off-screen landing row to the TOP of the list (the
// Splice paging feel), in both directions; landings that are already fully visible never scroll.
//
// The window is shrunk small enough that (a) the 12-row fixture overflows the list viewport and
// (b) the first past-the-fold landing is far enough from the end of the list that scrollToIndex's
// end-of-list clamp (offset can never exceed totalSize - viewport) cannot keep it from reaching
// the top — with ~4 rows visible the landing is row ~4 of 12, nowhere near the clamp. Every
// assertion is geometric (selected row's box vs the list's box), never index-hardcoded, so the
// one missing fixture row (excluded from keyboard walks but present in the list) is irrelevant.
const CONTENT_WIDTH = 900;
const CONTENT_HEIGHT = 208; // 48px top bar + ~160px of list => ~4 fully visible 40px rows

async function listScrollTop(list: Locator): Promise<number> {
  return list.evaluate((el) => el.scrollTop);
}

/** Distance between the selected row's top edge and the list viewport's top edge. */
async function selectedRowOffsetFromTop(page: Page, list: Locator): Promise<number> {
  const selected = list.locator('[role="option"][aria-selected="true"]');
  const [listBox, rowBox] = await Promise.all([list.boundingBox(), selected.boundingBox()]);
  if (listBox === null || rowBox === null) return Number.POSITIVE_INFINITY;
  return Math.abs(rowBox.y - listBox.y);
}

test('arrowing past the fold snaps the landing row to the top; visible landings never scroll', async ({
  ntwine,
}) => {
  const { page, app } = ntwine;
  await importAndWait(page);

  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
  }, { w: CONTENT_WIDTH, h: CONTENT_HEIGHT });

  const list = page.getByRole('listbox', { name: 'Sample list' });
  // Condition, not a timeout: the resize has landed once the list viewport is really this short.
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBeLessThan(CONTENT_HEIGHT);

  const clientHeight = await list.evaluate((el) => el.clientHeight);
  const rowHeight = await list
    .getByRole('option')
    .first()
    .evaluate((el) => el.getBoundingClientRect().height);
  const fullyVisible = Math.floor(clientHeight / rowHeight);
  expect(fullyVisible).toBeGreaterThanOrEqual(2); // sanity: the shrink actually took
  expect(fullyVisible).toBeLessThan(11); // sanity: the walk below really crosses the fold

  await list.focus();

  // Walk within the first page: landings are fully visible, so nothing scrolls.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selectedRowOffsetFromTop(page, list)).toBeLessThan(clientHeight);
  expect(await listScrollTop(list)).toBe(0);

  // Cross the fold: the first not-fully-visible landing snaps to the top of the viewport.
  for (let i = 2; i < fullyVisible + 1; i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect.poll(() => selectedRowOffsetFromTop(page, list)).toBeLessThanOrEqual(1);
  expect(await listScrollTop(list)).toBeGreaterThan(0);

  // And back up: the row above the (now top-aligned) selection is off-screen upward, so ArrowUp
  // snaps it to the top too — the same rule, both directions.
  const scrollTopBeforeUp = await listScrollTop(list);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selectedRowOffsetFromTop(page, list)).toBeLessThanOrEqual(1);
  expect(await listScrollTop(list)).toBeLessThan(scrollTopBeforeUp);
});
