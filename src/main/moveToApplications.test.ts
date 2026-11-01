import { describe, expect, it, vi } from 'vitest';
import { MOVE_DECLINED_META, offerMove, shouldOfferMove, type MoveDeps } from './moveToApplications';

const OFFER = { platform: 'darwin', isPackaged: true, inApplications: false, declined: false, e2e: false };

describe('shouldOfferMove', () => {
  it('offers on a packaged darwin build running outside Applications', () => {
    expect(shouldOfferMove(OFFER)).toBe(true);
  });
  it('never offers on win32', () => {
    expect(shouldOfferMove({ ...OFFER, platform: 'win32' })).toBe(false);
  });
  it('never offers on an unpackaged (dev) run', () => {
    expect(shouldOfferMove({ ...OFFER, isPackaged: false })).toBe(false);
  });
  it('never offers when already in Applications', () => {
    expect(shouldOfferMove({ ...OFFER, inApplications: true })).toBe(false);
  });
  it('never offers again once declined', () => {
    expect(shouldOfferMove({ ...OFFER, declined: true })).toBe(false);
  });
  it('never offers in E2E mode', () => {
    expect(shouldOfferMove({ ...OFFER, e2e: true })).toBe(false);
  });
});

function deps(over: Partial<MoveDeps>): MoveDeps {
  return {
    ask: vi.fn(async () => 'move' as const),
    move: vi.fn(() => true),
    remember: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

describe('offerMove', () => {
  it('uses the catalog meta key move_to_applications_declined', () => {
    expect(MOVE_DECLINED_META).toBe('move_to_applications_declined');
  });
  it("'later' remembers the decline and does not move", async () => {
    const d = deps({ ask: vi.fn(async () => 'later' as const) });
    await expect(offerMove(d)).resolves.toBe('declined');
    expect(d.remember).toHaveBeenCalledTimes(1);
    expect(d.move).not.toHaveBeenCalled();
  });
  it("'move' + successful move ⇒ 'moved', nothing remembered", async () => {
    const d = deps({});
    await expect(offerMove(d)).resolves.toBe('moved');
    expect(d.move).toHaveBeenCalledTimes(1);
    expect(d.remember).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });
  it("'move' + move() returning false ⇒ logs and 'failed', nothing remembered", async () => {
    const d = deps({ move: vi.fn(() => false) });
    await expect(offerMove(d)).resolves.toBe('failed');
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.remember).not.toHaveBeenCalled();
  });
  it("'move' + move() throwing ⇒ logs the error and 'failed' (treated exactly like false)", async () => {
    const d = deps({
      move: vi.fn(() => {
        throw new Error('EACCES');
      }),
    });
    await expect(offerMove(d)).resolves.toBe('failed');
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    expect(d.remember).not.toHaveBeenCalled();
  });
});
