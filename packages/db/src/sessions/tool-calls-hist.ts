// tool_call_days.hist as SQL `tool_ms_bucket` fills it (migration 0170):
// bucket 0 is 0ms, bucket b >= 1 holds [1.1^(b-1), 1.1^b) ms.
export const TOOL_MS_BUCKET_COUNT = 161;
const RATIO = 1.1;

/**
 * A bucket read back as its geometric middle, rounded to whole ms: within 5%
 * or 1ms of any ms in it, except the last bucket, which has no upper end and
 * reads back as about 65 minutes whatever it holds.
 */
export function bucketMs(bucket: number): number {
  return bucket === 0 ? 0 : Math.round(RATIO ** (bucket - 0.5));
}

/**
 * The median of the timed calls a histogram counts, as percentile_cont(0.5)
 * takes it: the middle call's bucket, or the mean of the two middle calls'
 * of an even count; never above the largest time seen. 0 when nothing was
 * timed.
 */
export function histMedianMs(hist: readonly number[], maxMs: number): number {
  const timed = hist.reduce((sum, n) => sum + n, 0);
  if (timed === 0) return 0;
  const median =
    (msAt(hist, Math.ceil(timed / 2)) + msAt(hist, Math.floor(timed / 2) + 1)) /
    2;
  return Math.min(Math.round(median), maxMs);
}

// The rank-th smallest timed call (from 1), read back from its bucket.
function msAt(hist: readonly number[], rank: number): number {
  let seen = 0;
  for (const [bucket, n] of hist.entries()) {
    seen += n;
    if (seen >= rank) return bucketMs(bucket);
  }
  return 0;
}
