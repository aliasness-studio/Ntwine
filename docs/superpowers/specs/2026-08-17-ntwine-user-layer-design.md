# Ntwine user library layer — design spec

Date: 2026-08-17 · Repo: `aliasness-studio/Ntwine` · Tracking issue: #6
Consulted: Codex second-opinion brainstorm (repo-grounded, 2026-08-17) — its identity findings
and bloat warnings are folded in throughout. Panel-reviewed 2026-08-17 (Claude/Codex/agy,
prompt md5 `8b060e430143a266ad006958a02e0fcd`); all findings applied below.

## 0. Owner decisions (locked, 2026-08-17)

- **D1 — Cut:** the full v1 user layer: favorites, custom tags, nicknames, flat collections,
  keyboard map. Saved searches / multi-select batch ops / quick-assign slots are named v1.5, not
  built now.
- **D2 — "Aliases" means nicknames:** an in-app display rename ("THE snare"); the file on disk is
  never touched or renamed. UI copy says **Nickname**, not Alias.
- **D3 — Premium bar, flat structures:** inspiration pool is Loopcloud / Ableton Collections /
  XO / Sononym; tag hierarchies, nested collections, smart folders, sharing, and AI similarity
  are explicitly out (bloat risk — each looks premium alone, together they kill the app).
- **D4 — Drag-into-collections is wanted** ("folders where they can drag things into") — the
  gesture question is resolved in §7.

## 1. Goals and non-goals

**Goal.** A user-data layer over the imported Splice catalog that turns browsing into
collecting: mark keepers, name them, tag them in your own vocabulary, group them into
collections — all keyboard-first, all surviving re-imports, library relocation, and a future
second machine.

**Non-goals (v1).** Sync UI (the data model is sync-*ready*; no sync feature ships), saved
searches, multi-select, batch operations, collection manual reordering, tag colors, ratings,
notes, editing/renaming anything on disk, touching Splice's own metadata (upstream tags stay
read-only).

## 2. Identity and storage

### 2.1 The durable key is `file_hash`

`samples.file_hash` is `UNIQUE NOT NULL` and is the importer's upsert key
(`ON CONFLICT(file_hash)`), so it survives the two locally-provable events: idempotent
re-import and library relocation (it is path-independent; internal `samples.id` is local-only).
The hash is *supplied by Splice's own sounds.db*, not computed by Ntwine — machine-to-machine
durability therefore rests on the stated assumption that Splice's DB carries the same hash for
the same sample on both of the owner's machines (same account; plausible, unverifiable from
this repo — the first Windows import should confirm it before any sync feature is built).
**Every user-layer row references `sample_file_hash TEXT`.** No sample-level Splice UUID exists
in the importer today (only `pack_uuid`); nothing in this spec may assume one.

A user row whose hash currently matches no catalog sample is *dormant, never deleted* — it
reattaches the moment a matching sample is imported again. No repair UI in v1.

### 2.2 Sidecar `user.db`

