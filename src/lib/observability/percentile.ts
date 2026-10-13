/** One latency sample. Times are milliseconds since epoch. */
export interface TimedSample {
  atMs: number;
  value: number;
}

const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_SAMPLES = 500;

/**
 * Nearest-rank percentile. `p` is 0–100. Empty input returns 0 so an idle
 * process does not look like a latency breach.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

/** Drop samples outside the window, then cap length. Mutates `samples`. */
export function pruneSamples(
  samples: TimedSample[],
  nowMs: number,
  windowMs = DEFAULT_WINDOW_MS,
  maxSamples = DEFAULT_MAX_SAMPLES,
): void {
  const cutoff = nowMs - windowMs;
  let drop = 0;
  while (drop < samples.length && samples[drop]!.atMs < cutoff) drop += 1;
  if (drop > 0) samples.splice(0, drop);
  if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
}

export function percentileOf(samples: readonly TimedSample[], p: number): number {
  return percentile(
    samples.map((sample) => sample.value),
    p,
  );
}
