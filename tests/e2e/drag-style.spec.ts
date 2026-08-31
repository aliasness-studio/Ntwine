import { DRAG_CARD_LAYOUTS } from '../../src/renderer/dragImage';
import { importAndWait, openSettings, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';
import type { Seam } from './harness/seam';
import type { Page } from '@playwright/test';

// Mirrors drag.ts's emit call site; see drag.spec.ts for why the shape is pinned locally.
interface DragPayload {
  icon: 'card' | 'fallback';
  iconSize: { width: number; height: number };
}

/**
 * Drags `AD_Kick_01.wav` and answers "how tall was the drag image, in the pixels it was painted
 * at". The height is what distinguishes the three styles (they deliberately share a width — that
 * is an OS clip limit, not a style choice), and `iconSize` is LOGICAL, so it has to be multiplied
 * back up by the display scale the renderer drew at. This is the only observable that reaches the
 * real drawn image: no OS drag session runs headless, so nothing in the DOM reflects the style.
 */
async function draggedCardHeight(page: Page, seam: Seam): Promise<number> {
  const before = await seam.count('ntwine:e2e:drag');
  await rowByFilename(page, 'AD_Kick_01.wav').dispatchEvent('dragstart');
  await expect.poll(() => seam.count('ntwine:e2e:drag')).toBe(before + 1);
  const payloads = await seam.drain<DragPayload>('ntwine:e2e:drag');
  const last = payloads[payloads.length - 1];
  expect(last.icon).toBe('card'); // a fallback icon would make the height meaningless
  const displayScale = await page.evaluate(() => window.devicePixelRatio);
  return Math.round(last.iconSize.height * displayScale);
}

test('the drag image style is a setting: each choice changes the picture a drag carries, and the choice survives a relaunch', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  await ntwine.seam.arm('ntwine:e2e:drag');

  // --- the default is the full card, chosen for someone who has never opened Settings ---
  expect(await draggedCardHeight(page, ntwine.seam)).toBe(DRAG_CARD_LAYOUTS.card.height);
  await openSettings(page);
  await expect(page.getByTestId('drag-style-card')).toHaveAttribute('aria-pressed', 'true');

  // --- each style paints its own picture. Height is the discriminator; all three share a width. ---
  for (const style of ['waveform', 'waveform-text', 'card'] as const) {
    await page.getByTestId(`drag-style-${style}`).click();
    await expect(page.getByTestId(`drag-style-${style}`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Close settings' }).click();

    expect(await draggedCardHeight(page, ntwine.seam), style).toBe(DRAG_CARD_LAYOUTS[style].height);

    await openSettings(page);
  }

  // --- a standing taste, not a browsing mode: unlike the autoplay toggle it outlives the process ---
  await page.getByTestId('drag-style-waveform').click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await ntwine.close();

  const second = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
  });
  try {
    await expect(second.page.getByRole('listbox', { name: 'Sample list' })).toBeVisible();
    await openSettings(second.page);
    await expect(second.page.getByTestId('drag-style-waveform')).toHaveAttribute('aria-pressed', 'true');
    await expect(second.page.getByTestId('drag-style-card')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await second.close();
  }
});
