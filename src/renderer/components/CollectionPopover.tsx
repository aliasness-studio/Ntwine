// CollectionPopover (Task 11 brief / design spec §5.3): the add-to-collection popover for one
// row, opened via the row context menu's "Add to collection…" action
// (`UserLayerStore.openCollectionPopover`). Same anchoring/store-reading posture as
// `TagsPopover.tsx` — see that file's own doc comment for the reasoning shared by both.
//
// Type-ahead resolution (design spec §2.3's promise, restated in the brief): "an existing name
// always resolves before any create fires." Concretely, `exactMatch` (a collection whose
// `normalizeUserName(name)` equals the normalized input) ALWAYS wins on Enter, regardless of
// which Enter variant was pressed — plain Enter adds to it, and Cmd/Ctrl+Enter also adds to it
// rather than attempting a create that `createCollection` would just reject as a collision.
// Cmd/Ctrl+Enter only reaches `createCollection` when no exact match exists. Absent an exact
// match, plain Enter targets the first prefix-filtered suggestion (ordinary type-ahead: narrow as
// you type, Enter commits the top result) — `userLayer.collections` already arrives A-Z (spec
// §4), so "first" is a stable, deterministic choice, not an arbitrary one.
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { normalizeUserName } from '../../shared/userNames';
import { useStores } from './StoreContext';

const Box = styled.div<{ $top: number }>`
  position: absolute;
  top: ${(p) => p.$top}px;
  left: 12px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  width: 220px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.borderStrong};
  background: ${(p) => p.theme.color.bgPanel};
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
`;

const Input = styled.input`
  padding: 5px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.accent};
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  max-height: 140px;
  overflow-y: auto;
`;

const ListItem = styled.button<{ $highlighted: boolean }>`
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 6px;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: ${(p) => (p.$highlighted ? p.theme.color.bgRowSelected : 'transparent')};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
  }
`;

const Hint = styled.div`
  font-size: 10px;
  color: ${(p) => p.theme.color.textFaint};
`;

// Same pattern as LibraryRail's create/rename editors (design spec §2.3's inline collision
// surface).
const AlertText = styled.span`
  font-size: 11px;
  color: ${(p) => p.theme.color.danger};
`;

export interface CollectionPopoverProps {
  sampleId: number;
  top: number;
  onClose: () => void;
}

export const CollectionPopover = observer(function CollectionPopover({
  sampleId,
  top,
  onClose,
}: CollectionPopoverProps) {
  const { userLayer } = useStores();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Esc / click-away — RowContextMenu's own listener pattern; see TagsPopover.tsx's identical
  // effect for the capture-phase-ordering reasoning.
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  // Empty input browses the full (A-Z) list rather than showing nothing — collections are a
  // small, curated set already always-visible in the rail, unlike the tag vocabulary
  // TagsPopover deliberately keeps hidden until typed.
  const normalizedValue = normalizeUserName(value);
  const filtered =
    normalizedValue === ''
      ? userLayer.collections
      : userLayer.collections.filter((c) => normalizeUserName(c.name).startsWith(normalizedValue));
  const exactMatch = userLayer.collections.find((c) => normalizeUserName(c.name) === normalizedValue);
  const highlighted = exactMatch ?? filtered[0];

  const addExisting = (collectionId: string): void => {
    void userLayer.addToCollection(collectionId, sampleId);
    setValue('');
    setError(null);
  };

  const createAndAdd = async (): Promise<void> => {
    const result = await userLayer.createCollection(value);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    void userLayer.addToCollection(result.id, sampleId);
    setValue('');
    setError(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    if (exactMatch) {
      addExisting(exactMatch.id);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      void createAndAdd();
      return;
    }
    if (highlighted) addExisting(highlighted.id);
  };

  return (
    <Box ref={boxRef} $top={top}>
      <Input
        aria-label="Add to collection"
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {error !== null && <AlertText role="alert">{error}</AlertText>}
      {normalizedValue !== '' && !exactMatch && (
        <Hint>Cmd/Ctrl+Enter to create &ldquo;{value.trim()}&rdquo;</Hint>
      )}
      <List>
        {filtered.map((c) => (
          <ListItem
            key={c.id}
            type="button"
            $highlighted={highlighted?.id === c.id}
            onClick={() => addExisting(c.id)}
          >
            <span>{c.name}</span>
            <span>{c.count}</span>
          </ListItem>
        ))}
      </List>
    </Box>
  );
});
