/** Polls a synchronous condition for up to two seconds, then fails with `label`. */
export async function waitFor(
  condition: () => boolean,
  label: string,
  { timeoutMs = 2_000, stepMs = 5 } = {},
): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (condition()) return;
    await Bun.sleep(stepMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
