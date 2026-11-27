import { describe, expect, it } from 'vitest';
import type { SampleRow } from '../shared/ipcTypes';
import {
  menuItemsFor,
  submenuPlacement,
  SYSTEM_SUBMENU_LABEL,
  type RowMenuEntry,
  type RowMenuItem,
} from './rowMenu';

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

/** Every action item, top-level and submenu children alike, in menu order. */
function actions(entries: RowMenuEntry[]): RowMenuItem[] {
  return entries.flatMap((e) => (e.kind === 'item' ? [e] : e.kind === 'submenu' ? e.items : []));
}

describe('menuItemsFor', () => {
  it('a non-favorited row gets a "Favorite" item (label flip)', () => {
    const items = actions(menuItemsFor(baseRow, undefined, 'darwin'));
    expect(items.find((i) => i.id === 'favorite')).toEqual({
      kind: 'item',
      id: 'favorite',
      label: 'Favorite',
    });
  });

  it('a favorited row gets an "Unfavorite" item — same id, flipped label', () => {
    const items = actions(menuItemsFor({ ...baseRow, favorite: true }, undefined, 'darwin'));
    expect(items.find((i) => i.id === 'favorite')).toEqual({
      kind: 'item',
      id: 'favorite',
      label: 'Unfavorite',
    });
  });

  it('a collection scope adds "removefrom" (only when scope?.kind === "collection")', () => {
    const items = actions(
      menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' }, 'darwin'),
    );
    expect(items.map((i) => i.id)).toContain('removefrom');
  });

  it('every non-collection scope omits "removefrom", including undefined ("All Samples")', () => {
    const ids = (scope: Parameters<typeof menuItemsFor>[1]) =>
      actions(menuItemsFor(baseRow, scope, 'darwin')).map((i) => i.id);
    expect(ids(undefined)).not.toContain('removefrom');
    expect(ids({ kind: 'favorites' })).not.toContain('removefrom');
    expect(ids({ kind: 'pack', packId: 1 })).not.toContain('removefrom');
  });

  it('a missing row gets only a flat disabled reveal and an enabled copy-path, in every scope', () => {
    const expected: RowMenuEntry[] = [
      { kind: 'item', id: 'reveal', label: 'Show in Finder', disabled: true },
      { kind: 'item', id: 'copypath', label: 'Copy full path' },
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

  it('names the reveal item inside the System submenu after the platform file manager', () => {
    const revealLabel = (platform: string) => {
      const system = menuItemsFor(baseRow, undefined, platform).find(
        (e) => e.kind === 'submenu' && e.label === SYSTEM_SUBMENU_LABEL,
      );
      return system?.kind === 'submenu'
        ? system.items.find((i) => i.id === 'reveal')?.label
        : undefined;
    };
    expect(revealLabel('darwin')).toBe('Show in Finder');
    expect(revealLabel('win32')).toBe('Show in Explorer');
    expect(revealLabel('linux')).toBe('Show in file manager');
    expect(revealLabel('freebsd')).toBe('Show in file manager');
  });

  it('pins the full layout outside a collection scope (user layer, separator, System submenu)', () => {
    expect(menuItemsFor(baseRow, undefined, 'darwin')).toEqual([
      { kind: 'item', id: 'favorite', label: 'Favorite' },
      { kind: 'item', id: 'nickname', label: 'Nickname…' },
      { kind: 'item', id: 'tags', label: 'Tags…' },
      { kind: 'item', id: 'addto', label: 'Add to collection…' },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: SYSTEM_SUBMENU_LABEL,
        items: [
          { kind: 'item', id: 'reveal', label: 'Show in Finder' },
          { kind: 'item', id: 'copypath', label: 'Copy full path' },
        ],
      },
    ]);
  });

  it('pins the full layout under a collection scope (removefrom before the separator)', () => {
    expect(menuItemsFor(baseRow, { kind: 'collection', collectionId: 'c1' }, 'win32')).toEqual([
      { kind: 'item', id: 'favorite', label: 'Favorite' },
      { kind: 'item', id: 'nickname', label: 'Nickname…' },
      { kind: 'item', id: 'tags', label: 'Tags…' },
      { kind: 'item', id: 'addto', label: 'Add to collection…' },
      { kind: 'item', id: 'removefrom', label: 'Remove from this collection' },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: SYSTEM_SUBMENU_LABEL,
        items: [
          { kind: 'item', id: 'reveal', label: 'Show in Explorer' },
          { kind: 'item', id: 'copypath', label: 'Copy full path' },
        ],
      },
    ]);
  });
});

describe('submenuPlacement', () => {
  const size = { width: 200, height: 66 };
  const viewport = { width: 1000, height: 600 };

  it('opens to the right at the desired top when it fits', () => {
    expect(submenuPlacement({ right: 400, top: 100 }, size, viewport)).toEqual({
      side: 'right',
      top: 100,
    });
  });

  it('still opens right when it exactly meets the right edge', () => {
    expect(submenuPlacement({ right: 800, top: 100 }, size, viewport).side).toBe('right');
  });

  it('flips to the left when the right side would overflow the window', () => {
    expect(submenuPlacement({ right: 801, top: 100 }, size, viewport).side).toBe('left');
  });

  it('moves up so its bottom stays inside the window', () => {
    expect(submenuPlacement({ right: 400, top: 570 }, size, viewport).top).toBe(534);
  });

  it('never moves above the top of the window', () => {
    const short = { width: 1000, height: 40 };
    expect(submenuPlacement({ right: 400, top: 50 }, size, short).top).toBe(0);
    expect(submenuPlacement({ right: 400, top: -3 }, size, viewport).top).toBe(0);
  });
});
