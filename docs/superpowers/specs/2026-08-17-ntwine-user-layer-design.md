# Ntwine user library layer — design spec

Date: 2026-08-17 · Repo: `aliasness-studio/Ntwine` · Tracking issue: #6
Consulted: Codex second-opinion brainstorm (repo-grounded, 2026-08-17) — its identity findings
and bloat warnings are folded in throughout.

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

`samples.file_hash` is `UNIQUE NOT NULL`, already imported, and is the only identity that
survives all three required events: idempotent re-import (import upserts on it), library
relocation (path-independent), and machine-to-machine travel (content-derived; internal
`samples.id` is local-only). **Every user-layer row references `sample_file_hash TEXT`.** No
sample-level Splice UUID exists in the importer today; nothing in this spec may assume one.

A user row whose hash currently matches no catalog sample is *dormant, never deleted* — it
reattaches the moment a matching sample is imported again. No repair UI in v1.

### 2.2 Sidecar `user.db`

User data lives in its own SQLite file, `<dataDir>/user.db`, beside `catalog.db` — precious
curation must not share blast radius with importer/FTS-rebuild bugs or any future
"rebuild catalog" flow, and future sync/backup is "copy one small file". The main process opens
`catalog.db` as today and `ATTACH`es `user.db` as schema alias `user` on the same connection, so
queries join across the two cheaply. Schema is created with `CREATE TABLE IF NOT EXISTS` at
open. Pre-release rule applies: schema changes are clean breaks, no migration stamps.

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
  normalized_name TEXT NOT NULL UNIQUE,           -- lower(trim(name))
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

Deliberately absent (YAGNI + the reserved-pool rule — no dead columns waiting for a feature):
ratings, notes, tag/collection colors, `position` ordering (v1.5 adds it with a clean break),
saved-searches table (v1.5). Empty tags (post-trim) are rejected; duplicate names collapse via
`normalized_name` (creating "Kick " when "kick" exists reuses the existing tag).

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
distinct matching samples from either source, present-only like today). A selected tag chip
matches a sample if **either** its Splice tags **or** its user tags contain that name. Multiple
selected tags AND together, exactly as today. No visual distinction in the cloud (v1); a row's
own user-tag chips are visually accented so you can tell your vocabulary apart in place.

### 3.4 Search

Search must find what the user named things. A sample matches the search text when (as today)
the FTS index matches — **or** when every search token prefix-matches the sample's nickname or
one of its user-tag names (case-insensitive, token semantics mirroring the FTS side). At 4.2k
samples this is a query-time `LIKE` clause over the attached tables; no second FTS index, no
rebuild coupling. The top-bar result count reflects it, so the e2e assertion surface is
unchanged in kind.

## 4. IPC surface

