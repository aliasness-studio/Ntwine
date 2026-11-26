import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type Catalog } from '../catalog/db';
import { buildFixtureSpliceDb, type FixtureRow } from './fixtureSpliceDb';
import { readSplice } from './spliceDb';
import { buildCatalog } from './importer';
import { downloadCovers } from './covers';

// Stub fetchFn (one ok with 4 bytes, one ok:false, one throwing) -> files on disk for ok,
// cover_file set only for ok, {ok:1, failed:2}, and a second run does not re-call fetch for
// the ok pack (skip-existing).

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-covers-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

const PACK_OK = 'pack-ok-uuid';
const PACK_OK_FALSE = 'pack-okfalse-uuid';
const PACK_THROWS = 'pack-throws-uuid';

const URL_OK = 'https://cdn.example.com/covers/ok.jpg';
const URL_OK_FALSE = 'https://cdn.example.com/covers/okfalse.jpg';
const URL_THROWS = 'https://cdn.example.com/covers/throws.jpg';

// Exactly 4 bytes — proves the written file is the
// fetched body byte-for-byte, not a placeholder of some other length.
const FOUR_BYTES = [1, 2, 3, 4];

function fourByteBuffer(): ArrayBuffer {
  return new Uint8Array(FOUR_BYTES).buffer;
}

// Three packs, no sample rows needed — downloadCovers only ever reads/writes the `packs` table,
// so buildCatalog's samples loop simply never runs (libraryRoot below goes unused as a result,
// same as any other buildCatalog call whose `data.samples` is empty).
function buildPackFixtureRows(): FixtureRow[] {
  return [
    { table: 'packs', uuid: PACK_OK, name: 'OK Pack', cover_url: URL_OK },
    { table: 'packs', uuid: PACK_OK_FALSE, name: 'Not-OK Pack', cover_url: URL_OK_FALSE },
    { table: 'packs', uuid: PACK_THROWS, name: 'Throwing Pack', cover_url: URL_THROWS },
  ];
}

function setUp() {
  const coversDir = join(tmp(), 'covers');
  const dbPath = join(tmp(), 'sounds.db');
  buildFixtureSpliceDb(dbPath, buildPackFixtureRows());
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  buildCatalog(catalog, data, tmp());
  return { coversDir, catalog };
}

function coverFileByUuid(catalog: Catalog, uuid: string): string | null {
  const row = catalog.db.prepare('SELECT cover_file FROM packs WHERE splice_uuid = ?').get(uuid) as
    { cover_file: string | null } | undefined;
  if (!row) throw new Error(`no such pack: ${uuid}`);
  return row.cover_file;
}

// A vi.fn() stub keyed by URL rather than call order, so the three outcomes (ok / ok:false /
// throw) are pinned to specific packs regardless of what order downloadCovers iterates them in.
function makeFetchFn() {
  return vi.fn(async (url: string) => {
    if (url === URL_OK) {
      return { ok: true, arrayBuffer: async () => fourByteBuffer() };
    }
    if (url === URL_OK_FALSE) {
      return {
        ok: false,
        arrayBuffer: async () => {
          throw new Error('arrayBuffer() must not be read on a non-ok response');
        },
      };
    }
    if (url === URL_THROWS) {
      throw new Error('simulated network failure');
    }
    throw new Error(`unexpected url passed to test fetchFn stub: ${url}`);
  });
}

