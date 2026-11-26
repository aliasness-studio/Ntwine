// Pure empty-state copy selection for SampleList's EmptyState.
// Split out as its own unit-testable module so the three exact strings are pinned without
// mounting SampleList's virtualized DOM. `scope` mirrors `library.filters.scope` (`Scope |
// undefined`) exactly — only favorites/collection scopes get bespoke copy; every other scope
// (a pack, or no scope at all — All Samples) shares the generic fallback SampleList already had.
import type { Scope } from '../shared/ipcTypes';

export function emptyStateText(scope: Scope | undefined): string {
  if (scope?.kind === 'favorites') {
    return 'No favorites yet — press F on a sample you love.';
  }
  if (scope?.kind === 'collection') {
    return 'Drag samples here, or press C on a selected sample.';
  }
  return 'No samples match the current filters';
}
