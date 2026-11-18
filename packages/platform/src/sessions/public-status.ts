// Stored statuses of a session or turn in flight. No writer stores
// needs_input any more; a row that holds it reads like running, so the
// public status never contradicts pending_request_count.
export const IN_FLIGHT_STATUSES: ("running" | "needs_input")[] = [
  "running",
  "needs_input",
];

// Stored statuses publicStatus can turn into needs_input.
export const AWAITABLE_STATUSES: ("running" | "needs_input" | "idle")[] = [
  ...IN_FLIGHT_STATUSES,
  "idle",
];

/**
 * `needs_input` is never stored: it is a running session or
 * turn with a request a person can still answer. Derived on read, it drops
 * back the instant the last one is answered, settled, expires or loses its
 * attempt, with no write or sweep to miss.
 */
export function publicStatus<S extends string>(
  stored: S,
  awaitingInput: boolean,
): S | "needs_input" | "running" {
  // An idle session that waits on a person parked its turn on their
  // requests: only a parked row is answerable with no turn in flight.
  if (stored === "idle" && awaitingInput) return "needs_input";
  if (!(IN_FLIGHT_STATUSES as string[]).includes(stored)) return stored;
  return awaitingInput ? "needs_input" : "running";
}
