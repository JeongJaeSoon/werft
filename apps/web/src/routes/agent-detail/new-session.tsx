import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  AgentDetail,
  AgentRelease,
  AgentSkillList,
  ConnectionOption,
  CreateSessionResponse,
} from "@werft-ai/contracts";
import {
  agentSessionListsFilter,
  sessionsQuery,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { guidanceFor } from "@werft-ai/react/components";
import {
  Button,
  buttonVariants,
  Code,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldError,
  FieldLabel,
  Switch,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { connectionsQuery } from "../../api/queries.ts";
import { useCan } from "../../auth/guard.tsx";
import { MESSAGE_MAX_BYTES } from "../../auth/limits.ts";
import { ReasonButton } from "../../auth/reason-button.tsx";
import { FormError } from "../../components/auth-page.tsx";
import { runsModel } from "../../components/connection-options.tsx";
import { errorKey, type Translate, useI18n } from "../../i18n/i18n.tsx";
import { agentSkillsQuery, versionLabel } from "../skills-data.ts";

const utf8 = new TextEncoder();
// The create request's `extensions.enable` limit.
const ENABLE_MAX = 32;

type AgentBlock = "archived" | "paused" | "noRelease";
type ReleaseBlock = "connection";

function consolePolicyBlock(
  agent: Pick<Agent, "status" | "active_release_id">,
): AgentBlock | null {
  if (agent.status !== "active") return agent.status;
  return agent.active_release_id === null ? "noRelease" : null;
}

// Only the connection is foreseen here. Whether a session starts without a
// repository, or on its release's, depends on the agent's GitHub settings
// row, which this screen does not read, so the server's refusal says so.
function foreseenServerRefusal(
  release: Pick<AgentRelease, "connection_id" | "runtime_config_snapshot">,
  connections: readonly ConnectionOption[] | undefined,
): ReleaseBlock | null {
  if (connections === undefined) return null;
  const connection = connections.find(
    (listed) => listed.id === release.connection_id,
  );
  const model = release.runtime_config_snapshot.model;
  return connection === undefined ||
    (typeof model === "string" &&
      !runsModel(connection, model) &&
      connection.model_successors[model] === undefined)
    ? "connection"
    : null;
}

function useScopeReason(): string | undefined {
  const { t } = useI18n();
  return useCan("sessions:write")
    ? undefined
    : t("guard.missingScope", { scope: "sessions:write" });
}

/**
 * The active release this build cannot read: the detail still names it, but
 * carries no release or lists it among the unreadable rows.
 */
function unreadableActiveRelease(detail: AgentDetail): string | null {
  const id = detail.agent.active_release_id;
  if (id === null) return null;
  // `?? false`: an API from before the field omits it mid-rollout.
  const listed =
    detail.unreadable_releases?.some((row) => row.id === id) ?? false;
  return detail.active_release === null || listed ? id : null;
}

export interface NewSessionStart {
  /** The release a start would send; null while there is none to send. */
  readonly releaseId: string | null;
  readonly reason: string | undefined;
  /** The Release tab is where the reason is fixed. */
  readonly fixedOnReleaseTab: boolean;
}

export function useNewSessionStart(detail: AgentDetail): NewSessionStart {
  const { t } = useI18n();
  const { client } = useWerft();
  const scopeReason = useScopeReason();
  const release = detail.active_release;
  const connections = useQuery({
    ...connectionsQuery(client),
    enabled: release !== null,
  });
  const stopped = consolePolicyBlock(detail.agent);
  const unreadable = unreadableActiveRelease(detail);
  const releaseId = unreadable === null ? (release?.id ?? null) : null;
  const blocked = (reason: string | undefined) => ({
    releaseId,
    reason,
    fixedOnReleaseTab: false,
  });
  if (stopped !== null) return blocked(t(AGENT_REASONS[stopped]));
  if (scopeReason !== undefined) return blocked(scopeReason);
  if (unreadable !== null)
    return {
      releaseId,
      reason: t("newSession.releaseUnreadable", { release: unreadable }),
      fixedOnReleaseTab: true,
    };
  const refused = release
    ? foreseenServerRefusal(release, connections.data?.items)
    : null;
  return blocked(refused === null ? undefined : t(RELEASE_REASONS[refused]));
}

const AGENT_REASONS = {
  archived: "agent.newSession.blocked.archived",
  paused: "agent.newSession.blocked.paused",
  noRelease: "agent.newSession.blocked.noRelease",
} as const satisfies Record<AgentBlock, Parameters<Translate>[0]>;

const RELEASE_REASONS = {
  connection: "agent.newSession.blocked.connection",
} as const satisfies Record<ReleaseBlock, Parameters<Translate>[0]>;

export function NewSessionReason({
  reason,
  action,
}: {
  readonly reason: string | undefined;
  readonly action?: ReactNode;
}) {
  return reason === undefined ? null : (
    <Text variant="sub" className="wrap-anywhere">
      {reason}
      {action ? <> {action}</> : null}
    </Text>
  );
}

type CreateBody = {
  agent_release_id: string;
  message: string;
  extensions?: { enable: string[] };
};
type Attempt = { readonly key: string; readonly body: CreateBody };
type AgentSkill = AgentSkillList["items"][number];

/**
 * The optional skills a session of this agent may turn on, by the scope that
 * decides each name: a workspace `required` or `forbidden` holds, otherwise
 * the agent's own attachment does. The server judges again at create.
 */
export function optionalSkills(items: readonly AgentSkill[]): AgentSkill[] {
  const holds = (item: AgentSkill | undefined) =>
    item?.scope === "workspace" &&
    (item.mode === "required" || item.mode === "forbidden");
  // As the server does, a row a new session leaves out drops before the
  // scopes are weighed: a repository skill switched off or withdrawn (a
  // server from before says nothing), and an optional row no session could
  // use (no version, or one not approved).
  const usable = items.filter(
    (item) =>
      (item.mode === "forbidden" ||
        (item.availability !== "hidden" &&
          item.availability !== "withdrawn")) &&
      (item.mode !== "optional" ||
        (item.version !== null && item.version.review === "approved")),
  );
  // The list's order is not a precedence: decide per name over both scopes.
  const deciding = new Map<string, AgentSkill>();
  for (const item of usable) {
    const other = deciding.get(item.name);
    if (
      other === undefined ||
      holds(item) ||
      (!holds(other) && item.scope === "agent")
    ) {
      deciding.set(item.name, item);
    }
  }
  return [...deciding.values()].filter(
    (item) =>
      item.mode === "optional" &&
      item.version !== null &&
      item.version.review === "approved",
  );
}

const refusedByServer = (error: ApiError) =>
  error.status >= 400 && error.status < 500;

// The create request's refusals about `extensions`, by `details.reason_code`.
const SKILL_REFUSALS = new Set([
  "required_removed",
  "required_replaced",
  "forbidden_revived",
  "not_optional",
  "bundle_not_found",
  "bundle_not_approved",
  "no_current_version",
  "skill_name_collision",
  "feature_unsupported",
  "skill_tool_not_allowed",
]);

function skillRefusalOf(
  error: ApiError,
): { reason: string; bundle: string } | null {
  if (error.code !== "UNSUPPORTED_CAPABILITY") return null;
  const details = error.details as {
    reason_code?: unknown;
    bundle?: unknown;
  } | null;
  const reason = details?.reason_code;
  if (typeof reason !== "string" || !SKILL_REFUSALS.has(reason)) return null;
  return {
    reason,
    bundle: typeof details?.bundle === "string" ? details.bundle : "",
  };
}

/** The release id a start was refused for as one this build cannot read. */
function unreadableReleaseOf(error: ApiError): string | null {
  if (error.code !== "RELEASE_SPEC_UNAVAILABLE") return null;
  const details = error.details as {
    reason_code?: unknown;
    release_id?: unknown;
  } | null;
  return details?.reason_code === "release_unreadable" &&
    typeof details.release_id === "string"
    ? details.release_id
    : null;
}

export function NewSessionButton({
  agentId,
  releaseId,
  reason,
}: {
  readonly agentId: string;
  readonly releaseId: string | null;
  readonly reason: string | undefined;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [blank, setBlank] = useState(false);
  // By skill name: a re-read that brings a newer approved version keeps the
  // switch on, and its label shows the version that will be sent.
  const [enabled, setEnabled] = useState<readonly string[]>([]);
  // Read once the dialog opens; someone who may not read the agent's skills
  // starts sessions without the choice, as before.
  const skills = useQuery({
    ...agentSkillsQuery(client, agentId, open),
    select: (list) => optionalSkills(list.items),
  });
  // A failed re-read keeps the last answer, so switches already on still send.
  const offered = skills.data ?? [];
  const enable = offered
    .filter((item) => enabled.includes(item.name))
    .flatMap((item) => (item.version ? [item.version.id] : []));
  // The server's limit is UTF-8 bytes, so a character count would not match.
  const tooLong = utf8.encode(message).length > MESSAGE_MAX_BYTES;
  // An answer that never came may still have made the session. Sending the
  // same key and the same body gets that session back; the release may have
  // changed by then, and the server hashes the whole body.
  const unanswered = useRef<Attempt | null>(null);
  // Only a switch the person moved changes the choice: a skills read that
  // failed or changed meanwhile must not turn a retry into a second session.
  const choiceMoved = useRef(false);
  const create = useMutation<CreateSessionResponse, ApiError, Attempt>({
    mutationFn: ({ key, body }) =>
      unwrap(
        client.POST("/v1/sessions", {
          params: { header: { "Idempotency-Key": key } },
          body,
        }),
      ) as Promise<CreateSessionResponse>,
    onSuccess: async (created) => {
      unanswered.current = null;
      void queryClient.invalidateQueries({
        ...sessionsQuery(client),
        exact: true,
      });
      void queryClient.invalidateQueries({
        ...waitingSessionsQuery(client),
        exact: true,
      });
      void queryClient.invalidateQueries(agentSessionListsFilter(client));
      await navigate({
        to: "/sessions/$id",
        params: { id: created.session_id },
      });
    },
    onError: (error) => {
      if (refusedByServer(error)) unanswered.current = null;
      // The attachments changed since the dialog read them.
      if (skillRefusalOf(error) !== null)
        void queryClient.invalidateQueries({
          queryKey: agentSkillsQuery(client, agentId).queryKey,
        });
    },
  });
  const refusal = (error: ApiError) => {
    const skill = skillRefusalOf(error);
    if (skill !== null)
      return skill.reason === "feature_unsupported"
        ? t("newSession.skillsUnsupported")
        : skill.reason === "skill_tool_not_allowed"
          ? t("newSession.skillToolMissing", { name: skill.bundle })
          : t("newSession.skillRefused", { name: skill.bundle });
    const unreadable = unreadableReleaseOf(error);
    if (unreadable !== null)
      return t("newSession.releaseUnreadable", { release: unreadable });
    const key = errorKey(error.code);
    return key === "error.UNKNOWN"
      ? (guidanceFor(error.code, locale) ?? t(key))
      : t(key);
  };
  const chosen = enable.length > 0 ? { enable } : undefined;
  // The release is left out of the match on purpose: see `unanswered`.
  const sameAsUnanswered = () => {
    const sent = unanswered.current;
    return sent?.body.message === message &&
      (!choiceMoved.current ||
        JSON.stringify(sent.body.extensions) === JSON.stringify(chosen))
      ? sent
      : null;
  };
  // The detail may be read again while the dialog is open and carry no release
  // for a new request: say why. An unanswered one still sends as it was.
  const nothingToSend = releaseId === null && sameAsUnanswered() === null;
  const error =
    nothingToSend && !create.isPending
      ? reason
      : create.error
        ? refusal(create.error)
        : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    if (message.trim() === "") {
      setBlank(true);
      return;
    }
    if (tooLong) return;
    const next =
      sameAsUnanswered() ??
      (releaseId === null
        ? null
        : {
            key: crypto.randomUUID(),
            body: {
              agent_release_id: releaseId,
              message,
              ...(chosen ? { extensions: chosen } : {}),
            },
          });
    if (next === null) return;
    unanswered.current = next;
    choiceMoved.current = false;
    create.mutate(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!create.isPending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <ReasonButton className={buttonVariants()} reason={reason}>
          {t("agent.newSession")}
        </ReasonButton>
      </DialogTrigger>
      {/* Many optional skills would push the message and the buttons off
          a short screen; the dialog scrolls instead, as teams.tsx's does. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={submit} className="grid min-w-0 gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t("agent.newSession.title")}</DialogTitle>
            <DialogDescription>
              {t("agent.newSession.description")}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={fieldId}>
              {t("agent.newSession.message")}
            </FieldLabel>
            <Textarea
              id={fieldId}
              rows={5}
              value={message}
              readOnly={create.isPending}
              aria-invalid={blank || tooLong ? true : undefined}
              onChange={(event) => {
                setMessage(event.target.value);
                setBlank(false);
              }}
            />
            <FieldError>
              {blank
                ? t("agent.newSession.messageRequired")
                : tooLong
                  ? t("agent.newSession.messageTooLong", {
                      max: MESSAGE_MAX_BYTES / 1024,
                    })
                  : null}
            </FieldError>
          </Field>
          {offered.length > 0 ? (
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1 font-medium text-control">
                {t("newSession.skills")}
              </legend>
              <Text variant="sub">
                {enable.length >= ENABLE_MAX
                  ? t("newSession.skillsLimit", { max: ENABLE_MAX })
                  : t("newSession.skillsHint")}
              </Text>
              {offered.map((item) => {
                const on = enabled.includes(item.name);
                const switchId = `${fieldId}-skill-${item.name}`;
                return (
                  <Field key={item.name} orientation="horizontal">
                    <Switch
                      id={switchId}
                      aria-label={t("newSession.skillToggle", {
                        name: item.name,
                      })}
                      checked={on}
                      disabled={
                        create.isPending || (!on && enable.length >= ENABLE_MAX)
                      }
                      onCheckedChange={(next) => {
                        choiceMoved.current = true;
                        setEnabled((now) =>
                          next
                            ? [...now, item.name]
                            : now.filter((other) => other !== item.name),
                        );
                      }}
                    />
                    {/* Clicking the name moves the switch too. */}
                    <FieldLabel
                      htmlFor={switchId}
                      className="wrap-anywhere font-normal"
                    >
                      <Code size="inherit">{item.name}</Code>
                      {item.version
                        ? ` · ${versionLabel(t, item.version)}`
                        : ""}
                    </FieldLabel>
                  </Field>
                );
              })}
            </fieldset>
          ) : null}
          {error ? <FormError>{error}</FormError> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
              >
                {t("agent.newSession.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending
                ? t("agent.newSession.submitting")
                : t("agent.newSession.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
