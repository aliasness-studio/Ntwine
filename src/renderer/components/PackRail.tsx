// Left-rail pack list (Task 13 brief, Step 1 / spec §7): "All Samples" + `library.packs`
// (already filtered to packs with >=1 present sample, and sorted A-Z, by `listPacks` — Task 7).
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
import { useStores } from './StoreContext';

const List = styled.div`
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 2px;
`;

const Item = styled.button<{ $active: boolean }>`
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

  &:hover {
    background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : p.theme.color.bgRowHover)};
  }
`;

const CoverSize = '28px';

const Cover = styled.img`
  width: ${CoverSize};
  height: ${CoverSize};
  border-radius: ${(p) => p.theme.radius.sm};
  object-fit: cover;
  flex-shrink: 0;
  background: ${(p) => p.theme.color.bgPanel};
`;

const CoverFallback = styled.div`
  width: ${CoverSize};
  height: ${CoverSize};
  border-radius: ${(p) => p.theme.radius.sm};
  background: ${(p) => p.theme.color.bgPanel};
  color: ${(p) => p.theme.color.textFaint};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  flex-shrink: 0;
`;

const AllSamplesIcon = styled.div`
  width: ${CoverSize};
  height: ${CoverSize};
  flex-shrink: 0;
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

/** Broken/missing cover art (spec §8: "Cover download fails -> Generic tile") falls back to a
 * styled tile via the real `<img>`'s `onError` — this covers BOTH "no cover_file was ever
 * downloaded" and "the file went missing on disk" uniformly, since either way the `cover://`
 * protocol handler answers with a 404 the `<img>` element treats as a load error. No need to
 * special-case `pack.coverFile === null` here at all. */
function PackCover({ packId, name }: { packId: number; name: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return <CoverFallback aria-hidden="true">{name.slice(0, 1).toUpperCase()}</CoverFallback>;
  }
  return <Cover src={api.coverUrl(packId)} alt="" onError={() => setBroken(true)} />;
}

export const PackRail = observer(function PackRail() {
  const { library } = useStores();
  const totalSamples = library.packs.reduce((sum, p) => sum + p.sampleCount, 0);

  return (
    <List role="listbox" aria-label="Packs">
      <Item
        type="button"
        role="option"
        aria-selected={library.filters.packId === undefined}
        $active={library.filters.packId === undefined}
        onClick={() => library.setPack(null)}
      >
        <AllSamplesIcon aria-hidden="true" />
        <Name>All Samples</Name>
        <Count>{totalSamples}</Count>
      </Item>
      {library.packs.map((pack) => (
        <Item
          key={pack.id}
          type="button"
          role="option"
          aria-selected={library.filters.packId === pack.id}
          $active={library.filters.packId === pack.id}
          onClick={() => library.setPack(pack.id)}
        >
          <PackCover packId={pack.id} name={pack.name} />
          <Name title={pack.name}>{pack.name}</Name>
          <Count>{pack.sampleCount}</Count>
        </Item>
      ))}
    </List>
  );
});
