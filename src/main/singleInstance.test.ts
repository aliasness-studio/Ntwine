import { describe, expect, it, vi } from 'vitest';
import { claimStartup, revealPrimary, type RevealDeps, type WindowLike } from './singleInstance';

describe('claimStartup', () => {
  it('a Squirrel.Windows event launch never requests the lock', () => {
    const requestLock = vi.fn(() => true);
    expect(claimStartup({ squirrelEvent: true, configFailed: false, requestLock })).toBe('squirrel');
    expect(requestLock).not.toHaveBeenCalled();
  });
  it('a launch whose E2E config was refused never requests the lock', () => {
    const requestLock = vi.fn(() => true);
    expect(claimStartup({ squirrelEvent: false, configFailed: true, requestLock })).toBe('abort');
    expect(requestLock).not.toHaveBeenCalled();
  });
  it('the Squirrel check comes before the E2E config check', () => {
    const requestLock = vi.fn(() => true);
    expect(claimStartup({ squirrelEvent: true, configFailed: true, requestLock })).toBe('squirrel');
  });
  it('the lock holder is the primary instance', () => {
    const requestLock = vi.fn(() => true);
    expect(claimStartup({ squirrelEvent: false, configFailed: false, requestLock })).toBe('primary');
    expect(requestLock).toHaveBeenCalledTimes(1);
  });
  it('a launch that does not get the lock is a secondary instance', () => {
    expect(
      claimStartup({ squirrelEvent: false, configFailed: false, requestLock: () => false }),
    ).toBe('secondary');
  });
});

function win(over: Partial<WindowLike> = {}): WindowLike {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...over,
  };
}

function deps(over: Partial<RevealDeps>): RevealDeps {
  return {
    window: null,
    startupDone: true,
    createWindow: vi.fn(() => win()),
    focusApp: vi.fn(),
    ...over,
  };
}

describe('revealPrimary', () => {
  it('shows and focuses the existing window without restoring an unminimized one', () => {
    const w = win();
    const d = deps({ window: w });
    revealPrimary(d);
    expect(w.restore).not.toHaveBeenCalled();
    expect(w.show).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
    expect(d.focusApp).toHaveBeenCalledTimes(1);
    expect(d.createWindow).not.toHaveBeenCalled();
  });
  it('restores a minimized window before showing it', () => {
    const w = win({ isMinimized: vi.fn(() => true) });
    revealPrimary(deps({ window: w }));
    expect(w.restore).toHaveBeenCalledTimes(1);
    expect(w.show).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
  });
  it('treats a destroyed window as no window, and recreates one once startup is done', () => {
    const dead = win({ isDestroyed: vi.fn(() => true) });
    const fresh = win();
    const d = deps({ window: dead, createWindow: vi.fn(() => fresh) });
    revealPrimary(d);
    expect(dead.show).not.toHaveBeenCalled();
    expect(dead.isMinimized).not.toHaveBeenCalled();
    expect(d.createWindow).toHaveBeenCalledTimes(1);
    expect(fresh.focus).toHaveBeenCalledTimes(1);
    expect(d.focusApp).toHaveBeenCalledTimes(1);
  });
  it('recreates the window when none exists after startup (macOS keeps a windowless app alive)', () => {
    const d = deps({ window: null });
    revealPrimary(d);
    expect(d.createWindow).toHaveBeenCalledTimes(1);
  });
  it('before startup is done (a startup dialog is up) only focuses the app, and never throws', () => {
    const d = deps({ window: null, startupDone: false });
    expect(() => revealPrimary(d)).not.toThrow();
    expect(d.createWindow).not.toHaveBeenCalled();
    expect(d.focusApp).toHaveBeenCalledTimes(1);
  });
});
