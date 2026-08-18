// keymap.test.ts (Task 12 brief, Step 1): every table row of `listKeyAction` (design spec §5.4),
// INCLUDING the no-selection no-ops and the non-collection Delete/Backspace -> null gate — red
// before keymap.ts existed. `landingIdAfterRemoval`'s suite below is the §3.1 selection-follow
// next-row rule's pure arithmetic, factored out of SampleList's `withSelectionFollow` specifically
// so it has a real unit test (this repo has no component-mounting test infra — vitest.config.ts
// only globs `src/**/*.test.ts`, and there is no `@testing-library/react` dependency — so a
// closure over live MobX stores can only be exercised end-to-end, Task 13's milestone; the pure
// index math underneath it can and should be pinned now). Covers the task's named landing-math
// cases by name: remove middle -> next; remove last -> previous; remove sole -> cleared.
import { describe, expect, it } from 'vitest';
import { landingIdAfterRemoval, listKeyAction, type ListKeyContext } from './keymap';

const selected: ListKeyContext = { hasSelection: true, scopeKind: undefined };
const noSelection: ListKeyContext = { hasSelection: false, scopeKind: undefined };

describe('listKeyAction', () => {
  describe('F — toggle favorite', () => {
    it('lowercase f with a selection resolves to toggleFavorite', () => {
      expect(listKeyAction({ key: 'f' }, selected)).toBe('toggleFavorite');
    });

    it('uppercase F (Shift+F) also resolves to toggleFavorite', () => {
      expect(listKeyAction({ key: 'F' }, selected)).toBe('toggleFavorite');
    });

    it('fires in EVERY scope — the Favorites-only selection-follow is SampleList’s wrap, not this gate', () => {
      expect(listKeyAction({ key: 'f' }, { hasSelection: true, scopeKind: 'favorites' })).toBe(
        'toggleFavorite',
      );
      expect(listKeyAction({ key: 'f' }, { hasSelection: true, scopeKind: 'collection' })).toBe(
        'toggleFavorite',
      );
      expect(listKeyAction({ key: 'f' }, { hasSelection: true, scopeKind: 'pack' })).toBe(
        'toggleFavorite',
      );
    });

    it('is a no-op without a selection (spec §5.4: every single-key action no-ops on empty selection)', () => {
      expect(listKeyAction({ key: 'f' }, noSelection)).toBeNull();
    });
  });

  describe('T — tags popover', () => {
    it('lower/upper T with a selection resolves to openTags', () => {
      expect(listKeyAction({ key: 't' }, selected)).toBe('openTags');
      expect(listKeyAction({ key: 'T' }, selected)).toBe('openTags');
    });

    it('is a no-op without a selection', () => {
      expect(listKeyAction({ key: 't' }, noSelection)).toBeNull();
    });
  });

  describe('C — add-to-collection popover', () => {
    it('lower/upper C with a selection resolves to openCollection', () => {
      expect(listKeyAction({ key: 'c' }, selected)).toBe('openCollection');
      expect(listKeyAction({ key: 'C' }, selected)).toBe('openCollection');
    });

    it('is a no-op without a selection', () => {
      expect(listKeyAction({ key: 'c' }, noSelection)).toBeNull();
    });
  });

  describe('N — nickname inline edit', () => {
    it('lower/upper N with a selection resolves to editNickname', () => {
      expect(listKeyAction({ key: 'n' }, selected)).toBe('editNickname');
      expect(listKeyAction({ key: 'N' }, selected)).toBe('editNickname');
    });

    it('is a no-op without a selection', () => {
      expect(listKeyAction({ key: 'n' }, noSelection)).toBeNull();
    });
  });

  describe('Delete/Backspace — collection-scope-only removal', () => {
    it('Delete under a collection scope resolves to removeFromCollection', () => {
      expect(
        listKeyAction({ key: 'Delete' }, { hasSelection: true, scopeKind: 'collection' }),
      ).toBe('removeFromCollection');
    });

    it('Backspace under a collection scope ALSO resolves to removeFromCollection', () => {
      expect(
        listKeyAction({ key: 'Backspace' }, { hasSelection: true, scopeKind: 'collection' }),
      ).toBe('removeFromCollection');
    });

    it('is a no-op under every non-collection scope, including All Samples (scopeKind undefined)', () => {
      expect(
        listKeyAction({ key: 'Delete' }, { hasSelection: true, scopeKind: undefined }),
      ).toBeNull();
      expect(
        listKeyAction({ key: 'Delete' }, { hasSelection: true, scopeKind: 'favorites' }),
      ).toBeNull();
      expect(
        listKeyAction({ key: 'Delete' }, { hasSelection: true, scopeKind: 'pack' }),
      ).toBeNull();
    });

    it('Backspace is ALSO a no-op under every non-collection scope', () => {
      expect(
        listKeyAction({ key: 'Backspace' }, { hasSelection: true, scopeKind: undefined }),
      ).toBeNull();
      expect(
        listKeyAction({ key: 'Backspace' }, { hasSelection: true, scopeKind: 'favorites' }),
      ).toBeNull();
    });

    it('is a no-op without a selection, even under a collection scope', () => {
      expect(
        listKeyAction({ key: 'Delete' }, { hasSelection: false, scopeKind: 'collection' }),
      ).toBeNull();
    });
  });

  describe('modifier combos defer to window-level bindings (Cmd/Ctrl+F)', () => {
    it('Cmd+F does not resolve to toggleFavorite — App.tsx owns that combo at window level', () => {
      expect(listKeyAction({ key: 'f', metaKey: true }, selected)).toBeNull();
    });

    it('Ctrl+F does not resolve to toggleFavorite either (Windows/Linux modifier)', () => {
      expect(listKeyAction({ key: 'f', ctrlKey: true }, selected)).toBeNull();
    });

    it('a held modifier guards every list key, not just F — prevents any double-dispatch alongside a window-level binding', () => {
      expect(listKeyAction({ key: 't', metaKey: true }, selected)).toBeNull();
      expect(
        listKeyAction(
          { key: 'Delete', metaKey: true },
          { hasSelection: true, scopeKind: 'collection' },
        ),
      ).toBeNull();
    });
  });

  describe('unrecognized keys', () => {
    it('an unrelated key is a no-op', () => {
      expect(listKeyAction({ key: 'a' }, selected)).toBeNull();
    });

    it('the arrow/space keys SampleList already owns directly are no-ops here too (no double-dispatch)', () => {
      expect(listKeyAction({ key: 'ArrowDown' }, selected)).toBeNull();
      expect(listKeyAction({ key: 'ArrowUp' }, selected)).toBeNull();
      expect(listKeyAction({ key: 'ArrowLeft' }, selected)).toBeNull();
      expect(listKeyAction({ key: ' ' }, selected)).toBeNull();
    });
  });
});

