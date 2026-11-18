import { expect, test } from "bun:test";
import { startPolling } from "./polling.ts";

test("a failing pass is reported and polling goes on", async () => {
  const errors: unknown[] = [];
  let passes = 0;
  const { promise: thirdPass, resolve } = Promise.withResolvers<void>();
  const polling = startPolling(
    1,
    async () => {
      passes += 1;
      if (passes === 3) resolve();
      if (passes === 1) throw new Error("boom");
    },
    (error) => errors.push(error),
  );
  await thirdPass;
  await polling.stop();
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe("boom");
});

test("stop waits for the pass in flight, tells it, and runs no other", async () => {
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const { promise: release, resolve: letGo } = Promise.withResolvers<void>();
  let passes = 0;
  let sawStop = false;
  let finished = false;
  const polling = startPolling(
    1,
    async (stopped) => {
      passes += 1;
      enter();
      await release;
      sawStop = stopped();
      finished = true;
    },
    () => {},
  );
  await entered;
  let stoppedEarly = false;
  const stopping = polling.stop().then(() => {
    stoppedEarly = !finished;
  });
  await Bun.sleep(5);
  expect(stoppedEarly).toBe(false);
  letGo();
  await stopping;
  expect(stoppedEarly).toBe(false);
  expect(finished).toBe(true);
  expect(sawStop).toBe(true);
  await Bun.sleep(10);
  expect(passes).toBe(1);
});
