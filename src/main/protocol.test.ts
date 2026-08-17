import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type Catalog } from './catalog/db';
import { buildFixtureSpliceDb, type FixtureRow } from './importer/fixtureSpliceDb';
import { readSplice } from './importer/spliceDb';
import { buildCatalog } from './importer/importer';
import { relPathToAbs } from './importer/transform';
import { resolveProtocolRequest } from './protocol';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-protocol-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

function idByHash(catalog: Catalog, hash: string): number {
  const row = catalog.db
    .prepare<[string], { id: number }>('SELECT id FROM samples WHERE file_hash = ?')
    .get(hash);
  if (!row) throw new Error(`fixture setup: no sample row for file_hash ${hash}`);
  return row.id;
}

function packIdByUuid(catalog: Catalog, uuid: string): number {
  const row = catalog.db
    .prepare<[string], { id: number }>('SELECT id FROM packs WHERE splice_uuid = ?')
    .get(uuid);
  if (!row) throw new Error(`fixture setup: no pack row for splice_uuid ${uuid}`);
  return row.id;
}

// One pack, two samples (one present, one about to be flagged missing) — enough to exercise
// every resolveProtocolRequest branch without a queries.test.ts-scale fixture. Built through the
// real Splice-fixture -> readSplice -> buildCatalog pipeline (this codebase's established
// fixture pattern, e.g. queries.test.ts/queue.test.ts) so the "normal" rows are exactly what
// import would actually produce; the two containment-trap tests below deliberately step outside
// that pipeline (see their own comments) since normalizeSample refuses to write what they need.
function setUp() {
  const libraryRoot = tmp();
  const dbPath = join(tmp(), 'sounds.db');
  const rows: FixtureRow[] = [
    { table: 'packs', uuid: 'pack-a', name: 'Pack A' },
    {
      table: 'samples',
      file_hash: 'h-present',
      local_path: join(libraryRoot, 'sounds', 'packs', 'Pack A', 'present.wav'),
      filename: 'present.wav',
      pack_uuid: 'pack-a',
      sample_type: 'oneshot',
    },
    {
      table: 'samples',
      file_hash: 'h-gone',
      local_path: join(libraryRoot, 'sounds', 'packs', 'Pack A', 'gone.wav'),
      filename: 'gone.wav',
      pack_uuid: 'pack-a',
      sample_type: 'oneshot',
    },
  ];
  buildFixtureSpliceDb(dbPath, rows);
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  buildCatalog(catalog, data, libraryRoot);

  const presentId = idByHash(catalog, 'h-present');
  const goneId = idByHash(catalog, 'h-gone');
  catalog.db.prepare('UPDATE samples SET missing = 1 WHERE id = ?').run(goneId);

  const packAId = packIdByUuid(catalog, 'pack-a');
  catalog.db.prepare('UPDATE packs SET cover_file = ? WHERE id = ?').run('pack-a.jpg', packAId);

  const coversDir = join(tmp(), 'covers');

  return { catalog, libraryRoot, coversDir, presentId, goneId, packAId };
}

describe('resolveProtocolRequest', () => {
  it('resolves a valid, present sample id to its absolute path under the library root', () => {
    const { catalog, libraryRoot, coversDir, presentId } = setUp();
    const result = resolveProtocolRequest(
      catalog,
      libraryRoot,
      coversDir,
      `sample://s/${presentId}`,
    );
    expect(result).toBe(relPathToAbs(libraryRoot, 'sounds/packs/Pack A/present.wav'));
  });

  it('refuses a missing-flagged sample id', () => {
    const { catalog, libraryRoot, coversDir, goneId } = setUp();
    expect(
      resolveProtocolRequest(catalog, libraryRoot, coversDir, `sample://s/${goneId}`),
    ).toBeNull();
  });

  it('refuses an id with no matching samples row', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    expect(resolveProtocolRequest(catalog, libraryRoot, coversDir, 'sample://s/999999')).toBeNull();
  });

  it('refuses a non-numeric id (path-traversal attempt in the id position)', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    expect(resolveProtocolRequest(catalog, libraryRoot, coversDir, 'sample://s/../etc')).toBeNull();
  });

  it('refuses a crafted rel_path escaping the library root, even for a real row (containment beats DB content)', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    // Bypasses normalizeSample's own out-of-root guard on purpose: our own importer would never
    // WRITE this row (transform.ts's toRelPath throws first), but a resolver that only trusts
    // what's already in the table must still refuse to serve it if the row exists by some other
    // means (a hand-edited DB, a future migration bug, ...). Direct SQL insert, not the fixture
    // pipeline, is exactly how to construct that "shouldn't happen but must still be safe" row.
    catalog.db
      .prepare(
        `INSERT INTO samples (file_hash, rel_path, filename, sample_type, missing)
         VALUES (?, ?, ?, 'oneshot', 0)`,
      )
      .run('h-hostile', '../../outside.wav', 'outside.wav');
    const hostileId = idByHash(catalog, 'h-hostile');
    expect(
      resolveProtocolRequest(catalog, libraryRoot, coversDir, `sample://s/${hostileId}`),
    ).toBeNull();
  });

  it('refuses a sibling-prefix escape: root ".../lib" vs a rel_path resolving into ".../library-evil/x.wav" (the naive startsWith trap)', () => {
    const root = join(tmp(), 'lib');
    const catalog = freshCatalog();
    catalog.db
      .prepare(
        `INSERT INTO samples (file_hash, rel_path, filename, sample_type, missing)
         VALUES (?, ?, ?, 'oneshot', 0)`,
      )
      .run('h-sibling', '../library-evil/x.wav', 'x.wav');
    const id = idByHash(catalog, 'h-sibling');

    // Sanity check on the trap itself: a naive string-prefix test WOULD wrongly call this
    // "inside" (the resolved path's characters really do start with root's), which is exactly
    // why the real implementation must use path.relative instead of `.startsWith(root)`.
    const resolvedNaively = join(root, '..', 'library-evil', 'x.wav');
    expect(resolvedNaively.startsWith(root)).toBe(true);

    expect(
      resolveProtocolRequest(catalog, root, join(tmp(), 'covers'), `sample://s/${id}`),
    ).toBeNull();
  });

  it('resolves a cover id to its path under coversDir (cover_file is a bare filename, joined here)', () => {
    const { catalog, libraryRoot, coversDir, packAId } = setUp();
    expect(resolveProtocolRequest(catalog, libraryRoot, coversDir, `cover://p/${packAId}`)).toBe(
      join(coversDir, 'pack-a.jpg'),
    );
  });

  it('refuses a cover id for a pack with no cover_file yet (cover never downloaded)', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    catalog.db.prepare(`INSERT INTO packs (splice_uuid, name) VALUES ('pack-b', 'Pack B')`).run();
    const id = packIdByUuid(catalog, 'pack-b');
    expect(resolveProtocolRequest(catalog, libraryRoot, coversDir, `cover://p/${id}`)).toBeNull();
  });

  it('refuses a cover id with no matching packs row', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    expect(resolveProtocolRequest(catalog, libraryRoot, coversDir, 'cover://p/999999')).toBeNull();
  });

  it('refuses an unrecognized scheme/shape', () => {
    const { catalog, libraryRoot, coversDir } = setUp();
    expect(
      resolveProtocolRequest(catalog, libraryRoot, coversDir, 'https://evil.example/x'),
    ).toBeNull();
  });
});