User data lives in its own SQLite file, `<dataDir>/user.db`, beside `catalog.db` — precious
curation must not share blast radius with importer/FTS-rebuild bugs or any future
"rebuild catalog" flow, and future sync/backup is "copy one small file". The main process opens
`catalog.db` as today and `ATTACH`es `user.db` as schema alias `user` on the same connection, so
queries join across the two cheaply. Schema is created with `CREATE TABLE IF NOT EXISTS` at
open, and the attached database's journal mode is set explicitly (`PRAGMA user.journal_mode =
WAL`, matching catalog.db) — per this spec's own principle, never depend on whichever default a
platform's SQLite build ships.

Two persistence notes with teeth:

- **Foreign keys.** The schema's `ON DELETE CASCADE`s are load-bearing (§4
  `deleteCollection`). better-sqlite3 13 defaults `foreign_keys` ON — confirmed empirically in
  this repo (see the pragma note in `src/main/importer/fixtureSpliceDb.ts`) — but per that same
  note's principle (never depend on whichever default a platform's SQLite build ships), the
  user-db open routine executes `PRAGMA foreign_keys = ON` explicitly, and a unit test pins
  that deleting a collection actually cascades its items.
- **Clean breaks cost more here.** The pre-release rule (clean breaks, no migration stamps)
  applies, but `user.db` is the app's first *unrebuildable* data — catalog.db can always be
  re-imported; deleted curation is gone. Once real curation exists, a schema clean break on
  `user.db` is an owner-ask, not a reflex.

### 2.3 Schema

```sql
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
  normalized_name TEXT NOT NULL UNIQUE,           -- normalized in JS, see §3.4
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
  normalized_name TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user.collection_items (
  collection_id    TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  sample_file_hash TEXT NOT NULL,
  added_at         TEXT NOT NULL,
  PRIMARY KEY (collection_id, sample_file_hash)
);
```

Timestamp discipline: `sample_state` rows are mutable and stamp `updated_at` on every write.
Every other table's rows are insert/delete-only — their timestamp is their `created_at`/
`added_at` — except `collections.name`, which `renameCollection` updates in place without any
stamp (v1 has no consumer for a collection-modified time; sync-era needs add it as a clean
break).

Name rules (tags AND collections, identical): names are trimmed; empty-after-trim is rejected;
uniqueness is on `normalizeUserName(name)` — **the one named normalizer for every persisted
`normalized_name` and every user-name comparison**:

```ts
normalizeUserName(name) = name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
```

(NFC first so an NFD "café" and an NFC "café" collide as one name — the library's real
filenames contain both encodings; internal whitespace collapses; JS `toLowerCase()`, not SQL
`lower()`, for non-ASCII folding.) Tag/collection uniqueness, user-tag filter matching, the
merged cloud's dedupe (§3.3), and autocomplete reuse all call this one function. Splice tags
arrive lowercased from import (transform.ts), so the same normalizer compares them unchanged. For **tags**, adding "Kick " when "kick" exists
reuses the existing tag (tags are a vocabulary — silent reuse is correct). For **collections**,
`createCollection`/`renameCollection` into an existing normalized name is an **error**, surfaced
inline at the editor (collections are containers — two "Drums" is a mistake, and silently
merging into an existing container would move samples somewhere the user didn't point). The
add-to-collection popover's type-ahead resolves existing names to their collection before any
create fires, so the collision path only arises from explicit creates/renames.

Deliberately absent (YAGNI + the reserved-pool rule — no dead columns waiting for a feature):
ratings, notes, tag/collection colors, `position` ordering (v1.5 adds it with a clean break),
saved-searches table (v1.5).

## 3. Query model

### 3.1 Scope

The list is always scoped by exactly one of: **All Samples** (default) · **one pack** ·
**Favorites** · **one collection**. `QueryFilters` gains `scope`:

```ts
type Scope =
  | { kind: 'all' }
  | { kind: 'pack'; packId: number }
  | { kind: 'favorites' }
  | { kind: 'collection'; collectionId: string };
