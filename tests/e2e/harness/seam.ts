import type { ElectronApplication } from '@playwright/test';

/**
 * Records main-process seam events. `arm` installs a recorder in main and RESOLVES
 * ONLY AFTER it is installed — always `await seam.arm(...)` before the action under test, then
 * assert with `expect.poll(() => seam.count(...))`. Negatives are counters that stay flat while a
 * sibling positive increments — never "no event within a timeout".
 * `count` is CUMULATIVE since arm; `drain` EMPTIES the payload buffer and returns it — drain after
 * every payload assertion so the next drain holds only what happened since.
 */
export interface Seam {
  arm(name: string): Promise<void>;
  count(name: string): Promise<number>;
  drain<T = unknown>(name: string): Promise<T[]>;
}

type Slot = { count: number; payloads: unknown[] };
type G = typeof globalThis & { __ntwineSeam?: Record<string, Slot> };

export function createSeam(app: ElectronApplication): Seam {
  return {
    arm: (name) =>
      app.evaluate(({ app }, name) => {
        const g = globalThis as G;
        g.__ntwineSeam ??= {};
        if (g.__ntwineSeam[name]) return;
        const slot: Slot = { count: 0, payloads: [] };
        g.__ntwineSeam[name] = slot;
        // Electron's `App` type redeclares `on` with literal event-name overloads only (no
        // `string` catch-all — electron.d.ts:48ff), so a custom name needs the EventEmitter view.
        (app as unknown as NodeJS.EventEmitter).on(name, (payload: unknown) => {
          slot.count++;
          slot.payloads.push(payload);
        });
      }, name),
    count: (name) =>
      app.evaluate((_electron, name) => (globalThis as G).__ntwineSeam?.[name]?.count ?? 0, name),
    drain: <T,>(name: string) =>
      app.evaluate((_electron, name) => {
        const slot = (globalThis as G).__ntwineSeam?.[name];
        return (slot ? slot.payloads.splice(0) : []) as T[];
      }, name),
  };
}