describe('landingIdAfterRemoval — §3.1 selection-follow next-row rule', () => {
  it('remove a MIDDLE row -> selection lands on the row that shifted into its place ("next")', () => {
    // rows [10, 20, 30]; 20 (index 1) is the one the write removes.
    expect(landingIdAfterRemoval(1, [10, 30])).toBe(30);
  });

  it('remove the LAST row -> selection lands on the new last row ("previous")', () => {
    // rows [10, 20, 30]; 30 (index 2) is the one the write removes.
    expect(landingIdAfterRemoval(2, [10, 20])).toBe(20);
  });

  it('remove the SOLE remaining row -> null (caller clears selection instead of selecting)', () => {
    expect(landingIdAfterRemoval(0, [])).toBeNull();
  });

  it('remove the FIRST row of a 3+ row list -> lands on what shifted into index 0', () => {
    // rows [10, 20, 30]; 10 (index 0) is the one the write removes.
    expect(landingIdAfterRemoval(0, [20, 30])).toBe(20);
  });

  it('a `before` of -1 (selection was not found pre-write) clamps to the first remaining row', () => {
    expect(landingIdAfterRemoval(-1, [20, 30, 40])).toBe(20);
  });

  it('a `before` past the end of a shrunken list clamps to the new last row', () => {
    expect(landingIdAfterRemoval(5, [10, 20])).toBe(20);
  });

  it('a write that removes nothing (after.length unchanged) lands back on the same index', () => {
    expect(landingIdAfterRemoval(1, [10, 20, 30])).toBe(20);
  });
});