```

(`packId` was previously a bare optional field; it moves into `scope` — clean break, one
serialization. Type/key/BPM/tag/search filters compose with every scope exactly as they do with
packs today.)

When a user-layer write removes the selected row from the current scope (unfavoriting under
Favorites, `Delete` under a collection), selection moves to the next row, clamping at the end —
one rule, both sites.

### 3.2 Rows

`querySamples` LEFT JOINs `user.sample_state` and aggregates `user.sample_tags` by hash.
`SampleRow` (shared IPC type) gains:

```ts
favorite: boolean;
nickname: string | null;
userTags: string[];   // display names, sorted A-Z
```

### 3.3 Tag filtering

The filter panel's tag cloud lists the union of Splice tags and user tags by name (counts =
distinct matching samples from either source, present-only like today). **The union is owned by
main's existing `listTags` — its semantics grow; no new bridge method** (the renderer cannot
compose it: `listUserTags` carries no counts). A selected tag chip matches a sample if
**either** its Splice tags **or** its user tags contain that name. Multiple selected tags AND
together, exactly as today. No visual distinction in the cloud (v1); a row's own user-tag chips
are visually accented so you can tell your vocabulary apart in place.

### 3.4 Search

Search must find what the user named things, without breaking mixed-vocabulary queries.
Semantics are **per-token**: a sample matches the search text when **every** search token
prefix-matches, at a word boundary, at least one of — its FTS-indexed text (filename, Splice
tags, pack name — today's index), its nickname, or one of its user-tag names. Tokens AND
together; sources union per token (so "snare kick" finds the file `AD_Kick_01.wav` nicknamed
"THE snare").

Nickname/user-tag matching and all name normalization run in **main-process JavaScript**
(`toLowerCase()` + tokenization there), not SQL — SQLite's `LIKE`/`lower()` fold ASCII only and
invite `%`/`_` escaping bugs, while the FTS side's tokenizer folds wider; JS keeps the two
sides' folding honest and handles the library's real unicode filenames. Whether the final
row-set intersection happens in SQL or JS is the plan's call — at 4.2k samples either is cheap.
The top-bar result count reflects all of this, so the e2e assertion surface is unchanged in
kind.

## 4. IPC surface

New `NtwineApi` methods (bridge grows from 12 to **23** exposed methods — `security.spec` pins
the bridge as BOTH an exact sorted array and the prose test title "exactly its 12 methods";
both update in the same task that grows the bridge. This sentence is the canonical statement of
that rule; §8 references it):

```ts
setFavorite(sampleId: number, on: boolean): Promise<void>;
setNickname(sampleId: number, nickname: string | null): Promise<void>;  // null clears; trimmed; '' -> null
listUserTags(): Promise<string[]>;                                      // display names A-Z, for autocomplete
addUserTag(sampleId: number, name: string): Promise<void>;
removeUserTag(sampleId: number, name: string): Promise<void>;
listLibraryRail(): Promise<{
  favorites: number;                                                    // present-only count
  collections: { id: string; name: string; count: number }[];           // A-Z, present-only counts
}>;
createCollection(name: string): Promise<{ id: string }>;                // name-collision -> error (§2.3)
renameCollection(id: string, name: string): Promise<void>;              // name-collision -> error (§2.3)
deleteCollection(id: string): Promise<void>;                            // items cascade; samples untouched
addToCollection(collectionId: string, sampleId: number): Promise<void>;
removeFromCollection(collectionId: string, sampleId: number): Promise<void>;
```

One EXISTING method changes shape: **`startDrag` is promoted from `ipcRenderer.send` to
`invoke`** — `webContents.startDrag` blocks the main process until the OS drag session ends
(drag.ts's own comment), so the invoke's resolution IS the drag-end signal §7 needs. Method
count is unchanged by this (still 23 total).

All writes resolve `sampleId → file_hash` in the main process (the renderer never sees hashes)
and are synchronous SQLite under the hood like the rest of ipc.ts (handlers answering in
registration order is what keeps LibraryStore's un-sequenced re-queries safe — the same
property the existing handlers rely on; do not make any user-layer handler internally async). `sample_state` writes stamp
`updated_at` (§2.3's timestamp discipline). Mutations return after the write; the renderer
re-queries what it needs (same request/response discipline as filters — no push events added
in v1).

## 5. UI

### 5.1 Rail: LIBRARY section

A new **LIBRARY** section sits at the top of the packs scroller (inside the same scroll — the
dock split from QoL r1 is unchanged): the existing **All Samples** row moves in as its first
row, then **Favorites** (heart glyph + present-only count), each collection A-Z (count), and a
**"+ New collection"** row (inline name editor on click; a name collision or empty name shows
an inline error on that editor, §2.3). Below it, the existing PACKS list under its own small
header, packs only. Clicking Favorites / a collection sets the scope (§3.1); All Samples clears
it. The active scope row highlights exactly like the active pack today.

Collection context menu (right-click): **Rename…** (inline edit; collision → inline error),
**Delete…** (confirm dialog in-app; deleting a collection never touches samples). **Deleting
the collection that is the current scope reverts the scope to All Samples**; renaming it just
relabels in place. Empty states: Favorites scope — "No favorites yet — press F on a sample you
love."; collection scope — "Drag samples here, or press C on a selected sample."

### 5.2 Rows

- **Heart**: a small heart button at the row's right edge — rendered on every NON-missing row,
  filled when favorited, hollow-on-hover otherwise; `aria-pressed`; click toggles without
  changing selection or playback.
- **Missing rows are read-only for the user layer** (one rule resolving every affordance):
  existing user state still *displays* (nickname, user-tag chips) but no edit affordance exists
  — no heart, no context menu (already the rule), and the keyboard cannot reach them (selection
  skips missing rows today). Curation on a missing row resumes when the file does.
- **Nickname**: when set, the filename cell shows the nickname; the real filename remains the
  `title` tooltip (it already is) and reappears dimmed-small after the nickname where width
  allows. Middle-truncation applies to whichever text renders.
- **User-tag chips**: rendered with the Splice chips, accent-outlined, after Splice's within the
  same +N overflow budget.
- **Context menu** (in-app React menu, not a native `Menu` — stylable and Playwright-drivable):
  Favorite/Unfavorite · Nickname… · Tags… · Add to collection ▸ (submenu lists collections +
  "New collection…") · Remove from this collection (only under a collection scope). Missing rows
  get no context menu (consistent with their no-click rule).

### 5.3 Popovers and inline edits

- **Tags popover** (`T` or context menu): anchored to the selected row; text input with
  autocomplete over `listUserTags()`; Enter adds (creating on first use), listed chips with ✕ to
  remove; Esc closes. Splice tags are visible there but read-only.
- **Nickname editor** (`N` or context menu): inline edit of the filename cell on the selected
  row; Enter commits, Esc cancels, empty clears the nickname.
- **Add-to-collection popover** (`C` or context menu): anchored to the selected row; type-ahead
  over collection names (an existing name always resolves to its collection, §2.3); Enter adds
  to the highlighted collection; typing a new name and Cmd/Ctrl+Enter creates it and adds in one
  gesture; Esc closes.

### 5.4 Keyboard map

Registration points are split by necessity: `F`/`T`/`C`/`N`/`Delete` live on the list container
(like today's arrows); `Cmd/Ctrl+F` is window-level (it must work from the rail and popovers);
the `Esc` search behavior lives on the search input itself (focus is by definition there).
A focused text input always types normally; popovers trap their own keys, Esc unwinds one
layer. **Every single-key action is a no-op when nothing is selected** (the existing
`replay()` no-op pattern).

| Key | Action |
|---|---|
| `F` | Toggle favorite on the selected row (under Favorites scope, selection then follows §3.1's next-row rule) |
| `T` | Tags popover for the selected row |
| `C` | Add-to-collection popover for the selected row |
| `N` | Nickname inline edit for the selected row |
| `Delete`/`Backspace` | Under a collection scope only: remove selected row from that collection (§3.1 next-row rule; never deletes files) |
| `Cmd/Ctrl+F` | Focus search |
| `Esc` (in search) | Clear search if non-empty, else return focus to the list |

Existing bindings unchanged: arrows navigate+play (+snap), `ArrowLeft`/`Space` retrigger.

## 6. Stores (renderer)

A new `UserLayerStore` (MobX 6, same DI pattern as LibraryStore: takes the typed api shape)
owns rail data (`favoritesCount`, `collections`), popover/menu open-state targets, and the write
actions; `LibraryStore` keeps query/filter ownership and gains only the `scope` field. Row
user-fields arrive on `SampleRow` through the existing query path — no second per-row store.
After any user-layer write, the store re-fetches the rail summary, **re-fetches the tag facets
(`listTags`) when the write touched user tags** (the cloud is a query-time snapshot in
LibraryStore and would otherwise go stale until relaunch), and asks LibraryStore to re-run the
current query — counts and row fields refresh through the one existing pipeline. (The cloud is
an init-time snapshot in LibraryStore today, which is why the explicit re-fetch is needed.)

## 7. Drag-into-collection

Native drag-out (`webContents.startDrag`) stays exactly as is from the user's point of view —
dragging a row still lands files in the DAW/Finder. For drag-*in*: rail collection rows are
HTML5 drop targets, discriminated by a renderer-owned **drag-source slot** with an explicit
lifecycle (after `dragstart`'s `preventDefault` there is no HTML5 drag session, so the slot is
the ONLY way to tell our own native drag from an external Finder/Explorer file drag — the two
look identical at the drop site):

- Today's `handleDragStart` already `preventDefault`s and invokes the native drag; **the slot
  is NEW work**: record the dragged sample id in the module-level slot *before* invoking
  `startDrag`.
- `startDrag` is an invoke (§4) that resolves when the OS drag session ends; **the renderer
  clears the slot in a `finally` around the awaited invoke** — a rejected invoke or thrown
  handler can never leave a stale id behind (unit-pinned). No push event needed, no reliance on
  `dragend` (which never fires for the cancelled HTML5 drag). A consumed drop also clears the
  slot immediately.
- **Discrimination rule: an empty slot means every file drop is ignored** — and not merely the
  `drop` handler: `dragenter`/`dragover` handling, hover highlight, `preventDefault()`, and
  `dataTransfer.dropEffect` are ALL gated on a non-empty slot, so an external Finder drag over
  the rail never shows a copy cursor or stuck hover state (Codex consult, 2026-08-17). Hover
  styling clears on `drop`, `dragleave`, window blur, and slot clear, independently of any data
  write.
- The slot carries a **session token**: `finally` only clears the slot it armed
  (`if (slot?.token === token)`), so a drop consumed before the invoke resolves — or a fast
  second drag — is never clobbered by a stale `finally`. `addToCollection` is idempotent
  (the composite PK; duplicate adds are no-ops).

Feasibility (**adapted for the overnight run, Codex-consulted**): whether a native `startDrag`
session delivers DOM drop events over the app's own window cannot be proven headlessly — the
session needs a real OS mouse. So v1 ships the drag-in **architecture complete but the native
gesture unproven**: slot + gated drop targets are wired (inert-but-harmless if the OS never
delivers the events), the e2e synthetic seam exercises the target/slot logic, and **the
morning hands-on is the spike** — the owner drags a row onto a collection on macOS (Windows on
his box later); if the OS doesn't deliver, the per-row grab-handle fallback (plain HTML5 in-app
drag for collection drops, native drag-out kept on the row body) remains an explicit owner
decision — it changes row hit-areas and is never adopted silently. Keyboard (`C`) and context
menu cover the same action regardless, so the feature never hinges on the gesture.

Drop feedback: the hovered collection row highlights; on drop its count bumps. Dropping onto
Favorites favorites the sample (same slot mechanism). E2E note: the harness's drag seam skips
the real native drag, so the e2e arm's `startDrag` invoke resolves immediately — which clears
the slot; `collections.spec`'s synthetic drag-in must sequence its synthetic drop before/around
that resolution (the plan owns the exact mechanism).

## 8. E2E and testing

- Unit (Vitest): user-db module (schema, favorite/nickname/tag/collection CRUD, normalization
  collisions incl. the collection-collision error, **delete-cascade actually fires** (§2.2),
  dormant-hash reattach), query composition (scopes × filters × search incl. the §3.4 per-token
  mixed-vocabulary case), UserLayerStore actions (incl. tag-facet refresh), keyboard-map
  dispatch decisions (incl. empty-selection no-ops).
- E2E (Playwright, same harness): `favorites.spec` (heart click + `F`, rail count, scope view,
  §3.1 selection rule on unfavorite-under-scope, survives relaunch — the persistence.spec
  relaunch pattern), `tags.spec` (T popover add/remove, autocomplete reuse, chip accent,
  filter-cloud union matching, search-by-user-tag), `nickname.spec` (N edit, display + tooltip,
  search-by-nickname incl. a mixed-vocabulary query, clear restores filename),
  `collections.spec` (create/rename/delete incl. collision inline errors and
  delete-active-scope fallback, add via C popover + context menu + drag-in when the spike
  lands, Delete-key removal, counts, empty states, survives relaunch),
  `user-layer-reimport.spec` (favorite → Settings re-import → favorite intact: the §2.1
  guarantee, pinned end-to-end).
- `security.spec` bridge pin (array + title) updates per §4's canonical rule.
- Known existing-spec fallout, budgeted not discovered: `browse.spec` pins the Packs listbox as
  exactly `['All Samples', ...packs]` (breaks when All Samples moves to LIBRARY, §5.1), and
  `filters.spec` asserts the `__ntwineE2E` filters echo clears to `{}` (the §3.1 scope clean
  break must keep "no scope" serializing to an absent key so that pin stays true — pin it that
  way deliberately).
- Fixture: unchanged — user.db starts empty in every test; user state is created through the
  real UI (the honest path). `__ntwineE2E` snapshot may gain a `scope` echo if a spec needs it;
  DOM-first assertions preferred.
- Gates: unchanged law — unit suite + `yarn e2e` (full repackage) green first-hand before PR.

## 9. v1.5 ladder (named, not built)

Saved searches (serialize `QueryFilters`+scope JSON), multi-select + batch favorite/tag/add,
collection manual ordering (`position`, clean break), quick-assign collection slots (`1`–`7`),
tag rename/merge management UI, drag-out of a whole collection.

## 10. Taste calls made for the owner (veto anytime)

1. LIBRARY section lives at the *top* of the rail, above PACKS, inside the same scroller — and
   All Samples moves into it as its first row.
2. Favorites/collections behave as *scopes* (like packs), not as filter chips.
3. User-tag chips are accented on rows; the filter cloud shows one merged vocabulary.
4. Collection views keep the standard sort (manual ordering is v1.5).
5. In-app context menu rather than native OS menus (stylable + testable).
6. `Delete` removes from a collection only under that collection's scope — nothing anywhere else.
7. Duplicate collection names are inline errors (tags silently reuse; collections never merge
   silently) — the C-popover resolves existing names before creating, so you only hit the error
   on an explicit create/rename.
