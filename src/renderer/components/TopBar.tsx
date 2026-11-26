// Search box + result count + volume. `library.setSearch`
// already owns the 50ms debounce — this component just forwards every keystroke.
import { observer } from 'mobx-react-lite';
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import styled from 'styled-components';
import { useStores } from './StoreContext';

const Bar = styled.div`
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  border-bottom: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgPanel};
`;

const SearchInput = styled.input`
  flex: 1;
  max-width: 420px;
  padding: 6px 10px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bg};
  color: ${(p) => p.theme.color.text};
  font-size: 13px;

  &:focus {
    outline: none;
    border-color: ${(p) => p.theme.color.accent};
  }
`;

const ResultCount = styled.div`
  color: ${(p) => p.theme.color.textMuted};
  font-size: 12px;
  white-space: nowrap;
`;

const VolumeRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
`;

const VolumeIcon = styled.span`
  color: ${(p) => p.theme.color.textFaint};
  font-size: 13px;
`;

const VolumeSlider = styled.input`
  width: 110px;
  accent-color: ${(p) => p.theme.color.accent};
`;

export interface TopBarHandle {
  /** App.tsx's window-level Cmd/Ctrl+F listener calls this. */
  focusSearch: () => void;
}

export interface TopBarProps {
  /** Esc in the search box when it's already empty: return focus to the
   * list. TopBar has no reach to the list container's DOM node on its own — App.tsx wires this
   * to SampleList's own forwarded `focusList`. */
  onEscEmpty: () => void;
}

export const TopBar = observer(
  forwardRef<TopBarHandle, TopBarProps>(function TopBar({ onEscEmpty }, ref) {
    const { library, player } = useStores();
    const searchRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({ focusSearch: () => searchRef.current?.focus() }), []);

    // Esc: lives on the search input itself ("focus is by definition there") —
    // a non-empty search clears first, same "Esc unwinds one layer" contract every other surface
    // (RowContextMenu/TagsPopover/CollectionPopover) already follows; an already-empty box blurs
    // and hands focus back to the list so arrow keys/F/T/C/N work immediately, no click required.
    const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
      if (e.key !== 'Escape') return;
      if (library.searchText !== '') {
        library.setSearch('');
        return;
      }
      searchRef.current?.blur();
      onEscEmpty();
    };

    return (
      <Bar>
        <SearchInput
          ref={searchRef}
          type="text"
          placeholder="Search filename, tags, pack…"
          aria-label="Search samples"
          value={library.searchText}
          onChange={(e) => library.setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <ResultCount data-testid="result-count">{library.resultCount} samples</ResultCount>
        <VolumeRow>
          <VolumeIcon aria-hidden="true">Vol</VolumeIcon>
          <VolumeSlider
            type="range"
            min={0}
            max={1}
            step={0.01}
            aria-label="Volume"
            value={player.volume}
            onChange={(e) => player.setVolume(Number(e.target.value))}
          />
        </VolumeRow>
      </Bar>
    );
  }),
);
