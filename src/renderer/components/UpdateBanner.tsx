// Download banner: a slim strip across the top of the main pane, shown for exactly as long as an
// update downloads (UpdateStore.bannerVisible). Squirrel reports no download progress, so the
// strip is indeterminate. It sits in its own `auto` grid row (App.tsx), so it pushes the search
// row down rather than covering anything, and the row collapses to nothing when this renders
// `null`. No dismiss: it is a notice that work is under way, and it leaves on its own when the
// download finishes (the rail-footer badge takes over) or fails.
import { observer } from 'mobx-react-lite';
import styled, { keyframes } from 'styled-components';
import { useStores } from './StoreContext';

const Strip = styled.div`
  grid-area: banner;
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 16px;
  overflow: hidden;
  border-bottom: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgRail};
  color: ${(p) => p.theme.color.textMuted};
  font-size: 12px;
  white-space: nowrap;
`;

const Hint = styled.span`
  color: ${(p) => p.theme.color.textFaint};
`;

// The segment is 30% of the track, so travelling from -100% to +334% of its own width carries it
// fully off both edges.
const sweep = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(334%); }
`;

const Track = styled.span`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
`;

// Muted on purpose: the accent at half strength reads as activity, not as a warning. Without
// motion the text alone carries the message, so the segment is dropped rather than frozen.
const Segment = styled.span`
  position: absolute;
  top: 0;
  bottom: 0;
  width: 30%;
  border-radius: ${(p) => p.theme.radius.pill};
  background: ${(p) => p.theme.color.accent};
  opacity: 0.5;
  animation: ${sweep} 1.8s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    display: none;
  }
`;

export const UpdateBanner = observer(function UpdateBanner() {
  const { update } = useStores();
  if (!update.bannerVisible) return null;

  return (
    <Strip role="status" aria-live="polite" data-testid="update-banner">
      <span>Downloading update…</span>
      <Hint>You can keep working.</Hint>
      <Track aria-hidden="true">
        <Segment />
      </Track>
    </Strip>
  );
});
