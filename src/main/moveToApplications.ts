import { posix } from 'node:path';

/**
 * Move-to-Applications offer. An app launched from ~/Downloads is App
 * Translocated by macOS (run from a randomized read-only mount), and Squirrel.Mac cannot replace
 * a translocated bundle — so the app offers, once, to move itself to /Applications.
 * Pure on purpose (the e2e.ts pattern): no runtime Electron import, so it runs under Vitest;
 * main.ts passes in the real dialog / app.moveToApplicationsFolder / catalog meta / Info.plist read.
 *
 * A copy already in Applications is never overwritten without asking, and never by a copy that is
 * not newer: opening an old download must not downgrade the installed app.
 */

/** Catalog meta key; '1' once the user chose "Don't Move" or "Don't Replace" (or pressed Esc, which
 * is the same button) — the offer is never repeated. */
export const MOVE_DECLINED_META = 'move_to_applications_declined';

/** Packaged darwin builds outside /Applications that have not declined, never in E2E mode.
 * Non-darwin returns false first, so main.ts never calls the macOS-only Electron APIs elsewhere. */
export function shouldOfferMove(a: {
  platform: string;
  isPackaged: boolean;
  inApplications: boolean;
  declined: boolean;
  e2e: boolean;
}): boolean {
  return a.platform === 'darwin' && a.isPackaged && !a.inApplications && !a.declined && !a.e2e;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  // A numeric identifier sorts below an alphanumeric one.
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic Versioning 2.0.0 precedence: -1, 0 or 1 for a <, =, > b, or null when either is not a
 * semver string. A prerelease sorts below its release (`0.2.0-rc.1` < `0.2.0`); build metadata is
 * ignored. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Math.sign(Number(pa[i]) - Number(pb[i]));
    if (d !== 0) return d as -1 | 1;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined) {
    if (ra === rb) return 0;
    return ra === undefined ? 1 : -1;
  }
  const ia = ra.split('.');
  const ib = rb.split('.');
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const d = compareIdentifiers(ia[i], ib[i]);
    if (d !== 0) return d as -1 | 1;
  }
  return Math.sign(ia.length - ib.length) as -1 | 0 | 1;
}

/** What is at the move's destination. `version` is the copy's CFBundleShortVersionString, or null
 * when it could not be read (missing or corrupt Info.plist). */
export type InstalledCopy = { kind: 'none' } | { kind: 'present'; version: string | null };

/** 'move' — nothing there. 'replace' — an older copy. 'replace-unknown' — a copy whose version
 * could not be read or compared. 'installed' — the same or a newer copy, which is never replaced. */
export type MovePrompt =
  | { kind: 'move' }
  | { kind: 'replace'; installed: string; running: string }
  | { kind: 'replace-unknown'; running: string }
  | { kind: 'installed'; installed: string; running: string; relation: 'same' | 'newer' };

export function planMove(installed: InstalledCopy, running: string): MovePrompt {
  if (installed.kind === 'none') return { kind: 'move' };
  const cmp = installed.version === null ? null : compareVersions(installed.version, running);
  if (installed.version === null || cmp === null) return { kind: 'replace-unknown', running };
  if (cmp < 0) return { kind: 'replace', installed: installed.version, running };
  return { kind: 'installed', installed: installed.version, running, relation: cmp === 0 ? 'same' : 'newer' };
}

const UPDATES_ONLY_FROM_APPLICATIONS = 'Ntwine updates itself only when it runs from Applications.';

/** The dialog for each prompt. Button 0 always accepts (move, replace, open that copy) and button 1
 * always declines; Esc presses cancelId, which is always the decline. Where accepting could replace
 * a copy of unknown version, Return defaults to the decline as well. */
export function promptText(p: MovePrompt): {
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: 0 | 1;
  cancelId: 1;
} {
  switch (p.kind) {
    case 'move':
      return {
        message: 'Move Ntwine to your Applications folder?',
        detail: UPDATES_ONLY_FROM_APPLICATIONS,
        buttons: ['Move to Applications', "Don't Move"],
        defaultId: 0,
        cancelId: 1,
      };
    case 'replace':
      return {
        message: `Replace Ntwine ${p.installed} in Applications with ${p.running}?`,
        detail: `The copy in Applications is older. ${UPDATES_ONLY_FROM_APPLICATIONS}`,
        buttons: ['Replace', "Don't Replace"],
        defaultId: 0,
        cancelId: 1,
      };
    case 'replace-unknown':
      return {
        message: `Replace the copy of Ntwine in Applications with ${p.running}?`,
        detail:
          "Ntwine can't tell which version the copy in Applications is. Replace it only if you know " +
          `it is older. ${UPDATES_ONLY_FROM_APPLICATIONS}`,
        buttons: ['Replace', "Don't Replace"],
        defaultId: 1,
        cancelId: 1,
      };
    case 'installed':
      return {
        message: `Ntwine ${p.installed} is already in your Applications folder.`,
        detail:
          p.relation === 'same'
            ? "This copy is the same version, but it runs from outside Applications, so it won't update itself."
            : `This copy is an older version (${p.running}), and it runs from outside Applications, so it won't update itself.`,
        buttons: ['Open That Copy', 'Keep Using This One'],
        defaultId: 0,
        cancelId: 1,
      };
  }
}

