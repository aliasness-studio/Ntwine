import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Electron Forge's VitePlugin aliases its own `entry: 'src/main.ts'` (forge.config.ts) to
      // `build.lib.entry`, which only ever produces one output file. `peaksWorker.ts` (Task 10)
      // needs to ship as its OWN separate bundle beside `main.js` — a utilityProcess child loads
      // it as an independent Node entry point, never something `main.js` imports — so a second
      // named entry is declared here instead. Vite's lib-mode build prefers an explicit
      // `rollupOptions.input` over the forge-derived single `lib.entry`, which is what makes
      // this the documented Electron Forge Vite pattern for utilityProcess/worker entries.
      // `[name].js` (forge's own `lib.fileName`) is what emits `main.js` + `peaksWorker.js` side
      // by side in `.vite/build/` — `path.join(__dirname, 'peaksWorker.js')` in queue.ts's
      // `WORKER_PATH` depends on that pairing. Verified via `yarn start` (Task 10 report).
      input: {
        main: 'src/main.ts',
        peaksWorker: 'src/main/waveforms/peaksWorker.ts',
      },
      // better-sqlite3 ships a compiled native addon (Release/better_sqlite3.node) located
      // through its own dynamic `require()` (a runtime path search, not a static string) —
      // Rollup's commonjs plugin can't resolve that when the module gets INLINED into the
      // bundle, and the inlined copy throws at runtime instead: "Could not dynamically require
      // .../Release/better_sqlite3.node" (discovered via `yarn start` in Task 11 — the first
      // code path to call `openCatalog` from the real bundled main.js rather than through the
      // ELECTRON_RUN_AS_NODE vitest path, which imports the TS source directly and never hits
      // Rollup's bundling at all). `external` leaves `require('better-sqlite3')` as a real
      // Node require against node_modules at runtime — the standard fix for bundling a native
      // Node addon — instead of inlining a module whose own loader depends on NOT being bundled.
      // `@electron-forge/plugin-auto-unpack-natives` (spec §9.2) is a separate, later concern —
      // for ASAR packaging specifically, which `yarn start`'s dev mode never invokes.
      external: ['better-sqlite3'],
    },
  },
});
