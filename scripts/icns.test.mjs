import { describe, expect, it } from 'vitest';
import { packIcns, readIcnsTypes } from './icns.mjs';

/** A stand-in PNG payload. `packIcns` embeds frame bytes verbatim, so their content is irrelevant. */
const png = (byte, length = 8) => Buffer.alloc(length, byte);

describe('packIcns', () => {
  it('writes the icns magic and total length', () => {
    const icns = packIcns([
      { size: 16, png: png(1) },
      { size: 32, png: png(2, 12) },
    ]);

    expect(icns.toString('latin1', 0, 4)).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  // macOS picks the retina variant of a point size from its own OSType: 'ic13' is 128pt@2x and
  // 'ic14' is 256pt@2x. Without them a Retina Finder upscales the 1x frame and the icon goes soft.
  it('maps sizes to OSTypes and duplicates retina types', () => {
    const icns = packIcns([
      { size: 16, png: png(1) },
      { size: 256, png: png(2) },
      { size: 512, png: png(3) },
    ]);

    expect(readIcnsTypes(icns)).toEqual(['icp4', 'ic08', 'ic13', 'ic09', 'ic14']);
  });

  it('embeds each PNG verbatim after an 8-byte entry header whose length includes the header', () => {
    const small = png(0xaa, 12);
    const large = png(0xbb, 20);

    const icns = packIcns([
      { size: 32, png: small },
      { size: 256, png: large },
    ]);

    // Walk the entries the way a reader would: header, then each entry's own length to the next.
    const expected = [
      ['icp5', small],
      ['ic08', large],
      ['ic13', large],
    ];
    let offset = 8;
    for (const [type, payload] of expected) {
      expect(icns.toString('latin1', offset, offset + 4)).toBe(type);
      const length = icns.readUInt32BE(offset + 4);
      expect(length).toBe(8 + payload.length);
      expect(icns.subarray(offset + 8, offset + length)).toEqual(payload);
      offset += length;
    }
    expect(offset).toBe(icns.length);
  });

  it('throws on an unsupported size and on no frames', () => {
    expect(() => packIcns([{ size: 48, png: png(4) }])).toThrow(/unsupported/i);
    expect(() => packIcns([])).toThrow(/no frames/i);
  });
});

describe('readIcnsTypes', () => {
  it('round-trips every supported size in file order', () => {
    const icns = packIcns([16, 32, 64, 128, 256, 512, 1024].map((size, index) => ({ size, png: png(index) })));

    expect(readIcnsTypes(icns)).toEqual(['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic13', 'ic09', 'ic14', 'ic10']);
  });
});
