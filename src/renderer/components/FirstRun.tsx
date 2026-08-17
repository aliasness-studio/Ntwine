// First-run import screen (Task 13 brief, Step 4). Shown by App.tsx when `!state.imported`.
// Flips to the library ONLY when `ImportStore.run()`'s returned promise resolves with a
// NON-error terminal phase — i.e. after catalog+stat+covers (spec §3.1 item 6: "missing flags
// are accurate" at that point); the waveform phase keeps running in the background afterward.
// `ImportStore.run()` itself never rejects (its own contract — a failure is caught and surfaced
// as `phase: 'error'` instead), so the error branch below is reached by checking `phase` after
// the await, not by a `catch`.
import { observer } from 'mobx-react-lite';
import styled from 'styled-components';
import type { NtwineApi } from '../../shared/ipcTypes';
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

  // Brief: "the Import button must disable itself once clicked (while phase is non-null and not
  // 'done'/'error')". In practice `run()`'s promise resolves before any 'waveforms' event can
  // arrive (runImport resolves after covers, before the background peaks queue starts), so this
  // component never actually observes phase 'waveforms'/'done' while still mounted — but the
  // condition is written to the brief's literal rule, not to "only the phases this component
  // happens to see today".
  const importing =
    importStore.phase !== null && importStore.phase !== 'done' && importStore.phase !== 'error';

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
          <DetectedValue title={state.libraryRoot ?? undefined}>
            {state.libraryRoot ?? '~/Splice (default)'}
          </DetectedValue>
        </DetectedRow>
        <DetectedRow>
          <span>Splice database</span>
          <DetectedValue>{state.spliceDbFound ? 'found' : 'not found'}</DetectedValue>
        </DetectedRow>
      </DetectedList>
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
