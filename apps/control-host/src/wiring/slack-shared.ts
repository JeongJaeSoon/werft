export type Param<F extends (...args: never[]) => unknown> = Parameters<F>[0];

/** The console's agent list, which names no agent; empty with no console. */
export function slackAgentsUrl(consoleOrigin: string | null): string {
  return consoleOrigin === null
    ? ""
    : new URL("/agents", consoleOrigin).toString();
}

export function slackConnectUrl(consoleOrigin: string | null): string {
  return consoleOrigin === null
    ? ""
    : new URL("/settings/linked-accounts", consoleOrigin).toString();
}
