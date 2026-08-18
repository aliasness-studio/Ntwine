import { describe, expect, it } from 'vitest';
import { isRowFullyVisible } from './scrollSnap';

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
