// utilityProcess entry point: forked either per queue.ts in-flight slot (the default, no-`kind`
// path below) or one-shot per ipc.ts `decodePreviewPcm` call (`kind: 'pcm'`).
// Either way it receives one `{ sampleId, absPath }`-shaped message at a time and replies with
// either a result or an error. Thin by design: no unit test here, the two things it calls
// (decodeAudio, computePeaks) are already covered by their own suites, and ipc.ts's
// decodePreviewPcm tests cover the caller-side contract of the `kind: 'pcm'` reply shape via an
// injected WorkerLike fake.
//
// utilityProcess children receive messages on process.parentPort (NOT worker_threads.parentPort)
process.parentPort.on('message', async (e) => {
  const { sampleId, absPath, kind } = e.data as {
    sampleId: number;
    absPath: string;
    // Optional discriminant — absent (or explicitly 'peaks') is the peaks path, since
    // queue.ts's pump() posts `{ sampleId, absPath }` with no `kind` field.
    kind?: 'peaks' | 'pcm';
  };
  try {
    const { decodeAudio } = await import('./decode');

    if (kind === 'pcm') {
      const { sampleRate, channels } = await decodeAudio(absPath);
      // Fresh, exactly-sized copies before crossing the process boundary: a decoder-owned
      // Float32Array's `.buffer` isn't guaranteed to be its own tightly-sized allocation
      // (decode.ts's own doc comment: "channels alias decoder-owned buffers"), so posting
      // `.buffer` directly could ship neighboring bytes, or — if channels share one underlying
      // buffer — hand back garbage for a sibling channel. Same defensive reasoning as
      // queries.ts's getPeaks un-aliasing a better-sqlite3 Buffer before handing it out.
      //
      // Electron's ParentPort.postMessage has no transfer-list parameter for ArrayBuffers (only
      // UtilityProcess/MessagePortMain's postMessage accepts a transfer list, and only for
      // MessagePortMain instances, not raw buffers — confirmed against electron.d.ts) — so this
      // is always a structured-clone copy, never a zero-copy transfer, regardless. Acceptable
      // here: decodePreviewPcm is a one-shot, user-triggered preview decode capped at
      // PREVIEW_MAX_BYTES/PREVIEW_MAX_SECONDS (ipc.ts), not the hot path queue.ts runs across
      // the whole library.
      const buffers = channels.map((c) => new Float32Array(c).buffer);
      process.parentPort.postMessage({ sampleId, ok: true, sampleRate, channels: buffers });
      return;
    }

    const { computePeaks } = await import('./peaks');
    const { channels } = await decodeAudio(absPath);
    const peaks = computePeaks(channels);
    process.parentPort.postMessage({ sampleId, ok: true, peaks: peaks.buffer });
  } catch (err) {
    process.parentPort.postMessage({ sampleId, ok: false, error: String(err) });
  }
});
