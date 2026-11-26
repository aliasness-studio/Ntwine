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
    const items = menuItemsFor(baseRow, undefined);
    expect(items.find((i) => i.id === 'favorite')).toEqual({ id: 'favorite', label: 'Favorite' });
  });

  it('a favorited row gets an "Unfavorite" item — same id, flipped label', () => {
    const items = menuItemsFor({ ...baseRow, favorite: true }, undefined);
    expect(items.find((i) => i.id === 'favorite')).toEqual({
      id: 'favorite',
      label: 'Unfavorite',
    });
  });

  it('a collection scope adds "removefrom" (only when scope?.kind === "collection")', () => {
    const items = menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' });
    expect(items.map((i) => i.id)).toContain('removefrom');
  });

  it('every non-collection scope omits "removefrom", including undefined ("All Samples")', () => {
    expect(menuItemsFor(baseRow, undefined).map((i) => i.id)).not.toContain('removefrom');
    expect(menuItemsFor(baseRow, { kind: 'favorites' }).map((i) => i.id)).not.toContain(
      'removefrom',
    );
    expect(
      menuItemsFor(baseRow, { kind: 'pack', packId: 1 }).map((i) => i.id),
    ).not.toContain('removefrom');
  });

  it('a missing row gets no menu at all, in every scope (missing rows are read-only)', () => {
    expect(menuItemsFor({ ...baseRow, missing: true }, undefined)).toEqual([]);
    expect(
      menuItemsFor({ ...baseRow, missing: true }, { kind: 'collection', collectionId: 'c1' }),
    ).toEqual([]);
  });

  it('pins the full item set/order outside a collection scope (favorite/nickname/tags/addto)', () => {
    expect(menuItemsFor(baseRow, undefined)).toEqual([
      { id: 'favorite', label: 'Favorite' },
      { id: 'nickname', label: 'Nickname…' },
      { id: 'tags', label: 'Tags…' },
      { id: 'addto', label: 'Add to collection…' },
    ]);
  });

  it('pins the full item set/order under a collection scope (removefrom appended last)', () => {
    expect(menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' })).toEqual([
      { id: 'favorite', label: 'Favorite' },
      { id: 'nickname', label: 'Nickname…' },
      { id: 'tags', label: 'Tags…' },
      { id: 'addto', label: 'Add to collection…' },
      { id: 'removefrom', label: 'Remove from this collection' },
    ]);
  });
});
