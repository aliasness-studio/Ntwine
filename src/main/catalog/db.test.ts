import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from './db';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'ntwine-')), 'catalog.db'));

describe('catalog schema', () => {
  it('creates all tables and is reopenable', () => {
    const c = fresh();
    const names = c.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r: any) => r.name);
    for (const t of ['meta', 'packs', 'samples', 'tags', 'sample_tags', 'waveforms', 'sample_search']) expect(names).toContain(t);
  });
  it('meta round-trips', () => {
    const c = fresh();
    expect(c.getMeta('library_root')).toBeNull();
    c.setMeta('library_root', '/x');
    expect(c.getMeta('library_root')).toBe('/x');
  });
  it('enforces the sample_type enum (persisted-enum law)', () => {
    const c = fresh();
    const ins = c.db.prepare("INSERT INTO samples (file_hash, rel_path, filename, sample_type) VALUES (?,?,?,?)");
    expect(() => ins.run('h1', 'a/b.wav', 'b.wav', 'oneshot')).not.toThrow();
    expect(() => ins.run('h2', 'a/c.wav', 'c.wav', 'granular')).toThrow();
  });
});
