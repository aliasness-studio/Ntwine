import { describe, expect, it, vi } from 'vitest';
import {
  applicationsCopyPath,
  compareVersions,
  MOVE_DECLINED_META,
  offerMove,
  openAfterExit,
  planMove,
  promptText,
  shouldOfferMove,
  type ConflictType,
  type MoveDeps,
  type MovePrompt,
} from './moveToApplications';

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

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.1.2', -1],
    ['0.1.2', '0.1.0', 1],
    ['0.1.2', '0.1.2', 0],
    ['0.9.0', '0.10.0', -1],
    ['1.0.0', '0.99.99', 1],
    ['0.2.0-rc.1', '0.2.0', -1],
    ['0.2.0', '0.2.0-rc.1', 1],
    ['0.2.0-rc.1', '0.2.0-rc.2', -1],
    ['0.2.0-rc.2', '0.2.0-rc.10', -1],
    ['0.2.0-rc.1', '0.1.9', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta.11', '1.0.0-rc.1', -1],
    ['1.0.0-rc.1', '1.0.0-rc.1', 0],
    ['1.0.0+build.5', '1.0.0', 0],
  ] as const)('%s vs %s → %d', (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });
  it.each([['', '0.1.0'], ['0.1', '0.1.0'], ['v0.1.0', '0.1.0'], ['0.1.0', 'garbage'], ['0.1.0-', '0.1.0']])(
    '%j vs %j is not comparable (null)',
    (a, b) => {
      expect(compareVersions(a, b)).toBeNull();
    },
  );
});

describe('planMove', () => {
  it('no copy in Applications ⇒ the plain move offer', () => {
    expect(planMove({ kind: 'none' }, '0.1.2')).toEqual({ kind: 'move' });
  });
  it('an older copy ⇒ offer to replace it, naming both versions', () => {
    expect(planMove({ kind: 'present', version: '0.1.0' }, '0.1.2')).toEqual({
      kind: 'replace',
      installed: '0.1.0',
      running: '0.1.2',
    });
  });
  it('an older prerelease copy of the same version ⇒ replace', () => {
    expect(planMove({ kind: 'present', version: '0.2.0-rc.1' }, '0.2.0').kind).toBe('replace');
  });
  it('the same version ⇒ already installed, never a replace', () => {
    expect(planMove({ kind: 'present', version: '0.1.2' }, '0.1.2')).toEqual({
      kind: 'installed',
      installed: '0.1.2',
      running: '0.1.2',
      relation: 'same',
    });
  });
  it('a newer copy ⇒ already installed, never a replace', () => {
    expect(planMove({ kind: 'present', version: '0.2.0' }, '0.1.2')).toEqual({
      kind: 'installed',
      installed: '0.2.0',
      running: '0.1.2',
      relation: 'newer',
    });
  });
  it('an unreadable version ⇒ unknown, never claims a version', () => {
    expect(planMove({ kind: 'present', version: null }, '0.1.2')).toEqual({
      kind: 'replace-unknown',
      running: '0.1.2',
    });
  });
  it('an unparseable version ⇒ unknown', () => {
    expect(planMove({ kind: 'present', version: 'Dict {' }, '0.1.2').kind).toBe('replace-unknown');
  });
});

