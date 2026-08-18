import type { Locator, Page } from '@playwright/test';
import { emptyStateText } from '../../src/renderer/emptyState';
import { importAndWait, readCount, rowByFilename } from './harness/actions';
import { expect, test } from './harness/fixtures';
import { launchNtwine } from './harness/launch';

// Generalizes favorites.spec.ts's own `libraryOption`/`countSpan` pair (Name then Count as the
// first/last <span> per option — LibraryRail.tsx's own top comment says this listbox shares that
// shape deliberately) from its `'All Samples' | 'Favorites'` literal union to any collection name
// this file creates, tolerant of whitespace between the two spans for the same reason
// `clickPack`/`toggleTag` (harness/actions.ts) already are. `escapeRegExp` is duplicated locally
// rather than imported — harness/actions.ts keeps its own copy private for the same reason
// CollectionPopover.tsx duplicates UserLayerStore's `errorMessage` instead of exporting it.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function libraryOption(page: Page, name: string): Locator {
  return page
    .getByRole('listbox', { name: 'Library' })
    .getByRole('option', { name: new RegExp(`^${escapeRegExp(name)}\\s*\\d+$`) });
}
function countSpan(option: Locator): Locator {
  return option.locator('span').last();
}

/**
 * Synthetic drag-in (design spec §7's e2e note; Task 13 ledger: "Task 15 sequences the synthetic
 * drop synchronously before the invoke's microtask clears the slot"). `SampleRow.handleDragStart`
 * arms `dragSource.ts`'s module-level slot SYNCHRONOUSLY, then awaits `api.startDrag(...)` — which
 * the e2e main-process arm (`drag.ts`'s `e2eEmit` branch) resolves immediately rather than
 * blocking on a real OS drag session, clearing the slot in a `finally` once that resolves. Two
 * separate Playwright `dispatchEvent()` calls are two separate CDP round trips — each slow enough,
 * relative to a same-process microtask, that the second call can land AFTER the slot has already
 * been cleared: a race that fails regardless of how fast the IPC round trip happens to be.
 * Dispatching BOTH the `dragstart` (arms the slot) and the `drop` (consumes it) via raw DOM calls
 * inside ONE `page.evaluate` keeps them in the same synchronous JS turn, so `drop`'s
 * `consumeDragSource()` always runs before any microtask tied to the `startDrag` promise chain —
 * event dispatch is itself synchronous, so nothing yields between the two calls below.
 * `[title="..."]` mirrors `rowByFilename`'s own filename-cell locator and LibraryRail's collection
 * `Name` `title` attribute — both unique, stable selectors already used elsewhere in this file/
 * actions.ts. Dispatched directly on the `role="option"` element itself (not a descendant), same
 * target drag.spec.ts's own `dispatchEvent('dragstart')` already uses.
 */
async function dragRowIntoCollection(page: Page, filename: string, collectionName: string): Promise<void> {
  await page.evaluate(
    ({ filename, collectionName }) => {
      const row = document.querySelector(`[title="${filename}"]`)?.closest('[role="option"]');
      const target = document.querySelector(`[title="${collectionName}"]`)?.closest('[role="option"]');
      if (!row || !target) {
        throw new Error(`dragRowIntoCollection: row=${String(!!row)} target=${String(!!target)}`);
      }
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    },
    { filename, collectionName },
  );
}

