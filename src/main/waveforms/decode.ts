import { readFile } from 'node:fs/promises';
import decode from 'audio-decode';

export interface DecodedAudio { sampleRate: number; channels: Float32Array[] }

export async function decodeAudio(filePath: string): Promise<DecodedAudio> {
  const buf = await readFile(filePath);
  // audio-decode@3.x (the @audio/decode-based rewrite) returns { channelData, sampleRate },
  // not the older AudioBuffer-shaped { numberOfChannels, getChannelData() } — confirmed against
  // this repo's installed version (audio-decode.d.ts / @audio/decode's AudioData interface).
  const audio = await decode(buf);
  return { sampleRate: audio.sampleRate, channels: audio.channelData };
}
