import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The window icon for `yarn start`, or undefined when there isn't one.
 *
 * On Windows the icon a user actually sees on a packaged build — taskbar, Alt-Tab, the exe in
 * Explorer — comes from the executable's embedded resource, which Forge writes from
 * `packagerConfig.icon`. This is only for the unpackaged dev run, where there is no such
 * executable and the window would otherwise wear Electron's default atom.
 *
 * `exists` is injected so the decision can be tested without a filesystem.
 */
export function resolveWindowIcon(appPath: string, exists: (file: string) => boolean = existsSync): string | undefined {
  const icon = path.join(appPath, 'assets', 'icon.ico');
  return exists(icon) ? icon : undefined;
}
