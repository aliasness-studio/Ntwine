// LIBRARY rail section (Task 8 brief / design spec §5.1): sits above PACKS in the same
// PacksScroll — All Samples (moved in from PackRail, Task 13), Favorites, one row per
// `userLayer.collections`, and a "+ New collection" affordance. Deliberately mirrors PackRail's
// listbox idiom exactly (role="listbox"/"option", aria-selected, styled-components, Name/Count
// as the first/last <span> per option) so both rails read as one visual system and the e2e
// nameSpan/countSpan helpers (browse.spec.ts) work unmodified against this listbox too.
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { consumeDragSource, peekDragSource, type DragSource } from '../dragSource';
import { useStores } from './StoreContext';

const RailSection = styled.div`
  display: flex;
  flex-direction: column;
  padding: 8px 0;
`;

const SectionLabel = styled.div`
  padding: 0 10px 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${(p) => p.theme.color.textFaint};
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  padding: 0 8px;
  gap: 2px;
`;

// `$dragOver` (Task 13 / spec §7): "the hovered collection row highlights" — an inset box-shadow
// rather than an `outline` so the highlight follows the button's own `border-radius` (outline
// doesn't, in most browsers) and layers legibly over `$active`'s background tint when a row is
// BOTH the current scope AND a live drop target at once.
const Item = styled.button<{ $active: boolean; $dragOver: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : 'transparent')};
  color: ${(p) => p.theme.color.text};
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  width: 100%;
  box-shadow: ${(p) => (p.$dragOver ? `inset 0 0 0 2px ${p.theme.color.accent}` : 'none')};

  &:hover {
    background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : p.theme.color.bgRowHover)};
  }
`;

// Matches PackRail's `CoverSize` literal so a Library row's Name column lines up exactly with a
// Packs row's Name column directly beneath it in the same scroller — every option gets one of
// these (blank for All Samples/collections, the heart glyph for Favorites) rather than only some
// rows having a leading element, which would stagger the Name text at different x-offsets.
const IconSize = '28px';

const IconSlot = styled.div`
  width: ${IconSize};
  height: ${IconSize};
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${(p) => p.theme.color.accent};
`;

const Name = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Count = styled.span`
  color: ${(p) => p.theme.color.textFaint};
  font-size: 11px;
  flex-shrink: 0;
`;

// Anchors the tiny context menu / delete confirm to the collection row they belong to, without
// nesting a `<button>` inside `Item` (itself a `<button>`) — invalid HTML that browsers silently
// hoist out of the outer button, corrupting the layout. `MenuBox` below is a sibling of `Item`,
// not a child.
const CollectionWrap = styled.div`
  position: relative;
`;

const MenuBox = styled.div`
  position: absolute;
  top: 100%;
  right: 4px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  min-width: 120px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.borderStrong};
  background: ${(p) => p.theme.color.bgPanel};
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
`;

const MenuButton = styled.button`
  padding: 5px 8px;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: transparent;
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
  }
`;

const ConfirmText = styled.div`
  padding: 4px 8px 2px;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
`;

const ConfirmRow = styled.div`
  display: flex;
  gap: 4px;
`;

const TextInput = styled.input`
  flex: 1;
  min-width: 0;
  padding: 5px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.accent};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
`;

const EditRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
`;

const EditInputRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const AlertText = styled.span`
  padding-left: calc(${IconSize} + 8px);
  font-size: 11px;
  color: ${(p) => p.theme.color.danger};
`;

