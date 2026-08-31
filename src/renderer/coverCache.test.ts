import { describe, expect, it, vi } from 'vitest';
import { createCoverCache, createImageLoader, type CoverLoader } from './coverCache';

/**
 * A loader that hands back an inert stand-in image and PARKS its settle callback, so each test
 * decides exactly when (and whether) a given pack's art finishes loading. The real loader settles
 * from an `<img>`'s `onload`/`onerror`, which no node test can drive.
 */
function fakeLoader(): {
  loader: CoverLoader;
  urls: string[];
  settle: (index: number, ok: boolean) => void;
  imageAt: (index: number) => CanvasImageSource;
} {
  const urls: string[] = [];
  const images: CanvasImageSource[] = [];
  const settlers: ((ok: boolean) => void)[] = [];
  const loader: CoverLoader = (url, onSettled) => {
    const image = { url } as unknown as CanvasImageSource;
    urls.push(url);
    images.push(image);
    settlers.push(onSettled);
    return image;
  };
  return {
    loader,
    urls,
    settle: (index, ok) => settlers[index](ok),
    imageAt: (index) => images[index],
  };
}

// Mirrors preload.ts's own `coverUrl` helper — the cache takes the builder as an argument rather
// than hardcoding the scheme, so this suite never has to stand up a `window.ntwine`.
const COVER_URL = (packId: number) => `cover://p/${packId}`;

describe('coverCache', () => {
  it('requests one image per pack, addressed by that pack’s own cover url', () => {
    const { loader, urls } = fakeLoader();
    const cache = createCoverCache(loader, COVER_URL);

    cache.warm([7, 9]);

    expect(urls).toEqual(['cover://p/7', 'cover://p/9']);
  });

  it('requests a given pack only once, even while its first load is still in flight', () => {
    const { loader, urls } = fakeLoader();
    const cache = createCoverCache(loader, COVER_URL);

    cache.warm([7]);
    cache.warm([7, 7]);

    expect(urls).toEqual(['cover://p/7']);
  });

  it('holds back an image that has not finished loading yet', () => {
    const { loader } = fakeLoader();
    const cache = createCoverCache(loader, COVER_URL);

    cache.warm([7]);

    expect(cache.get(7)).toBeNull();
  });

  it('hands out the image once it has loaded', () => {
    const { loader, settle, imageAt } = fakeLoader();
    const cache = createCoverCache(loader, COVER_URL);

    cache.warm([7]);
    settle(0, true);

    expect(cache.get(7)).toBe(imageAt(0));
  });

  it('never hands out an image whose load failed, and never retries it', () => {
    const { loader, settle, urls } = fakeLoader();
    const cache = createCoverCache(loader, COVER_URL);

    cache.warm([7]);
    settle(0, false);
    cache.warm([7]);

    expect(cache.get(7)).toBeNull();
    expect(urls).toEqual(['cover://p/7']);
  });

  it('has nothing for a pack that was never warmed', () => {
    const cache = createCoverCache(fakeLoader().loader, COVER_URL);

    expect(cache.get(7)).toBeNull();
  });

  it('survives a loader that throws, treating that pack as coverless rather than propagating', () => {
    const loader = vi.fn(() => {
      throw new Error('no image constructor here');
    }) as unknown as CoverLoader;
    const cache = createCoverCache(loader, COVER_URL);

    expect(() => cache.warm([7])).not.toThrow();
    expect(cache.get(7)).toBeNull();
  });
});

/**
 * Regression suite for the taint bug (found by drag.spec.ts's `icon` assertion, 2026-08-31, and
 * confirmed against the real app: `cover://p/<id>` is a different origin from the app's own
 * document, so an `<img>` fetched WITHOUT `crossOrigin` taints any canvas it is drawn onto, and
 * `toDataURL` then throws `SecurityError: Tainted canvases may not be exported`. The drag card
 * silently degraded to main's fallback square for every sample whose pack had art.
 *
 * A fake `<img>` rather than a real one because there is no DOM here — but the two things that
 * actually caused the bug (whether `crossOrigin` is set at all, and whether it is set BEFORE
 * `src`) are both observable as property writes, so they are what these tests pin.
 */
function fakeImage() {
  const writes: string[] = [];
  const image = {
    _crossOrigin: null as string | null,
    _src: '',
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    set crossOrigin(v: string | null) {
      writes.push('crossOrigin');
      this._crossOrigin = v;
    },
    get crossOrigin() {
      return this._crossOrigin;
    },
    set src(v: string) {
      writes.push('src');
      this._src = v;
    },
    get src() {
      return this._src;
    },
  };
  return { image, writes };
}

describe('createImageLoader', () => {
  it('fetches cover art anonymously, so drawing it never taints the drag card canvas', () => {
    const { image } = fakeImage();
    const load = createImageLoader(() => image as unknown as HTMLImageElement);

    load('cover://p/7', () => {});

    expect(image.crossOrigin).toBe('anonymous');
  });

  it('sets crossOrigin before src — assigning src first starts the fetch under the old, tainting mode', () => {
    const { image, writes } = fakeImage();
    const load = createImageLoader(() => image as unknown as HTMLImageElement);

    load('cover://p/7', () => {});

    expect(writes).toEqual(['crossOrigin', 'src']);
    expect(image.src).toBe('cover://p/7');
  });

  it('reports a finished load as a success and a failed one as a failure', () => {
    const { image } = fakeImage();
    const load = createImageLoader(() => image as unknown as HTMLImageElement);
    const settled = vi.fn();

    load('cover://p/7', settled);
    image.onload!();
    image.onerror!();

    expect(settled.mock.calls).toEqual([[true], [false]]);
  });
});
