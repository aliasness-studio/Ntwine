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
    },
  },
});
