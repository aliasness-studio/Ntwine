import { describe, expect, it, vi } from 'vitest';
import type { PlayPort } from './stores/PlayerStore';
import { installE2ESnapshot, wrapPlayPort } from './e2eSnapshot';

const fakePort = (): PlayPort => ({ play: vi.fn(), stop: vi.fn(), setVolume: vi.fn() });

describe('wrapPlayPort', () => {
  it('unarmed: returns the SAME port object — nothing wrapped, nothing counted', () => {
    const base = fakePort();
    const { port, counters } = wrapPlayPort(base, false);
    expect(port).toBe(base);
    port.play(7);
    expect(counters()).toStrictEqual({ playCount: 0, lastPlayedId: null, stopCount: 0 });
  });
  it('armed: counts plays and records the last id, then delegates every method', () => {
    const base = fakePort();
    const { port, counters } = wrapPlayPort(base, true);
    expect(port).not.toBe(base);
    port.play(3); port.play(9); port.stop(); port.setVolume(0.3);
    expect(counters()).toStrictEqual({ playCount: 2, lastPlayedId: 9, stopCount: 1 });
    expect(base.play).toHaveBeenNthCalledWith(1, 3);
    expect(base.play).toHaveBeenNthCalledWith(2, 9);
    expect(base.stop).toHaveBeenCalledOnce();
    expect(base.setVolume).toHaveBeenCalledWith(0.3);
  });
});

describe('installE2ESnapshot', () => {
  it('unarmed: never attaches — the property stays absent (spec §4 security row)', () => {
    const target: { __ntwineE2E?: unknown } = {};
    installE2ESnapshot(target, false, () => { throw new Error('must not be read'); });
    expect('__ntwineE2E' in target).toBe(false);
  });
  it('armed: attaches synchronously and returns the live reading on every call', () => {
    const target: { __ntwineE2E?: () => unknown } = {};
    let n = 0;
    installE2ESnapshot(target, true, () => ({ n: ++n }) as never);
    expect(typeof target.__ntwineE2E).toBe('function');
    expect(target.__ntwineE2E!()).toStrictEqual({ n: 1 });
    expect(target.__ntwineE2E!()).toStrictEqual({ n: 2 });
  });
});
