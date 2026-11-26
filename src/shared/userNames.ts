// Pure name-normalization for the user layer — lives in `src/shared/`, not
// `src/main/`, because it must be importable renderer-side too (autocomplete/collision-preview
// call sites) with zero imports of its own, matching `keyDisplay.ts`'s
// rationale for the same directory. `src/main/user/userDb.ts` re-exports this for main-side
// convenience so every persisted-name call site in that module stays a same-directory import.

/**
 * The one named normalizer for every persisted `normalized_name` and every
 * user-name comparison: tags, collections, and their uniqueness/reuse checks all call this and
 * only this. NFC first so an NFD "café" and an NFC "café" collide as one name (the library's
 * real filenames contain both encodings); internal whitespace collapses to a single space;
 * `toLowerCase()` (not SQL `lower()`, which folds ASCII only) handles non-ASCII case folding.
 */
export function normalizeUserName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
