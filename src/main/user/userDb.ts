import { randomUUID } from 'node:crypto';
import type { Catalog } from '../catalog/db';
import { normalizeUserName } from '../../shared/userNames';

// Re-exported for main-side convenience so every persisted-name call site in this module (and
// its consumers, e.g. ipc.ts) can import it alongside `openUserDb`/`UserDb`
// without a second import line back to `src/shared`.
export { normalizeUserName };

/**
 * Thrown by `addUserTag`/`createCollection`/`renameCollection` on an empty (post-trim) name, and
 * by collection create/rename on a `normalizeUserName` collision with a DIFFERENT collection
 * (collections never merge silently on collision — tags reuse silently
 * instead, which is why only the collection path throws here). Callers surface `.message`
 * inline at the editor.
 */
export class UserNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserNameError';
  }
}

export interface UserDb {
  setFavorite(fileHash: string, on: boolean): void;
  setNickname(fileHash: string, nickname: string | null): void; // trims; '' -> null
  addUserTag(fileHash: string, name: string): void; // creates tag on first use (reuse by normalized name); throws UserNameError on empty
  removeUserTag(fileHash: string, name: string): void; // no-op when absent
  listUserTagNames(): string[]; // display names A-Z
  createCollection(name: string): { id: string }; // throws UserNameError on empty/collision
  renameCollection(id: string, name: string): void; // throws UserNameError on empty/collision
  deleteCollection(id: string): void; // cascade via FK
  addToCollection(collectionId: string, fileHash: string): void; // idempotent (INSERT OR IGNORE)
  removeFromCollection(collectionId: string, fileHash: string): void;
  listLibraryRail(): {
    favorites: number;
    collections: { id: string; name: string; count: number }[];
  }; // present-only counts (join samples missing=0)
}

