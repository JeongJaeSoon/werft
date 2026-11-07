import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  AgentDetail,
  AgentRelease,
  CreateSessionResponse,
  ProfileSummary,
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
  Text,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useRef, useState } from "react";
import { profilesQuery } from "../../api/queries.ts";
import { useCan, useMe } from "../../auth/guard.tsx";
import { ReasonButton } from "../../auth/reason-button.tsx";
import { FormError } from "../../components/auth-page.tsx";
import { startableWhenPinned } from "../../components/profile-options.tsx";
import { errorKey, type Translate, useI18n } from "../../i18n/i18n.tsx";

type AgentBlock = "archived" | "paused" | "noRelease";
type ReleaseBlock = "profile" | "repository";

function consolePolicyBlock(
  agent: Pick<Agent, "status" | "active_release_id">,
): AgentBlock | null {
  if (agent.status !== "active") return agent.status;
  return agent.active_release_id === null ? "noRelease" : null;
}

function foreseenServerRefusal(
  release: Pick<AgentRelease, "runtime_profile_id" | "repository_id"> & {
    readonly policy_pins: Pick<AgentRelease["policy_pins"], "github">;
  },
  profiles: readonly ProfileSummary[] | undefined,
): ReleaseBlock | null {
  if (profiles === undefined) return null;
  const profile = profiles.find(
    (listed) => listed.id === release.runtime_profile_id,
  );
  if (profile === undefined || !startableWhenPinned(profile)) return "profile";
  const repository = release.repository_id;
  if (repository === null) return null;
  const pinned = release.policy_pins.github?.repositories;
  return (profile.repository_ids?.includes(repository) ?? true) &&
    (pinned?.includes(repository) ?? true)
    ? null
    : "repository";
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
  const profiles = useQuery({
    ...profilesQuery(client),
    enabled: release !== null,
  });
  const stopped = consolePolicyBlock(detail.agent);
  if (stopped !== null) return t(AGENT_REASONS[stopped]);
  if (scopeReason !== undefined) return scopeReason;
  const refused = release
    ? foreseenServerRefusal(release, profiles.data?.items)
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
  profile: "agent.newSession.blocked.profile",
  repository: "agent.newSession.blocked.repository",
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
  repository,
  reason,
}: {
  readonly releaseId: string | null;
  readonly repository?: string | null | undefined;
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
          {repository === undefined ? null : (
            <Text variant="sub" className="wrap-anywhere">
              {t("agent.newSession.repository")}{" "}
              {repository === null ? (
                t("agent.releases.repositoryNone")
              ) : (
                <Code className="wrap-anywhere">{repository}</Code>
              )}
            </Text>
          )}
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
