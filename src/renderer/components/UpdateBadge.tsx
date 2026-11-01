// Update badge (release pipeline PR 2, Task 9), in the rail footer between the transport dock and
// the settings gear. Reads UpdateStore and nothing else: main decides every transition, this only
// offers the one action each non-idle state allows — restart-to-install when an update is `ready`,
// or open the download page when a signature mismatch means it must be installed by hand — plus a
// dismiss. Renders `null` while hidden, so the footer's `space-between` layout keeps its original
// two occupants (and their test ids) until there is actually something to say.
import { observer } from 'mobx-react-lite';
import styled from 'styled-components';
import { useStores } from './StoreContext';

const Group = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
`;

// Same shape as TransportControls.tsx's TransportButton (each component defining its own is this
// repo's established pattern — see the comment there). `$active` is the accent treatment, used for
// `ready` so the badge reads as a call to action rather than another idle control.
const BadgeButton = styled.button<{ $active?: boolean }>`
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => (p.$active ? p.theme.color.accent : p.theme.color.border)};
  background: ${(p) => (p.$active ? p.theme.color.bgRowSelected : 'transparent')};
  color: ${(p) => (p.$active ? p.theme.color.accentStrong : p.theme.color.textMuted)};
  cursor: pointer;

  &:hover {
    background: ${(p) => p.theme.color.bgRowHover};
    color: ${(p) => p.theme.color.text};
  }
`;

// Deliberately smaller and borderless: secondary to the action beside it.
const DismissButton = styled.button`
  width: 16px;
  height: 16px;
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

// Inline SVG per TransportControls.tsx's convention (no platform-dependent dingbats);
// `currentColor` inherits the button's colour, so hover and `$active` apply for free.
function UpdateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7 10 L7 4.2 M4.6 6.4 L7 4 L9.4 6.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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

export const UpdateBadge = observer(function UpdateBadge() {
  const { update } = useStores();
  if (!update.visible) return null;
  const { state } = update;

  return (
    <Group role="group" aria-label="Update" data-testid="update-badge">
      {state.kind === 'ready' ? (
        // The feed's release name already reads like "Ntwine v0.2.0 (beta)", so it goes in
        // verbatim rather than behind another "Ntwine" prefix.
        <BadgeButton
          type="button"
          $active
          aria-label="Restart to update"
          title={`${state.version} is ready — restart to update`}
          data-testid="update-restart"
          onClick={() => void update.install()}
        >
          <UpdateIcon />
        </BadgeButton>
      ) : (
        <BadgeButton
          type="button"
          aria-label="Download the new version"
          title="This update must be installed by hand — opens the download page"
          data-testid="update-download"
          onClick={() => void update.openReleases()}
        >
          <UpdateIcon />
        </BadgeButton>
      )}
      <DismissButton
        type="button"
        aria-label="Dismiss update notice"
        title="Dismiss"
        data-testid="update-dismiss"
        onClick={() => update.dismiss()}
      >
        <DismissIcon />
      </DismissButton>
    </Group>
  );
});