/** Where app.moveToApplicationsFolder puts this bundle: the local-domain Applications folder plus
 * the running bundle's own file name (`<bundle>.app/Contents/MacOS/<exe>` → `/Applications/<bundle>.app`).
 * Derived the same way so the copy inspected is exactly the one a move would replace. */
export function applicationsCopyPath(execPath: string): string {
  const bundle = posix.dirname(posix.dirname(posix.dirname(execPath)));
  return posix.join('/Applications', posix.basename(bundle));
}

/** A detached shell command that waits for `pid` to exit, then opens `bundle` through LaunchServices
 * — the same wait Electron's own move relaunch uses. Waiting matters: the other copy shares this
 * one's user data, so it would otherwise find the single-instance lock still held and quit. The pid
 * and path travel as positional arguments, never spliced into the script. */
export function openAfterExit(pid: number, bundle: string): { file: string; args: string[] } {
  return {
    file: '/bin/sh',
    args: [
      '-c',
      'while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.1; done; exec /usr/bin/open "$2"',
      'sh',
      String(pid),
      bundle,
    ],
  };
}

/** Electron's conflictHandler argument. */
export type ConflictType = 'exists' | 'existsAndRunning';

export interface MoveDeps {
  /** This copy's version (app.getVersion()). */
  running: string;
  /** What is at applicationsCopyPath(). A throw is treated as a copy of unknown version. */
  inspect: () => Promise<InstalledCopy>;
  ask: (prompt: MovePrompt) => Promise<'accept' | 'decline'>;
  /** app.moveToApplicationsFolder with the given conflictHandler. true ⇒ moved (Electron relaunches
   * from /Applications and quits this instance itself). */
  move: (conflictHandler: (type: ConflictType) => boolean) => boolean;
  remember: () => void;
  log: (m: string) => void;
}

/** 'moved' — Electron is relaunching from Applications. 'declined' — remembered. 'failed' — the
 * user-facing message is main.ts's; nothing is remembered, so the offer comes back next launch.
 * 'open-installed' — launch the copy in Applications and quit. 'kept' — carry on from here, not
 * remembered: the copy in Applications is the same or newer, so running this one is almost always
 * a mistake worth pointing out again, and the decline flag lives in the catalog every copy shares,
 * where it would also silence the replace offer of a later, newer download. 'installed-running' —
 * the copy in Applications is open, so it was left alone. */
export type MoveOutcome = 'moved' | 'declined' | 'failed' | 'open-installed' | 'kept' | 'installed-running';

export async function offerMove(deps: MoveDeps): Promise<MoveOutcome> {
  let installed: InstalledCopy;
  try {
    installed = await deps.inspect();
  } catch (err) {
    deps.log(`inspecting the copy in Applications threw: ${err instanceof Error ? err.message : String(err)}`);
    installed = { kind: 'present', version: null };
  }
  const prompt = planMove(installed, deps.running);
  const answer = await deps.ask(prompt);
  if (prompt.kind === 'installed') return answer === 'accept' ? 'open-installed' : 'kept';
  if (answer === 'decline') {
    deps.remember();
    return 'declined';
  }

  // Replacing is allowed only where the user was just asked about a copy in Applications, and
  // never while that copy is running (Electron would focus it and quit this one).
  // Asserted rather than annotated: assigned only inside the handler, which TS's narrowing of the
  // `null` initializer cannot see.
  let refused = null as 'running' | 'unexpected' | null;
  const conflictHandler = (type: ConflictType): boolean => {
    if (type === 'exists' && prompt.kind !== 'move') return true;
    refused = type === 'existsAndRunning' ? 'running' : 'unexpected';
    return false;
  };
  let moved: boolean;
  try {
    moved = deps.move(conflictHandler);
  } catch (err) {
    deps.log(`moveToApplicationsFolder threw: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
  if (moved) return 'moved';
  if (refused === 'running') {
    deps.log('the copy in Applications is running; not replacing it');
    return 'installed-running';
  }
  if (refused === 'unexpected') {
    deps.log('a copy appeared in Applications after it was checked; not replacing it');
    return 'failed';
  }
  deps.log('moveToApplicationsFolder returned false');
  return 'failed';
}
