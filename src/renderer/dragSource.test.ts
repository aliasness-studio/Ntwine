// The renderer-owned drag-source slot is the ONLY way a rail drop
// target can tell our own native row drag from an external Finder/Explorer file drag (once
// SampleRow's `handleDragStart` calls `preventDefault`, there is no HTML5 drag session of our own
// left for `dataTransfer` to carry anything useful). These tests pin the slot's full lifecycle,
// INCLUDING the session-token semantics that keep a late `finally` (from `startDrag`'s invoke
// resolving after a drop already consumed the slot, or after a second drag armed a newer one)
// from ever clobbering a slot it doesn't own.
import { describe, expect, it } from 'vitest';
import { armDragSource, clearDragSource, consumeDragSource, peekDragSource } from './dragSource';

describe('dragSource', () => {
  it('armDragSource records the sample id under a fresh token that peekDragSource reflects', () => {
    const token = armDragSource(42);

    expect(peekDragSource()).toEqual({ sampleId: 42, token });
  });

  it('arming again unconditionally overwrites the previous slot with a new id and a new token', () => {
    const first = armDragSource(1);
    const second = armDragSource(2);

    expect(second).not.toBe(first);
    expect(peekDragSource()).toEqual({ sampleId: 2, token: second });
  });

  it('consumeDragSource returns the live slot and clears it in the same call', () => {
    const token = armDragSource(7);

    expect(consumeDragSource()).toEqual({ sampleId: 7, token });
    expect(peekDragSource()).toBeNull();
  });

  it('consumeDragSource on an empty slot returns null rather than throwing', () => {
    consumeDragSource(); // ensure empty regardless of prior test state

    expect(consumeDragSource()).toBeNull();
  });

  it('clearDragSource(token) clears the slot when the token still matches the live arm', () => {
    const token = armDragSource(3);

    clearDragSource(token);

    expect(peekDragSource()).toBeNull();
  });

  it('a stale token clear is a no-op after re-arm: it never disturbs the newer slot', () => {
    const staleToken = armDragSource(1);
    const currentToken = armDragSource(2); // a second drag starts before the first's finally runs

    clearDragSource(staleToken);

    expect(peekDragSource()).toEqual({ sampleId: 2, token: currentToken });
  });

  it('clearDragSource after a drop already consumed its slot does not disturb a slot armed since', () => {
    const firstToken = armDragSource(1);
    expect(consumeDragSource()).toEqual({ sampleId: 1, token: firstToken }); // a drop claims it
    const secondToken = armDragSource(2); // a new drag arms before the first drag's finally runs

    clearDragSource(firstToken); // the first drag's late finally fires

    expect(peekDragSource()).toEqual({ sampleId: 2, token: secondToken });
  });

  it('clearDragSource on an already-empty slot is a no-op and never throws', () => {
    const token = armDragSource(9);
    clearDragSource(token);

    expect(() => clearDragSource(token)).not.toThrow();
    expect(peekDragSource()).toBeNull();
  });
});
