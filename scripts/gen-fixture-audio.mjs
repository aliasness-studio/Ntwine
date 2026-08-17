// scripts/gen-fixture-audio.mjs — writes 44100 Hz mono 16-bit PCM: sine.wav + sine.aiff
import { mkdirSync, writeFileSync } from 'node:fs';
const RATE = 44100, N = 4410, A = 0.5; // 100 ms
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * A * 32767);
const pcmBE = Buffer.alloc(N * 2); const pcmLE = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) { pcmLE.writeInt16LE(pcm[i], i * 2); pcmBE.writeInt16BE(pcm[i], i * 2); }

// WAV (LE)
const wav = Buffer.alloc(44 + pcmLE.length);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcmLE.length, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcmLE.length, 40);
pcmLE.copy(wav, 44);

// AIFF (BE). COMM sampleRate is 80-bit extended float; 44100 = 40 0E AC 44 00*6
const ext44100 = Buffer.from([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
const comm = Buffer.alloc(26); comm.write('COMM', 0); comm.writeUInt32BE(18, 4);
comm.writeUInt16BE(1, 8); comm.writeUInt32BE(N, 10); comm.writeUInt16BE(16, 14);
ext44100.copy(comm, 16);
const ssnd = Buffer.alloc(16 + pcmBE.length); ssnd.write('SSND', 0);
ssnd.writeUInt32BE(8 + pcmBE.length, 4); pcmBE.copy(ssnd, 16);
const form = Buffer.alloc(12); form.write('FORM', 0);
form.writeUInt32BE(4 + comm.length + ssnd.length, 4); form.write('AIFF', 8);

mkdirSync('tests/fixtures', { recursive: true });
writeFileSync('tests/fixtures/sine.wav', wav);
writeFileSync('tests/fixtures/sine.aiff', Buffer.concat([form, comm, ssnd]));
console.log('fixtures written');
