import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeAudio } from './decode';
import { writeSineAiff, writeSineWav } from '../../../tests/support/sineAudio';

describe('decodeAudio', () => {
  let dir: string;
  let wavPath: string;
  let aiffPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ntwine-decode-'));
    wavPath = join(dir, 'sine.wav');
    aiffPath = join(dir, 'sine.aiff');
    writeSineWav(wavPath, 100);
    writeSineAiff(aiffPath, 100);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('decodes the wav fixture', async () => {
    const { sampleRate, channels } = await decodeAudio(wavPath);
    expect(sampleRate).toBe(44100);
    expect(channels.length).toBe(1);
    expect(channels[0].length).toBe(4410);
    expect(Math.max(...channels[0])).toBeGreaterThan(0.4); // 440 Hz sine at 0.5
  });
  it('decodes the aiff fixture (THE §9.3 GATE)', async () => {
    const { sampleRate, channels } = await decodeAudio(aiffPath);
    expect(sampleRate).toBe(44100);
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
