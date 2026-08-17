// utilityProcess entry point (Task 10): forked once per queue.ts in-flight slot, receiving one
// { sampleId, absPath } message at a time and replying with either the computed peaks or an
// error — see queue.ts for the pool/concurrency contract. Thin by design: no unit test here, the
// two things it calls (decodeAudio, computePeaks) are already covered by their own suites.
//
// utilityProcess children receive messages on process.parentPort (NOT worker_threads.parentPort)
process.parentPort.on('message', async (e) => {
  const { sampleId, absPath } = e.data as { sampleId: number; absPath: string };
  try {
    const { decodeAudio } = await import('./decode');
    const { computePeaks } = await import('./peaks');
    const { channels } = await decodeAudio(absPath);
    const peaks = computePeaks(channels);
    process.parentPort.postMessage({ sampleId, ok: true, peaks: peaks.buffer });
  } catch (err) {
    process.parentPort.postMessage({ sampleId, ok: false, error: String(err) });
  }
});
