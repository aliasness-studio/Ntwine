// Settings overlay (Task 13 brief, Step 4 / spec §7 "small gear, bottom of the rail"): current
// library root, a re-pick button (persists + re-stats, no re-import), and a re-run-import button.
// App.tsx owns the open/closed boolean and renders this conditionally; this component owns
// everything inside the sheet itself.
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { api } from '../stores/api';
import { useStores } from './StoreContext';

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
`;

const Sheet = styled.div`
  width: 420px;
  padding: 24px;
  border-radius: ${(p) => p.theme.radius.md};
  background: ${(p) => p.theme.color.bgPanel};
  border: 1px solid ${(p) => p.theme.color.border};
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const CloseButton = styled.button`
  align-self: flex-end;
  background: none;
  border: none;
  color: ${(p) => p.theme.color.textMuted};
  cursor: pointer;
  font-size: 12px;
  padding: 0;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 16px;
`;

const FieldRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const FieldLabel = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${(p) => p.theme.color.textFaint};
`;

const FieldValue = styled.div`
  font-size: 13px;
  word-break: break-all;
`;

const ButtonRow = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 8px;
`;

const Button = styled.button`
  padding: 8px 14px;
  border-radius: ${(p) => p.theme.radius.sm};
  border: 1px solid ${(p) => p.theme.color.border};
  background: ${(p) => p.theme.color.bgRail};
  color: ${(p) => p.theme.color.text};
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const StatusLine = styled.div`
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
`;

export interface SettingsSheetProps {
  onClose: () => void;
}

export const SettingsSheet = observer(function SettingsSheet({ onClose }: SettingsSheetProps) {
  const { library, importStore } = useStores();
  const [root, setRoot] = useState<string | null>(null);
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [repicking, setRepicking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getState().then((state) => {
      if (cancelled) return;
      setRoot(state.libraryRoot);
      setLoadingRoot(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Review round 1, Finding 2 + 3 (controller-elevated) — see FirstRun.tsx's `importing` for the
  // full rationale; same predicate, same fix, hand-duplicated here until now.
  const reimporting = importStore.running;

  const handleRepick = async (): Promise<void> => {
    setRepicking(true);
    try {
      // spec §8 "library root moved": pickLibraryRoot persists the new root and re-stats
      // (main.ts's ipc.ts handler) — it never re-imports.
      const newRoot = await api.pickLibraryRoot();
      if (newRoot !== null) {
        setRoot(newRoot);
        await library.init(); // refresh rows/packs against the just-updated `missing` flags.
      }
    } catch (err) {
      console.error('SettingsSheet: pickLibraryRoot failed', err);
    } finally {
      setRepicking(false);
    }
  };

  const handleReimport = async (): Promise<void> => {
    await importStore.run();
    if (importStore.phase !== 'error') {
      try {
        await library.init(); // refresh rows/packs/tags against whatever the re-import changed.
      } catch (err) {
        console.error('SettingsSheet: refreshing the library after re-import failed', err);
      }
    }
  };

  return (
    <Backdrop onClick={onClose}>
      <Sheet onClick={(e) => e.stopPropagation()}>
        <CloseButton type="button" onClick={onClose} aria-label="Close settings">
          Close ×
        </CloseButton>
        <Title>Settings</Title>
        <FieldRow>
          <FieldLabel>Library folder</FieldLabel>
          <FieldValue>{loadingRoot ? 'Loading…' : (root ?? 'Unknown')}</FieldValue>
        </FieldRow>
        <ButtonRow>
          <Button type="button" disabled={repicking} onClick={() => void handleRepick()}>
            {repicking ? 'Picking…' : 'Re-pick folder'}
          </Button>
          <Button type="button" disabled={reimporting} onClick={() => void handleReimport()}>
            {reimporting ? 'Importing…' : 'Re-run import'}
          </Button>
        </ButtonRow>
        {importStore.phase !== null && (
          <StatusLine>
            {importStore.phase}
            {importStore.total > 0 ? ` (${importStore.done}/${importStore.total})` : ''}
            {importStore.message ? ` — ${importStore.message}` : ''}
          </StatusLine>
        )}
      </Sheet>
    </Backdrop>
  );
});
