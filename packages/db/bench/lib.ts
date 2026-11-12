export const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    Number((sorted[Math.ceil(q * sorted.length) - 1] ?? 0).toFixed(1));
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};

export async function timed(fn: () => Promise<unknown>, runs = 20) {
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return stats(samples);
}

export async function timedMs(fn: () => Promise<unknown>, runs: number) {
  await fn();
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    Number((samples[Math.ceil(q * samples.length) - 1] ?? 0).toFixed(1));
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}
