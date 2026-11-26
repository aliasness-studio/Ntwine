import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { PlayerStore } from './PlayerStore';

// Not typed `: PlayPort` on purpose — keeping the inferred `Mock<...>` shape on each field is
// what lets assertions read `port.play` directly (see queue.test.ts's own `FakeWorker` comment:
// re-declaring an inherited method with a Mock-typed override on an `extends`-ed interface is
// what TS's stricter interface-extension check rejects; a bare object literal passed
// structurally into `new PlayerStore(...)` sidesteps that without ever needing the extends).
function makeFakePlayPort() {
  return {
    play: vi.fn<(sampleId: number) => void>(),
    stop: vi.fn<() => void>(),
    setVolume: vi.fn<(v: number) => void>(),
  };
}

describe('PlayerStore', () => {
  describe('select', () => {
    it('defaults to autoplay — a bare select(id) plays ("click a row -> it plays immediately")', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.select(7);

      expect(store.selectedId).toBe(7);
      expect(port.play).toHaveBeenCalledTimes(1);
      expect(port.play).toHaveBeenCalledWith(7);
    });

    it('select(id, { autoplay: true }) selects and plays', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.select(3, { autoplay: true });

      expect(store.selectedId).toBe(3);
      expect(port.play).toHaveBeenCalledWith(3);
    });

    it('select(id, { autoplay: false }) selects WITHOUT playing', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.select(3, { autoplay: false });

      expect(store.selectedId).toBe(3);
      expect(port.play).not.toHaveBeenCalled();
    });

    it('re-selecting the already-selected id with autoplay still re-plays it (click-to-replay)', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(3);

      store.select(3);

      expect(port.play).toHaveBeenCalledTimes(2);
    });
  });

  describe('moveSelection', () => {
    const visibleIds = [10, 20, 30, 40];

    it('from no selection, delta 1 (ArrowDown) lands on the FIRST visible id and plays it', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.moveSelection(1, visibleIds);

      expect(store.selectedId).toBe(10);
      expect(port.play).toHaveBeenCalledWith(10);
    });

    it('from no selection, delta -1 (ArrowUp) also lands on the FIRST visible id — no "wrap to the end"', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.moveSelection(-1, visibleIds);

      expect(store.selectedId).toBe(10);
      expect(port.play).toHaveBeenCalledWith(10);
    });

    it('steps forward one id at a time, playing each landing', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(20, { autoplay: false });

      store.moveSelection(1, visibleIds);
      expect(store.selectedId).toBe(30);
      expect(port.play).toHaveBeenNthCalledWith(1, 30);

      store.moveSelection(1, visibleIds);
      expect(store.selectedId).toBe(40);
      expect(port.play).toHaveBeenNthCalledWith(2, 40);
    });

    it('steps backward one id at a time, playing each landing', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(30, { autoplay: false });

      store.moveSelection(-1, visibleIds);

      expect(store.selectedId).toBe(20);
      expect(port.play).toHaveBeenCalledWith(20);
    });

    it('clamps at the TOP edge (no wrap) — repeated Down at the last id keeps landing on (and replaying) it', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(40, { autoplay: false });

      store.moveSelection(1, visibleIds);
      expect(store.selectedId).toBe(40);
      store.moveSelection(1, visibleIds);
      expect(store.selectedId).toBe(40);

      // Every landing plays — even a clamped, unchanged one.
      expect(port.play).toHaveBeenCalledTimes(2);
      expect(port.play).toHaveBeenCalledWith(40);
    });

    it('clamps at the BOTTOM edge (no wrap) — repeated Up at the first id keeps landing on (and replaying) it', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(10, { autoplay: false });

      store.moveSelection(-1, visibleIds);
      expect(store.selectedId).toBe(10);
      store.moveSelection(-1, visibleIds);
      expect(store.selectedId).toBe(10);

      expect(port.play).toHaveBeenCalledTimes(2);
      expect(port.play).toHaveBeenCalledWith(10);
    });

    it('a selected id no longer present in visibleIds (e.g. filtered out) is treated like no selection', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(999, { autoplay: false }); // not in visibleIds

      store.moveSelection(1, visibleIds);

      expect(store.selectedId).toBe(10);
      expect(port.play).toHaveBeenCalledWith(10);
    });

    it('is a no-op — no play, no selection change — when visibleIds is empty', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(10, { autoplay: false });

      store.moveSelection(1, []);

      expect(store.selectedId).toBe(10);
      expect(port.play).not.toHaveBeenCalled();
    });
  });

  describe('clearSelection', () => {
    it('clears the selection', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(7, { autoplay: false });

      store.clearSelection();

      expect(store.selectedId).toBeNull();
    });

    it('never calls play — the write emptied the scope, there is nothing left to sound', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(7, { autoplay: false });

      store.clearSelection();

      expect(port.play).not.toHaveBeenCalled();
    });

    it('is a safe no-op when nothing is selected', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.clearSelection();

      expect(store.selectedId).toBeNull();
      expect(port.play).not.toHaveBeenCalled();
    });
  });

  describe('replay', () => {
    it('re-plays the current selection', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(5, { autoplay: false });

      store.replay();

      expect(port.play).toHaveBeenCalledTimes(1);
      expect(port.play).toHaveBeenCalledWith(5);
    });

    it('is a no-op when nothing is selected', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.replay();

      expect(port.play).not.toHaveBeenCalled();
    });
  });

  describe('volume', () => {
    it('setVolume forwards to PlayPort.setVolume and updates the observable', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.setVolume(0.42);

      expect(store.volume).toBe(0.42);
      expect(port.setVolume).toHaveBeenCalledTimes(1);
      expect(port.setVolume).toHaveBeenCalledWith(0.42);
    });
  });

  it('starts with no selection and full volume', () => {
    const store = new PlayerStore(makeFakePlayPort());
    expect(store.selectedId).toBeNull();
    expect(store.volume).toBe(1);
  });

  // PlayerStore's actions are entirely synchronous (no `await` anywhere in this store), so there
  // is no post-await-mutation gap that COULD violate `enforceActions: 'observed'` — but this is
  // a cheap regression guard: a live observer (autorun) is what actually makes 'observed' mode
  // enforce anything (an unobserved mutation never warns, no matter where it happens — verified
  // against mobx's own source), so wiring one up here means this test would start failing the
  // moment any future change to this store introduced an unguarded async mutation.
  it('never triggers a MobX enforceActions warning under a live observer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new PlayerStore(makeFakePlayPort());
    const seen: (number | null)[] = [];
    const stop = autorun(() => {
      seen.push(store.selectedId);
    });

    store.select(1);
    store.moveSelection(1, [1, 2, 3]);
    store.replay();
    store.setVolume(0.5);
    store.clearSelection();

    stop();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([null, 1, 2, null]);
    warnSpy.mockRestore();
  });
});

