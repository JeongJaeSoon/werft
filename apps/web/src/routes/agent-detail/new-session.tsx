import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  AgentDetail,
  AgentRelease,
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
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useRef, useState } from "react";
import { connectionsQuery } from "../../api/queries.ts";
import { useCan, useMe } from "../../auth/guard.tsx";
import { ReasonButton } from "../../auth/reason-button.tsx";
import { FormError } from "../../components/auth-page.tsx";
import { runsModel } from "../../components/connection-options.tsx";
import { errorKey, type Translate, useI18n } from "../../i18n/i18n.tsx";

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

export function useOutsiderNewSessionReason(
  agent: Pick<Agent, "status" | "active_release_id">,
): string | undefined {
  const { t } = useI18n();
  const scopeReason = useScopeReason();
  const access = useMe()?.workspace?.settings.agent_outsider_access;
  const block = consolePolicyBlock(agent);
  if (block !== null) return t(AGENT_REASONS[block]);
  if (scopeReason !== undefined) return scopeReason;
  return access === "use" || access === undefined
    ? undefined
    : t("agent.newSession.blocked.outsider");
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

type CreateBody = { agent_release_id: string; message: string };
type Attempt = { readonly key: string; readonly body: CreateBody };

const refusedByServer = (error: ApiError) =>
  error.status >= 400 && error.status < 500;

export function NewSessionButton({
  releaseId,
  reason,
}: {
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
    const resend = unanswered.current;
    const next =
      resend?.body.message === message
        ? resend
        : {
            key: crypto.randomUUID(),
            body: { agent_release_id: releaseId, message },
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
              aria-invalid={blank ? true : undefined}
              onChange={(event) => {
                setMessage(event.target.value);
                setBlank(false);
              }}
            />
            <FieldError>
              {blank ? t("agent.newSession.messageRequired") : null}
            </FieldError>
          </Field>
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
