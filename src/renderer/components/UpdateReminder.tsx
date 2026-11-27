// Update reminder: a compact icon button at the right end of the top bar, shown only once the
// update banner has been dismissed (UpdateStore.reminder), so an update notice never leaves the
// top of the window. It offers the same one action the banner did — restart-to-install when
// `ready`, the download page when `failed` — and while `downloading`, where there is nothing to
// act on, it brings the banner back. Renders `null` while the banner shows or nothing is pending.
import { observer } from 'mobx-react-lite';
import styled from 'styled-components';
import { useStores } from './StoreContext';

// Same shape as TransportControls.tsx's TransportButton (each component defining its own is this
// repo's established pattern — see the comment there). `$active` is the accent treatment, used for
// `ready` so the button reads as a call to action rather than another idle control.
const ReminderButton = styled.button<{ $active?: boolean }>`
  flex-shrink: 0;
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

export const UpdateReminder = observer(function UpdateReminder() {
  const { update } = useStores();
  const state = update.reminder;
  if (state === null) return null;

  switch (state.kind) {
    case 'ready':
      return (
        <ReminderButton
          type="button"
          $active
          aria-label="Restart to update"
          title={`${state.version} is ready — restart to update`}
          data-testid="update-reminder"
          onClick={() =>
            update.install().catch((err) => console.error('UpdateReminder: install failed', err))
          }
        >
          <UpdateIcon />
        </ReminderButton>
      );
    case 'failed':
      return (
        <ReminderButton
          type="button"
          aria-label="Download the new version"
          title="This update must be installed by hand — opens the download page"
          data-testid="update-reminder"
          onClick={() =>
            update
              .openReleases()
              .catch((err) => console.error('UpdateReminder: openReleases failed', err))
          }
        >
          <UpdateIcon />
        </ReminderButton>
      );
    case 'downloading':
      return (
        <ReminderButton
          type="button"
          aria-label="Downloading update"
          title="Downloading update"
          data-testid="update-reminder"
          onClick={() => update.reopen()}
        >
          <UpdateIcon />
        </ReminderButton>
      );
  }
});
