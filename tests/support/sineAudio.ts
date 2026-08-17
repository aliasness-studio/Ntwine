// tests/support/sineAudio.ts — shared 44100 Hz mono 16-bit PCM sine generator, ported verbatim
// from the deleted scripts/gen-fixture-audio.mjs (plan-review ruling 2026-08-17: an .mjs cannot
// import a TS module, so the generator moved here instead of staying a "two-line caller"). Both
// decode.test.ts and the e2e fixture library (tests/e2e/fixture/library.ts) generate their audio
// inputs through these same three functions — "the same generator" is literally true rather than
// two independently maintained copies.
import { writeFileSync } from 'node:fs';

const RATE = 44100;
const AMPLITUDE = 0.5;

export function sinePcm16(ms: number, hz = 440, rate = 44100): Int16Array {
  const n = Math.round((rate * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * AMPLITUDE * 32767);
  }
  return pcm;
}

export function writeSineWav(path: string, ms: number, hz = 440): void {
  const pcm = sinePcm16(ms, hz, RATE);
  const pcmLE = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) pcmLE.writeInt16LE(pcm[i], i * 2);

  // WAV (LE)
  const wav = Buffer.alloc(44 + pcmLE.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcmLE.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcmLE.length, 40);
  pcmLE.copy(wav, 44);

  writeFileSync(path, wav);
}

export function writeSineAiff(path: string, ms: number, hz = 440): void {
  const pcm = sinePcm16(ms, hz, RATE);
  const pcmBE = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) pcmBE.writeInt16BE(pcm[i], i * 2);

  // AIFF (BE). COMM sampleRate is 80-bit extended float; 44100 = 40 0E AC 44 00*6
  const ext44100 = Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
  const comm = Buffer.alloc(26);
  comm.write('COMM', 0);
  comm.writeUInt32BE(18, 4);
  comm.writeUInt16BE(1, 8);
  comm.writeUInt32BE(pcm.length, 10);
  comm.writeUInt16BE(16, 14);
  ext44100.copy(comm, 16);

  const ssnd = Buffer.alloc(16 + pcmBE.length);
  ssnd.write('SSND', 0);
  ssnd.writeUInt32BE(8 + pcmBE.length, 4);
  pcmBE.copy(ssnd, 16);

  const form = Buffer.alloc(12);
  form.write('FORM', 0);
  form.writeUInt32BE(4 + comm.length + ssnd.length, 4);
  form.write('AIFF', 8);

  writeFileSync(path, Buffer.concat([form, comm, ssnd]));
}
