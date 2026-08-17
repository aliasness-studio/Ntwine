// Shared action helpers over the real renderer (Task 4 brief, Interfaces block). Every locator
// strategy here is transcribed verbatim from the brief — accessible-name/role/testid based, never
// a CSS class or a `waitForTimeout`. `waitForWaveform`/`isRealWaveform` are added to this file by
// Task 7.
import type { Locator, Page } from '@playwright/test';
import type { E2ESnapshot } from '../../../src/shared/e2eTypes';

/** MDN's standard escape: every regex metacharacter gets a backslash, so a fixture-supplied name
 * (pack name, tag) can be dropped into a `new RegExp(...)` as a literal without accidentally
 * being interpreted as a pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Click `Import library` and wait for the library view to land (the `Sample list` listbox only
 * exists once App.tsx has flipped out of the FirstRun screen). */
export async function importAndWait(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Import library' }).click();
  await page.getByRole('listbox', { name: 'Sample list' }).waitFor();
}

/** Parses the top-bar `[data-testid=result-count]` text (`"<n> samples"`) into a number. Throws
 * rather than returning NaN on an unexpected shape — a silently-wrong count would defeat the
 * point of a backstop assertion. */
export async function readCount(page: Page): Promise<number> {
  const text = await page.getByTestId('result-count').textContent();
  const match = text?.match(/^(\d+) samples$/);
  if (!match) {
    throw new Error(`readCount: unexpected result-count text ${JSON.stringify(text)}`);
  }
  return Number(match[1]);
}

/** The live `window.__ntwineE2E` snapshot (e2e spec §3.1) — armed only under `NTWINE_E2E=1`. */
export async function snapshot(page: Page): Promise<E2ESnapshot> {
  return page.evaluate(() => window.__ntwineE2E!());
}

/** Fills the top-bar search box (`aria-label="Search samples"`, TopBar.tsx). */
export async function search(page: Page, text: string): Promise<void> {
  await page.getByLabel('Search samples').fill(text);
}

/** Clicks a pack in the rail by name. `PackRail.tsx` renders each option as `<Name>` + `<Count>`,
 * two flex siblings with no guaranteed literal whitespace text node between them — whether
 * Playwright's accessible-name computation joins them with a space isn't verifiable statically,
 * so the match tolerates zero-or-more whitespace between the name and its trailing count. */
export async function clickPack(page: Page, name: string): Promise<void> {
  await page
    .getByRole('listbox', { name: 'Packs' })
    .getByRole('option', { name: new RegExp(`^${escapeRegExp(name)}\\s*\\d+$`) })
    .click();
}

/** Type filter toggle (`FilterPanel.tsx`'s `One-shot`/`Loop` buttons) — `exact` so `One-shot`
 * never accidentally matches a longer/overlapping accessible name. */
export async function toggleType(page: Page, type: 'One-shot' | 'Loop'): Promise<void> {
  await page.getByRole('button', { name: type, exact: true }).click();
}

/** Key filter (`FilterPanel.tsx`, `aria-label="Key filter"`). `''` selects the `Any key` option
 * (`<option value="">`). */
export async function pickKey(page: Page, key: string): Promise<void> {
  await page.getByLabel('Key filter').selectOption(key);
}

/** BPM range inputs (`FilterPanel.tsx`, `aria-label="Minimum BPM"` / `"Maximum BPM"`). `''`
 * clears a bound (mirrors `parseOptionalNumber`'s empty-string-means-null reading). */
export async function setBpm(page: Page, min: number | '', max: number | ''): Promise<void> {
  await page.getByLabel('Minimum BPM').fill(String(min));
  await page.getByLabel('Maximum BPM').fill(String(max));
}

/** Tag chip toggle (`FilterPanel.tsx`'s `TagChip`) — a `<button>` whose accessible name is the
 * tag's name followed by its count (`{tag.name} <ChipCount>{tag.count}</ChipCount>`, a literal
 * space in the JSX between them, but matched tolerantly for the same reason as `clickPack`). */
export async function toggleTag(page: Page, tag: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(tag)}\\s*\\d+$`) }).click();
}

/** Locates a sample row by its filename. The `title` attribute lives on the `Filename` span
 * inside the row (`SampleRow.tsx`), not on the row itself, so this filters the listbox's options
 * by a descendant match rather than targeting the row directly. Synchronous — a `Locator`, not a
 * promise — so callers can chain further Playwright locator/assertion calls on it. */
export function rowByFilename(page: Page, filename: string): Locator {
  return page
    .getByRole('listbox', { name: 'Sample list' })
    .getByRole('option')
    .filter({ has: page.locator(`[title="${filename}"]`) });
}

/** Opens the settings sheet via the rail's gear button (`App.tsx`, `aria-label="Settings"`). */
export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
}