describe('promptText', () => {
  it('the plain move offer keeps its wording', () => {
    expect(promptText({ kind: 'move' })).toEqual({
      message: 'Move Ntwine to your Applications folder?',
      detail: 'Ntwine updates itself only when it runs from Applications.',
      buttons: ['Move to Applications', "Don't Move"],
      defaultId: 0,
      cancelId: 1,
    });
  });
  it('the replace offer names both versions', () => {
    const t = promptText({ kind: 'replace', installed: '0.1.0', running: '0.1.2' });
    expect(t.message).toBe('Replace Ntwine 0.1.0 in Applications with 0.1.2?');
    expect(t.buttons).toEqual(['Replace', "Don't Replace"]);
    expect(t.defaultId).toBe(0);
    expect(t.cancelId).toBe(1);
  });
  it('the unknown-version offer claims no version for the installed copy and defaults to not replacing', () => {
    const t = promptText({ kind: 'replace-unknown', running: '0.1.2' });
    expect(t.message).toBe('Replace the copy of Ntwine in Applications with 0.1.2?');
    expect(t.detail).toMatch(/can't tell which version/);
    expect(t.buttons).toEqual(['Replace', "Don't Replace"]);
    expect(t.defaultId).toBe(1);
    expect(t.cancelId).toBe(1);
  });
  it('an installed copy of the same version: open it or keep this one, which will not update', () => {
    const t = promptText({ kind: 'installed', installed: '0.1.2', running: '0.1.2', relation: 'same' });
    expect(t.message).toBe('Ntwine 0.1.2 is already in your Applications folder.');
    expect(t.detail).toMatch(/same version/);
    expect(t.detail).toMatch(/won't update itself/);
    expect(t.buttons).toEqual(['Open That Copy', 'Keep Using This One']);
    expect(t.defaultId).toBe(0);
    expect(t.cancelId).toBe(1);
  });
  it('an installed newer copy names this copy as the older one', () => {
    const t = promptText({ kind: 'installed', installed: '0.2.0', running: '0.1.2', relation: 'newer' });
    expect(t.message).toBe('Ntwine 0.2.0 is already in your Applications folder.');
    expect(t.detail).toMatch(/older version \(0\.1\.2\)/);
    expect(t.detail).toMatch(/won't update itself/);
  });
});

describe('applicationsCopyPath', () => {
  it('is /Applications plus the running bundle name, which is where moveToApplicationsFolder writes', () => {
    expect(applicationsCopyPath('/Users/x/Downloads/Ntwine.app/Contents/MacOS/Ntwine')).toBe(
      '/Applications/Ntwine.app',
    );
    expect(
      applicationsCopyPath('/private/var/folders/ab/T/AppTranslocation/U/d/Ntwine 2.app/Contents/MacOS/Ntwine'),
    ).toBe('/Applications/Ntwine 2.app');
  });
});

describe('openAfterExit', () => {
  it('waits for this pid to exit, then opens the bundle through LaunchServices; pid and path are arguments, not script text', () => {
    const { file, args } = openAfterExit(4242, "/Applications/Ntwine's.app");
    expect(file).toBe('/bin/sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('/bin/kill -0 "$1"');
    expect(args[1]).toContain('/usr/bin/open "$2"');
    expect(args[1]).not.toContain('4242');
    expect(args.slice(2)).toEqual(['sh', '4242', "/Applications/Ntwine's.app"]);
  });
});

function deps(over: Partial<MoveDeps>): MoveDeps {
  return {
    running: '0.1.2',
    inspect: vi.fn(async () => ({ kind: 'none' as const })),
    ask: vi.fn(async () => 'accept' as const),
    move: vi.fn(() => true),
    remember: vi.fn(),
    log: vi.fn(),
    ...over,
  };
}

/** A move() that reports `type` to Electron's conflict handler and does what Electron does with
 * the answer: false stops the move (move returns false), true replaces. */
function moveWithConflict(type: ConflictType) {
  const seen: boolean[] = [];
  const move = vi.fn((handler: (t: ConflictType) => boolean) => {
    const ok = handler(type);
    seen.push(ok);
    return ok;
  });
  return { move, seen };
}

describe('offerMove', () => {
  it('uses the catalog meta key move_to_applications_declined', () => {
    expect(MOVE_DECLINED_META).toBe('move_to_applications_declined');
  });

  describe('no copy in Applications', () => {
    it('asks the plain move question', async () => {
      const d = deps({});
      await offerMove(d);
      expect(d.ask).toHaveBeenCalledWith({ kind: 'move' } satisfies MovePrompt);
    });
    it("decline remembers and does not move", async () => {
      const d = deps({ ask: vi.fn(async () => 'decline' as const) });
      await expect(offerMove(d)).resolves.toBe('declined');
      expect(d.remember).toHaveBeenCalledTimes(1);
      expect(d.move).not.toHaveBeenCalled();
    });
    it("accept + successful move ⇒ 'moved', nothing remembered", async () => {
      const d = deps({});
      await expect(offerMove(d)).resolves.toBe('moved');
      expect(d.move).toHaveBeenCalledTimes(1);
      expect(d.remember).not.toHaveBeenCalled();
      expect(d.log).not.toHaveBeenCalled();
    });
    it("accept + move() returning false ⇒ logs and 'failed', nothing remembered", async () => {
      const d = deps({ move: vi.fn(() => false) });
      await expect(offerMove(d)).resolves.toBe('failed');
      expect(d.log).toHaveBeenCalledTimes(1);
      expect(d.remember).not.toHaveBeenCalled();
    });
    it("accept + move() throwing ⇒ logs the error and 'failed' (treated exactly like false)", async () => {
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
    it('a copy that appeared after the check is never overwritten (the user was not asked about it)', async () => {
      const { move, seen } = moveWithConflict('exists');
      const d = deps({ move });
      await expect(offerMove(d)).resolves.toBe('failed');
      expect(seen).toEqual([false]);
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('appeared'));
    });
  });

  describe('an older copy in Applications', () => {
    const inspect = vi.fn(async () => ({ kind: 'present' as const, version: '0.1.0' }));
    it('asks to replace it, naming both versions', async () => {
      const d = deps({ inspect, move: moveWithConflict('exists').move });
      await offerMove(d);
      expect(d.ask).toHaveBeenCalledWith({ kind: 'replace', installed: '0.1.0', running: '0.1.2' });
    });
    it("accept replaces the existing copy ⇒ 'moved'", async () => {
      const { move, seen } = moveWithConflict('exists');
      const d = deps({ inspect, move });
      await expect(offerMove(d)).resolves.toBe('moved');
      expect(seen).toEqual([true]);
      expect(d.remember).not.toHaveBeenCalled();
    });
    it('decline is remembered and nothing moves', async () => {
      const d = deps({ inspect, ask: vi.fn(async () => 'decline' as const) });
      await expect(offerMove(d)).resolves.toBe('declined');
      expect(d.remember).toHaveBeenCalledTimes(1);
      expect(d.move).not.toHaveBeenCalled();
    });
    it("a copy that is running is never replaced ⇒ 'installed-running', nothing remembered", async () => {
      const { move, seen } = moveWithConflict('existsAndRunning');
      const d = deps({ inspect, move });
      await expect(offerMove(d)).resolves.toBe('installed-running');
      expect(seen).toEqual([false]);
      expect(d.remember).not.toHaveBeenCalled();
      expect(d.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('an unreadable copy in Applications', () => {
    const inspect = vi.fn(async () => ({ kind: 'present' as const, version: null }));
    it('asks without claiming a version; accept replaces', async () => {
      const { move, seen } = moveWithConflict('exists');
      const d = deps({ inspect, move });
      await expect(offerMove(d)).resolves.toBe('moved');
      expect(d.ask).toHaveBeenCalledWith({ kind: 'replace-unknown', running: '0.1.2' });
      expect(seen).toEqual([true]);
    });
    it('decline is remembered', async () => {
      const d = deps({ inspect, ask: vi.fn(async () => 'decline' as const) });
      await expect(offerMove(d)).resolves.toBe('declined');
      expect(d.remember).toHaveBeenCalledTimes(1);
      expect(d.move).not.toHaveBeenCalled();
    });
    it('an inspect() that throws is treated as an unreadable copy, never as a free path', async () => {
      const d = deps({
        inspect: vi.fn(async () => {
          throw new Error('EPERM');
        }),
        ask: vi.fn(async () => 'decline' as const),
      });
      await offerMove(d);
      expect(d.ask).toHaveBeenCalledWith({ kind: 'replace-unknown', running: '0.1.2' });
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    });
    it('a running copy is never replaced', async () => {
      const { move, seen } = moveWithConflict('existsAndRunning');
      await expect(offerMove(deps({ inspect, move }))).resolves.toBe('installed-running');
      expect(seen).toEqual([false]);
    });
  });

  describe.each([
    ['same', '0.1.2'],
    ['newer', '0.2.0'],
  ] as const)('a %s copy in Applications', (relation, version) => {
    const inspect = vi.fn(async () => ({ kind: 'present' as const, version }));
    it('never moves; accept ⇒ open that copy', async () => {
      const d = deps({ inspect });
      await expect(offerMove(d)).resolves.toBe('open-installed');
      expect(d.ask).toHaveBeenCalledWith({ kind: 'installed', installed: version, running: '0.1.2', relation });
      expect(d.move).not.toHaveBeenCalled();
      expect(d.remember).not.toHaveBeenCalled();
    });
    it("decline ⇒ keep using this one, NOT remembered (the next launch of this copy asks again)", async () => {
      const d = deps({ inspect, ask: vi.fn(async () => 'decline' as const) });
      await expect(offerMove(d)).resolves.toBe('kept');
      expect(d.move).not.toHaveBeenCalled();
      expect(d.remember).not.toHaveBeenCalled();
    });
  });
});
