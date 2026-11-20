import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  ActivateAgentResponse,
  AgentDetail,
  AgentRelease,
  CreateSessionResponse,
  PostSessionMessageResponse,
} from "@werft-ai/contracts";
import {
  agentSessionListsFilter,
  sessionQuery,
  sessionsQuery,
  sessionTurnsQuery,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useSessionEvents, useSessionTurns, useWerft } from "@werft-ai/react";
import { SessionChat } from "@werft-ai/react/blocks";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Text,
  Textarea,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { queryKeysOf } from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import { MESSAGE_MAX_BYTES } from "../auth/limits.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { agentRefusal } from "./agent-refusal.ts";
import { FormError } from "./auth-page.tsx";

const utf8 = new TextEncoder();

const newest = (releases: readonly AgentRelease[]) =>
  [...releases].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

/** The newest release of this version on this connection. */
export function releaseOf(
  detail: AgentDetail,
  versionId: string | null,
  connectionId: string,
): AgentRelease | undefined {
  return newest(
    detail.releases.filter(
      (release) =>
        release.version_id === versionId &&
        release.connection_id === connectionId,
    ),
  );
}

/**
 * The release a preview tries on this agent: the one its draft saved, else,
 * with no draft and none published, the newest. None when nothing waits to
 * be tried, or when the draft's release was never made: an older one would
 * stand in for the settings last saved.
 */
export function previewRelease(detail: AgentDetail): AgentRelease | undefined {
  const { draft } = detail;
  if (draft) {
    // A refused save left a release only for what was saved before it.
    if (draft.failure !== null) return undefined;
    const drafted = releaseOf(detail, draft.version_id, draft.connection_id);
    return drafted?.id === detail.agent.active_release_id ? undefined : drafted;
  }
  return detail.agent.active_release_id === null
    ? newest(detail.releases)
    : undefined;
}

type StartBody = {
  agent_release_id: string;
  message: string;
  preview: true;
};
type Attempt = { readonly key: string; readonly body: StartBody };
type FollowUp = {
  readonly key: string;
  readonly sessionId: string;
  readonly message: string;
};

/**
 * Tries a release in a preview session: the first message starts one, the
 * next ones go to it. A new release needs a new chat, so the caller keys
 * this on the release.
 */
