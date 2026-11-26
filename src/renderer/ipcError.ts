// The ONE shared helper for turning a caught IPC-invoke rejection into user-facing text — used by
// `UserLayerStore.ts` and `CollectionPopover.tsx` instead of duplicate `errorMessage` copies.
//
// Electron's `ipcRenderer.invoke` cannot structured-clone a custom `Error` subclass across the
// contextIsolation boundary, so a rejected `ipcMain.handle` handler arrives in the renderer as a
// GENERIC `Error` whose `.message` Electron itself has decorated:
// `Error invoking remote method '<channel>': <name>: <message>` — the trailing `<name>: <message>`
// half is the original error's own `Error.prototype.toString()` (the standard `${name}:
// ${message}` format), which is why `UserNameError`'s own `this.name = 'UserNameError'`
// (`src/main/user/userDb.ts`) shows up literally rather than being a minification artifact.
// `collections.spec.ts` caught this live: `LibraryRail`'s/`CollectionPopover`'s inline
// alerts were showing that whole decorated string instead of the clean domain message `userDb.ts`
// actually throws.
//
// Both strips below are anchored to the START of the message and applied in this fixed order:
// (1) the Electron wrapper — always noise, regardless of what the original error was; (2) the
// `UserNameError:` prefix SPECIFICALLY, not a generic `\w+Error:` pattern — an unexpected SYSTEM error (a `TypeError`, or anything that isn't this one known
// domain error) must stay visible with its own name intact after (1) strips the Electron noise, so
// a real bug still surfaces as something identifiable instead of being laundered into a
// misleadingly "clean"-looking string.
//
// NOTE for a future IPC redesign: this module exists only because `invoke`/`handle` throws across
// the process boundary. If the user-layer IPC surface is ever redesigned to return an explicit
// `{ error }` result instead of rejecting, this stripping becomes
// unnecessary and the module can go away entirely.
const INVOKE_WRAPPER_PREFIX = /^Error invoking remote method '[^']+':\s*/;
const USER_NAME_ERROR_PREFIX = /^UserNameError:\s*/;

export function ipcErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.message.replace(INVOKE_WRAPPER_PREFIX, '').replace(USER_NAME_ERROR_PREFIX, '');
}