describe('downloadCovers', () => {
  it('writes bytes + sets cover_file only for the ok pack, tolerates ok:false and a throw, and returns {ok:1, failed:2}', async () => {
    const { coversDir, catalog } = setUp();
    const fetchFn = makeFetchFn();

    const result = await downloadCovers(catalog, coversDir, fetchFn);

    expect(result).toEqual({ ok: 1, failed: 2 });

    const okPath = join(coversDir, `${PACK_OK}.jpg`);
    expect(existsSync(okPath)).toBe(true);
    expect(Array.from(readFileSync(okPath))).toEqual(FOUR_BYTES);

    expect(coverFileByUuid(catalog, PACK_OK)).toBe(`${PACK_OK}.jpg`);
    expect(coverFileByUuid(catalog, PACK_OK_FALSE)).toBeNull();
    expect(coverFileByUuid(catalog, PACK_THROWS)).toBeNull();

    // Neither failure path leaves a file behind.
    expect(existsSync(join(coversDir, `${PACK_OK_FALSE}.jpg`))).toBe(false);
    expect(existsSync(join(coversDir, `${PACK_THROWS}.jpg`))).toBe(false);
  });

  it('skip-existing: a second run does not re-call fetch for the already-downloaded pack', async () => {
    const { coversDir, catalog } = setUp();
    const fetchFn = makeFetchFn();

    const first = await downloadCovers(catalog, coversDir, fetchFn);
    expect(first).toEqual({ ok: 1, failed: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    fetchFn.mockClear();

    const second = await downloadCovers(catalog, coversDir, fetchFn);

    const calledUrls = fetchFn.mock.calls.map((args) => args[0]);
    expect(calledUrls).not.toContain(URL_OK);
    // The two packs that never succeeded still have no durable cover_file/file on disk, so
    // there's nothing to skip for them — they're retried every run (self-healing, not just
    // "sticky failed").
    expect(calledUrls).toContain(URL_OK_FALSE);
    expect(calledUrls).toContain(URL_THROWS);
    expect(second).toEqual({ ok: 0, failed: 2 });
  });

  it('skips a pack with no cover_url entirely, without calling fetch', async () => {
    const coversDir = join(tmp(), 'covers');
    const dbPath = join(tmp(), 'sounds.db');
    buildFixtureSpliceDb(dbPath, [
      { table: 'packs', uuid: 'pack-no-cover', name: 'No Cover Pack' },
    ]);
    const data = readSplice(dbPath);
    const catalog = freshCatalog();
    buildCatalog(catalog, data, tmp());
    const fetchFn = vi.fn();

    const result = await downloadCovers(catalog, coversDir, fetchFn);

    expect(result).toEqual({ ok: 0, failed: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(coverFileByUuid(catalog, 'pack-no-cover')).toBeNull();
  });

  // `splice_uuid` comes straight from the Splice sounds.db (untrusted
  // input, same threat model protocol.test.ts's containment-trap tests use for `rel_path`) and
  // buildCatalog copies it into `packs.splice_uuid` verbatim, no path validation. downloadCovers
  // then builds `${splice_uuid}.jpg` and writes it under coversDir with no containment check — a
  // hostile/corrupt sounds.db row can walk the write outside coversDir entirely. One `..` is
  // enough to prove it and keeps the escape target inside this test's own tmp root (see the
  // `root`/`coversDir` split below) rather than the shared OS tmpdir.
  it('refuses a splice_uuid that would escape coversDir, counts it as a failure, and continues to the next pack', async () => {
    const root = tmp();
    const coversDir = join(root, 'covers');
    const dbPath = join(root, 'sounds.db');
    const HOSTILE_UUID = '../evil';
    buildFixtureSpliceDb(dbPath, [
      { table: 'packs', uuid: HOSTILE_UUID, name: 'Hostile Pack', cover_url: URL_OK },
      { table: 'packs', uuid: PACK_OK, name: 'OK Pack', cover_url: URL_OK },
    ]);
    const data = readSplice(dbPath);
    const catalog = freshCatalog();
    buildCatalog(catalog, data, root);
    const fetchFn = makeFetchFn();

    const result = await downloadCovers(catalog, coversDir, fetchFn);

    expect(result).toEqual({ ok: 1, failed: 1 });

    // The traversal target — one level above coversDir, i.e. a sibling of covers/ under the same
    // per-test root — must not exist: nothing escaped coversDir.
    expect(existsSync(join(root, 'evil.jpg'))).toBe(false);
    // coversDir itself holds only the well-behaved pack's file.
    expect(readdirSync(coversDir)).toEqual([`${PACK_OK}.jpg`]);

    // The importer continued past the hostile row instead of aborting the whole pass.
    expect(coverFileByUuid(catalog, PACK_OK)).toBe(`${PACK_OK}.jpg`);
    expect(coverFileByUuid(catalog, HOSTILE_UUID)).toBeNull();
    // The containment check rejects before any network fetch — the hostile row never reaches
    // fetchFn at all, only the OK pack does.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
