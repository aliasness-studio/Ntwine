// Minimal ICO container writer, for the app icon pipeline (scripts/build-icons.mjs).
//
// Hand-rolled rather than pulled from npm: the format below is ~30 lines, and a build-time
// dependency that runs over the artwork shipped in every installer is not worth adding to the
// supply chain of an app whose whole security posture is "loads zero remote content".
//
// The layout is fixed by the format: a 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per frame,
// then the frame payloads. Each payload here is a whole PNG file — Windows Vista and later read
// PNG-compressed frames directly, which is what lets a 256px frame ship in a few KB instead of the
// ~256KB an uncompressed BMP frame would cost.

const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

/**
 * @typedef {{ size: number, png: Buffer }} IcoFrame
 * @param {IcoFrame[]} frames
 * @returns {Buffer}
 */
export function packIco(frames) {
  if (frames.length === 0) {
    throw new Error('packIco: refusing to write an icon with no frames — Windows ignores such a file');
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(ENTRY_BYTES * frames.length);
  let offset = HEADER_BYTES + directory.length;

  frames.forEach((frame, index) => {
    const at = index * ENTRY_BYTES;
    // Width and height are ONE byte each, so 256 does not fit; the format spells it 0. A literal
    // 256 truncates to 0 anyway, but only by accident — writing it deliberately is the difference
    // between a documented escape and a bug that happens to work.
    const dimension = frame.size === 256 ? 0 : frame.size;
    directory.writeUInt8(dimension, at);
    directory.writeUInt8(dimension, at + 1);
    directory.writeUInt8(0, at + 2); // palette size; 0 = not paletted
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel — RGBA, matching the PNG frames
    directory.writeUInt32LE(frame.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, directory, ...frames.map((f) => f.png)]);
}

/**
 * The sizes an ICO advertises, in directory order. Used by the icon test to check the committed
 * binary still carries every frame the pipeline is supposed to produce — a regeneration that
 * quietly drops a size is otherwise invisible until Windows picks a blurry frame.
 * @param {Buffer} ico
 * @returns {number[]}
 */
export function readIcoSizes(ico) {
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_unused, index) => {
    const dimension = ico.readUInt8(HEADER_BYTES + index * ENTRY_BYTES);
    return dimension === 0 ? 256 : dimension;
  });
}