const NewCollectionButton = styled.button`
  margin: 2px 8px 0;
  padding: 6px 8px;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: transparent;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

// Same inline-SVG reasoning as App.tsx's GearIcon/ChevronIcon: a system-font heart dingbat
// renders inconsistently across platforms, so the Favorites row's glyph (spec §5.1) is a small
// filled path instead — the standard "favorite" heart shape, `currentColor` so it inherits
// `IconSlot`'s accent color for free.
function HeartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

interface Collection {
  id: string;
  name: string;
  count: number;
}

// Discriminates the ONE tiny popup this rail can show at a time (the collection-local context
// menu, or its delete confirm) — never both, and never for more than one collection at once, so a
// single piece of state is enough (no per-row open flags to keep in sync).
type RailMenu =
  | { kind: 'closed' }
  | { kind: 'menu'; collectionId: string }
  | { kind: 'confirmDelete'; collectionId: string };

export const LibraryRail = observer(function LibraryRail() {
  const { library, userLayer } = useStores();
  const scope = library.filters.scope;

  const [menu, setMenu] = useState<RailMenu>({ kind: 'closed' });
  const closeMenu = (): void => setMenu({ kind: 'closed' });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  // Task 13 / spec §7: which drop target (if any) is currently drag-hovered — 'favorites' or
  // `collection:${id}`, the SAME identifier string threaded through the dev probe below, so hover
  // state and the debug payload's `targetId` are always one computed value, not two independently
  // -maintained identities for the same target.
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // Gates the `dragover` dev-probe line to the FIRST over event per hover session — `dragover`
  // fires continuously while the pointer sits still over a target, and logging every one of those
  // would flood devtools during the morning hands-on this probe exists for (spec §7's feasibility
  // note). Reset whenever hover (re)starts on a target via `dragenter`.
  const loggedOverRef = useRef<string | null>(null);

  // A native OS drag session (`webContents.startDrag`) can end without ever delivering a `drop`
  // or `dragleave` back to this window — e.g. the app loses focus mid-drag. Window `blur` is the
  // backstop that guarantees hover styling never gets stuck highlighted (spec §7: "Hover styling
  // clears on drop, dragleave, window blur, and slot clear, independently of any data write").
  useEffect(() => {
    const onBlur = (): void => setDragOverId(null);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // Dev probe (Codex consult B, spec §7): a `console.debug` breadcrumb so the morning hands-on can
  // see in devtools whether Electron even delivers DOM drag events over a native `startDrag`
  // session (Ruling R1 — unproven as of this session). Reads `peekDragSource()` rather than taking
  // a sample id parameter: every call site below is already inside a slot-gated handler, so this
  // reports the SAME value the gate itself just checked, not a second copy of it.
  const debugDrag = (phase: 'enter' | 'over' | 'drop', targetId: string): void => {
    console.debug('[ntwine:drag-in]', phase, {
      slot: peekDragSource()?.sampleId ?? null,
      targetId,
    });
  };

  // Discrimination rule (spec §7): an empty slot means every file drop is ignored, and not merely
  // `onDrop` — `dragenter`/`dragover` handling, the hover highlight, and `preventDefault()` are
  // ALL gated on a non-empty slot together, so an external Finder/Explorer drag over the rail
  // never shows a copy cursor or leaves a stuck hover state. `e.dataTransfer &&` guards the
  // `dropEffect` write because a synthetically-dispatched drag event (Playwright's
  // `dispatchEvent`, Task 15's synthetic seam) carries no real `DataTransfer` at runtime, unlike
  // what the DOM lib's `DragEvent` typing promises.
  const handleDragEnter =
    (targetId: string) =>
    (e: DragEvent<HTMLButtonElement>): void => {
      if (peekDragSource() === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      loggedOverRef.current = null;
      debugDrag('enter', targetId);
      setDragOverId(targetId);
    };

  const handleDragOver =
    (targetId: string) =>
    (e: DragEvent<HTMLButtonElement>): void => {
      if (peekDragSource() === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (loggedOverRef.current !== targetId) {
        loggedOverRef.current = targetId;
        debugDrag('over', targetId);
      }
      setDragOverId(targetId);
    };

  // Only clears hover if THIS target is the one currently hovered — `dragenter` on a newly
  // entered target can fire before `dragleave` on the one just left (event order across elements
  // isn't guaranteed), so an unconditional clear here could wipe out a hover the new target's own
  // `dragenter` just set.
  const handleDragLeave = (targetId: string) => (): void => {
    setDragOverId((current) => (current === targetId ? null : current));
    if (loggedOverRef.current === targetId) loggedOverRef.current = null;
  };

  // `onDrop` consumes the slot FIRST (spec §7's own ordering). An empty result — the slot was
  // already claimed (a fast second drag, or a drop that raced a late `finally`) — clears hover and
  // bails before `preventDefault`, rather than this handler pretending a drop it can't identify
  // was ours. Hover clears unconditionally, independent of whether the write actually happens
  // (spec §7), so a drop that turns out empty never leaves the target looking armed.
  const handleDrop =
    (targetId: string, apply: (src: DragSource) => void) =>
    (e: DragEvent<HTMLButtonElement>): void => {
      const src = consumeDragSource();
      setDragOverId(null);
      loggedOverRef.current = null;
      if (!src) return;
      e.preventDefault();
      debugDrag('drop', targetId);
      apply(src);
    };

  // `scope === undefined` is the "All Samples" state — `Scope` (ipcTypes.ts) has no explicit
  // 'all' variant; absence IS all (PackRail's own comment, unchanged reasoning — this row is the
  // one that moved here).
  const allSamplesActive = scope === undefined;
  const favoritesActive = scope?.kind === 'favorites';
  // The exact expression PackRail deletes (Task 8 brief Step 3b): `userLayer`/`listLibraryRail`
  // carries no total, so this row keeps the same PRESENT-only sum PackRail's old All Samples row
  // read from `library.packs` — not `userLayer.favoritesCount`-style rail data.
  const totalPresentSamples = library.packs.reduce((s, p) => s + p.sampleCount, 0);

  const startCreate = (): void => {
    closeMenu();
    setCreating(true);
    setNewName('');
    setNewError(null);
  };
  const cancelCreate = (): void => {
    setCreating(false);
    setNewName('');
    setNewError(null);
  };
  const submitCreate = async (): Promise<void> => {
    const result = await userLayer.createCollection(newName);
    if ('error' in result) {
      setNewError(result.error);
      return;
    }
    setCreating(false);
    setNewName('');
    setNewError(null);
  };
  const handleNewCollectionKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void submitCreate();
    else if (e.key === 'Escape') cancelCreate();
  };

  const startRename = (c: Collection): void => {
    closeMenu();
    setRenamingId(c.id);
    setRenameValue(c.name);
    setRenameError(null);
  };
  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameValue('');
    setRenameError(null);
  };
  const submitRename = async (id: string): Promise<void> => {
    const result = await userLayer.renameCollection(id, renameValue);
    if (result !== null) {
      setRenameError(result.error);
      return;
    }
    setRenamingId(null);
    setRenameValue('');
    setRenameError(null);
  };
  const confirmDelete = async (id: string): Promise<void> => {
    closeMenu();
    await userLayer.deleteCollection(id);
  };

  return (
    <RailSection>
      <SectionLabel>Library</SectionLabel>
      <List role="listbox" aria-label="Library">
        <Item
          type="button"
          role="option"
          aria-selected={allSamplesActive}
          $active={allSamplesActive}
          $dragOver={false}
          onClick={() => {
            closeMenu();
            library.setScope(null);
          }}
        >
          <IconSlot aria-hidden="true" />
          <Name>All Samples</Name>
          <Count>{totalPresentSamples}</Count>
        </Item>
        <Item
          type="button"
          role="option"
          aria-selected={favoritesActive}
          $active={favoritesActive}
          $dragOver={dragOverId === 'favorites'}
          onClick={() => {
            closeMenu();
            library.setScope({ kind: 'favorites' });
          }}
          onDragEnter={handleDragEnter('favorites')}
          onDragOver={handleDragOver('favorites')}
          onDragLeave={handleDragLeave('favorites')}
          onDrop={handleDrop('favorites', (src) => {
            void userLayer.setFavorite(src.sampleId, true);
          })}
        >
          <IconSlot aria-hidden="true">
            <HeartIcon />
          </IconSlot>
          <Name>Favorites</Name>
          <Count>{userLayer.favoritesCount}</Count>
        </Item>
        {userLayer.collections.map((c) => {
          const isActive = scope?.kind === 'collection' && scope.collectionId === c.id;

          if (renamingId === c.id) {
            return (
              <EditRow key={c.id}>
                <EditInputRow>
                  <IconSlot aria-hidden="true" />
                  <TextInput
                    aria-label="Rename collection name"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => {
                      setRenameValue(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitRename(c.id);
                      else if (e.key === 'Escape') cancelRename();
                    }}
                  />
                </EditInputRow>
                {renameError !== null && <AlertText role="alert">{renameError}</AlertText>}
              </EditRow>
            );
          }

          return (
            <CollectionWrap key={c.id}>
              <Item
                type="button"
                role="option"
                aria-selected={isActive}
                $active={isActive}
                $dragOver={dragOverId === `collection:${c.id}`}
                onClick={() => {
                  closeMenu();
                  library.setScope({ kind: 'collection', collectionId: c.id });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ kind: 'menu', collectionId: c.id });
                }}
                onDragEnter={handleDragEnter(`collection:${c.id}`)}
                onDragOver={handleDragOver(`collection:${c.id}`)}
                onDragLeave={handleDragLeave(`collection:${c.id}`)}
                onDrop={handleDrop(`collection:${c.id}`, (src) => {
                  void userLayer.addToCollection(c.id, src.sampleId);
                })}
              >
                <IconSlot aria-hidden="true" />
                <Name title={c.name}>{c.name}</Name>
                <Count>{c.count}</Count>
              </Item>
              {/* Collection-local context menu (design spec §5.1): Rename…/Delete… only — the
                  full row context menu (favorite/tags/add-to-collection) is Task 10, not this
                  rail. Dismissed only by choosing an action here, not by Esc/click-outside — a
                  deliberate simplification for this stopgap two-button box; Task 10's real menu
                  should get the full outside-click/Esc treatment when it lands. */}
              {menu.kind === 'menu' && menu.collectionId === c.id && (
                <MenuBox>
                  <MenuButton type="button" onClick={() => startRename(c)}>
                    Rename…
                  </MenuButton>
                  <MenuButton
                    type="button"
                    onClick={() => setMenu({ kind: 'confirmDelete', collectionId: c.id })}
                  >
                    Delete…
                  </MenuButton>
                </MenuBox>
              )}
              {menu.kind === 'confirmDelete' && menu.collectionId === c.id && (
                <MenuBox>
                  <ConfirmText>Delete &ldquo;{c.name}&rdquo;? Samples stay in your library.</ConfirmText>
                  <ConfirmRow>
                    <MenuButton type="button" onClick={() => void confirmDelete(c.id)}>
                      Delete
                    </MenuButton>
                    <MenuButton type="button" onClick={closeMenu}>
                      Cancel
                    </MenuButton>
                  </ConfirmRow>
                </MenuBox>
              )}
            </CollectionWrap>
          );
        })}
      </List>
      {creating ? (
        <EditRow>
          <EditInputRow>
            <IconSlot aria-hidden="true" />
            <TextInput
              aria-label="New collection name"
              autoFocus
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setNewError(null);
              }}
              onKeyDown={handleNewCollectionKeyDown}
            />
          </EditInputRow>
          {newError !== null && <AlertText role="alert">{newError}</AlertText>}
        </EditRow>
      ) : (
        <NewCollectionButton type="button" onClick={startCreate}>
          + New collection
        </NewCollectionButton>
      )}
    </RailSection>
  );
});
