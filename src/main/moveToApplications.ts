/**
 * Move-to-Applications offer. An app launched from ~/Downloads is App
 * Translocated by macOS (run from a randomized read-only mount), and Squirrel.Mac cannot replace
 * a translocated bundle — so the app offers, once, to move itself to /Applications.
 * Pure on purpose (the e2e.ts pattern): no runtime Electron import, so it runs under Vitest;
 * main.ts passes in the real dialog / app.moveToApplicationsFolder / catalog meta.
 */

/** Catalog meta key; '1' once the user chose "Don't Move" (or pressed Esc, which is the same
 * button) — the offer is never repeated. */
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

export interface MoveDeps {
  ask: () => Promise<'move' | 'later'>;
  /** true ⇒ moved (Electron relaunches from /Applications and quits this instance itself). */
  move: () => boolean;
  remember: () => void;
  log: (m: string) => void;
}

/** 'failed' leaves the user-facing message to main.ts; nothing is remembered on failure, so the
 * offer comes back next launch. A throwing move() is treated exactly like false. */
export async function offerMove(deps: MoveDeps): Promise<'moved' | 'declined' | 'failed'> {
  if ((await deps.ask()) === 'later') {
    deps.remember();
    return 'declined';
  }
  let moved: boolean;
  try {
    moved = deps.move();
  } catch (err) {
    deps.log(`moveToApplicationsFolder threw: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
  if (moved) return 'moved';
  deps.log('moveToApplicationsFolder returned false');
  return 'failed';
}
