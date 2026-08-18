import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCatalog, type Catalog } from '../catalog/db';
import { normalizeUserName, openUserDb, UserNameError, type UserDb } from './userDb';

let dir: string;
let catalog: Catalog;
let user: UserDb;

function insertSample(fileHash: string, opts: { missing?: boolean } = {}): number {
  const r = catalog.db
    .prepare(
      `INSERT INTO samples (file_hash, rel_path, filename, sample_type, missing)
       VALUES (?, ?, ?, 'oneshot', ?)`,
    )
    .run(fileHash, `p/${fileHash}.wav`, `${fileHash}.wav`, opts.missing ? 1 : 0);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ntwine-userdb-'));
  catalog = openCatalog(join(dir, 'catalog.db'));
  user = openUserDb(catalog, join(dir, 'user.db'));
});
afterEach(() => {
  catalog.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeUserName', () => {
  it('folds case, trims, collapses whitespace, and NFC-normalizes', () => {
    expect(normalizeUserName('  Big  Kick ')).toBe('big kick');
    // NFD e + combining acute vs NFC é — one name
    expect(normalizeUserName('café')).toBe(normalizeUserName('café'));
  });
});

describe('favorites + nickname (sample_state)', () => {
  it('round-trips favorite and nickname, and clears nickname on empty', () => {
    user.setFavorite('h1', true);
    user.setNickname('h1', '  THE snare ');
    let row = catalog.db.prepare(`SELECT favorite, nickname FROM user.sample_state WHERE sample_file_hash = 'h1'`).get() as { favorite: number; nickname: string | null };
    expect(row).toEqual({ favorite: 1, nickname: 'THE snare' });
    user.setNickname('h1', '   ');
    row = catalog.db.prepare(`SELECT favorite, nickname FROM user.sample_state WHERE sample_file_hash = 'h1'`).get() as { favorite: number; nickname: string | null };
    expect(row).toEqual({ favorite: 1, nickname: null });
  });
  it('stamps updated_at on every write', () => {
    user.setFavorite('h1', true);
    const first = (catalog.db.prepare(`SELECT updated_at FROM user.sample_state WHERE sample_file_hash='h1'`).get() as { updated_at: string }).updated_at;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('keeps dormant rows: state for a hash with no catalog sample persists', () => {
    user.setFavorite('ghost', true);
    expect(catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.sample_state`).get()).toEqual({ n: 1 });
  });
});

describe('user tags', () => {
  it('reuses an existing tag by normalized name and lists display names A-Z', () => {
    user.addUserTag('h1', 'Kick');
    user.addUserTag('h2', ' kick ');
    user.addUserTag('h1', 'bounce');
    expect(catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.tags`).get()).toEqual({ n: 2 });
    expect(user.listUserTagNames()).toEqual(['bounce', 'Kick']); // localeCompare display sort (Global Constraints)
    user.removeUserTag('h1', 'KICK'); // removal matches by normalized name too
    expect(catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.sample_tags`).get()).toEqual({ n: 2 });
  });
  it('rejects empty tag names', () => {
    expect(() => user.addUserTag('h1', '   ')).toThrow(UserNameError);
  });
});

describe('collections', () => {
  it('creates, renames, errors on collision by normalized name, and cascade-deletes items', () => {
    const { id } = user.createCollection('Drums');
    expect(() => user.createCollection(' drums ')).toThrow(UserNameError);
    user.addToCollection(id, 'h1');
    user.addToCollection(id, 'h1'); // idempotent
    expect(catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.collection_items`).get()).toEqual({ n: 1 });
    const { id: other } = user.createCollection('Other');
    expect(() => user.renameCollection(other, 'DRUMS')).toThrow(UserNameError);
    user.deleteCollection(id);
    expect(catalog.db.prepare(`SELECT COUNT(*) AS n FROM user.collection_items`).get()).toEqual({ n: 0 }); // FK cascade fired
  });
});

describe('listLibraryRail', () => {
  it('counts PRESENT samples only, collections A-Z', () => {
    insertSample('h1');
    insertSample('h2', { missing: true });
    user.setFavorite('h1', true);
    user.setFavorite('h2', true);
    user.setFavorite('ghost', true); // dormant — no catalog row
    const { id } = user.createCollection('Zeta');
    const { id: id2 } = user.createCollection('Alpha');
    user.addToCollection(id, 'h1');
    user.addToCollection(id, 'h2');
    user.addToCollection(id2, 'h1');
    const rail = user.listLibraryRail();
    expect(rail.favorites).toBe(1);
    expect(rail.collections.map((c) => ({ name: c.name, count: c.count }))).toEqual([
      { name: 'Alpha', count: 1 },
      { name: 'Zeta', count: 1 },
    ]);
  });
});
