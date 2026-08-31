// Pack cover art, kept decoded and ready in memory so the drag card (dragImage.ts) can be painted
// SYNCHRONOUSLY inside a `dragstart` handler.
//
// The timing is the whole reason this module exists. `SampleRow.handleDragStart` has one
// synchronous shot at building the drag image — by the time an `<img>`'s `onload` fires, the OS
// drag session has already begun with whatever icon it was given. So covers are warmed ahead of
// time for the rows the user can currently see (SampleList's visible-range effect, the same place
// waveform peaks are batch-fetched), and `get` is a pure map read that never waits.
//
// A load that fails is remembered as failed and never retried: `cover://p/<id>` 404s for any pack
// whose art was never downloaded (protocol.ts resolves those to null), and a browse session
// scrolling past such a pack would otherwise re-request it on every visible-range change forever.
// That mirrors `PackRail`'s `PackCover`, which latches its own `onError` into a permanent fallback
// tile for exactly the same reason.

export type CoverLoader = (url: string, onSettled: (ok: boolean) => void) => CanvasImageSource;

export interface CoverCache {
  /** Starts loading art for any of these packs not already requested. Safe to call every render. */
  warm(packIds: number[]): void;
  /** The loaded image, or `null` while pending, after a failure, or if never warmed. */
  get(packId: number): CanvasImageSource | null;
}

interface Entry {
  image: CanvasImageSource | null;
  ready: boolean;
}

export function createCoverCache(
  loader: CoverLoader,
  coverUrl: (packId: number) => string,
): CoverCache {
  // Presence in the map means "already requested" — that, not `ready`, is what makes `warm`
  // idempotent while a load is still in flight.
  const entries = new Map<number, Entry>();

  return {
    warm(packIds: number[]): void {
      for (const packId of packIds) {
        if (entries.has(packId)) continue;
        const entry: Entry = { image: null, ready: false };
        entries.set(packId, entry);
        try {
          entry.image = loader(coverUrl(packId), (ok) => {
            entry.ready = ok;
            if (!ok) entry.image = null;
          });
        } catch {
          // No image constructor available (or a malformed url). The entry stays in the map as a
          // permanent "this pack has no usable cover", which is also what keeps it from retrying.
          entry.image = null;
        }
      }
    },

    get(packId: number): CanvasImageSource | null {
      const entry = entries.get(packId);
      return entry !== undefined && entry.ready ? entry.image : null;
    },
  };
}

/**
 * The real, `<img>`-backed loader. `newImage` is a factory rather than a bare `new Image()` so
 * this is reachable from coverCache.test.ts, which runs with no DOM at all.
 *
 * `crossOrigin = 'anonymous'` is the load-bearing line, and it is NOT optional politeness.
 * `cover://p/<id>` is a different origin from the app's own document, so an image fetched without
 * it taints every canvas it is drawn onto — and a tainted canvas throws `SecurityError` out of
 * `toDataURL`, which is exactly how the drag card gets exported (dragImage.ts's `renderDragCard`).
 * Omitting it doesn't fail loudly: the card render throws, SampleRow's catch swallows it, and every
 * sample from a pack WITH art silently drags under main's plain fallback square — the precise
 * regression `drag.spec.ts`'s `icon` assertion exists to catch. It is safe because protocol.ts
 * registers the `cover` scheme with `corsEnabled: true`.
 *
 * It must also be assigned BEFORE `src`: setting `src` is what kicks off the fetch, and a fetch
 * already in flight does not retroactively become anonymous.
 */
export function createImageLoader(newImage: () => HTMLImageElement): CoverLoader {
  return (url, onSettled) => {
    const image = newImage();
    image.crossOrigin = 'anonymous';
    image.onload = () => onSettled(true);
    image.onerror = () => onSettled(false);
    image.src = url;
    return image;
  };
}

/**
 * The renderer's one shared cache. Built on first call, never at module load: this file has to
 * stay importable under `environment: 'node'` (coverCache.test.ts), so nothing here may touch
 * `window`, `document` or `Image` until a real renderer actually asks.
 *
 * `window.ntwine.coverUrl` rather than a fourth hand-written `cover://p/<id>` template — preload.ts
 * already owns that shape and protocol.ts already owns the pattern that parses it.
 */
let shared: CoverCache | null = null;

export function sharedCoverCache(): CoverCache {
  if (shared === null) {
    shared = createCoverCache(
      createImageLoader(() => new Image()),
      (packId) => window.ntwine.coverUrl(packId),
    );
  }
  return shared;
}
