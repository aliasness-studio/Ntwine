// Left-rail pack list: `library.packs` (already filtered to
// packs with >=1 present sample, and sorted A-Z, by `listPacks`). The All Samples row
// that used to lead this list moved into LibraryRail's own listbox —
// this component now renders packs only, under its own small header so the two rails still read
// as distinct sections inside the shared PacksScroll.
import { observer } from 'mobx-react-lite';
import { Fragment, useState } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
import { useStores } from './StoreContext';

// A Fragment, not a wrapping styled.div, holds `SectionLabel` + `List` below —
// sidebar.spec.ts's `packsScrollState` reads the "Packs" listbox's `parentElement` and expects
// PacksScroll itself (App.tsx's scroll container), not an intermediate section wrapper. LibraryRail
// has no such pre-existing DOM-parentage contract to preserve, so it wraps freely; this one can't.
const SectionLabel = styled.div`
  padding: 8px 10px 4px;
  border-top: 1px solid ${(p) => p.theme.color.border};
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${(p) => p.theme.color.textFaint};
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  padding: 0 8px 8px;
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

/** Broken/missing cover art (a failed cover download shows a generic tile) falls back to a
 * styled tile via the real `<img>`'s `onError` — this covers BOTH "no cover_file was ever
 * downloaded" and "the file went missing on disk" uniformly, since either way the `cover://`
 * protocol handler answers with a 404 the `<img>` element treats as a load error. No need to
 * special-case `pack.coverFile === null` here at all. */
function PackCover({ packId, name }: { packId: number; name: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <CoverFallback data-testid="cover-fallback" aria-hidden="true">
        {name.slice(0, 1).toUpperCase()}
      </CoverFallback>
    );
  }
  return <Cover src={api.coverUrl(packId)} alt="" onError={() => setBroken(true)} />;
}

export const PackRail = observer(function PackRail() {
  const { library } = useStores();

  return (
    <Fragment>
      <SectionLabel>Packs</SectionLabel>
      <List role="listbox" aria-label="Packs">
        {library.packs.map((pack) => {
          const scope = library.filters.scope;
          const isActive = scope?.kind === 'pack' && scope.packId === pack.id;
          return (
            <Item
              key={pack.id}
              type="button"
              role="option"
              aria-selected={isActive}
              $active={isActive}
              onClick={() => library.setScope({ kind: 'pack', packId: pack.id })}
            >
              <PackCover packId={pack.id} name={pack.name} />
              <Name title={pack.name}>{pack.name}</Name>
              <Count>{pack.sampleCount}</Count>
            </Item>
          );
        })}
      </List>
    </Fragment>
  );
});
