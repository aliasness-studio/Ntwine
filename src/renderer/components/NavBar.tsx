// "You are here" bar (QoL round 2, 2026-08-20). Two jobs, both consequences of making rows
// link-navigable: once a click on a pack/key/bpm/tag can change what you're looking at, the app
// owes you (1) a way back, and (2) a visible answer to "why am I seeing these rows?" — otherwise a
// filter followed three rows ago silently narrows every later view, which reads as a bug.
//
// Renders NOTHING when there's neither history nor an active filter, so the default "All Samples"
// view keeps its full height and the bar's presence is itself the signal that something is
// narrowing the list.
import { observer } from 'mobx-react-lite';
import styled from 'styled-components';
import { formatKey } from '../../shared/keyDisplay';
import type { Scope } from '../../shared/ipcTypes';
import { useStores } from './StoreContext';

const Bar = styled.div`
  grid-area: crumbs;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bg};
`;

const IconButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: transparent;
  color: ${(p) => p.theme.color.textMuted};
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }

  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
`;

const Crumb = styled.span`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border-radius: ${(p) => p.theme.radius.pill};
  border: 1px solid ${(p) => p.theme.color.accent};
  background: ${(p) => p.theme.color.bgRowSelected};
  color: ${(p) => p.theme.color.accentStrong};
  font-size: 11px;
  max-width: 260px;
`;

const CrumbLabel = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const RemoveButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.accent};
    color: ${(p) => p.theme.color.bg};
  }
`;

const TextButton = styled.button`
  padding: 2px 8px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: transparent;
  color: ${(p) => p.theme.color.textMuted};
  font-size: 11px;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

const Spacer = styled.span`
  margin-left: auto;
`;

// Same inline-SVG reasoning as App.tsx's GearIcon/ChevronIcon: a system-font arrow dingbat renders
// inconsistently across platforms.
function BackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M7.5 2 L3.5 6 L7.5 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function bpmLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) {
    return min === max ? `${min} BPM` : `${min}–${max} BPM`;
  }
  if (min !== undefined) return `${min}+ BPM`;
  return `up to ${max} BPM`;
}

interface CrumbSpec {
  key: string;
  label: string;
  remove: () => void;
}

export const NavBar = observer(function NavBar() {
  const { library, userLayer } = useStores();
  const f = library.filters;

  // Scope names come from the stores that own them, and fall back to a generic label rather than
  // vanishing: a pack/collection can be absent from the rail mid-refresh, and a crumb that
  // disappears while its filter is still applied is worse than one with a vague name.
  const scopeLabel = (scope: Scope): string => {
    if (scope.kind === 'favorites') return 'Favorites';
    if (scope.kind === 'pack') {
      return library.packs.find((p) => p.id === scope.packId)?.name ?? 'Pack';
    }
    return userLayer.collections.find((c) => c.id === scope.collectionId)?.name ?? 'Collection';
  };

  const crumbs: CrumbSpec[] = [];
  if (f.scope !== undefined) {
    const scope = f.scope;
    crumbs.push({ key: 'scope', label: scopeLabel(scope), remove: () => library.setScope(null) });
  }
  if (f.sampleType !== undefined) {
    const type = f.sampleType;
    crumbs.push({
      key: 'type',
      label: type === 'oneshot' ? 'One-shot' : 'Loop',
      remove: () => library.toggleType(type), // toggling the ACTIVE value is what clears it
    });
  }
  if (f.audioKey !== undefined) {
    crumbs.push({
      key: 'key',
      label: formatKey(f.audioKey, null),
      remove: () => library.setKey(null),
    });
  }
  if (f.bpmMin !== undefined || f.bpmMax !== undefined) {
    crumbs.push({
      key: 'bpm',
      label: bpmLabel(f.bpmMin, f.bpmMax),
      remove: () => library.setBpmRange(null, null),
    });
  }
  for (const tag of f.tags ?? []) {
    crumbs.push({ key: `tag-${tag}`, label: tag, remove: () => library.toggleTag(tag) });
  }
  if (f.search !== undefined) {
    crumbs.push({ key: 'search', label: `“${f.search}”`, remove: () => library.setSearch('') });
  }

  if (!library.canGoBack && crumbs.length === 0) return null;

  return (
    <Bar data-testid="nav-bar">
      <IconButton
        type="button"
        title="Back"
        aria-label="Back"
        data-testid="nav-back"
        disabled={!library.canGoBack}
        onClick={() => library.back()}
      >
        <BackIcon />
      </IconButton>
      {crumbs.map((crumb) => (
        <Crumb key={crumb.key} data-testid="nav-crumb">
          {/* Its own testid: the crumb element's text includes the ✕, so only the label carries
              the filter's name on its own. */}
          <CrumbLabel data-testid="nav-crumb-label" title={crumb.label}>
            {crumb.label}
          </CrumbLabel>
          <RemoveButton
            type="button"
            aria-label={`Remove filter ${crumb.label}`}
            onClick={crumb.remove}
          >
            ✕
          </RemoveButton>
        </Crumb>
      ))}
      {crumbs.length > 0 && (
        <>
          <Spacer />
          <TextButton type="button" data-testid="nav-clear" onClick={() => library.clearFilters()}>
            Clear all
          </TextButton>
        </>
      )}
    </Bar>
  );
});
