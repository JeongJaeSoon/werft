export type Polling = { stop(): Promise<void> };

/**
 * Runs `pass` `intervalMs` after start and then `intervalMs` after each pass
 * ends, so passes never overlap. A pass that throws goes to `onError` and
 * the next one is still scheduled. `stop` cancels the next pass and waits for
 * the one in flight, which can read `stopped` to end early.
 */
export function startPolling(
  intervalMs: number,
  pass: (stopped: () => boolean) => Promise<unknown>,
  onError: (error: unknown) => void,
): Polling {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = (async () => {
      try {
        await pass(() => stopped);
      } catch (error) {
        onError(error);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };
  timer = setTimeout(tick, intervalMs);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
