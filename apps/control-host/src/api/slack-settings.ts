import type {
  SlackSettings,
  UpdateSlackSettingsRequest,
  UpdateSlackSettingsResponse,
} from "@werft-ai/contracts";
import type { SlackSettingsStore } from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  type Caller,
  SessionServiceError,
} from "@werft-ai/platform";
import { slackEventsUrl } from "../wiring/chat-slack.ts";
import { requireSignInOwner } from "./provider-admin.ts";
import { computedEventsBase, parseEventsPublicUrl } from "./slack-config.ts";

/**
 * The events base Slack is sent, read on every use so a saved address
 * reaches every replica at once: the saved one, else the console's.
 */
export function slackEventsBaseOf(
  store: Pick<SlackSettingsStore, "read">,
  consoleOrigin: string | null,
): () => Promise<string | null> {
  const computed = computedEventsBase(consoleOrigin);
  return async () => (await store.read())?.eventsPublicUrl ?? computed;
}

/**
 * The owner's Slack settings for the whole installation. A changed address
 * reaches an app made before it once its events are checked again from the
 * agent's Slack tab.
 */
export function createSlackSettingsAdmin(deps: {
  authorization: AuthorizationPolicy;
  store: SlackSettingsStore;
  consoleOrigin: string | null;
}) {
  const computed = computedEventsBase(deps.consoleOrigin);
  const viewOf = (saved: string | null): SlackSettings => {
    const base = saved ?? computed;
    return {
      events_public_url: saved,
      computed_events_base: computed,
      events_url_template:
        base === null ? null : slackEventsUrl(base, "{agent_id}"),
    };
  };
  return {
    async read(caller: Caller): Promise<SlackSettings> {
      await requireSignInOwner(deps.authorization, caller);
      return viewOf((await deps.store.read())?.eventsPublicUrl ?? null);
    },

    async change(
      caller: Caller,
      body: UpdateSlackSettingsRequest,
    ): Promise<UpdateSlackSettingsResponse> {
      const audit = await requireSignInOwner(deps.authorization, caller);
      const raw = body.events_public_url?.trim() || null;
      const value = raw === null ? null : parseEventsPublicUrl(raw);
      if (raw !== null && value === null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The events address must be an https URL without a query, fragment or credentials",
          undefined,
          { reason_code: "events_url_invalid" },
        );
      }
      const { changed } = await deps.store.setEventsPublicUrl({
        value,
        audit,
      });
      return {
        ...viewOf(value),
        ...(changed ? { receipt_id: audit.receiptId } : {}),
      };
    },
  };
}

export type SlackSettingsAdmin = ReturnType<typeof createSlackSettingsAdmin>;

/**
 * SLACK_EVENTS_PUBLIC_URL is no longer read. The first start that finds it
 * and no saved settings carries a valid value in, once; the warnings say
 * what happened and never carry the value.
 */
export async function importSlackEventsPublicUrl(
  env: Record<string, string | undefined>,
  store: SlackSettingsStore,
): Promise<string[]> {
  const raw = env.SLACK_EVENTS_PUBLIC_URL;
  if (!raw) return [];
  if ((await store.read()) !== null) {
    return ["Ignored removed settings: SLACK_EVENTS_PUBLIC_URL"];
  }
  const value = parseEventsPublicUrl(raw.trim());
  if (value === null) {
    return [
      "SLACK_EVENTS_PUBLIC_URL was not carried in: it is not an https URL without a query. Set the events address in Settings > Integrations > Slack, then remove it",
    ];
  }
  return (await store.importEventsPublicUrl(value))
    ? [
        "SLACK_EVENTS_PUBLIC_URL was carried into Settings > Integrations > Slack and is no longer read; remove it",
      ]
    : ["Ignored removed settings: SLACK_EVENTS_PUBLIC_URL"];
}
