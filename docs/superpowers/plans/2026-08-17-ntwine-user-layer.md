# Ntwine User Library Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Favorites, custom tags, nicknames, and flat collections over the imported Splice catalog — keyed to `file_hash` in a sidecar `user.db`, keyboard-first, fully e2e-pinned.

**Architecture:** A new main-process `userDb` module ATTACHes `user.db` to the existing catalog connection; `querySamples`/`listTags`/search grow user-aware semantics; 11 new IPC methods (bridge 12→23) + `startDrag` promoted to invoke; renderer gains `UserLayerStore`, a LIBRARY rail section, row affordances (heart/nickname/chips), context menu, popovers, keyboard map, and slot-discriminated drag-in targets.

**Tech Stack:** Electron (Forge 7.11/Vite 5, CJS main), React 19, TS strict, MobX 6 (`makeAutoObservable`, DI-by-typed-api-shape), styled-components 6, better-sqlite3 13, Vitest (under `ELECTRON_RUN_AS_NODE`), Playwright 1.62.1 e2e harness.

**Spec:** `docs/superpowers/specs/2026-08-17-ntwine-user-layer-design.md` (panel-applied twice; argue from it, it wins over this plan on conflict)

## Global Constraints

- The sample library on disk is read-only, always. No file is ever renamed/written under the library root.
- Renderer never touches fs/SQLite; everything crosses the typed `NtwineApi` bridge. contextIsolation/webSecurity stay on.
- MobX pin: `mobx ^6.15` + `mobx-react-lite ^4` — never 7.x. TS strict; `yarn typecheck` and `yarn lint` clean per task.
- TDD per task: failing test → red → implement → green → commit. Unit gate per task: `yarn test`. Full `yarn e2e` (repackages) at the three milestones marked below — REQUIRED because `src/` changes.
- Every user-layer row keys on `sample_file_hash` (Splice-supplied `samples.file_hash`). The renderer never sees hashes; main resolves `sampleId → file_hash`.
- `normalizeUserName(name) = name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()` — the ONE normalizer for every persisted `normalized_name` and user-name comparison.
- Splice metadata (catalog tables) is never mutated by the user layer.
- Bridge ends at exactly 23 methods; `tests/e2e/security.spec.ts` pin (sorted array AND the "exactly its N methods" title) updates in the same task that grows the bridge (Task 6).
- Commit author `AliasNess Studio <aliasness.studio@proton.me>`. Commits reference `Refs #6` in the final line before the co-author trailer. Implementers never stash/amend/rebase/push.
- The pre-release clean-break rule applies EXCEPT: the current build must round-trip its own `user.db`, and once real curation exists a user.db schema break is an owner-ask.

---

### Task 1: userDb module (schema, normalizer, CRUD)

**Files:**
- Create: `src/main/user/userDb.ts`
- Test: `src/main/user/userDb.test.ts`

**Interfaces:**
- Consumes: `Catalog` from `src/main/catalog/db.ts` (`{ db, getMeta, setMeta }`).
- Produces (later tasks rely on these exact signatures):

```ts
export function normalizeUserName(name: string): string;
export interface UserDb {
  setFavorite(fileHash: string, on: boolean): void;
  setNickname(fileHash: string, nickname: string | null): void; // trims; '' -> null
  addUserTag(fileHash: string, name: string): void;             // creates tag on first use (reuse by normalized name); throws UserNameError on empty
  removeUserTag(fileHash: string, name: string): void;          // no-op when absent
  listUserTagNames(): string[];                                 // display names A-Z
  createCollection(name: string): { id: string };               // throws UserNameError on empty/collision
  renameCollection(id: string, name: string): void;             // throws UserNameError on empty/collision
  deleteCollection(id: string): void;                           // cascade via FK
  addToCollection(collectionId: string, fileHash: string): void;    // idempotent (INSERT OR IGNORE)
  removeFromCollection(collectionId: string, fileHash: string): void;
  listLibraryRail(): { favorites: number; collections: { id: string; name: string; count: number }[] }; // present-only counts (join samples missing=0)
  userTextByHash(): Map<string, { nickname: string | null; tags: string[] }>; // for search (Task 4)
}
export class UserNameError extends Error { constructor(message: string) { super(message); this.name = 'UserNameError'; } }
export function openUserDb(catalog: Catalog, userDbPath: string): UserDb;
```

- [ ] **Step 1: Write the failing tests** — `src/main/user/userDb.test.ts`. Build an in-memory catalog + temp user.db per test:

```ts
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
    expect(user.listUserTagNames()).toEqual(['Kick', 'bounce']); // A-Z by display name, case-sensitive sort is fine — pin actual: localeCompare
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

describe('userTextByHash', () => {
  it('returns nickname + tag names per hash', () => {
    user.setNickname('h1', 'THE snare');
    user.addUserTag('h1', 'bounce');
    user.addUserTag('h2', 'kick');
    const m = user.userTextByHash();
    expect(m.get('h1')).toEqual({ nickname: 'THE snare', tags: ['bounce'] });
    expect(m.get('h2')).toEqual({ nickname: null, tags: ['kick'] });
  });
});
```

