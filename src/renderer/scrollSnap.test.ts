import { describe, expect, it } from 'vitest';
import { doesPopoverFitBelowRow, isRowFullyVisible } from './scrollSnap';

// Viewport 200px tall, 40px rows => rows 0..4 fit exactly when scrolled to the top.
const VIEWPORT = 200;
const ROW = 40;

describe('isRowFullyVisible', () => {
  it('a row wholly inside the viewport is visible', () => {
    expect(isRowFullyVisible(0, VIEWPORT, 2, ROW)).toBe(true);
  });

  it('the exact-fit boundaries count as visible (top row and bottom row of a full page)', () => {
    expect(isRowFullyVisible(0, VIEWPORT, 0, ROW)).toBe(true); // rowTop === scrollTop
    expect(isRowFullyVisible(0, VIEWPORT, 4, ROW)).toBe(true); // rowBottom === scrollTop + viewport
  });

  it('the first row below the fold is NOT visible, even before it is fully hidden', () => {
    expect(isRowFullyVisible(0, VIEWPORT, 5, ROW)).toBe(false); // starts exactly at the fold
    expect(isRowFullyVisible(10, VIEWPORT, 5, ROW)).toBe(false); // partially clipped at the bottom
  });

  it('a row above the viewport is NOT visible, including partially clipped at the top', () => {
    expect(isRowFullyVisible(80, VIEWPORT, 0, ROW)).toBe(false); // fully above
    expect(isRowFullyVisible(90, VIEWPORT, 2, ROW)).toBe(false); // row 2 spans 80..120, clipped
  });

  it('a scrolled viewport shifts the visible window with it', () => {
    expect(isRowFullyVisible(200, VIEWPORT, 5, ROW)).toBe(true); // rows 5..9 now fit
    expect(isRowFullyVisible(200, VIEWPORT, 4, ROW)).toBe(false);
    expect(isRowFullyVisible(200, VIEWPORT, 10, ROW)).toBe(false);
  });

  it('a zero-height viewport shows nothing', () => {
    expect(isRowFullyVisible(0, 0, 0, ROW)).toBe(false);
  });
});

describe('doesPopoverFitBelowRow', () => {
  // A 100px popover anchored below row 0 (bottom edge at 40) spans 40..140 — comfortably inside
  // the 200px viewport scrolled to the top. The "already has room" direction (Important 2's fix
  // must NOT move a view that didn't need to move).
  it('a popover with room below the row fits — no scroll needed', () => {
    expect(doesPopoverFitBelowRow(0, VIEWPORT, 0, ROW, 100)).toBe(true);
  });

  // Row 4 (spans 160..200, the LAST row that fits in a 200px viewport scrolled to 0) has a
  // 100px popover spanning 200..300 — entirely past the fold. The primary bug this fixes: a
  // popover for a row at the viewport's bottom renders invisibly.
  it('a popover that would extend past the bottom of the viewport does NOT fit', () => {
    expect(doesPopoverFitBelowRow(0, VIEWPORT, 4, ROW, 100)).toBe(false);
  });

  it('the exact-fit boundary counts as fitting, mirroring isRowFullyVisible’s own inclusive edge', () => {
    // Row 3 (spans 120..160); a 40px popover spans 160..200 === scrollTop + viewport exactly.
    expect(doesPopoverFitBelowRow(0, VIEWPORT, 3, ROW, 40)).toBe(true);
  });

  it('one pixel over the boundary does not fit', () => {
    expect(doesPopoverFitBelowRow(0, VIEWPORT, 3, ROW, 41)).toBe(false);
  });

  it('a scrolled viewport shifts the fit window with it — the same row now fits', () => {
    // Row 4's popover (200..300) didn't fit when scrollTop was 0; scrolled to 200 the viewport
    // covers 200..400, so the same popover now fits entirely.
    expect(doesPopoverFitBelowRow(200, VIEWPORT, 4, ROW, 100)).toBe(true);
  });

  // Not the primary bug (SampleList never renders a popover for a row TanStack Virtual isn't
  // currently rendering at all), but the same geometry answers it for free: a row scrolled
  // entirely above the viewport never counts as "fits", regardless of how short the popover is.
  it('a row scrolled above the viewport never fits, even with a tiny popover', () => {
    expect(doesPopoverFitBelowRow(200, VIEWPORT, 0, ROW, 1)).toBe(false);
  });
});
