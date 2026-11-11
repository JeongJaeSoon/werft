class WindowRateLimiter {
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
      maxKeys: number;
    },
  ) {}

  take(key: string, now: number): boolean {
    let window = this.#windows.get(key);
    if (
      window === undefined ||
      now - window.startedAt >= this.options.windowMs
    ) {
      this.#windows.delete(key);
      if (this.#windows.size >= this.options.maxKeys) {
        const oldest = this.#windows.keys().next().value;
        if (oldest !== undefined) this.#windows.delete(oldest);
      }
      window = { startedAt: now, count: 0 };
      this.#windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.options.limit;
  }

  retryAfterSeconds(key: string, now: number): number {
    const window = this.#windows.get(key);
    if (window === undefined) return 1;
    return Math.max(
      1,
      Math.ceil((window.startedAt + this.options.windowMs - now) / 1000),
    );
  }
}

// Slack sends at most ~30,000 events an hour per app (500 a minute), so
// neither limit is near what a real workspace sends.
const SLACK_EVENTS_GLOBAL_LIMIT_PER_MINUTE = 1000;
const SLACK_EVENTS_AGENT_LIMIT_PER_MINUTE = 600;

export function createSlackEventsLimiter(options?: {
  globalPerMinute?: number;
  agentPerMinute?: number;
}) {
  const global = new WindowRateLimiter({
    limit: options?.globalPerMinute ?? SLACK_EVENTS_GLOBAL_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxKeys: 1,
  });
  const perAgent = new WindowRateLimiter({
    limit: options?.agentPerMinute ?? SLACK_EVENTS_AGENT_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxKeys: 4096,
  });
  return {
    admit(
      agentId: string,
      now = Date.now(),
    ): { ok: true } | { ok: false; retryAfter: number } {
      if (!global.take("global", now)) {
        return {
          ok: false,
          retryAfter: global.retryAfterSeconds("global", now),
        };
      }
      const key = agentId.toLowerCase();
      if (!perAgent.take(key, now)) {
        return { ok: false, retryAfter: perAgent.retryAfterSeconds(key, now) };
      }
      return { ok: true };
    },
  };
}

export type SlackEventsLimiter = ReturnType<typeof createSlackEventsLimiter>;