test('create/duplicate/rename/delete round-trip through the rail and the row context menu, the C popover and the row menu both land an add in the collection scope, Delete falls back to the collection empty-state, a synthetic drag-in exercises the drop-target write path, deleting the ACTIVE scope collection falls back to All Samples, and only the surviving collection plus its membership persist across relaunch', async ({
  ntwine,
}) => {
  const { page, fixture } = ntwine;
  await importAndWait(page);
  const list = page.getByRole('listbox', { name: 'Sample list' });
  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // sanity: 12 before any interaction

  // --- create "Crate" via the rail's "+ New collection" inline input ---
  await page.getByRole('button', { name: '+ New collection' }).click();
  await page.getByLabel('New collection name').fill('Crate');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('New collection name')).toHaveCount(0); // editor closes on commit
  await expect(countSpan(libraryOption(page, 'Crate'))).toHaveText('0');

  // --- duplicate create: normalizeUserName collision -> inline role=alert, editor stays open
  // (LibraryRail.tsx's submitCreate only clears `creating` on the success path) ---
  await page.getByRole('button', { name: '+ New collection' }).click();
  await page.getByLabel('New collection name').fill('Crate');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('A collection named "Crate" already exists.');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('New collection name')).toHaveCount(0);

  // --- C popover on the selected row -> plain Enter adds to the only (so highlighted-by-default)
  // collection: design spec §5.3 — absent an exact match, Enter targets the first prefix-filtered
  // suggestion, and "Crate" is both with nothing typed. CollectionPopover's `addExisting` clears
  // the input but does NOT close the popover on success, so Escape closes it explicitly after. ---
  const rowA = rowByFilename(page, 'AD_Kick_01.wav');
  await rowA.click();
  await list.focus();
  await page.keyboard.press('c');
  await page.getByLabel('Add to collection').waitFor();
  await page.getByLabel('Add to collection').press('Enter');
  await expect(countSpan(libraryOption(page, 'Crate'))).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Add to collection')).toHaveCount(0);

  // --- collection scope shows the row ---
  await libraryOption(page, 'Crate').click();
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(rowA).toBeVisible();

  // --- Delete removes it from the collection (never the file) -> collection empty state, rail
  // count back to 0 ---
  await rowA.click();
  await list.focus();
  await page.keyboard.press('Delete');
  await expect(list.getByRole('option')).toHaveCount(0);
  await expect(countSpan(libraryOption(page, 'Crate'))).toHaveText('0');
  await expect(
    page.getByText(emptyStateText({ kind: 'collection', collectionId: '' }), { exact: true }),
  ).toBeVisible();

  // --- row context menu's "Add to collection…" reaches the SAME popover (Ledger Ruling R2: no
  // "▸" submenu — rowMenu.ts's `menuItemsFor` drops the glyph deliberately) and adds it back,
  // viewed from All Samples since the row just left Crate's own scoped view ---
  await libraryOption(page, 'All Samples').click();
  await rowA.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to collection…' }).click();
  await page.getByLabel('Add to collection').waitFor();
  await page.getByLabel('Add to collection').press('Enter');
  await expect(countSpan(libraryOption(page, 'Crate'))).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Add to collection')).toHaveCount(0);

  // --- a second collection, to give the rename-collision case something real to collide with ---
  await page.getByRole('button', { name: '+ New collection' }).click();
  await page.getByLabel('New collection name').fill('Digs');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('New collection name')).toHaveCount(0);
  await expect(countSpan(libraryOption(page, 'Digs'))).toHaveText('0');

  // --- rename via collection right-click: collision error pinned. CARRIED FIX (Task 8 deferred
  // minor, applied in this task): the rename branch must expose the SAME role="option"
  // aria-selected="false" shape every other Library option has — before the fix it was a
  // role-less div, so this scoped getByRole('option') lookup only resolves with the fix applied. ---
  await libraryOption(page, 'Digs').click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename…' }).click();
  const renameInput = page.getByLabel('Rename collection name');
  await expect(renameInput).toHaveValue('Digs'); // sanity: editor reopens pre-filled
  const renamingOption = page
    .getByRole('listbox', { name: 'Library' })
    .getByRole('option')
    .filter({ has: renameInput });
  await expect(renamingOption).toHaveAttribute('aria-selected', 'false');

  await renameInput.fill('Crate');
  await page.keyboard.press('Enter');
  await expect(renamingOption.getByRole('alert')).toHaveText('A collection named "Crate" already exists.');
  await page.keyboard.press('Escape');
  await expect(renameInput).toHaveCount(0);
  await expect(libraryOption(page, 'Digs')).toBeVisible(); // rename was cancelled, name unchanged

  // --- synthetic drag-in (see dragRowIntoCollection's own doc comment for the sequencing this
  // exercises): drag a THIRD, not-yet-collected row into Digs via the real drop-target write path ---
  await dragRowIntoCollection(page, 'BK_Pluck.aiff', 'Digs');
  await expect(countSpan(libraryOption(page, 'Digs'))).toHaveText('1');
  await libraryOption(page, 'Digs').click();
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(rowByFilename(page, 'BK_Pluck.aiff')).toBeVisible();

  // --- delete-active-scope: scope into Crate (this also re-confirms the context-menu re-add
  // landed), delete it via the rail's own confirm, and the scope must fall back to All Samples
  // automatically (UserLayerStore.deleteCollection resets scope BEFORE the delete's own refresh) ---
  await libraryOption(page, 'Crate').click();
  await expect(list.getByRole('option')).toHaveCount(1);

  await libraryOption(page, 'Crate').click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect.poll(() => readCount(page)).toBe(fixture.totalSamples); // 12: fell back to All Samples
  await expect(libraryOption(page, 'Crate')).toHaveCount(0);
  await expect(libraryOption(page, 'All Samples')).toHaveAttribute('aria-selected', 'true');

  // --- relaunch: Crate stays gone; Digs and its one member persist ---
  await ntwine.close();
  const second = await launchNtwine({
    userData: fixture.userData,
    appData: fixture.appData,
    libraryRoot: fixture.libraryRoot,
  });
  try {
    await expect(second.page.getByRole('listbox', { name: 'Sample list' })).toBeVisible();
    await expect.poll(() => readCount(second.page)).toBe(fixture.totalSamples);
    await expect(libraryOption(second.page, 'Crate')).toHaveCount(0);
    await expect(countSpan(libraryOption(second.page, 'Digs'))).toHaveText('1');

    await libraryOption(second.page, 'Digs').click();
    await expect(second.page.getByRole('listbox', { name: 'Sample list' }).getByRole('option')).toHaveCount(1);
    await expect(rowByFilename(second.page, 'BK_Pluck.aiff')).toBeVisible();
  } finally {
    await second.close();
  }
});
