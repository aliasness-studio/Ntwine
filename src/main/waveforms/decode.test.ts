import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { decodeAudio } from './decode';

describe('decodeAudio', () => {
  it('decodes the wav fixture', async () => {
    const { sampleRate, channels } = await decodeAudio('tests/fixtures/sine.wav');
    expect(sampleRate).toBe(44100);
    expect(channels.length).toBe(1);
    expect(channels[0].length).toBe(4410);
    expect(Math.max(...channels[0])).toBeGreaterThan(0.4); // 440 Hz sine at 0.5
  });
  it('decodes the aiff fixture (THE §9.3 GATE)', async () => {
    const { channels } = await decodeAudio('tests/fixtures/sine.aiff');
    expect(channels[0].length).toBe(4410);
    expect(Math.max(...channels[0])).toBeGreaterThan(0.4);
  });
  const realAif = '/Users/<user>/Splice/sounds/packs'; // deep real-library check, owner machine only
  it.skipIf(!existsSync(realAif))('decodes a real library .aif when available', async () => {
    const { execSync } = await import('node:child_process');
    const f = execSync(`find '${realAif}' -name '*.aif' | head -1`).toString().trim();
    const { channels } = await decodeAudio(f);
    expect(channels[0].length).toBeGreaterThan(0);
  });
});
