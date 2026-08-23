// Transport dock (2026-08-23), in the rail footer beside the settings gear. Two controls, both
// answering the same live-use complaint from opposite ends: trigger a 30-second sample by accident
// and v1 gave you no way to silence it — every action that changed "current" played the new
// landing, and nothing ever called `playPort.stop()`, so the only available gesture was to
// RESTART it. Stop cures that; the autoplay toggle prevents it.
//
// Deliberately NOT a play/pause pair. WebAudio preview here is fire-and-forget (previewPlayer
// starts a fresh voice per play, with no pause/resume seam and no position state), so a Pause
// button would be a lie about what the audio layer can do.
import { observer } from 'mobx-react-lite';
import styled from 'styled-components';
import { useStores } from './StoreContext';

const Dock = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

// Same shape as App.tsx's GearButton and NavBar's IconButton — each component defining its own is
// this repo's established pattern (see NavBar.tsx), rather than hoisting a shared button into a
// module every rail neighbour would then depend on.
const TransportButton = styled.button<{ $active?: boolean }>`
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

// Inline SVG for the same reason as App.tsx's GearIcon and NavBar's BackIcon: a system-font
// dingbat (■, ▶) renders at wildly different weights and baselines across platforms, and this app
// is now built for two. `currentColor` inherits the button's own colour, so hover and the active
// state above apply for free.
function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** A play triangle, struck through when autoplay is off — the slash is what carries the state for
 * anyone who can't perceive the colour change on the button itself. */
function AutoplayIcon({ on }: { on: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.5 2.2 L9.5 6 L3.5 9.8 Z" fill="currentColor" />
      {!on && (
        <path d="M1.6 10.4 L10.4 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

export const TransportControls = observer(function TransportControls() {
  const { player } = useStores();

  return (
    <Dock role="group" aria-label="Transport" data-testid="transport">
      {/* Never disabled, on purpose. It's a panic button, and previewPlayer.stop() already no-ops
          when no voice is sounding; knowing whether audio is ACTUALLY playing would need an
          ended-signal the player doesn't raise. A Stop that greys out at the wrong moment is
          worse than one that occasionally does nothing. */}
      <TransportButton
        type="button"
        title="Stop playback"
        aria-label="Stop"
        data-testid="transport-stop"
        onClick={() => player.stop()}
      >
        <StopIcon />
      </TransportButton>
      {/* aria-pressed, not a checkbox: this is a toggle button whose label stays constant, which
          is exactly the pattern aria-pressed exists for. */}
      <TransportButton
        type="button"
        $active={player.autoplay}
        aria-pressed={player.autoplay}
        title={
          player.autoplay
            ? 'Autoplay on — clicking or arrowing to a row plays it'
            : 'Autoplay off — rows select silently; Space or ← plays'
        }
        aria-label="Autoplay"
        data-testid="transport-autoplay"
        onClick={() => player.toggleAutoplay()}
      >
        <AutoplayIcon on={player.autoplay} />
      </TransportButton>
    </Dock>
  );
});
