import { describe, expect, it } from 'vitest';
import { computeDefaultBounds } from './defaultBounds';

describe('computeDefaultBounds', () => {
  it('takes 75% of each work-area dimension on a big display (16" MBP)', () => {
    // 16" MacBook Pro default scaled resolution, minus the menu bar.
    expect(computeDefaultBounds({ width: 1728, height: 1079 })).toEqual({
      width: 1296,
      height: 809,
    });
  });

  it('rounds to whole pixels (BrowserWindow takes integers)', () => {
    // 1050 * 0.75 = 787.5 -> 788; 1001 * 0.75 = 750.75 -> 751
    expect(computeDefaultBounds({ width: 1001, height: 1050 })).toEqual({
      width: 800, // 751 floors up to the 800 minimum
      height: 788,
    });
  });

  it('never goes below 800x600 while the screen still fits it', () => {
    // 75% would be 750x525 — both under the floor, both floors fit the screen.
    expect(computeDefaultBounds({ width: 1000, height: 700 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('never exceeds the work area itself when the screen is smaller than the floor', () => {
    expect(computeDefaultBounds({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
    });
  });
});
