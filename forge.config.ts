import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
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
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
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
