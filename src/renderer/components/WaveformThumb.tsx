// Canvas waveform thumbnail: `{ peaks: ArrayBuffer | null;
// width: 96; height: 32 }` — devicePixelRatio-scaled canvas, 200 min/max bars from an Int8Array
// view of `peaks`, a flat gray placeholder line when `peaks` is null. Deliberately a "dumb"
// prop-driven component (no `observer`, no store reads): SampleRow/SampleList already resolve
// the correct ArrayBuffer-or-null (including the peaksFailed "never draw this blob" rule) before
// it ever reaches here — this component's only job is turning bytes into pixels.
import { useEffect, useRef } from 'react';
import styled, { useTheme } from 'styled-components';

export interface WaveformThumbProps {
  peaks: ArrayBuffer | null;
  width: number;
  height: number;
}

// computePeaks (src/main/waveforms/peaks.ts) always writes 200 buckets; `view.length / 2` is
// still read defensively at draw time (below) rather than hardcoded, matching queries.ts's own
// "derive bucket_count, don't assume it" precedent, in case a future `format` bump ever changes
// the bucket count this canvas has to draw.
const Canvas = styled.canvas<{ $width: number; $height: number }>`
  display: block;
  width: ${(p) => p.$width}px;
  height: ${(p) => p.$height}px;
  flex-shrink: 0;
`;

export function WaveformThumb({ peaks, width, height }: WaveformThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const halfHeight = height / 2;

    if (peaks === null) {
      ctx.strokeStyle = theme.color.textFaint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, halfHeight);
      ctx.lineTo(width, halfHeight);
      ctx.stroke();
      return;
    }

    const view = new Int8Array(peaks);
    const buckets = view.length / 2;
    if (buckets <= 0) return;

    const barPitch = width / buckets;
    ctx.fillStyle = theme.color.accent;
    for (let i = 0; i < buckets; i++) {
      const min = view[i * 2];
      const max = view[i * 2 + 1];
      const x = i * barPitch;
      // Peak bytes are clamped to +-127 (computePeaks); each bucket's [min, max] maps linearly
      // onto the canvas around the vertical center.
      const yTop = halfHeight - (max / 127) * halfHeight;
      const yBottom = halfHeight - (min / 127) * halfHeight;
      const barHeight = Math.max(1, yBottom - yTop);
      ctx.fillRect(x, yTop, Math.max(1, barPitch - 0.5), barHeight);
    }
  }, [peaks, width, height, theme]);

  return <Canvas ref={canvasRef} $width={width} $height={height} />;
}
