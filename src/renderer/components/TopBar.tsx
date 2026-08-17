// Search box + result count + volume (Task 13 brief, Step 1 / spec §7). `library.setSearch`
// already owns the 50ms debounce (Task 12) — this component just forwards every keystroke.
import { observer } from 'mobx-react-lite';
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

export const TopBar = observer(function TopBar() {
  const { library, player } = useStores();

  return (
    <Bar>
      <SearchInput
        type="text"
        placeholder="Search filename, tags, pack…"
        aria-label="Search samples"
        value={library.searchText}
        onChange={(e) => library.setSearch(e.target.value)}
      />
      <ResultCount>{library.resultCount} samples</ResultCount>
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
});
