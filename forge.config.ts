import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { version } from './package.json';
import { resolveSigning } from './scripts/signing.mjs';

/** The `.app` bundle `path` lives inside — Forge hooks get `<bundle>/Contents/Resources/app`. */
function enclosingAppBundle(path: string): string {
  for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
    if (dir.endsWith('.app')) return dir;
  }
  throw new Error(`packageAfterCopy: no .app bundle above ${path}`);
}

/** `plutil -remove`, tolerating only the key already being absent; any other failure throws. */
function removePlistKey(plist: string, key: string): void {
  try {
    execFileSync('plutil', ['-remove', key, plist], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (!stderr.includes('No value to remove')) throw err;
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Extension-less on purpose: @electron/packager appends the one the platform wants (.ico on
    // Windows, .icns on macOS) and ignores this on Linux, where the icon comes from the maker
    // options below instead. Both files are generated from assets/icon.svg by `yarn icons`.
    icon: 'assets/icon',
    appBundleId: 'com.aliasness.ntwine',
    appCategoryType: 'public.app-category.music',
    // Developer ID signing + notarization, only when NTWINE_SIGN_IDENTITY is set (see the file);
    // with no signing env both keys are undefined: an unsigned build, exactly as before.
    ...resolveSigning(process.env),
    // `--arch universal` lipo-merges every Mach-O file that differs between the x64 and arm64
    // builds and refuses any that is byte-identical in both unless it matches this glob.
    // better-sqlite3 ships each darwin prebuild as its own thin binary, and both land in both
    // per-arch builds, so both are identical across them; lib/binding.js picks
    // prebuilds/darwin-${process.arch}.node at runtime, so copying them through as-is is correct.
    osxUniversal: { x64ArchFiles: '**/better-sqlite3/prebuilds/darwin-{x64,arm64}.node' },
    // F7, part 2: @electron-forge/plugin-vite's own resolveForgeConfig sets packagerConfig.ignore
    // to `(file) => !file.startsWith('/.vite')` whenever ignore is still unset when it runs — i.e.
    // it excludes node_modules from the packaged app entirely, on the assumption Vite bundles
    // everything. True for every other dependency, but better-sqlite3 is deliberately `external`
    // in vite.main.config.ts (a native .node addon can't be bundled), so its real node_modules
    // subtree must survive packaging or `require('better-sqlite3')` fails with "Cannot find
    // module" before AutoUnpackNativesPlugin (below) ever gets a file to unpack from asar —
    // confirmed empirically: registering only the plugin still left app.asar with zero
    // node_modules entries (33 total, none matching better-sqlite3) and the boot probe still hung.
    // Setting `ignore` here (a function) makes VitePlugin skip its own default, so this replicates
    // that default's `.vite/**` allowance and adds the one native-dep carve-out; better-sqlite3's
    // own require graph (lib/binding.js) is self-contained — no bare-specifier requires beyond
    // itself — so no further node_modules subtree is needed.
    ignore: (file: string) => {
      if (!file) return false;
      if (file.startsWith('/.vite')) return false;
      // The copy-filter prunes a directory wholesale once `ignore()` returns true for it — it
      // never recurses to test children individually. `/node_modules` itself must stay "kept" (or
      // the walker never descends far enough to see `/node_modules/better-sqlite3` at all — verified
      // with a throwaway instrumented run: without this line, `/node_modules` was visited exactly
      // once and nothing under it ever was).
      if (file === '/node_modules') return false;
      if (file.startsWith('/node_modules/better-sqlite3')) return false;
      return true;
    },
  },
  // Skip @electron/rebuild's native-module pass entirely. Our ONLY native dep, better-sqlite3
  // v13, ships its runtime binary in prebuilds/<platform>-<arch>.node (lib/binding.js loads
  // ONLY from there) and its binding.gyp no-ops when a prebuild exists — verified: after a full
  // package, out/…/prebuilds/win32-x64.node is byte-identical (sha256) to the one in
  // node_modules, and no build/Release/*.node exists. The rebuild therefore compiles nothing —
  // but @electron/rebuild's pinned @electron/node-gyp still has to FIND Visual Studio to do
  // that nothing, and its VS discovery can't parse VS 2026 ("18", now on GitHub's
  // windows-latest runners): "unknown version \"undefined\"" → package fails. An empty
  // onlyModules list rebuilds no modules, so no VS is required to package on Windows at all.
  rebuildConfig: { onlyModules: [] },
  hooks: {
    // Spec C7: Electron's template Info.plist ships boilerplate microphone and camera usage
    // descriptions; Ntwine uses neither device. This hook runs on the copied bundle before the
    // packager reads Info.plist from disk and rewrites it, so the removal survives into the app.
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      if (platform !== 'darwin') return;
      const plist = join(enclosingAppBundle(buildPath), 'Contents', 'Info.plist');
      for (const key of ['NSMicrophoneUsageDescription', 'NSCameraUsageDescription']) {
        removePlistKey(plist, key);
      }
    },
  },
  makers: [
    // setupIcon dresses the installer .exe itself; iconUrl is the Add/Remove-Programs icon and
    // must be an http(s) URL Windows can fetch, so it points at the checked-in .ico on main.
    // `setupExe` puts the version and platform in the installer's name, so release assets from
    // different versions never collide.
    new MakerSquirrel({
      name: 'Ntwine',
      authors: 'AliasNess Studio',
      setupExe: `Ntwine-${version}-win32-x64-Setup.exe`,
      iconUrl: 'https://raw.githubusercontent.com/aliasness-studio/Ntwine/main/assets/icon.ico',
      setupIcon: 'assets/icon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    // The Linux packagers want one plain raster, not an .ico container.
    new MakerRpm({ options: { icon: 'assets/icon.png' } }),
    new MakerDeb({ options: { icon: 'assets/icon.png' } }),
  ],
  plugins: [
    // F7: better-sqlite3 is a native runtime dep (vite.main.config.ts externalizes it — see the
    // comment there) but a plain `asar: true` package never unpacks it, so a packaged app's
    // require('better-sqlite3') tries to dlopen a .node file from INSIDE app.asar, which the OS
    // loader can't do — the app hangs during main-process module load, before app.whenReady() ever
    // fires (confirmed via tests/e2e/packaged.spec.ts: no plugin → both probes hang to the 30s
    // SIGKILL ceiling, zero GPU/renderer child processes ever spawn). This plugin must run BEFORE
    // the packaging plugins below (Forge docs order) so VitePlugin's/FusesPlugin's asar step sees
    // the unpack list already populated.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
