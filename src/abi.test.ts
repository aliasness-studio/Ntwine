import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('toolchain', () => {
  it('loads better-sqlite3 under the test runner ABI', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x)');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    expect(db.prepare('SELECT count(*) c FROM t').get()).toEqual({ c: 1 });
  });
  it('has FTS5 compiled in', () => {
    const db = new Database(':memory:');
    db.exec("CREATE VIRTUAL TABLE s USING fts5(body)");
    db.prepare('INSERT INTO s VALUES (?)').run('kick drum tight');
    expect(db.prepare("SELECT count(*) c FROM s WHERE s MATCH 'kick'").get()).toEqual({ c: 1 });
  });
});
