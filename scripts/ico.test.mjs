import { describe, expect, it } from 'vitest';
import { packIco, readIcoSizes } from './ico.mjs';

/** A stand-in PNG payload. `packIco` embeds frame bytes verbatim, so their content is irrelevant. */
const png = (byte, length = 8) => Buffer.alloc(length, byte);

describe('packIco', () => {
  it('writes the ICO header: reserved 0, type 1 (icon), and the frame count', () => {
    const ico = packIco([
      { size: 16, png: png(1) },
      { size: 32, png: png(2) },
    ]);

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
  });

  it('embeds each frame’s bytes verbatim at the offset its directory entry advertises', () => {
    const first = png(0xaa, 12);
    const second = png(0xbb, 20);

    const ico = packIco([
      { size: 16, png: first },
      { size: 32, png: second },
    ]);

    for (const [index, expected] of [first, second].entries()) {
      const entry = 6 + index * 16;
      const length = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(ico.subarray(offset, offset + length)).toEqual(expected);
    }
  });

  // The ICO directory stores each dimension in ONE byte, so 256 does not fit and the format spells
  // it 0. Getting this wrong produces a file Windows reads as a 0x0 frame and silently ignores —
  // which looks exactly like "the big icon just didn't take".
  it('encodes a 256px frame as 0, the format’s escape for the one size that overflows a byte', () => {
    const ico = packIco([{ size: 256, png: png(3) }]);

    expect(ico.readUInt8(6)).toBe(0);
    expect(ico.readUInt8(7)).toBe(0);
  });

  it('encodes every other size as its literal width and height', () => {
    const ico = packIco([{ size: 48, png: png(4) }]);

    expect(ico.readUInt8(6)).toBe(48);
    expect(ico.readUInt8(7)).toBe(48);
  });

  it('declares 32-bit colour with one plane, matching the PNG frames it carries', () => {
    const ico = packIco([{ size: 32, png: png(5) }]);

    expect(ico.readUInt16LE(6 + 4)).toBe(1);
    expect(ico.readUInt16LE(6 + 6)).toBe(32);
  });

  it('refuses to write an icon with no frames rather than emitting a file Windows ignores', () => {
    expect(() => packIco([])).toThrow(/frame/i);
  });
});

describe('readIcoSizes', () => {
  it('round-trips the sizes it was packed with, 256 included', () => {
    const ico = packIco([
      { size: 16, png: png(1) },
      { size: 48, png: png(2) },
      { size: 256, png: png(3) },
    ]);

    expect(readIcoSizes(ico)).toEqual([16, 48, 256]);
  });
});
