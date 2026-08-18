// TagsPopover (Task 11 brief / design spec §5.3): the in-app tags editor for one row, opened via
// the row context menu's "Tags…" action (`UserLayerStore.openTagsPopover`). `SampleList` anchors
// it at the target row's own virtual position (the `top` prop, TanStack Virtual coordinates) as a
// sibling of the rows inside the SAME `Inner` container `SampleRow` renders into, so it scrolls
// in lockstep with the row it belongs to — the exact coordinate space `SampleRow`'s own
// `transform: translateY(top)` already uses.
//
// Unlike `SampleRow`/`RowContextMenu`'s "no store reads" posture (pure list-rendering
// components), this is an `observer` that reads `userLayer` directly — the same shape
// `LibraryRail`'s own rename/create editors already take for a store-backed editing surface with
// a live-updating list and several direct write actions.
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import type { SampleRow } from '../../shared/ipcTypes';
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
  width: 240px;
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

const Suggestions = styled.div`
  display: flex;
  flex-direction: column;
  max-height: 120px;
  overflow-y: auto;
`;

const SuggestionButton = styled.button`
  padding: 4px 6px;
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

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`;

const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: ${(p) => p.theme.radius.pill};
  font-size: 11px;
`;

// Accent-outlined, matching the row's own `UserChip` idiom (SampleRow.tsx) — removable via the
// trailing ✕ button.
const UserTagChip = styled(Chip)`
  background: transparent;
  border: 1px solid ${(p) => p.theme.color.accent};
  color: ${(p) => p.theme.color.accentStrong};
`;

// Splice tags are read-only here (brief: "splice tags read-only muted, no ✕") — muted fill/text,
// no remove affordance at all, so there's nothing to mistake for an interactive chip.
const SpliceTagChip = styled(Chip)`
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.textFaint};
`;

const RemoveButton = styled.button`
  border: none;
  background: transparent;
  color: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
`;

export interface TagsPopoverProps {
  row: SampleRow;
  top: number;
  onClose: () => void;
}

export const TagsPopover = observer(function TagsPopover({ row, top, onClose }: TagsPopoverProps) {
  const { userLayer } = useStores();
  const [value, setValue] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  // spec §5.3: "loaded via loadUserTags() on popover open" — this component only ever mounts
  // while the popover is open (SampleList's conditional render), so a mount-only effect IS "on
  // popover open". `UserLayerStore.userTagNames`'s own field comment names this exact call site.
  useEffect(() => {
    void userLayer.loadUserTags();
  }, [userLayer]);

  // Esc / click-away — RowContextMenu's own listener pattern (document-level, capture-phase, so
  // it fires ahead of the target's own bubble-phase handlers regardless of local
  // stopPropagation elsewhere in this component).
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

  // Prefix-filtered via normalizeUserName (brief: "match via normalizeUserName") — empty input
  // shows no suggestions rather than the entire vocabulary, and a tag the row already carries is
  // never suggested again (its chip with a ✕ is already right below).
  const normalizedValue = normalizeUserName(value);
  const suggestions =
    normalizedValue === ''
      ? []
      : userLayer.userTagNames.filter(
          (name) => normalizeUserName(name).startsWith(normalizedValue) && !row.userTags.includes(name),
        );

  // `addUserTag` (main/userDb.ts) throws on an empty-after-trim name — this popover has no inline
  // error surface for tags (unlike CollectionPopover's designed `{ error }` contract), so an
  // empty commit is a client-side no-op rather than an avoidable unhandled rejection.
  const commit = (name: string): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    void userLayer.addTag(row.id, trimmed);
    setValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(value);
  };

  return (
    <Box ref={boxRef} $top={top}>
      <Input
        aria-label="Add tag"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {suggestions.length > 0 && (
        <Suggestions>
          {suggestions.map((name) => (
            <SuggestionButton key={name} type="button" onClick={() => commit(name)}>
              {name}
            </SuggestionButton>
          ))}
        </Suggestions>
      )}
      <ChipRow>
        {row.userTags.map((name) => (
          <UserTagChip key={`user-${name}`}>
            {name}
            <RemoveButton
              type="button"
              aria-label={`Remove tag ${name}`}
              onClick={() => void userLayer.removeTag(row.id, name)}
            >
              ✕
            </RemoveButton>
          </UserTagChip>
        ))}
        {row.tags.map((name) => (
          <SpliceTagChip key={`splice-${name}`}>{name}</SpliceTagChip>
        ))}
      </ChipRow>
    </Box>
  );
});