// Transport dock (2026-08-23). Two gestures the v1 design deliberately left out, added because
// both failure modes are real in live use: a long sample you triggered by accident could only be
// RESTARTED (every action that changes "current" plays; nothing ever called `playPort.stop()`),
// and browsing with the arrow keys sounds every row it lands on whether you wanted that or not.
describe('PlayerStore — transport', () => {
  describe('stop', () => {
    it('calls through to the port — the gesture v1 had no caller for', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(7);

      store.stop();

      expect(port.stop).toHaveBeenCalledTimes(1);
    });

    it('leaves the selection alone, so ArrowLeft/Space can still replay what was stopped', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(7);

      store.stop();

      expect(store.selectedId).toBe(7);
      store.replay();
      expect(port.play).toHaveBeenLastCalledWith(7);
    });

    it('is safe with nothing selected — Stop is a panic button, never conditionally disabled', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      expect(() => store.stop()).not.toThrow();
      expect(port.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('autoplay preference', () => {
    it('defaults to on — the v1 behaviour is unchanged until you turn it off', () => {
      expect(new PlayerStore(makeFakePlayPort()).autoplay).toBe(true);
    });

    it('toggleAutoplay flips it', () => {
      const store = new PlayerStore(makeFakePlayPort());

      store.toggleAutoplay();
      expect(store.autoplay).toBe(false);
      store.toggleAutoplay();
      expect(store.autoplay).toBe(true);
    });

    it('off: a row click still SELECTS, it just does not sound', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.toggleAutoplay();

      store.select(7);

      expect(store.selectedId).toBe(7);
      expect(port.play).not.toHaveBeenCalled();
    });

    it('off: arrow keys still walk the list silently', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.toggleAutoplay();

      store.moveSelection(1, [1, 2, 3]);
      store.moveSelection(1, [1, 2, 3]);

      expect(store.selectedId).toBe(2);
      expect(port.play).not.toHaveBeenCalled();
    });

    // The whole point of the toggle: browsing goes quiet, but asking still works. ArrowLeft and
    // Space both route here (SampleList.tsx), and pressing either IS the explicit request.
    it('off: replay STILL plays — the preference gates landings, not explicit asks', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.select(7);
      store.toggleAutoplay();

      store.replay();

      expect(port.play).toHaveBeenCalledWith(7);
    });

    it('back on: landings sound again', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);
      store.toggleAutoplay();
      store.select(1);
      store.toggleAutoplay();

      store.select(2);

      expect(port.play).toHaveBeenCalledTimes(1);
      expect(port.play).toHaveBeenCalledWith(2);
    });

    // The per-call opt-out predates the preference (restoring a prior selection on mount must not
    // sound). Neither overrides the other: either one saying "no" is enough.
    it('on: an explicit { autoplay: false } still wins', () => {
      const port = makeFakePlayPort();
      const store = new PlayerStore(port);

      store.select(3, { autoplay: false });

      expect(store.selectedId).toBe(3);
      expect(port.play).not.toHaveBeenCalled();
    });
  });

  it('the new mutations trigger no MobX enforceActions warning under a live observer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new PlayerStore(makeFakePlayPort());
    const seen: boolean[] = [];
    const dispose = autorun(() => {
      seen.push(store.autoplay);
    });

    store.toggleAutoplay();
    store.stop();
    store.toggleAutoplay();

    dispose();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([true, false, true]);
    warnSpy.mockRestore();
  });
});
