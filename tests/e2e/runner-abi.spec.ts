import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';

// Proves the runner process itself is on Electron's ABI: the
// fixture builder (tests/e2e/fixture/library.ts) and the real-library smoke import better-sqlite3 in THIS process.
test('better-sqlite3 loads in the Playwright runner process', () => {
  const db = new Database(':memory:');
  expect(db.prepare('select sqlite_version() as v').get()).toMatchObject({ v: expect.any(String) });
  db.close();
});
