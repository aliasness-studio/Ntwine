import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1, // one Electron instance at a time
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'default', grepInvert: /@real/ },
    { name: 'real', grep: /@real/, timeout: 15 * 60_000 }, // ~612 sequential live cover fetches
  ],
});
