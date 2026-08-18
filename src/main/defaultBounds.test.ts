import { describe, expect, it } from 'vitest';
import { computeDefaultBounds } from './defaultBounds';

describe('computeDefaultBounds', () => {
  it('takes 90% of each work-area dimension on a big display (16" MBP)', () => {
    // 16" MacBook Pro default scaled resolution, minus the menu bar.
    expect(computeDefaultBounds({ width: 1728, height: 1079 })).toEqual({
      width: 1555,
      height: 971,
    });
  });

  it('rounds to whole pixels (BrowserWindow takes integers)', () => {
    // 1001 * 0.9 = 900.9 -> 901; 1050 * 0.9 = 945
    expect(computeDefaultBounds({ width: 1001, height: 1050 })).toEqual({
      width: 901,
      height: 945,
    });
  });

  it('never goes below 800x600 while the screen still fits it', () => {
    // 90% would be 792x585 — both under the floor, both floors fit the screen.
    expect(computeDefaultBounds({ width: 880, height: 650 })).toEqual({
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
