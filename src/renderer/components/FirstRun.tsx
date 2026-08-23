// First-run import screen (Task 13 brief, Step 4). Shown by App.tsx when `!state.imported`.
// Flips to the library ONLY when `ImportStore.run()`'s returned promise resolves with a
// NON-error terminal phase — i.e. after catalog+stat+covers (spec §3.1 item 6: "missing flags
// are accurate" at that point); the waveform phase keeps running in the background afterward.
// `ImportStore.run()` itself never rejects (its own contract — a failure is caught and surfaced
// as `phase: 'error'` instead), so the error branch below is reached by checking `phase` after
// the await, not by a `catch`.
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import styled from 'styled-components';
import type { NtwineApi } from '../../shared/ipcTypes';
import { ipcErrorMessage } from '../ipcError';
import { api } from '../stores/api';
import { useStores } from './StoreContext';

const PHASE_LABEL: Partial<Record<string, string>> = {
  snapshot: 'Copying the Splice database…',
  catalog: 'Building the catalog…',
  stat: 'Checking files on disk…',
  covers: 'Downloading pack covers…',
  waveforms: 'Computing waveforms…',
};

const Card = styled.div`
  width: 440px;
  padding: 32px;
  border-radius: ${(p) => p.theme.radius.md};
  background: ${(p) => p.theme.color.bgPanel};
  border: 1px solid ${(p) => p.theme.color.border};
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
`;

const Subtitle = styled.p`
  margin: 0;
  font-size: 13px;
  color: ${(p) => p.theme.color.textMuted};
  line-height: 1.5;
`;

const DetectedList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const DetectedRow = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
`;

const DetectedValue = styled.span`
  color: ${(p) => p.theme.color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
`;

const ImportButton = styled.button`
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 600;
  border-radius: ${(p) => p.theme.radius.md};
  border: none;
  background: ${(p) => p.theme.color.accent};
  color: ${(p) => p.theme.color.bg};
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const SecondaryButton = styled.button`
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  border-radius: ${(p) => p.theme.radius.md};
  border: 1px solid ${(p) => p.theme.color.border};
  background: transparent;
  color: ${(p) => p.theme.color.text};
  cursor: pointer;
  align-self: flex-start;
`;

const InlineButton = styled(SecondaryButton)`
  padding: 2px 8px;
  font-size: 11px;
  align-self: center;
  flex-shrink: 0;
`;

const ProgressLine = styled.div`
  font-size: 12px;
  color: ${(p) => p.theme.color.textMuted};
`;

const ErrorLine = styled.div`
  font-size: 12px;
  color: ${(p) => p.theme.color.danger};
`;

export interface FirstRunProps {
  state: Awaited<ReturnType<NtwineApi['getState']>>;
  onImported: () => void;
}

export const FirstRun = observer(function FirstRun({ state, onImported }: FirstRunProps) {
  const { importStore } = useStores();

  // The Splice-DB picker fallback (Windows-port audit blocker): detection's win32 glob is a
  // best-guess, and without this button a missed guess left the app with no way in. Local state
  // (seeded from the boot-time getState) because a successful pick changes the answer without a
  // relaunch — main persists meta.splice_db_path and getState would agree on the next boot.
  const [dbFound, setDbFound] = useState(state.spliceDbFound);
  const [pickError, setPickError] = useState<string | null>(null);

  // First-run library-root picker (Option A, 2026-08-20). `state.libraryRoot` is now the
  // EFFECTIVE root main would import with — Splice's own reported splice_folder when readable,
  // else the platform's stock location (ipc.ts's currentLibraryRoot) — so this row shows a real
  // path from the first paint instead of a hardcoded "~/Splice (default)" that was wrong on
  // Windows. The button remains for the cases detection can't cover (a library Splice doesn't
  // know about, an unreadable settings.json): Settings' re-pick only exists AFTER a successful
  // import, and importing with a wrong root refuses every row (normalizeSample's out-of-root
  // throw), so without it a wrong default still wedges first-run. Reuses the exact
  // pickLibraryRoot IPC Settings uses (persists meta.library_root + stat pass; the stat over a
  // pre-import empty catalog is a no-op). Local state, same rationale as dbFound above.
  const [libraryRoot, setLibraryRoot] = useState(state.libraryRoot);

  const handleChangeRoot = (): void => {
    void api.pickLibraryRoot().then((picked) => {
      if (picked !== null) setLibraryRoot(picked); // null = dialog canceled
    });
  };

  const handleLocate = (): void => {
    setPickError(null);
    void api
      .pickSpliceDb()
      .then((picked) => {
        if (picked !== null) setDbFound(true); // null = dialog canceled — no change either way
      })
      .catch((err: unknown) => setPickError(ipcErrorMessage(err)));
  };

  // Review round 1, Finding 2 + 3 (controller-elevated): this used to hand-derive "is an import
  // running" from `phase` (duplicated verbatim in SettingsSheet.tsx) — racy, since `phase` only
  // updates once the first `onImportProgress` event round-trips from main, leaving a window
  // where a fast double-click saw `phase === null` in both call sites and neither guard engaged.
  // `ImportStore.running` is the single source of truth now: flipped synchronously inside
  // `run()`, before any await, so there's no such window — see its own doc comment.
  const importing = importStore.running;

  const handleImport = (): void => {
    void importStore.run().then(() => {
      if (importStore.phase !== 'error') {
        onImported();
      }
    });
  };

  return (
    <Card>
      <Title>Welcome to Ntwine</Title>
      <Subtitle>
        Ntwine browses your downloaded Splice library without the Splice app. Import once to build a
        local catalog — nothing here is ever written back to your Splice folder.
      </Subtitle>
      <DetectedList>
        <DetectedRow>
          <span>Library folder</span>
          <DetectedValue data-testid="first-run-library-root" title={libraryRoot}>
            {libraryRoot}
          </DetectedValue>
          <InlineButton type="button" onClick={handleChangeRoot}>
            Change…
          </InlineButton>
        </DetectedRow>
        <DetectedRow>
          <span>Splice database</span>
          <DetectedValue data-testid="detected-splice-db">
            {dbFound ? 'found' : 'not found'}
          </DetectedValue>
        </DetectedRow>
      </DetectedList>
      {!dbFound && (
        <>
          <Subtitle>
            Couldn&apos;t find Splice&apos;s sounds.db automatically. If Splice is installed, you can
            point Ntwine at the file yourself.
          </Subtitle>
          <SecondaryButton type="button" onClick={handleLocate}>
            Locate sounds.db…
          </SecondaryButton>
        </>
      )}
      {pickError !== null && <ErrorLine data-testid="pick-splice-db-error">{pickError}</ErrorLine>}
      <ImportButton type="button" disabled={importing} onClick={handleImport}>
        {importing ? 'Importing…' : 'Import library'}
      </ImportButton>
      {importStore.phase !== null && importStore.phase !== 'error' && (
        <ProgressLine>
          {PHASE_LABEL[importStore.phase] ?? importStore.phase}
          {importStore.total > 0 ? ` (${importStore.done}/${importStore.total})` : ''}
          {importStore.message ? ` — ${importStore.message}` : ''}
        </ProgressLine>
      )}
      {importStore.phase === 'error' && (
        <ErrorLine>{importStore.message ?? 'Import failed for an unknown reason.'}</ErrorLine>
      )}
    </Card>
  );
});
