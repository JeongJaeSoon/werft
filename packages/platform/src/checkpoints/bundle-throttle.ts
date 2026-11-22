import { messageOf } from "@werft-ai/runtime-core";

// Bundles cooling down at once. A full table forgets the oldest entry, which
// only lets that bundle be verified again early.
export const MAX_COOLING_BUNDLES = 1024;

/**
 * Bundles whose verification threw, and the error each one threw, until
 * `cooldownMs` has passed. Every entry lives the same time, so insertion
 * order is expiry order and the oldest is the first to drop.
 */
function createCooldown(cooldownMs: number, clock: () => number) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error(`Bundle retry cooldown must be at least 0: ${cooldownMs}`);
  }
  const entries = new Map<string, { error: Error; until: number }>();
  return {
    pending(id: string): Error | undefined {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (clock() < entry.until) return entry.error;
      entries.delete(id);
      return undefined;
    },
    start(id: string, key: string, cause: unknown) {
      if (cooldownMs === 0) return;
      const until = clock() + cooldownMs;
      const reason = messageOf(cause);
      entries.delete(id);
      entries.set(id, {
        error: new Error(
          `workspace bundle ${key} is not verified again before ${new Date(until).toISOString()}; its last verification failed: ${reason}`,
          { cause },
        ),
        until,
      });
      for (const oldest of entries.keys()) {
        if (entries.size <= MAX_COOLING_BUNDLES) break;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * Runs at most `limit` tasks at once, handing a finishing task's slot
 * straight to the next in line so a burst cannot briefly exceed the limit.
 */
function createGate(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer: ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      // Hand the slot over rather than release it, so nobody slips between.
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

export { createCooldown, createGate };
