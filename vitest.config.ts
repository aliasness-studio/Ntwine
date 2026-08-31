import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/` holds developer tooling (the icon pipeline), not app code, so it is plain ESM
    // JavaScript rather than TypeScript — it runs directly under `electron scripts/…` with no
    // build step. Its pure parts still get the same test treatment as everything else.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // 30 s, not vitest's default 5 s. These are disk-bound tests, not slow logic: the catalog
    // and importer suites mkdtemp a fresh directory and build REAL SQLite files per test —
    // queries.test.ts does it 44 times over, three temp dirs at a time. Locally that file
    // finishes in ~1.5 s; on a Defender-scanned windows-latest runner the same file has taken
    // 50 s, and individual SYNCHRONOUS test bodies crossed the 5 s wall (vitest reports those
    // as "timed out" only once the body returns, so it lands as a red run with no assertion
    // failure anywhere in it — see run 32421578866, 2026-08-20). The ceiling is here to catch a
    // genuine hang, so it belongs above the slowest honest runner, not above the fastest.
    testTimeout: 30_000,
  },
});
