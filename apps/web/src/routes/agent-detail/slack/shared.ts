import type { components } from "@werft-ai/client";
import {
  errorKey,
  type MessageKey,
  type Translate,
} from "../../../i18n/i18n.tsx";
import { reasonCodeOf, storeOff } from "../../workspace-slack.tsx";

export type Binding =
  components["schemas"]["ListSlackBindingsResponse"]["items"][number];
type BindingInput = components["schemas"]["PutSlackBindingRequest"];
export type BindingChange = {
  readonly body: BindingInput;
  readonly kind: "reaction" | "home" | "connect";
};
// With no row yet the server makes one on the first DM and answers it.
export const dmOn = (dm: Binding | undefined) =>
  dm === undefined || dm.mode !== "off";

export const SECTION = {
  channels: "slack-channels",
  basic: "slack-basic",
  token: "slack-token",
  addresses: "slack-addresses",
  app: "slack-app",
  danger: "slack-danger",
  /** The new-agent flow's one section. */
  advanced: "slack-advanced",
} as const;
/** The tab's sections, in the side list's words. */
export const SECTION_LABEL = {
  channels: "slack.channels",
  basic: "slack.basic",
  token: "workspace.tokenSection",
  addresses: "workspace.addressesTitle",
  app: "workspace.slackApps",
  danger: "slack.danger",
} as const satisfies Record<string, MessageKey>;
export type SectionKey = keyof typeof SECTION_LABEL;
export const SLACK_WARNING_KEY = {
  config_token_issuer_changed: {
    title: "slack.issuerChanged.title",
    body: "slack.issuerChanged.body",
  },
  repository_required: {
    title: "slack.repositoryRequired.title",
    body: "slack.repositoryRequired.body",
  },
  profile_unavailable: {
    title: "slack.profileUnavailable.title",
    body: "slack.profileUnavailable.body",
  },
  no_active_release: {
    title: "slack.noActiveRelease.title",
    body: "slack.noActiveRelease.body",
  },
} as const satisfies Record<
  components["schemas"]["GetSlackAppResponse"]["warnings"][number]["code"],
  { title: MessageKey; body: MessageKey }
>;
export const SECTION_BOX =
  "flex scroll-mt-4 flex-col gap-[var(--werft-space-block)] outline-none";
/** A section the side list jumps to, clear of the sticky header. */
export const SECTION_TARGET = "scroll-mt-4 outline-none";
export const RECHECK_ID = "slack-events-recheck";
export const UNVERIFIED_POLL_MS = 10_000;
export const EVENTS_BADGE = {
  verified: "green",
  pending: "amber",
  failed: "red",
} as const;

/** Slack's own words for a failure, where the generic ones say too little. */
export function slackReason(error: unknown, t: Translate): string | undefined {
  const code = (error as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
  if (code === "CONFIG_TOKEN_INVALID" || code === "SLACK_LINK_NOT_CONFIGURED")
    return t("slack.error.config");
  if (code === "SLACK_APP_CREATING") return t("slack.error.creating");
  if (code === "SLACK_APP_GONE") return t("slack.error.gone");
  if (code === "AGENT_NOT_ACTIVE") return t("slack.activateFirst");
  if (code === "SLACK_NOT_INSTALLED") return t("slack.error.notInstalled");
  if (code === "SLACK_INSTALL_DENIED") return t("slack.error.denied");
  if (code === "SLACK_INSTALL_STATE_INVALID") return t("slack.error.expired");
  if (code === "SLACK_INSTALL_REJECTED" || code === "SLACK_INSTALL_CONFLICT")
    return t("slack.error.rejected");
  if (code === "CURSOR_EXPIRED") return t("slack.error.cursor");
  if (storeOff(error)) return t("workspace.tokenStoreUnavailable");
  if (code === "BACKEND_UNAVAILABLE") {
    const reason = reasonCodeOf(error);
    if (reason === "slack_refused") {
      const slack = (error as { details?: { slack_error?: unknown } }).details
        ?.slack_error;
      return t("slack.error.refused", {
        code: typeof slack === "string" ? slack : "unknown",
      });
    }
    if (reason === "console_origin_unset")
      return t("slack.error.consoleOrigin");
    if (reason === "events_url_unset") return t("slack.error.eventsUrl");
    if (reason === "slack_no_answer") return t("slack.error.noAnswer");
    // A cause this screen has no words for: a retry cannot help, so name the
    // code instead of "try again shortly".
    if ((error as { retryable?: unknown }).retryable === false)
      return t("slack.error.unknown", { code: reason ?? code });
  }
  return undefined;
}

export function slackFailure(error: unknown, t: Translate): string {
  const code = (error as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
  return slackReason(error, t) ?? t(errorKey(code));
}

export function slackState(
  error: unknown,
  identity: object | undefined,
  record:
    | {
        readonly secrets: { readonly slack_bot_token: { configured: boolean } };
      }
    | null
    | undefined,
) {
  return error
    ? "error"
    : identity
      ? "connected"
      : record?.secrets.slack_bot_token.configured
        ? "reinstall"
        : record
          ? "pending"
          : "none";
}
