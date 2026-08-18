import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, type Catalog } from './db';
import { buildFixtureSpliceDb, type FixtureRow } from '../importer/fixtureSpliceDb';
import { readSplice } from '../importer/spliceDb';
import { buildCatalog } from '../importer/importer';
import { rebuildSearch, searchIdsForToken } from './search';

const tmp = () => mkdtempSync(join(tmpdir(), 'ntwine-search-'));
const freshCatalog = () => openCatalog(join(tmp(), 'catalog.db'));

const PACK_UUID = 'pack-analog-dreams';

// One pack ("Analog Dreams") holding two samples, each carrying its target text in exactly one
// FTS column, so a query can only reach it through that column:
//   - Kick_808.wav / tags 'punchy'          -> filename-prefix match only ('kic'/'KIC')
//   - texture_pad.wav / tags 'ambient,soft' -> tag-prefix match only ('amb')
// Neither sample's filename or tags contain "ana", so a match on 'ana' can only come from the
// pack name "Analog Dreams" they share -> both rows.
function buildFixtureRows(libraryRoot: string): FixtureRow[] {
  return [
    { table: 'packs', uuid: PACK_UUID, name: 'Analog Dreams' },
    {
      table: 'samples',
      file_hash: 'h-kick',
      local_path: join(libraryRoot, 'sounds/packs/Analog Dreams/Kick_808.wav'),
      filename: 'Kick_808.wav',
      pack_uuid: PACK_UUID,
      sample_type: 'oneshot',
      duration: 500,
      tags: 'punchy',
    },
    {
      table: 'samples',
      file_hash: 'h-pad',
      local_path: join(libraryRoot, 'sounds/packs/Analog Dreams/texture_pad.wav'),
      filename: 'texture_pad.wav',
      pack_uuid: PACK_UUID,
      sample_type: 'loop',
      duration: 4000,
      tags: 'ambient,soft',
    },
  ];
}

// Builds a fresh fixture + catalog per test (mirrors importer.test.ts's own convention) and runs
// buildCatalog, which wires rebuildSearch into its transaction (the Task 7 seam in importer.ts)
// — so `sample_search` is already populated once by the time a test body runs.
function setUp() {
  const libraryRoot = tmp();
  const dbPath = join(tmp(), 'sounds.db');
  buildFixtureSpliceDb(dbPath, buildFixtureRows(libraryRoot));
  const data = readSplice(dbPath);
  const catalog = freshCatalog();
  buildCatalog(catalog, data, libraryRoot);
  return { catalog };
}

function sampleId(catalog: Catalog, fileHash: string): number {
  const row = catalog.db.prepare('SELECT id FROM samples WHERE file_hash = ?').get(fileHash) as
    { id: number } | undefined;
  if (!row) throw new Error(`fixture sample "${fileHash}" not found`);
  return row.id;
}

describe('searchIdsForToken', () => {
  it('matches a filename prefix, case-insensitively', () => {
    const { catalog } = setUp();

    expect(searchIdsForToken(catalog, 'KIC')).toEqual([sampleId(catalog, 'h-kick')]);
  });

  it('matches a tag prefix', () => {
    const { catalog } = setUp();

    expect(searchIdsForToken(catalog, 'amb')).toEqual([sampleId(catalog, 'h-pad')]);
  });

  it('matches a pack-name prefix, returning every sample in that pack', () => {
    const { catalog } = setUp();
    const kickId = sampleId(catalog, 'h-kick');
    const padId = sampleId(catalog, 'h-pad');

    const ids = searchIdsForToken(catalog, 'ana')
      .slice()
      .sort((a, b) => a - b);
    expect(ids).toEqual([kickId, padId].sort((a, b) => a - b));
  });

  // Multi-token AND composition (was pinned here against the old whole-query `searchIds`) is now
  // queries.ts's job — `searchIdsForToken` only ever sees one already-split token, unioned with
  // nickname/user-tag hits and AND-composed across tokens by `querySamples` itself (Task 4). This
  // file's own former 'kic ana' (same row, different FTS columns) / 'kic amb' (different rows)
  // cases are ported verbatim in spirit to queries.test.ts's
  // "FTS-only tokens still AND together under the new JS-Set composition" test — same shape,
  // this repo's own fixture strings.

  it('returns an empty array (not a throw) for a token that matches nothing', () => {
    const { catalog } = setUp();

    expect(() => searchIdsForToken(catalog, 'zzznotfound')).not.toThrow();
    expect(searchIdsForToken(catalog, 'zzznotfound')).toEqual([]);
  });

  it('throws on an empty or whitespace-only token', () => {
    const { catalog } = setUp();

    expect(() => searchIdsForToken(catalog, '')).toThrow();
    expect(() => searchIdsForToken(catalog, '   ')).toThrow();
  });

  it('does not throw on a token containing a double quote (escaping)', () => {
    const { catalog } = setUp();

    expect(() => searchIdsForToken(catalog, 'ki"ck')).not.toThrow();
  });

  it('survives rebuildSearch being called twice with no duplicate FTS rows', () => {
    const { catalog } = setUp();
    const countRows = () =>
      (catalog.db.prepare('SELECT COUNT(*) AS n FROM sample_search').get() as { n: number }).n;
    const countSamples = () =>
      (catalog.db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }).n;

    // buildCatalog's own rebuild (inside setUp) already ran once.
    expect(countRows()).toBe(countSamples());

    rebuildSearch(catalog);
    rebuildSearch(catalog);

    expect(countRows()).toBe(countSamples());
    expect(searchIdsForToken(catalog, 'KIC')).toEqual([sampleId(catalog, 'h-kick')]); // still exactly one hit
  });
});
