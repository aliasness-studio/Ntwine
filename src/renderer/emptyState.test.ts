import { describe, expect, it } from 'vitest';
import { emptyStateText } from './emptyState';

describe('emptyStateText', () => {
  it('favorites scope gets its own empty-state copy (spec §5.1)', () => {
    expect(emptyStateText({ kind: 'favorites' })).toBe(
      'No favorites yet — press F on a sample you love.',
    );
  });

  it('collection scope gets its own empty-state copy (spec §5.1)', () => {
    expect(emptyStateText({ kind: 'collection', collectionId: 'c1' })).toBe(
      'Drag samples here, or press C on a selected sample.',
    );
  });

  it('no scope (All Samples) falls back to the generic filters message', () => {
    expect(emptyStateText(undefined)).toBe('No samples match the current filters');
  });

  it('pack scope also falls back to the generic filters message — only favorites/collection get bespoke copy', () => {
    expect(emptyStateText({ kind: 'pack', packId: 1 })).toBe(
      'No samples match the current filters',
    );
  });
});
