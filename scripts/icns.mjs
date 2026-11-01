// Minimal ICNS container writer, for the macOS app icon (scripts/build-icons.mjs).
//
// Hand-rolled rather than pulled from npm, for the same reason as ico.mjs: the format below is a
// handful of lines, and a build-time dependency that runs over the artwork shipped in every
// installer is not worth adding to the supply chain of an app whose whole security posture is
// "loads zero remote content". `iconutil` would also do it, but only on macOS — this runs anywhere.
//
// The layout is fixed by the format: the 4-byte magic 'icns', a big-endian u32 total file length,
// then one entry per image — a 4-char OSType, a big-endian u32 entry length that counts its own
// 8-byte header, then the payload. Every payload here is a whole PNG file; macOS 10.7 and later
// read PNG-compressed entries for all the types below.

const HEADER_BYTES = 8;
const ENTRY_HEADER_BYTES = 8;

/**
 * The OSTypes each pixel size is written under, in file order. Fixed by the format; any other size
 * has no type.
 *
 * A size can fill two slots: its own 1x type, and the @2x of half its size. macOS looks up a
 * Retina variant by its own OSType rather than by pixel count — 'ic11' is 16pt@2x (32px), 'ic12'
 * is 32pt@2x (64px), 'ic13' is 128pt@2x (256px), 'ic14' is 256pt@2x (512px) — so the same PNG is
 * written a second time under that type, otherwise a Retina Finder upscales the 1x frame.
 *
 * 64px has no 1x slot: 'icp6' looks like the next step after 'icp4'/'icp5' but Apple reads it as a
 * 48px image, so a 64px PNG there is a mislabelled frame. 64px goes in 'ic12' only.
 */
const TYPES_FOR_SIZE = new Map([
  [16, ['icp4']],
  [32, ['icp5', 'ic11']],
  [64, ['ic12']],
  [128, ['ic07']],
  [256, ['ic08', 'ic13']],
  [512, ['ic09', 'ic14']],
  [1024, ['ic10']],
]);

/**
 * @typedef {{ size: number, png: Buffer }} IcnsFrame
 * @param {IcnsFrame[]} frames
 * @returns {Buffer}
 */
export function packIcns(frames) {
  if (frames.length === 0) {
    throw new Error('packIcns: refusing to write an icon with no frames — macOS falls back to the generic icon');
  }

  const entries = frames.flatMap((frame) => {
    const types = TYPES_FOR_SIZE.get(frame.size);
    if (types === undefined) {
      throw new Error(`packIcns: unsupported size ${frame.size}px — ICNS has no OSType for it`);
    }
    return types.map((entryType) => {
      const header = Buffer.alloc(ENTRY_HEADER_BYTES);
      header.write(entryType, 0, 4, 'latin1');
      header.writeUInt32BE(ENTRY_HEADER_BYTES + frame.png.length, 4);
      return Buffer.concat([header, frame.png]);
    });
  });

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('icns', 0, 4, 'latin1');
  header.writeUInt32BE(HEADER_BYTES + entries.reduce((total, entry) => total + entry.length, 0), 4);

  return Buffer.concat([header, ...entries]);
}

/**
 * The OSTypes an ICNS carries, in file order. Used by the icon test to check the committed binary
 * still carries every entry the pipeline is supposed to produce — a regeneration that quietly drops
 * one is otherwise invisible until Finder shows a blurry or generic icon.
 * @param {Buffer} icns
 * @returns {string[]}
 */
export function readIcnsTypes(icns) {
  const end = icns.readUInt32BE(4);
  /** @type {string[]} */
  const types = [];
  for (let offset = HEADER_BYTES; offset < end; ) {
    const length = icns.readUInt32BE(offset + 4);
    // A corrupt length under the header size would never advance; fail instead of spinning.
    if (length < ENTRY_HEADER_BYTES) {
      throw new Error(`readIcnsTypes: entry at byte ${offset} claims length ${length}, shorter than its own header`);
    }
    types.push(icns.toString('latin1', offset, offset + 4));
    offset += length;
  }
  return types;
}