- [ ] **Step 2: Run to verify red** — `yarn test src/main/user/userDb.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `src/main/user/userDb.ts`.** Core shape (write in full, matching the Interfaces block; key excerpts):

```ts
import type { Catalog } from '../catalog/db';

export function normalizeUserName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export class UserNameError extends Error { /* as in Interfaces block */ }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user.sample_state ( /* spec §2.3 verbatim */ );
/* tags, sample_tags, collections, collection_items — spec §2.3 verbatim */
`;

const nowIso = (): string => new Date().toISOString();

export function openUserDb(catalog: Catalog, userDbPath: string): UserDb {
  const { db } = catalog;
  db.prepare('ATTACH DATABASE ? AS user').run(userDbPath);
  db.pragma('foreign_keys = ON');           // spec §2.2 — never depend on the driver default
  db.pragma('user.journal_mode = WAL');
  db.exec(SCHEMA);
  // ... statements + methods per the Interfaces block
}
```

Implementation notes (binding): `setFavorite`/`setNickname` upsert `sample_state` (`ON CONFLICT(sample_file_hash) DO UPDATE`) stamping `updated_at = nowIso()` and `created_at` on insert. `addUserTag` looks up `user.tags` by `normalized_name`, inserts with `crypto.randomUUID()` if absent (rejecting empty via `UserNameError` BEFORE any write), then `INSERT OR IGNORE` into `user.sample_tags`. `removeUserTag` resolves the tag by normalized name; missing tag → no-op. `createCollection`/`renameCollection` throw `UserNameError` on empty or when a DIFFERENT collection already owns the normalized name (check by SELECT first — do not rely on catching SQLITE_CONSTRAINT, which would also swallow FK errors). `listUserTagNames` sorts by display name via `localeCompare`. `listLibraryRail` favorites count: `SELECT COUNT(*) FROM user.sample_state us JOIN samples s ON s.file_hash = us.sample_file_hash AND s.missing = 0 WHERE us.favorite = 1`; per-collection counts analogous over `collection_items`. `userTextByHash` = one pass over `sample_state` (nickname non-null) + one over `sample_tags JOIN tags`, merged into the Map.

- [ ] **Step 4: Run to green** — `yarn test src/main/user/userDb.test.ts`, then full `yarn test` + `yarn typecheck` + `yarn lint`.
- [ ] **Step 5: Commit** — `feat(user-layer): userDb sidecar module — schema, normalizer, CRUD` (+ `Refs #6`).

---

### Task 2: scope clean break (`packId` → `scope`)

**Files:**
- Modify: `src/shared/ipcTypes.ts` (QueryFilters), `src/main/catalog/queries.ts` (querySamples pack arm), `src/renderer/stores/LibraryStore.ts` (`setPack` → `setScope`), `src/renderer/components/PackRail.tsx` (active reads + click), `src/renderer/components/SampleList.tsx` (none — verify), `tests/e2e/harness/actions.ts` (none — verify)
- Test: existing `src/main/catalog/*.test.ts` + `src/renderer/stores/LibraryStore.test.ts` updates; new cases in each

**Interfaces:**
- Produces:

```ts
// ipcTypes.ts
export type Scope =
  | { kind: 'pack'; packId: number }
  | { kind: 'favorites' }
  | { kind: 'collection'; collectionId: string };
export interface QueryFilters { scope?: Scope; /* packId REMOVED */ sampleType?: ...; bpmMin?: ...; bpmMax?: ...; audioKey?: ...; tags?: string[]; search?: string; }
// LibraryStore
setScope(scope: Scope | null): void;  // null = All Samples; serializes as ABSENT key (filters.spec's `{}` pin stays true)
```

Note: the `{ kind: 'all' }` variant from the spec is represented as **absence** (`scope === undefined`) — the spec's §8 fallout note requires "no scope" to serialize to an absent key.

- [ ] **Step 1: failing tests** — queries: `querySamples` with `{ scope: { kind: 'pack', packId } }` returns that pack's rows (port the existing packId case); `{ scope: undefined }` returns all; a `favorites`/`collection` scope with no user.db attached is NOT exercised here (Task 3). LibraryStore: `setScope({kind:'pack',packId:2})` → `filters.scope` set + re-query called; `setScope(null)` → `filters` has NO `scope` key (`'scope' in store.filters === false`).
- [ ] **Step 2: red** — run the two test files.
- [ ] **Step 3: implement** — queries.ts: replace the `f.packId` arm with

```ts
if (f.scope !== undefined && f.scope.kind === 'pack') {
  where.push('s.pack_id = ?');
  params.push(f.scope.packId);
}
```

