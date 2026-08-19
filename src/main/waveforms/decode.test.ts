import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  // Deep real-library check, owner machine only. Platform-neutral on purpose (Windows-port
  // audit finding): the old '/Users/<user>/Splice/...' literal resolves DRIVE-RELATIVELY on
  // win32 (to C:\Users\<user>\Splice\...), so the day Splice lands there this gate would have
  // self-armed — and its `execSync("find ... | head ...")` body would then have hard-failed
  // (Windows `find.exe` is a string-search tool). homedir() names the same place on both
  // machines; the file walk is plain fs.
  const realAif = join(homedir(), 'Splice', 'sounds', 'packs');
  function firstAifUnder(dir: string): string | null {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = firstAifUnder(full);
        if (hit !== null) return hit;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.aif')) {
        return full;
      }
    }
    return null;
  }
  it.skipIf(!existsSync(realAif))('decodes a real library .aif when available', async () => {
    const f = firstAifUnder(realAif);
    if (f === null) return; // a real library with zero .aif files — nothing to gate on
    const { channels } = await decodeAudio(f);
    expect(channels[0].length).toBeGreaterThan(0);
  });
});
