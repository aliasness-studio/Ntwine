import { describe, expect, it } from 'vitest';
import type { SampleRow } from '../shared/ipcTypes';
import { menuItemsFor } from './rowMenu';

// Same fixture shape as LibraryStore.test.ts's `sampleRow` — a full `SampleRow` literal, not a
// partial cast, so a future required field lands here as a real typecheck failure instead of an
// `any`-shaped silent gap.
const baseRow: SampleRow = {
  id: 1,
  filename: 'kick.wav',
  relPath: 'packs/Pack A/kick.wav',
  packId: 1,
  packName: 'Pack A',
  sampleType: 'oneshot',
  bpm: 120,
  audioKey: 'c',
  chordType: null,
  durationMs: 500,
  missing: false,
  tags: ['kick'],
  hasPeaks: true,
  peaksFailed: false,
  favorite: false,
  nickname: null,
  userTags: [],
};

describe('menuItemsFor', () => {
  it('a non-favorited row gets a "Favorite" item (label flip)', () => {
    const items = menuItemsFor(baseRow, undefined, 'darwin');
    expect(items.find((i) => i.id === 'favorite')).toEqual({ id: 'favorite', label: 'Favorite' });
  });

  it('a favorited row gets an "Unfavorite" item — same id, flipped label', () => {
    const items = menuItemsFor({ ...baseRow, favorite: true }, undefined, 'darwin');
    expect(items.find((i) => i.id === 'favorite')).toEqual({
      id: 'favorite',
      label: 'Unfavorite',
    });
  });

  it('a collection scope adds "removefrom" (only when scope?.kind === "collection")', () => {
    const items = menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' }, 'darwin');
    expect(items.map((i) => i.id)).toContain('removefrom');
  });

  it('every non-collection scope omits "removefrom", including undefined ("All Samples")', () => {
    expect(menuItemsFor(baseRow, undefined, 'darwin').map((i) => i.id)).not.toContain('removefrom');
    expect(menuItemsFor(baseRow, { kind: 'favorites' }, 'darwin').map((i) => i.id)).not.toContain(
      'removefrom',
    );
    expect(
      menuItemsFor(baseRow, { kind: 'pack', packId: 1 }, 'darwin').map((i) => i.id),
    ).not.toContain('removefrom');
  });

  it('a missing row gets only a disabled reveal and an enabled copy-path, in every scope', () => {
    const expected = [
      { id: 'reveal', label: 'Show in Finder', disabled: true },
      { id: 'copypath', label: 'Copy full path' },
    ];
    expect(menuItemsFor({ ...baseRow, missing: true }, undefined, 'darwin')).toEqual(expected);
    expect(
      menuItemsFor(
        { ...baseRow, missing: true },
        { kind: 'collection', collectionId: 'c1' },
        'darwin',
      ),
    ).toEqual(expected);
  });

  it('names the reveal item after the platform file manager', () => {
    const revealLabel = (platform: string) =>
      menuItemsFor(baseRow, undefined, platform).find((i) => i.id === 'reveal')?.label;
    expect(revealLabel('darwin')).toBe('Show in Finder');
    expect(revealLabel('win32')).toBe('Show in Explorer');
    expect(revealLabel('linux')).toBe('Show in file manager');
    expect(revealLabel('freebsd')).toBe('Show in file manager');
  });

  it('pins the full item set/order outside a collection scope (user layer, then reveal/copypath)', () => {
    expect(menuItemsFor(baseRow, undefined, 'darwin')).toEqual([
      { id: 'favorite', label: 'Favorite' },
      { id: 'nickname', label: 'Nickname…' },
      { id: 'tags', label: 'Tags…' },
      { id: 'addto', label: 'Add to collection…' },
      { id: 'reveal', label: 'Show in Finder' },
      { id: 'copypath', label: 'Copy full path' },
    ]);
  });

  it('pins the full item set/order under a collection scope (removefrom before reveal/copypath)', () => {
    expect(menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' }, 'darwin')).toEqual([
      { id: 'favorite', label: 'Favorite' },
      { id: 'nickname', label: 'Nickname…' },
      { id: 'tags', label: 'Tags…' },
      { id: 'addto', label: 'Add to collection…' },
      { id: 'removefrom', label: 'Remove from this collection' },
      { id: 'reveal', label: 'Show in Finder' },
      { id: 'copypath', label: 'Copy full path' },
    ]);
  });
});
