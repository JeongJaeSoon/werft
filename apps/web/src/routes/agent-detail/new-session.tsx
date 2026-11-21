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
import { type FormEvent, useId, useRef, useState } from "react";
import { connectionsQuery } from "../../api/queries.ts";
import { useCan } from "../../auth/guard.tsx";
import { MESSAGE_MAX_BYTES } from "../../auth/limits.ts";
import { ReasonButton } from "../../auth/reason-button.tsx";
import { FormError } from "../../components/auth-page.tsx";
import { runsModel } from "../../components/connection-options.tsx";
import { errorKey, type Translate, useI18n } from "../../i18n/i18n.tsx";
import { agentSkillsQuery, versionLabel } from "../skills-data.ts";

const utf8 = new TextEncoder();

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

export function useNewSessionReason(detail: AgentDetail): string | undefined {
  const { t } = useI18n();
  const { client } = useWerft();
  const scopeReason = useScopeReason();
  const release = detail.active_release;
  const connections = useQuery({
    ...connectionsQuery(client),
    enabled: release !== null,
  });
  const stopped = consolePolicyBlock(detail.agent);
  if (stopped !== null) return t(AGENT_REASONS[stopped]);
  if (scopeReason !== undefined) return scopeReason;
  const refused = release
    ? foreseenServerRefusal(release, connections.data?.items)
    : null;
  return refused === null ? undefined : t(RELEASE_REASONS[refused]);
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
}: {
  readonly reason: string | undefined;
}) {
  return reason === undefined ? null : <Text variant="sub">{reason}</Text>;
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
  const deciding = new Map<string, AgentSkill>();
  for (const item of items) {
    const outer = deciding.get(item.name);
    const holds =
      outer?.scope === "workspace" &&
      (outer.mode === "required" || outer.mode === "forbidden");
    if (outer === undefined || (item.scope === "agent" && !holds)) {
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
  const [enabled, setEnabled] = useState<readonly string[]>([]);
  // Read once the dialog opens; someone who may not read the agent's skills
  // starts sessions without the choice, as before.
  const skills = useQuery({
    ...agentSkillsQuery(client, agentId, open),
    select: (list) => optionalSkills(list.items),
  });
  const offered = skills.isSuccess ? skills.data : [];
  const enable = offered
    .flatMap((item) => (item.version ? [item.version.id] : []))
    .filter((id) => enabled.includes(id));
  // The server's limit is UTF-8 bytes, so a character count would not match.
  const tooLong = utf8.encode(message).length > MESSAGE_MAX_BYTES;
  // An answer that never came may still have made the session. Sending the
  // same key and the same body gets that session back; the release may have
  // changed by then, and the server hashes the whole body.
  const unanswered = useRef<Attempt | null>(null);
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
    },
  });
  const refusal = (error: ApiError) => {
    const key = errorKey(error.code);
    return key === "error.UNKNOWN"
      ? (guidanceFor(error.code, locale) ?? t(key))
      : t(key);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (releaseId === null || create.isPending) return;
    if (message.trim() === "") {
      setBlank(true);
      return;
    }
    if (tooLong) return;
    const chosen = enable.length > 0 ? { enable } : undefined;
    const resend = unanswered.current;
    // The release is left out of the match on purpose: see `unanswered`.
    const next =
      resend?.body.message === message &&
      JSON.stringify(resend.body.extensions) === JSON.stringify(chosen)
        ? resend
        : {
            key: crypto.randomUUID(),
            body: {
              agent_release_id: releaseId,
              message,
              ...(chosen ? { extensions: chosen } : {}),
            },
          };
    unanswered.current = next;
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
      <DialogContent>
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
              <Text variant="sub">{t("newSession.skillsHint")}</Text>
              {offered.map((item) => {
                const id = item.version?.id ?? "";
                return (
                  <Field key={item.name} orientation="horizontal">
                    <Switch
                      aria-label={t("newSession.skillToggle", {
                        name: item.name,
                      })}
                      checked={enabled.includes(id)}
                      disabled={create.isPending}
                      onCheckedChange={(next) =>
                        setEnabled((now) =>
                          next
                            ? [...now, id]
                            : now.filter((other) => other !== id),
                        )
                      }
                    />
                    <Text as="span" className="wrap-anywhere">
                      <Code size="inherit">{item.name}</Code>
                      {item.version
                        ? ` · ${versionLabel(t, item.version)}`
                        : ""}
                    </Text>
                  </Field>
                );
              })}
            </fieldset>
          ) : null}
          {create.error ? <FormError>{refusal(create.error)}</FormError> : null}
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
