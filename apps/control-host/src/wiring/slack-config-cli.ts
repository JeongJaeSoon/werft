// The slack-app operator command's chat adapters. The command builds the
// service it needs per subcommand, so each builder stays separate.
import {
  createSlackAppService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackEventsFinalize,
  createSlackLinkAppService,
} from "./chat-slack.ts";
import type { Param } from "./slack-shared.ts";

export type SlackCliApi = ReturnType<typeof createSlackConfigApi>;

export function wireSlackCliApi(options: Param<typeof createSlackConfigApi>) {
  return createSlackConfigApi(options);
}

/** What every subcommand's service is built from. */
export type SlackCliDeps = Param<typeof createSlackAppService>;

export function wireSlackCliDeps(input: {
  authorization: SlackCliDeps["authorization"];
  apps: NonNullable<SlackCliDeps["apps"]>;
  tokenStore: Param<typeof createSlackConfigTokens>["store"];
  api: SlackCliApi;
  consoleOrigin: SlackCliDeps["consoleOrigin"];
}): SlackCliDeps & { apps: NonNullable<SlackCliDeps["apps"]> } {
  return {
    authorization: input.authorization,
    apps: input.apps,
    tokens: createSlackConfigTokens({
      store: input.tokenStore,
      api: input.api,
    }),
    api: input.api,
    consoleOrigin: input.consoleOrigin,
  };
}

export function wireSlackCliAppService(deps: SlackCliDeps) {
  return createSlackAppService(deps);
}

export function wireSlackCliLinkAppService(
  deps: Param<typeof createSlackLinkAppService>,
) {
  return createSlackLinkAppService(deps);
}

export function wireSlackCliEventsFinalize(
  deps: Param<typeof createSlackEventsFinalize>,
) {
  return createSlackEventsFinalize(deps);
}
