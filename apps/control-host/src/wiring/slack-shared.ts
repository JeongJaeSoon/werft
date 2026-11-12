export type Param<F extends (...args: never[]) => unknown> = Parameters<F>[0];

export function slackConnectUrl(consoleOrigin: string | null): string {
  return consoleOrigin === null
    ? ""
    : new URL("/settings/linked-accounts", consoleOrigin).toString();
}
