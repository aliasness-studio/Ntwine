// Turns assets/icon.svg + assets/icon-small.svg into the binaries the build actually ships:
// assets/icon.ico (Windows: the exe, the taskbar, the Squirrel installer) and assets/icon.png
// (Linux .deb/.rpm, plus anywhere a plain image is wanted). Run it with `yarn icons` after editing
// either SVG; the outputs are committed, so a normal `yarn make` never needs this script.
//
// ELECTRON IS THE RASTERIZER, deliberately. It is already a devDependency and the app's own
// runtime, so this adds no tooling and — unlike a Playwright/Puppeteer Chromium or a native
// librsvg binding — needs no separate download to run. That matters for a project whose stated
// requirement is working fully offline: `yarn install && yarn icons` has to be enough.
//
// Run as a real Electron main process (`electron scripts/build-icons.mjs`), NOT under
// ELECTRON_RUN_AS_NODE: `capturePage` needs a live compositor, which the Node-only mode has no
// window to give it.
//
// If a run dies instantly with `[Error: UnknownVizError]` and no output, just run it again — that
// is Chromium's display compositor failing to come up at launch, on this Windows box roughly one
// run in three. It happens before any of this file executes, so there is nothing here to harden
// against it; a second `yarn icons` has always worked.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packIco, readIcoSizes } from './ico.mjs';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/**
 * Which drawing serves which frame. 32 is the crossover, established by rendering both drawings at
 * both sizes magnified: at 32px the detailed mark is thin but crisp and its A still has a counter,
 * at 24px that counter closes to a speck and the strokes wash out. Below the crossover the blunter,
 * crossbar-free drawing is the one that stays legible (see icon-small.svg).
 */
const FRAMES = [
  { size: 16, source: 'icon-small.svg' },
  { size: 24, source: 'icon-small.svg' },
  { size: 32, source: 'icon.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 64, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
  { size: 256, source: 'icon.svg' },
];

/** The standalone PNG (Linux packagers want a single large raster, not a container). */
const PNG_SIZE = 512;
const PNG_SOURCE = 'icon.svg';

/**
 * Wraps an SVG in a page that paints it at exactly `size` CSS pixels with nothing else on screen —
 * no margins, no background of its own, so `capturePage` returns the artwork and its transparency
 * rather than the artwork on white.
 */
function page(svg, size) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
${svg}`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Renders one SVG to a `size`x`size` PNG buffer, by painting it into the top-left corner of a
 * fixed, comfortably large window and capturing just that corner.
 *
 * One window for every frame, rather than a window per size, because Windows enforces a MINIMUM
 * window size: a 16x16 BrowserWindow is really 44x56, and the capture comes back that shape (the
 * assertion below caught exactly this on the first run). Capturing a rect out of a big window
 * sidesteps the floor entirely, and reuses one compositor instead of standing up seven.
 *
 * `force-device-scale-factor` (set before app ready, below) is what makes a `size`-CSS-pixel rect
 * capture to exactly `size` DEVICE pixels — this machine's display reports 1.5, and without pinning
 * it every frame would come out 1.5x and need a lossy downscale.
 */
async function render(win, source, size) {
  const svg = readFileSync(join(ASSETS, source), 'utf8');
  await win.loadURL(page(svg, size));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (image.isEmpty()) throw new Error(`capturePage returned an empty image for ${source} at ${size}px`);
  const { width, height } = image.getSize();
  if (width !== size || height !== size) {
    throw new Error(`expected a ${size}x${size} capture of ${source}, got ${width}x${height}`);
  }
  return image.toPNG();
}

async function main() {
  mkdirSync(ASSETS, { recursive: true });

  // Sized to the largest frame anything asks for, so every capture rect fits inside it.
  const extent = Math.max(PNG_SIZE, ...FRAMES.map((f) => f.size));
  const win = new BrowserWindow({
    width: extent,
    height: extent,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  });

  try {
    const frames = [];
    for (const { size, source } of FRAMES) {
      frames.push({ size, png: await render(win, source, size) });
      console.log(`  rendered ${source} at ${size}px`);
    }

    const ico = packIco(frames);
    writeFileSync(join(ASSETS, 'icon.ico'), ico);
    console.log(`wrote assets/icon.ico — sizes ${readIcoSizes(ico).join(', ')}`);

    writeFileSync(join(ASSETS, 'icon.png'), await render(win, PNG_SOURCE, PNG_SIZE));
    console.log(`wrote assets/icon.png — ${PNG_SIZE}x${PNG_SIZE}`);
  } finally {
    win.destroy();
  }
}

// Pinned before ready, which is the only point at which Chromium reads it.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration(); // deterministic output; a build must not depend on the host GPU

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