New `NtwineApi` methods (bridge grows from 12 to **23** exposed methods — `security.spec`'s
exact-bridge pin updates in the same task that adds them):

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
createCollection(name: string): Promise<{ id: string }>;
renameCollection(id: string, name: string): Promise<void>;
deleteCollection(id: string): Promise<void>;                            // items cascade; samples untouched
addToCollection(collectionId: string, sampleId: number): Promise<void>;
removeFromCollection(collectionId: string, sampleId: number): Promise<void>;
```

All writes resolve `sampleId → file_hash` in the main process (the renderer never sees hashes),
stamp `updated_at`, and are synchronous SQLite under the hood like the rest of ipc.ts (the
LibraryStore stale-response rule from the V1 review stays satisfied). Mutations return after the
write; the renderer re-queries what it needs (same request/response discipline as filters —
no push events added in v1).

## 5. UI

### 5.1 Rail: LIBRARY section

A new **LIBRARY** section sits at the top of the packs scroller (inside the same scroll — the
dock split from QoL r1 is unchanged): a **Favorites** row (heart glyph + present-only count),
each collection A-Z (count), and a **"+ New collection"** row (inline name editor on click).
Below it, the existing PACKS list under its own small header. Clicking Favorites / a collection
sets the scope (§3.1); All Samples clears it. The active scope row highlights exactly like the
active pack today.

Collection context menu (right-click): **Rename…** (inline edit), **Delete…** (confirm dialog
in-app; deleting a collection never touches samples). Empty states: Favorites scope — "No
favorites yet — press F on a sample you love."; collection scope — "Drag samples here, or press
C on a selected sample."

### 5.2 Rows

- **Heart**: a small heart button at the row's right edge — always rendered, filled when
  favorited, hollow-on-hover otherwise; `aria-pressed`; click toggles without changing
  selection or playback.
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
  over collection names; Enter adds to the highlighted collection; typing a new name and
  Cmd/Ctrl+Enter creates it and adds in one gesture; Esc closes.

### 5.4 Keyboard map

Registered on the list container (like today's arrows — a focused text input always types
normally; popovers trap their own keys, Esc unwinds one layer):

| Key | Action |
|---|---|
| `F` | Toggle favorite on the selected row |
| `T` | Tags popover for the selected row |
| `C` | Add-to-collection popover for the selected row |
| `N` | Nickname inline edit for the selected row |
| `Delete`/`Backspace` | Under a collection scope only: remove selected row from that collection (selection moves to the next row; never deletes files) |
| `Cmd/Ctrl+F` | Focus search |
| `Esc` (in search) | Clear search if non-empty, else return focus to the list |

Existing bindings unchanged: arrows navigate+play (+snap), `ArrowLeft`/`Space` retrigger.

## 6. Stores (renderer)

A new `UserLayerStore` (MobX 6, same DI pattern as LibraryStore: takes the typed api shape)
owns rail data (`favoritesCount`, `collections`), popover/menu open-state targets, and the write
actions; `LibraryStore` keeps query/filter ownership and gains only the `scope` field. Row
user-fields arrive on `SampleRow` through the existing query path — no second per-row store.
After any user-layer write, the store re-fetches the rail summary and asks LibraryStore to
re-run the current query (counts and row fields refresh through the one existing pipeline).

## 7. Drag-into-collection

Native drag-out (`webContents.startDrag`) stays exactly as is — dragging a row still lands
files in the DAW/Finder. For drag-*in*: rail collection rows are HTML5 drop targets. On
`dragstart` the renderer already `preventDefault`s and records the dragged sample id in a
module-level "drag source" slot before invoking the native drag; when a native-drag hover ends
in a drop over a collection row, the drop handler consumes that slot (files dropped from
*outside* the app are ignored in v1 — no import-by-drop). If the OS-level native drag proves not
to deliver DOM drop events over our own window on either platform (**spike task in the plan —
must be proven on macOS AND Windows before the interaction tasks build on it**), the fallback
is: rows expose a small grab-handle that starts a plain HTML5 in-app drag for collection drops,
while the row body keeps the native drag-out. Keyboard (`C`) and context menu cover the same
action regardless, so the feature never hinges on the gesture.

Drop feedback: the hovered collection row highlights; on drop its count bumps. Dropping onto
Favorites favorites the sample (same slot mechanism).

## 8. E2E and testing

- Unit (Vitest): user-db module (schema, favorite/nickname/tag/collection CRUD, normalization
  collisions, dormant-hash reattach), query composition (scopes × filters × search incl.
  nickname/user-tag matches), UserLayerStore actions, keyboard-map dispatch decisions.
- E2E (Playwright, same harness): `favorites.spec` (heart click + `F`, rail count, scope view,
  survives relaunch — the persistence.spec relaunch pattern), `tags.spec` (T popover add/remove,
  autocomplete reuse, chip accent, filter-cloud union matching, search-by-user-tag),
  `nickname.spec` (N edit, display + tooltip, search-by-nickname, clear restores filename),
  `collections.spec` (create/rename/delete, add via C popover + context menu + drag-in when the
  spike lands, Delete-key removal, counts, empty states, survives relaunch),
  `user-layer-reimport.spec` (favorite → Settings re-import → favorite intact: the §2.1
  guarantee, pinned end-to-end).
- `security.spec` bridge pin updates 12 → 23 in the same task that grows the bridge.
- Fixture: unchanged — user.db starts empty in every test; user state is created through the
  real UI (the honest path). `__ntwineE2E` snapshot may gain a `scope` echo if a spec needs it;
  DOM-first assertions preferred.
- Gates: unchanged law — unit suite + `yarn e2e` (full repackage) green first-hand before PR.

## 9. v1.5 ladder (named, not built)

Saved searches (serialize `QueryFilters`+scope JSON), multi-select + batch favorite/tag/add,
collection manual ordering (`position`, clean break), quick-assign collection slots (`1`–`7`),
tag rename/merge management UI, drag-out of a whole collection.

## 10. Taste calls made for the owner (veto anytime)

1. LIBRARY section lives at the *top* of the rail, above PACKS, inside the same scroller.
2. Favorites/collections behave as *scopes* (like packs), not as filter chips.
3. User-tag chips are accented on rows; the filter cloud shows one merged vocabulary.
4. Collection views keep the standard sort (manual ordering is v1.5).
5. In-app context menu rather than native OS menus (stylable + testable).
6. `Delete` removes from a collection only under that collection's scope — nothing anywhere else.