// The user-layer schema. Created inside the `user` schema alias ATTACHed in `openUserDb`
// below. The unqualified parent-table names in the REFERENCES clauses (`tags(id)`,
// `collections(id)`) resolve to the SAME database as the child table being created — SQLite
// foreign keys cannot cross an ATTACHed-database boundary — which is exactly what keeps these
// pointed at `user.tags`/`user.collections` and never at catalog.db's own same-named (but
// unrelated, integer-keyed) `tags`/`sample_tags` tables on the main schema of this same
// connection. The delete-cascade unit test below pins that this resolution is what actually
// happens, not just what the SQL implies.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS user.sample_state (
  sample_file_hash TEXT PRIMARY KEY,
  favorite         INTEGER NOT NULL DEFAULT 0,   -- 0/1
  nickname         TEXT,                          -- NULL = no nickname
  created_at       TEXT NOT NULL,                 -- ISO-8601 UTC
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user.tags (
  id              TEXT PRIMARY KEY,               -- app-generated (crypto.randomUUID)
  name            TEXT NOT NULL,                  -- display form, trimmed
  normalized_name TEXT NOT NULL UNIQUE,           -- normalizeUserName(name)
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user.sample_tags (
  sample_file_hash TEXT NOT NULL,
  tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (sample_file_hash, tag_id)
);

CREATE TABLE IF NOT EXISTS user.collections (
  id              TEXT PRIMARY KEY,               -- app-generated
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,           -- normalizeUserName(name)
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user.collection_items (
  collection_id    TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  sample_file_hash TEXT NOT NULL,
  added_at         TEXT NOT NULL,
  PRIMARY KEY (collection_id, sample_file_hash)
);
`;

const nowIso = (): string => new Date().toISOString();

export function openUserDb(catalog: Catalog, userDbPath: string): UserDb {
  const { db } = catalog;
  db.prepare('ATTACH DATABASE ? AS user').run(userDbPath);
  // Never depend on whichever default a platform's SQLite build ships:
  // foreign_keys is a connection-wide pragma (no schema qualifier); journal_mode is set
  // per-schema for the newly attached `user` database, matching catalog.db's own WAL setting.
  db.pragma('foreign_keys = ON');
  db.pragma('user.journal_mode = WAL');
  db.exec(SCHEMA);

  const setFavoriteStmt = db.prepare(`
    INSERT INTO user.sample_state (sample_file_hash, favorite, nickname, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(sample_file_hash) DO UPDATE SET favorite = excluded.favorite, updated_at = excluded.updated_at
  `);
  const setNicknameStmt = db.prepare(`
    INSERT INTO user.sample_state (sample_file_hash, favorite, nickname, created_at, updated_at)
    VALUES (?, 0, ?, ?, ?)
    ON CONFLICT(sample_file_hash) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at
  `);

  const selectTagByNormalizedName = db.prepare(`SELECT id FROM user.tags WHERE normalized_name = ?`);
  const insertTag = db.prepare(`INSERT INTO user.tags (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)`);
  const insertSampleTag = db.prepare(
    `INSERT OR IGNORE INTO user.sample_tags (sample_file_hash, tag_id, created_at) VALUES (?, ?, ?)`,
  );
  const deleteSampleTag = db.prepare(`DELETE FROM user.sample_tags WHERE sample_file_hash = ? AND tag_id = ?`);
  const listTagNamesStmt = db.prepare(`SELECT name FROM user.tags`);

  const selectCollectionByNormalizedName = db.prepare(`SELECT id FROM user.collections WHERE normalized_name = ?`);
  const insertCollection = db.prepare(
    `INSERT INTO user.collections (id, name, normalized_name, created_at) VALUES (?, ?, ?, ?)`,
  );
  const updateCollectionName = db.prepare(`UPDATE user.collections SET name = ?, normalized_name = ? WHERE id = ?`);
  const deleteCollectionStmt = db.prepare(`DELETE FROM user.collections WHERE id = ?`);
  const listCollectionsStmt = db.prepare(`SELECT id, name FROM user.collections`);

  const insertCollectionItem = db.prepare(
    `INSERT OR IGNORE INTO user.collection_items (collection_id, sample_file_hash, added_at) VALUES (?, ?, ?)`,
  );
  const deleteCollectionItem = db.prepare(
    `DELETE FROM user.collection_items WHERE collection_id = ? AND sample_file_hash = ?`,
  );

  const favoritesCountStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM user.sample_state us
    JOIN samples s ON s.file_hash = us.sample_file_hash AND s.missing = 0
    WHERE us.favorite = 1
  `);
  const collectionCountStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM user.collection_items ci
    JOIN samples s ON s.file_hash = ci.sample_file_hash AND s.missing = 0
    WHERE ci.collection_id = ?
  `);

  // Shared by addUserTag/createCollection/renameCollection — empty-after-trim is rejected before
  // any write (the same name rules for tags AND collections).
  function requireNormalized(name: string): string {
    const normalized = normalizeUserName(name);
    if (normalized === '') throw new UserNameError('Name cannot be empty.');
    return normalized;
  }

  return {
    setFavorite(fileHash, on) {
      const now = nowIso();
      setFavoriteStmt.run(fileHash, on ? 1 : 0, now, now);
    },

    setNickname(fileHash, nickname) {
      const trimmed = nickname === null ? null : nickname.trim();
      const value = trimmed === '' ? null : trimmed;
      const now = nowIso();
      setNicknameStmt.run(fileHash, value, now, now);
    },

    addUserTag(fileHash, name) {
      const normalized = requireNormalized(name);
      const existing = selectTagByNormalizedName.get(normalized) as { id: string } | undefined;
      const tagId = existing ? existing.id : randomUUID();
      if (!existing) insertTag.run(tagId, name.trim(), normalized, nowIso());
      insertSampleTag.run(fileHash, tagId, nowIso());
    },

    removeUserTag(fileHash, name) {
      const normalized = normalizeUserName(name);
      const existing = selectTagByNormalizedName.get(normalized) as { id: string } | undefined;
      if (!existing) return;
      deleteSampleTag.run(fileHash, existing.id);
    },

    listUserTagNames() {
      const rows = listTagNamesStmt.all() as { name: string }[];
      // JS localeCompare, never SQL collation.
      return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b));
    },

    createCollection(name) {
      const normalized = requireNormalized(name);
      const existing = selectCollectionByNormalizedName.get(normalized) as { id: string } | undefined;
      if (existing) throw new UserNameError(`A collection named "${name.trim()}" already exists.`);
      const id = randomUUID();
      insertCollection.run(id, name.trim(), normalized, nowIso());
      return { id };
    },

    renameCollection(id, name) {
      const normalized = requireNormalized(name);
      const existing = selectCollectionByNormalizedName.get(normalized) as { id: string } | undefined;
      if (existing && existing.id !== id) {
        throw new UserNameError(`A collection named "${name.trim()}" already exists.`);
      }
      updateCollectionName.run(name.trim(), normalized, id);
    },

    deleteCollection(id) {
      deleteCollectionStmt.run(id);
    },

    addToCollection(collectionId, fileHash) {
      insertCollectionItem.run(collectionId, fileHash, nowIso());
    },

    removeFromCollection(collectionId, fileHash) {
      deleteCollectionItem.run(collectionId, fileHash);
    },

    listLibraryRail() {
      const favorites = (favoritesCountStmt.get() as { n: number }).n;
      const collections = (listCollectionsStmt.all() as { id: string; name: string }[])
        .map((c) => ({
          id: c.id,
          name: c.name,
          count: (collectionCountStmt.get(c.id) as { n: number }).n,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { favorites, collections };
    },
  };
}