(favorites/collection arms land in Task 3 — add `// Task 3` marker-free TODO-free: add the two arms NOW as dead-reachable SQL against `user.` tables ONLY IF Task 1 is merged before this task runs; otherwise leave the union of kinds non-exhaustive with a `default: break`. This plan orders Task 1 first, so **implement all three arms here**, favorites: `s.file_hash IN (SELECT sample_file_hash FROM user.sample_state WHERE favorite = 1)`, collection: `s.file_hash IN (SELECT sample_file_hash FROM user.collection_items WHERE collection_id = ?)` — they are correct SQL whether or not rows exist, but tests for them wait for Task 3's fixture wiring.) LibraryStore: `setPack(id)` becomes `setScope(scope)` calling `patchFilters({ scope: scope ?? undefined })`; PackRail: `library.filters.scope?.kind === 'pack' && library.filters.scope.packId === pack.id` for active; All Samples row active when `filters.scope === undefined`; clicks call `library.setScope({ kind: 'pack', packId: pack.id })` / `library.setScope(null)`.
- [ ] **Step 4: green** — `yarn test && yarn typecheck && yarn lint`. NOTE: `querySamples` callers pass plain objects over IPC; nested `scope` survives structured clone fine.
- [ ] **Step 5: Commit** — `feat(user-layer): scope replaces packId in QueryFilters (clean break)`.

**IMPORTANT for the Task-2 implementer:** `querySamples`'s favorites/collection arms reference `user.` tables that only exist after `openUserDb` ran on the connection. Until Task 6 wires `openUserDb` in ipc.ts, PRODUCTION never sends those scopes (no UI exists), and unit tests that exercise them construct the catalog via `openCatalog` + `openUserDb` (Task 3 does). SQLite only resolves table names at statement PREPARE, and querySamples builds SQL per call — a `pack`-scoped or unscoped call never mentions `user.` tables, so nothing breaks pre-wiring.

---

### Task 3: user fields + user scopes in querySamples

**Files:**
- Modify: `src/main/catalog/queries.ts`, `src/shared/ipcTypes.ts` (SampleRow)
- Test: `src/main/catalog/queries.test.ts` (extend; construct catalog + `openUserDb`)

**Interfaces:**
- Produces: `SampleRow` gains `favorite: boolean; nickname: string | null; userTags: string[]` (display names A-Z). `querySamples` signature UNCHANGED (`(catalog, f)`) — the user tables live on the same connection.

- [ ] **Step 1: failing tests** — with `openUserDb` attached: (a) favorite/nickname flow through rows (`favorite: true`, `nickname: 'THE snare'`, absent state → `favorite: false, nickname: null, userTags: []`); (b) `userTags` sorted A-Z; (c) `{ scope: { kind: 'favorites' } }` returns only favorited-present rows; (d) `{ scope: { kind: 'collection', collectionId } }` returns members; (e) a `pack` scope + favorite field coexist.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** — row SELECT adds `s.file_hash AS fileHash, us.favorite AS favorite, us.nickname AS nickname` via `LEFT JOIN user.sample_state us ON us.sample_file_hash = s.file_hash` — **BUT only when the user schema is attached**: add one guard `const hasUser = (db.pragma('database_list', { simple: false }) as { name: string }[]).some((d) => d.name === 'user');` and build the join/columns conditionally (`0 AS favorite, NULL AS nickname` otherwise), so `querySamples` keeps working for any caller that never attached (existing tests). userTags: second query `SELECT st.sample_file_hash AS hash, t.name AS name FROM user.sample_tags st JOIN user.tags t ON t.id = st.tag_id WHERE st.sample_file_hash IN (...)` over the returned rows' hashes, grouped in JS (mirror the existing splice-tags second query; ORDER BY t.name). Map into the returned objects (`favorite: r.favorite === 1`).
- [ ] **Step 4: green** — full unit wall + typecheck + lint.
- [ ] **Step 5: Commit** — `feat(user-layer): querySamples carries favorite/nickname/userTags + user scopes`.

---

### Task 4: per-token search union

**Files:**
- Modify: `src/main/catalog/search.ts` (add `searchIdsForToken`), `src/main/catalog/queries.ts` (search composition)
- Test: `src/main/catalog/search.test.ts` + `queries.test.ts` (extend)

**Interfaces:**
- Produces: `searchIdsForToken(catalog, token): number[]` (same quote/escape/prefix mechanics as `searchIds`, one token). `querySamples` search behavior per spec §3.4: every token must match FTS-text OR nickname OR a user tag; tokens AND.

- [ ] **Step 1: failing tests** — (a) mixed vocabulary: file `AD_Kick_01.wav` nicknamed `THE snare`; search `snare kick` matches it; (b) user-tag token: tag `bounce` + search `bounce` matches; (c) tokens AND: `snare nosuch` matches nothing; (d) case/NFC: nickname `Café Hit`, search `café` (NFD) matches (JS folding, word-boundary prefix `caf` also matches); (e) word-boundary prefix: nickname `THE snare` — token `sna` matches, token `nare` does NOT; (f) FTS-only behavior unchanged (existing tests keep passing).
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** — in queries.ts replace the whole-query `searchIds` block:

```ts
let matchedIds: number[] | null = null;
if (f.search !== undefined && f.search.trim() !== '') {
  const tokens = f.search.split(/\s+/).filter((t) => t.length > 0);
  // Per-token union across sources (spec §3.4), AND across tokens.
  const userText = hasUser ? readUserTextWithIds(db) : new Map<number, { text: string[] }>();
  let acc: Set<number> | null = null;
  for (const token of tokens) {
    const ftsIds = new Set(searchIdsForToken(catalog, token));
    const norm = normalizeUserName(token);
    for (const [id, { text }] of userText) {
      if (text.some((t) => wordPrefixMatch(t, norm))) ftsIds.add(id);
    }
    acc = acc === null ? ftsIds : new Set([...acc].filter((id) => ftsIds.has(id)));
    if (acc.size === 0) return [];
  }
  matchedIds = [...(acc ?? new Set<number>())];
  if (matchedIds.length === 0) return [];
}
```

with helpers in queries.ts (or a small `userSearch.ts`): `readUserTextWithIds(db)` = one SQL join `samples.file_hash → user.sample_state/user.sample_tags` producing per-`samples.id` normalized text fragments (`normalizeUserName(nickname)`, each tag's `normalized_name`); `wordPrefixMatch(text, tokenNorm)` = `text.startsWith(tokenNorm) || text.includes(' ' + tokenNorm)` after normalization (word boundary = start or post-space, matching FTS's prefix-token feel; normalized text already collapsed whitespace). `normalizeUserName` imported from `../user/userDb`.
- [ ] **Step 4: green** — full wall.
- [ ] **Step 5: Commit** — `feat(user-layer): per-token search union over FTS + nickname + user tags`.

---

### Task 5: listTags union + either-source tag filter

**Files:**
- Modify: `src/main/catalog/queries.ts` (`listTags`, tags filter arm)
- Test: `queries.test.ts` (extend)

- [ ] **Step 1: failing tests** — (a) `listTags` merges: splice tag `kick` on 2 present samples + user tag `kick` on 1 of them + 1 other present sample → one facet `kick` count 3 (distinct samples, either source); user-only tag appears; missing samples excluded from both sides; (b) tag filter `{ tags: ['kick'] }` matches samples having it from EITHER source; (c) two selected tags AND across sources (splice `kick` + user `bounce` on one sample matches `['kick','bounce']`).
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** — `listTags`: when user schema attached, gather `(name, sample_id)` pairs from both sources in SQL (user side: display-name from `user.tags.name`… **merge key is `normalizeUserName`** — splice names are already-lowercase; display name for a merged facet = the splice display form when both exist, else the user display form), union into `Map<normName, { display, ids: Set }>`, emit `{ name: display, count: ids.size }` sorted count DESC then name ASC (existing contract). Tag filter arm: replace the single HAVING subquery with per-name pairs:

```ts
for (const name of wanted) {
  where.push(`(
    EXISTS (SELECT 1 FROM sample_tags st JOIN tags t ON t.id = st.tag_id
            WHERE st.sample_id = s.id AND t.name = ?)
    ${hasUser ? `OR EXISTS (SELECT 1 FROM user.sample_tags ust JOIN user.tags ut ON ut.id = ust.tag_id
            WHERE ust.sample_file_hash = s.file_hash AND ut.normalized_name = ?)` : ''}
  )`);
  params.push(name);
  if (hasUser) params.push(normalizeUserName(name));
}
```

- [ ] **Step 4: green** — full wall (existing listTags tests must still pass — splice-only path preserved when `!hasUser`).
- [ ] **Step 5: Commit** — `feat(user-layer): union tag facet + either-source tag filtering`.

---

### Task 6: IPC surface, bridge, startDrag invoke, security pin  — **MILESTONE: full `yarn e2e` after this task**

**Files:**
- Modify: `src/shared/ipcTypes.ts` (NtwineApi + `startDrag(): Promise<void>`), `src/main/ipc.ts` (11 handlers + `userDb` dep), `src/main.ts` (openUserDb wiring), `src/preload.ts` (11 invokes + startDrag invoke), `src/main/drag.ts` (`ipcMain.on` → `ipcMain.handle`), `tests/e2e/security.spec.ts` (pin 12→23 + title)
- Test: `src/main/ipc.test.ts` (extend), `src/main/drag.test.ts` (if exists — verify handler resolution), e2e suite (milestone)

**Interfaces:**
- Produces: the spec §4 method list verbatim on `NtwineApi`/preload/`registerIpc` (`ntwine:<method>` channels). `RegisterIpcDeps` gains `userDb: UserDb`. `registerDragHandler` becomes handle-based:

```ts
export function registerDragHandler(resolvePath: (sampleId: number) => string | null, e2eEmit: E2EEmit | null = null): void {
  const icon = makeDragIcon();
  ipcMain.handle('ntwine:drag-start', async (event, sampleId: number) => {
    const resolved = resolvePath(Number(sampleId));
    const file = resolved && existsSync(resolved) ? resolved : null;
    if (e2eEmit) { e2eEmit('ntwine:e2e:drag', { sampleId: Number(sampleId), file }); return; } // resolves immediately — spec §7 e2e note
    if (file) event.sender.startDrag({ file, icon }); // blocks until the OS drag session ends; resolution IS drag-end
  });
}
```

- [ ] **Step 1: failing tests** — ipc.test.ts already stubs `ipcMain`; extend its harness: registering exposes the 11 new channels; `ntwine:setFavorite` resolves id→hash through the catalog row then calls `userDb.setFavorite` (insert a sample row, invoke the captured handler, read user.db state); `ntwine:createCollection` maps `UserNameError` to a rejected invoke whose `message` contains the reason (renderer shows it inline); `ntwine:listLibraryRail` returns the Task-1 shape.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** — main.ts whenReady: `const userDb = openUserDb(catalog, path.join(dataDir, 'user.db'));` then pass into `registerIpc({ ..., userDb })`. ipc.ts: one `ipcMain.handle` per method; id→hash helper `const hashOf = (sampleId: number): string | null => (catalog.db.prepare('SELECT file_hash AS h FROM samples WHERE id = ?').get(sampleId) as { h: string } | undefined)?.h ?? null;` — unknown id → handler returns without writing (never throws for a stale renderer id). preload.ts: 11 `ipcRenderer.invoke` lines + `startDrag: (sampleId) => ipcRenderer.invoke('ntwine:drag-start', sampleId)`; update its exceptions comment. ipcTypes.ts NtwineApi verbatim from spec §4. security.spec: sorted 23-array + title `exactly its 23 methods`.
- [ ] **Step 4: green + MILESTONE** — `yarn test && yarn typecheck && yarn lint`, then **full `yarn e2e`** (drag.spec/preview.spec/security.spec must all pass — drag.spec drives the same seam; the invoke arm resolves immediately under e2e).
- [ ] **Step 5: Commit** — `feat(user-layer): 23-method bridge, user IPC handlers, startDrag promoted to invoke`.

---

### Task 7: UserLayerStore + renderer wiring

**Files:**
- Create: `src/renderer/stores/UserLayerStore.ts`
- Modify: `src/renderer.tsx` (instantiate + StoreContext), `src/renderer/components/StoreContext.ts` (Stores type), `src/renderer/stores/LibraryStore.ts` (add `refreshTags()` + expose `rerun()` = public runQuery)
- Test: `src/renderer/stores/UserLayerStore.test.ts`

**Interfaces:**
- Produces:

```ts
export class UserLayerStore {
  favoritesCount = 0;
  collections: { id: string; name: string; count: number }[] = [];
  constructor(api: NtwineApi, library: LibraryStore) // same DI pattern; makeAutoObservable(this, { api: false, library: false })
  async init(): Promise<void>;                        // fetch rail
  async toggleFavorite(row: SampleRow): Promise<void>; // setFavorite(!row.favorite) → refresh()
  async setNickname(sampleId: number, nickname: string | null): Promise<void>;
  async addTag(sampleId: number, name: string): Promise<void>;      // then refreshTags too
  async removeTag(sampleId: number, name: string): Promise<void>;   // then refreshTags too
  async createCollection(name: string): Promise<{ id: string } | { error: string }>;
  async renameCollection(id: string, name: string): Promise<{ error: string } | null>;
  async deleteCollection(id: string): Promise<void>;  // if current scope is this collection → library.setScope(null) FIRST
  async addToCollection(collectionId: string, sampleId: number): Promise<void>;
  async removeFromCollection(collectionId: string, sampleId: number): Promise<void>;
  private async refresh(opts?: { tags?: boolean }): Promise<void>; // rail + library.rerun() (+ refreshTags when tags changed)
}
```

`createCollection`/`renameCollection` catch the rejected invoke and return `{ error }` — popover/rail editors render it inline; every other action lets errors surface to console (same posture as existing stores).

- [ ] **Step 1: failing tests** — mock api object: `toggleFavorite` calls `setFavorite` with negated flag then `listLibraryRail` + `library.rerun`; `addTag` triggers `listTags` refresh on the library double; `deleteCollection` on the currently-scoped collection resets scope to null BEFORE re-query (assert call order); `createCollection` collision returns `{ error }` (mock rejects).
- [ ] **Step 2: red.** — **Step 3: implement** (LibraryStore: `refreshTags()` = `this.tags = await this.api.listTags()` in runInAction; make `runQuery` public as `rerun()`). — **Step 4: green.** — **Step 5: Commit** `feat(user-layer): UserLayerStore + library refresh plumbing`.

---

### Task 8: LIBRARY rail section

**Files:**
- Create: `src/renderer/components/LibraryRail.tsx`
- Modify: `src/renderer/components/App.tsx` (PacksScroll gets `<LibraryRail />` above `<PackRail />`), `src/renderer/components/PackRail.tsx` (REMOVE the All Samples row + its totalSamples reduce; PACKS header), `src/renderer.tsx`/`StoreContext` if not done in T7
- Test: e2e later (Task 14/15); unit: none beyond typecheck (pure view over stores)
- Modify: `tests/e2e/browse.spec.ts` — the rail pin `['All Samples', ...packs]` moves: packs listbox now pins `fixture.packs` exactly; add a LIBRARY-listbox assertion (`All Samples`, `Favorites`)

**Interfaces:** LibraryRail renders `role="listbox" aria-label="Library"` with options: All Samples (active when `library.filters.scope === undefined`, click → `setScope(null)`), Favorites (heart glyph + `userLayer.favoritesCount`, click → `setScope({kind:'favorites'})`), one option per `userLayer.collections` (name + count, click → collection scope), and a `+ New collection` button (NOT role=option) that swaps to an inline `<input aria-label="New collection name">`; Enter → `createCollection` (error → inline `<span role="alert">`), Esc → cancel. Right-click on a collection option opens a minimal inline menu (Rename…/Delete…) — implemented here as two buttons in a small absolutely-positioned box (the full row context menu is Task 10; this one is collection-local and tiny). Delete shows an in-app confirm (two buttons); on confirm calls `userLayer.deleteCollection`. Empty states per spec §5.1 rendered by SampleList? — NO: keep SampleList untouched; the empty-state strings for favorites/collection scopes replace the existing `No samples match the current filters` text in `SampleList.tsx`'s EmptyState via a small helper `emptyStateText(scope)` in `src/renderer/emptyState.ts` (unit-testable pure function; SampleList imports it).

- [ ] Step 1: `src/renderer/emptyState.test.ts` — favorites scope → "No favorites yet — press F on a sample you love."; collection scope → "Drag samples here, or press C on a selected sample."; otherwise → "No samples match the current filters". Red → implement → green.
- [ ] Step 2: build LibraryRail + App/PackRail changes; `yarn typecheck && yarn lint && yarn test`.
- [ ] Step 3: update `browse.spec.ts` pins (do NOT run e2e yet — milestone comes at Task 13; but keep the spec edit in this commit so the suite is coherent at the milestone).
- [ ] Step 4: Commit — `feat(user-layer): LIBRARY rail section (All Samples, Favorites, collections)`.

---

### Task 9: row UI — heart, nickname, user chips, missing read-only

**Files:**
- Modify: `src/renderer/components/SampleRow.tsx`, `src/renderer/components/SampleList.tsx` (pass `onToggleFavorite`)
- Test: typecheck/lint (+e2e Task 14)

Row changes (spec §5.2): heart `<button aria-pressed={row.favorite} aria-label="Favorite">` rendered only when `!row.missing`, click `e.stopPropagation()` + `onToggleFavorite()` (SampleList passes `() => userLayer.toggleFavorite(row)`); filename cell shows `row.nickname ?? middleTruncate(row.filename)` — when nicknamed, render nickname + `<DimmedReal>{middleTruncate(row.filename, 24)}</DimmedReal>`, `title` stays `row.filename`; user chips render after splice chips within the same `MAX_INLINE_TAGS` budget (`[...row.tags.map(splice), ...row.userTags.map(user)]` sliced together; user chips get `$user` accent-outline styling and `data-testid="user-tag-chip"`).

- [ ] Implement → `yarn test && yarn typecheck && yarn lint` → Commit `feat(user-layer): row heart, nickname display, user tag chips`.

---

### Task 10: row context menu

**Files:**
- Create: `src/renderer/components/RowContextMenu.tsx`
- Modify: `src/renderer/components/SampleList.tsx` (onContextMenu on rows → open at cursor for that row), `src/renderer/components/App.tsx` if a portal root is needed (prefer plain absolute positioning inside Scroller's nearest positioned ancestor — use `position: fixed` at the mouse point; no portal needed)
- Test: e2e (Task 14/15); pure `menuItemsFor(row, scope)` helper unit test

**Interfaces:** `menuItemsFor(row: SampleRow, scope: Scope | undefined): { id: 'favorite'|'nickname'|'tags'|'addto'|'removefrom'; label: string }[]` — pure, in `src/renderer/rowMenu.ts`: favorite label flips (`Favorite`/`Unfavorite`), `removefrom` present only when `scope?.kind === 'collection'`, and **missing rows return []** (no menu — spec §5.2). The component renders `role="menu"` items `role="menuitem"`, closes on Esc/click-away/action; `addto` opens the Task-11 collection popover; `nickname` starts the Task-11 inline edit; `tags` opens the tags popover.

- [ ] Step 1: `rowMenu.test.ts` (all four branches + missing → []) red → green.
- [ ] Step 2: component + wiring; gates; Commit `feat(user-layer): in-app row context menu`.

---

### Task 11: popovers (tags, add-to-collection) + nickname inline edit

**Files:**
- Create: `src/renderer/components/TagsPopover.tsx`, `src/renderer/components/CollectionPopover.tsx`
- Modify: `src/renderer/components/SampleRow.tsx` (inline nickname editor state), `src/renderer/components/SampleList.tsx` (popover anchoring: open for SELECTED row at its virtual position), `src/renderer/stores/UserLayerStore.ts` (popover open-state: `openPopover: { kind: 'tags'|'collection'; sampleId: number } | null`, `nicknameEditId: number | null`)
- Test: store-level unit (open/close transitions); e2e Task 14/15

Behaviors (spec §5.3): TagsPopover — input `aria-label="Add tag"` with autocomplete list from `listUserTags()` filtered by prefix; Enter adds (`userLayer.addTag`); existing user tags of the row listed as chips with `✕` remove buttons; splice tags shown read-only (muted, no ✕); Esc closes. CollectionPopover — input `aria-label="Add to collection"`; type-ahead resolves existing names (normalized compare in the component via simple `toLowerCase().trim()` against fetched names is NOT the persisted normalizer — instead match by `name.trim().toLowerCase()` for UX and let main be authoritative); Enter adds to highlighted; Cmd/Ctrl+Enter with a non-matching name → `createCollection` then add ("create and add in one gesture"); rejected create shows the returned `{ error }` inline. Nickname editor — `nicknameEditId` renders an `<input aria-label="Nickname">` in place of the filename cell for that row; Enter commits (`setNickname`, `''`→null), Esc cancels.

- [ ] Implement with store transitions unit-tested; gates; Commit `feat(user-layer): tags/collection popovers + nickname inline edit`.

---

### Task 12: keyboard map + selection-follow rule

**Files:**
- Modify: `src/renderer/components/SampleList.tsx` (F/T/C/N/Delete in `handleKeyDown`), `src/renderer/components/App.tsx` (window-level Cmd/Ctrl+F), `src/renderer/components/TopBar.tsx` (search Esc + a `ref` App can focus)
- Create: `src/renderer/keymap.ts` — pure `listKeyAction(e: { key, metaKey, ctrlKey }, ctx: { hasSelection, scopeKind }): Action | null`
- Test: `src/renderer/keymap.test.ts`

Rules (spec §5.4): `F` toggle favorite (no-op without selection), `T`/`C`/`N` open the matching popover/editor for the selected row, `Delete`/`Backspace` only when `scopeKind === 'collection'` → removeFromCollection + selection moves next (§3.1 — implement in SampleList: capture the selected index in `visibleIds` before the write; after re-query, select `visibleIds[min(i, len-1)]` with `{autoplay:false}`; same helper used by unfavorite-under-Favorites via UserLayerStore calling back). Cmd/Ctrl+F at window level → focus search input (App `useEffect` keydown listener; TopBar exposes focus via a forwarded ref or a `focusSearch` callback registered on mount). Esc in search: non-empty → `setSearch('')`; empty → `blur()` + focus the list container.

- [ ] Step 1: keymap.test.ts (every row of the table incl. no-selection no-ops and non-collection Delete → null) red → green.
- [ ] Step 2: wire; gates; Commit `feat(user-layer): keyboard map (F/T/C/N/Delete, Cmd+F, search Esc)`.

---

### Task 13: drag-in (slot module, drop targets)  — **MILESTONE: full `yarn e2e` after this task**

**Files:**
- Create: `src/renderer/dragSource.ts` + `src/renderer/dragSource.test.ts`
- Modify: `src/renderer/components/SampleRow.tsx` (handleDragStart arms slot + awaits invoke in try/finally), `src/renderer/components/LibraryRail.tsx` (drop targets on Favorites + collection options, all gated on slot)
- Test: unit (slot lifecycle incl. token semantics); e2e synthetic in Task 15

**Interfaces (spec §7 + Codex consult, verbatim semantics):**

```ts
// src/renderer/dragSource.ts — module-level slot, session-token guarded
export interface DragSource { sampleId: number; token: symbol }
export function armDragSource(sampleId: number): symbol;
export function peekDragSource(): DragSource | null;
export function consumeDragSource(): DragSource | null;      // read-and-clear
export function clearDragSource(token: symbol): void;        // clears only if the token matches
```

SampleRow:

```ts
const handleDragStart = (e: DragEvent<HTMLDivElement>): void => {
  e.preventDefault();
  if (row.missing) { /* existing badge flash path unchanged */ return; }
  const token = armDragSource(row.id);
  void (async () => {
    try { await api.startDrag(row.id); } finally { clearDragSource(token); }
  })();
};
```

LibraryRail targets: `onDragEnter/onDragOver` — `if (peekDragSource() === null) return;` else `e.preventDefault()` + hover state; `onDragLeave`/window `blur` clear hover; `onDrop` — `const src = consumeDragSource(); if (!src) return; e.preventDefault();` then Favorites target → `userLayer.toggleFavorite`-equivalent (`setFavorite(src.sampleId, true)`), collection target → `userLayer.addToCollection(collection.id, src.sampleId)`; clear hover. Dev probe (Codex consult B): `console.debug('[ntwine:drag-in]', phase, { slot: peekDragSource()?.sampleId ?? null, targetId })` in enter/over(throttled to first)/drop — visible in the morning hands-on's devtools.

- [ ] Step 1: dragSource.test.ts — arm/peek/consume; stale-token clear is a no-op after re-arm; consume clears; clear(token) after consume doesn't disturb a newer slot. Red → green.
- [ ] Step 2: wire SampleRow + LibraryRail; gates (`yarn test && yarn typecheck && yarn lint`).
- [ ] Step 3: **MILESTONE — full `yarn e2e`** (whole suite incl. Tasks 8-12 UI: browse pin update proves out here; fix anything red before committing further).
- [ ] Step 4: Commit `feat(user-layer): drag-in slot + gated collection drop targets`.

---

### Task 14: e2e — favorites, nickname, tags

**Files:**
- Create: `tests/e2e/favorites.spec.ts`, `tests/e2e/nickname.spec.ts`, `tests/e2e/user-tags.spec.ts`
- Modify: `tests/e2e/harness/actions.ts` (add `rowHeart(page, filename)`, `openTagsPopover`, `contextMenuOn(page, filename)` helpers as needed)

Test content (spec §8; use existing patterns — `importAndWait`, `rowByFilename`, `expect.poll(readCount)`, relaunch via `launchNtwine` + try/finally):
- favorites.spec: click heart on `AD_Kick_01.wav` → `aria-pressed=true`; rail Favorites count 1; click Favorites scope → count 1 row; press `F` (list focused, selection on it via click) → unfavorites → §3.1: EmptyState shows favorites empty-string; relaunch same profile → favorite persisted (re-favorite first), rail count restored.
- nickname.spec: `N` on selected row → input; type `THE snare` Enter → cell text shows nickname, `title` still filename; `search('snare kick')` → mixed-vocabulary hit (count 1); clear nickname (N, empty, Enter) → filename text restored.
- user-tags.spec: `T` popover on a row → add `bounce`; chip (`data-testid=user-tag-chip`) appears; tag cloud gains `bounce 1` chip; toggling it filters to 1; search `bounce` finds it; remove via popover ✕ → chip gone, cloud updated (facet refresh pin).
- [ ] Write specs → `yarn e2e:only` against the Task-13 packaged build IF unchanged since (assertProductionArtifact enforces freshness — if any `src/` fix was needed, full `yarn e2e`); iterate to green. Commit `test(user-layer): favorites/nickname/user-tags e2e`.

---

### Task 15: e2e — collections + reimport survival; suite reconciliation  — **MILESTONE: full `yarn e2e` + full gates (final)**

**Files:**
- Create: `tests/e2e/collections.spec.ts`, `tests/e2e/user-layer-reimport.spec.ts`
- Modify: any existing spec still red from the restructure (expected: none beyond browse.spec already updated in Task 8; verify `filters.spec` `{}` pin holds)

Test content:
- collections.spec: create `Crate` via rail + inline input; duplicate create shows inline `role=alert`; `C` popover on selected row → Enter adds (count 1); collection scope shows the row; `Delete` removes (empty state string); context-menu `Add to collection ▸` path adds again; rename via collection right-click (collision error pinned); synthetic drag-in: `dispatchEvent(new DragEvent('dragstart'))` on a row arms the slot (e2e drag seam resolves the invoke immediately — dispatch `drop` on the collection option SYNCHRONOUSLY within the same `page.evaluate` so the drop consumes the slot before the invoke's microtask clears it; this sequencing is the spec §7 e2e note); delete-active-scope → falls back to All Samples (count 12); relaunch → collection + membership persisted.
- user-layer-reimport.spec: favorite + nickname + tag a row; `openSettings` → click `Re-run import`; wait for import completion (`expect.poll(readCount)` back to 12); assert favorite/nickname/tag intact (the §2.1 hash-key guarantee, end-to-end).
- [ ] Write specs → **full `yarn e2e`** green first-hand (all ~26 specs) → `yarn test && yarn typecheck && yarn lint` → Commit `test(user-layer): collections + reimport-survival e2e`.

---

## Execution notes for the SDD controller

- Task order is the dependency order; no parallel implementers.
- Full `yarn e2e` milestones: after Task 6, Task 13, Task 15. Unit wall + typecheck + lint per task.
- The native drag-in GESTURE stays unproven overnight by design (spec §7 adaptation) — the synthetic seam covers the logic; the morning hands-on is the spike. Never claim the gesture verified.
- Judgment calls mid-run: consult Codex (`codex exec -s read-only -C <repo>`), record the ruling in the ledger, continue.
- After Task 15: finishing flow — push `feat/user-layer`, PR with `--base main` (ALWAYS explicit), merge on green, tree-verify, cleanup.
