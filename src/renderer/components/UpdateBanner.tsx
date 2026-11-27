// Update banner: a slim strip across the top of the main pane, the one place every update notice
// lives (UpdateStore.banner). `downloading` is a progress notice with an indeterminate sweep
// (Squirrel reports no download progress); `ready` offers restart-to-install; `failed` (a
// signature mismatch) offers the download page instead. Every state can be dismissed, after which
// TopBar's UpdateReminder keeps it one click away. It sits in its own `auto` grid row (App.tsx),
// so it pushes the search row down rather than covering anything, and the row collapses to
// nothing when this renders `null`.
import { observer } from 'mobx-react-lite';
import styled, { keyframes } from 'styled-components';
import type { NoticeState } from '../stores/UpdateStore';
import { useStores } from './StoreContext';

const Strip = styled.div`
  grid-area: banner;
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 8px 0 16px;
  overflow: hidden;
  border-bottom: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgRail};
  color: ${(p) => p.theme.color.textMuted};
  font-size: 12px;
  white-space: nowrap;
`;

// The live region. It stays mounted across state changes (only its text changes), so a
// transition such as downloading -> ready is announced.
const Message = styled.span`
  display: flex;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
`;

const Hint = styled.span`
  color: ${(p) => p.theme.color.textFaint};
`;

// A text button in the accent treatment, so the one action the notice offers reads as the call
// to action. Sized to sit inside the 28px strip.
const ActionButton = styled.button`
  flex-shrink: 0;
  height: 20px;
  padding: 0 8px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.accent};
  background: ${(p) => p.theme.color.bgRowSelected};
  color: ${(p) => p.theme.color.accentStrong};
  font: inherit;
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

// Borderless and pinned to the right edge: secondary to the action beside the message.
const DismissButton = styled.button`
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  margin-left: auto;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: ${(p) => p.theme.radius.sm};
  background: transparent;
  color: ${(p) => p.theme.color.textFaint};
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
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

// Inline SVG per TransportControls.tsx's convention (no platform-dependent dingbats);
// `currentColor` inherits the button's colour, so hover applies for free.
function DismissIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function messageFor(state: NoticeState) {
  switch (state.kind) {
    case 'downloading':
      return (
        <>
          <span>Downloading update…</span>
          <Hint>You can keep working.</Hint>
        </>
      );
    case 'ready':
      // The feed's release name already reads like "Ntwine v0.2.0 (beta)", so it goes in
      // verbatim rather than behind another "Ntwine" prefix.
      return `${state.version} is ready.`;
    case 'failed':
      return 'This update must be installed by hand.';
  }
}

export const UpdateBanner = observer(function UpdateBanner() {
  const { update } = useStores();
  const state = update.banner;
  if (state === null) return null;

  return (
    <Strip data-testid="update-banner">
      <Message role="status" aria-live="polite" data-testid="update-banner-message">
        {messageFor(state)}
      </Message>
      {state.kind === 'ready' && (
        <ActionButton
          type="button"
          onClick={() =>
            update.install().catch((err) => console.error('UpdateBanner: install failed', err))
          }
        >
          Restart to update
        </ActionButton>
      )}
      {state.kind === 'failed' && (
        <ActionButton
          type="button"
          title="Opens the download page"
          onClick={() =>
            update
              .openReleases()
              .catch((err) => console.error('UpdateBanner: openReleases failed', err))
          }
        >
          Download
        </ActionButton>
      )}
      <DismissButton
        type="button"
        aria-label="Dismiss update notice"
        title="Dismiss"
        onClick={() => update.dismiss()}
      >
        <DismissIcon />
      </DismissButton>
      {state.kind === 'downloading' && (
        <Track aria-hidden="true">
          <Segment />
        </Track>
      )}
    </Strip>
  );
});
