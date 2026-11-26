// Filter controls: type toggle, key select, BPM range, tag
// chips. Every control here is a thin view over `LibraryStore`'s existing actions
// (`toggleType`/`setKey`/`setBpmRange`/`toggleTag`) — no filter logic lives in this component.
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import styled from 'styled-components';
import { formatKey, PITCH_CLASSES } from '../../shared/keyDisplay';
import { useStores } from './StoreContext';

// listTags() already returns tags sorted count-desc, name-asc — the first N of
// `library.tags` IS "top N by count" with no extra sort needed here.
const TOP_TAG_COUNT = 20;

// No border-top of its own: App.tsx's FilterDock (this panel's only mount point) draws the
// rail-section divider, and its header row sits between that divider and this panel.
const Panel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 8px 12px;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const SectionLabel = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${(p) => p.theme.color.textFaint};
`;

const ToggleRow = styled.div`
  display: flex;
  gap: 6px;
`;

const ToggleButton = styled.button<{ $active: boolean }>`
  flex: 1;
  padding: 5px 8px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => (p.$active ? p.theme.color.accent : p.theme.color.border)};
  background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : 'transparent')};
  color: ${(p) => (p.$active ? p.theme.color.accentStrong : p.theme.color.textMuted)};
  font-size: 12px;
  cursor: pointer;
`;

const Select = styled.select`
  padding: 5px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
`;

const RangeRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`;

const NumberInput = styled.input`
  width: 56px;
  padding: 5px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
`;

const RangeSeparator = styled.span`
  color: ${(p) => p.theme.color.textFaint};
`;

const TagFilterInput = styled.input`
  padding: 5px 6px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
`;

const ChipList = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
`;

const TagChip = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: ${(p) => p.theme.radius.pill};
  border: 1px solid ${(p) => (p.$active ? p.theme.color.accent : p.theme.color.border)};
  background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : 'transparent')};
  color: ${(p) => (p.$active ? p.theme.color.accentStrong : p.theme.color.textMuted)};
  font-size: 11px;
  cursor: pointer;
`;

const ChipCount = styled.span`
  color: ${(p) => p.theme.color.textFaint};
  font-size: 10px;
`;

function parseOptionalNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

export const FilterPanel = observer(function FilterPanel() {
  const { library } = useStores();
  const [tagQuery, setTagQuery] = useState('');

  const trimmedTagQuery = tagQuery.trim().toLowerCase();
  const visibleTags =
    trimmedTagQuery === ''
      ? library.tags.slice(0, TOP_TAG_COUNT)
      : library.tags.filter((t) => t.name.includes(trimmedTagQuery));
  const activeTags = library.filters.tags ?? [];

  return (
    <Panel>
      <Section>
        <SectionLabel>Type</SectionLabel>
        <ToggleRow>
          <ToggleButton
            type="button"
            $active={library.filters.sampleType === 'oneshot'}
            onClick={() => library.toggleType('oneshot')}
          >
            One-shot
          </ToggleButton>
          <ToggleButton
            type="button"
            $active={library.filters.sampleType === 'loop'}
            onClick={() => library.toggleType('loop')}
          >
            Loop
          </ToggleButton>
        </ToggleRow>
      </Section>

      <Section>
        <SectionLabel>Key</SectionLabel>
        <Select
          aria-label="Key filter"
          value={library.filters.audioKey ?? ''}
          onChange={(e) => library.setKey(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Any key</option>
          {PITCH_CLASSES.map((k) => (
            <option key={k} value={k}>
              {formatKey(k, null)}
            </option>
          ))}
        </Select>
      </Section>

      <Section>
        <SectionLabel>BPM</SectionLabel>
        <RangeRow>
          <NumberInput
            type="number"
            min={0}
            placeholder="min"
            aria-label="Minimum BPM"
            value={library.filters.bpmMin ?? ''}
            onChange={(e) =>
              library.setBpmRange(
                parseOptionalNumber(e.target.value),
                library.filters.bpmMax ?? null,
              )
            }
          />
          <RangeSeparator>–</RangeSeparator>
          <NumberInput
            type="number"
            min={0}
            placeholder="max"
            aria-label="Maximum BPM"
            value={library.filters.bpmMax ?? ''}
            onChange={(e) =>
              library.setBpmRange(
                library.filters.bpmMin ?? null,
                parseOptionalNumber(e.target.value),
              )
            }
          />
        </RangeRow>
      </Section>

      <Section>
        <SectionLabel>Tags</SectionLabel>
        <TagFilterInput
          type="text"
          placeholder="Filter tags…"
          aria-label="Filter tag list"
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
        />
        <ChipList>
          {visibleTags.map((tag) => (
            <TagChip
              key={tag.name}
              type="button"
              $active={activeTags.includes(tag.name)}
              onClick={() => library.toggleTag(tag.name)}
            >
              {tag.name} <ChipCount>{tag.count}</ChipCount>
            </TagChip>
          ))}
        </ChipList>
      </Section>
    </Panel>
  );
});