export function PreviewChat({
  releaseId,
  agentName,
}: {
  readonly releaseId: string;
  readonly agentName: string;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const fieldId = useId();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [blank, setBlank] = useState(false);
  const tooLong = utf8.encode(message).length > MESSAGE_MAX_BYTES;
  // An answer that never came may still have started the session; the same
  // key and body get that session back instead of a second one.
  const unanswered = useRef<Attempt | null>(null);
  const start = useMutation<CreateSessionResponse, ApiError, Attempt>({
    mutationFn: ({ key, body }) =>
      unwrap(
        client.POST("/v1/sessions", {
          params: { header: { "Idempotency-Key": key } },
          body,
        }),
      ) as Promise<CreateSessionResponse>,
    onSuccess: (created) => {
      unanswered.current = null;
      setSessionId(created.session_id);
      setMessage("");
      void queryClient.invalidateQueries({
        ...sessionsQuery(client),
        exact: true,
      });
      void queryClient.invalidateQueries({
        ...waitingSessionsQuery(client),
        exact: true,
      });
      void queryClient.invalidateQueries(agentSessionListsFilter(client));
    },
    onError: (error) => {
      if (error.status >= 400 && error.status < 500) unanswered.current = null;
    },
  });
  // The same holds for a later message: resent, it keeps its key.
  const unsent = useRef<FollowUp | null>(null);
  const send = useMutation<PostSessionMessageResponse, ApiError, FollowUp>({
    mutationFn: ({ key, sessionId: id, message: text }) =>
      unwrap(
        client.POST("/v1/sessions/{id}/messages", {
          params: { path: { id }, header: { "Idempotency-Key": key } },
          body: { message: text, mode: "enqueue" },
        }),
      ) as Promise<PostSessionMessageResponse>,
    onSuccess: (_, { sessionId: id }) => {
      unsent.current = null;
      setMessage("");
      void queryClient.invalidateQueries({
        ...sessionQuery(client, id),
        exact: true,
      });
      void queryClient.invalidateQueries(sessionTurnsQuery(client, id));
    },
    onError: (error) => {
      if (error.status >= 400 && error.status < 500) unsent.current = null;
    },
  });
  const open = sessionId !== null;
  const events = useSessionEvents(sessionId ?? "", open);
  const turns = useSessionTurns(sessionId ?? "", open);
  const session = useQuery({
    ...sessionQuery(client, sessionId ?? ""),
    enabled: open,
  });
  const status = session.data?.status;
  const pending = start.isPending || send.isPending;
  const failure = start.error ?? send.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (message.trim() === "") {
      setBlank(true);
      return;
    }
    if (tooLong) return;
    if (sessionId !== null) {
      const again = unsent.current;
      const followUp =
        again?.sessionId === sessionId && again.message === message
          ? again
          : { key: crypto.randomUUID(), sessionId, message };
      unsent.current = followUp;
      send.mutate(followUp);
      return;
    }
    const resend = unanswered.current;
    const next =
      resend?.body.message === message
        ? resend
        : {
            key: crypto.randomUUID(),
            body: {
              agent_release_id: releaseId,
              message,
              preview: true as const,
            },
          };
    unanswered.current = next;
    start.mutate(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {sessionId === null ? (
        <Text variant="sub">{t("agents.preview.empty")}</Text>
      ) : (
        <>
          <SessionChat
            events={events.events}
            state={events.state}
            turns={turns.data?.items}
            agentName={agentName}
            working={
              status === "running" ||
              status === "queued" ||
              status === "needs_input"
            }
          />
          {status === "needs_input" ? (
            <Text variant="sub" role="status">
              {t("agents.preview.needsInput")}
            </Text>
          ) : null}
          <Link
            to="/sessions/$id"
            params={{ id: sessionId }}
            className="self-start text-link underline-offset-2 hover:underline"
          >
            {t("agents.preview.openSession")}
          </Link>
        </>
      )}
      <form
        onSubmit={submit}
        noValidate
        className="flex min-w-0 flex-col gap-3"
      >
        <Field>
          <FieldLabel htmlFor={fieldId}>
            {t("agents.preview.message")}
          </FieldLabel>
          <Textarea
            id={fieldId}
            rows={3}
            value={message}
            readOnly={pending}
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
        {failure ? (
          <FormError>{agentRefusal(t, failure, role)}</FormError>
        ) : null}
        <div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? t("agents.preview.sending") : t("agents.preview.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** A preview chat over the page, for a release tried from the agent's page. */
export function PreviewDialog({
  release,
  agentName,
  onClose,
  returnTo,
}: {
  /** Open while set. */
  readonly release: AgentRelease | null;
  readonly agentName: string;
  readonly onClose: () => void;
  /** Where focus goes on close when the button that opened it is gone. */
  readonly returnTo?: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const open = release !== null;
  // The screens open it from their own buttons, with no Dialog.Trigger for
  // Radix to give focus back to. A layout effect runs before Radix's focus
  // move, so what holds focus then is the opener.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null;
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[40rem]"
        onCloseAutoFocus={(event) => {
          // An opener gone with its form, or one that lost focus while it
          // was disabled (focus then sat on <body>), gives way to the
          // caller's fallback.
          const own = opener.current;
          const back =
            own?.isConnected && own !== own.ownerDocument.body
              ? own
              : returnTo?.current;
          if (!back?.isConnected) return;
          event.preventDefault();
          back.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("agents.preview.dialogTitle", {
              release: release?.label ?? "",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("agents.preview.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        {release ? (
          <PreviewChat
            key={release.id}
            releaseId={release.id}
            agentName={agentName}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Publishes a release: activates it with the revision the screen read. The
 * agent lists are read again whatever the answer, since a lost answer may
 * still have published it.
 */
export function usePublishAgent(agentId: string) {
  const { client } = useWerft();
  const queryClient = useQueryClient();
  return useMutation<
    ActivateAgentResponse,
    ApiError,
    { readonly releaseId: string; readonly expected: number }
  >({
    mutationFn: ({ releaseId, expected }) =>
      unwrap(
        client.POST("/v1/agents/{id}/activate", {
          params: { path: { id: agentId } },
          body: { release_id: releaseId, expected_revision: expected },
        }),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeysOf(client).agents }),
  });
}

/** The confirmation before publishing, naming the team that gains the agent. */
export function PublishDialog({
  open,
  onOpenChange,
  team,
  busy,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly team: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("agents.publish.title")}
      consequence={t("agents.publish.consequence", { team })}
      confirmLabel={
        busy ? t("agents.publish.publishing") : t("agents.publish.confirm")
      }
      cancelLabel={t("common.cancel")}
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}
