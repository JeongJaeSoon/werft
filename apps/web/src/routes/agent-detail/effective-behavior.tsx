import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  AgentRelease,
  BehaviorValues,
  SaveAgentResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  Button,
  Card,
  Code,
  Heading,
  KeyValueList,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { agentListsFilter, queryKeysOf } from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import {
  cardFromDraft,
  draftFromCard,
} from "../../components/agent-card-form.tsx";
import {
  PreviewDialog,
  previewRelease,
} from "../../components/agent-preview.tsx";
import { agentRefusal } from "../../components/agent-refusal.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { draftVersion, shownVersion } from "./versions.tsx";

type Translate = ReturnType<typeof useI18n>["t"];

/** Why a save was kept but not applied, in words; a code this page lacks shows as sent. */
export function saveFailureText(t: Translate, reason: string | null): string {
  switch (reason) {
    case "model_not_in_connection":
      return t("agent.save.reason.model_not_in_connection");
    case "credential_unbound":
      return t("agent.save.reason.credential_unbound");
    case "release_refused":
      return t("agent.save.reason.release_refused");
    case "connection_unknown":
      return t("agent.save.reason.connection_unknown");
    case "runtime_unsupported":
    case "tools_unknown":
      return t("agent.save.reason.runtime_unsupported");
    case "retries_exhausted":
      return t("agent.save.reason.retries_exhausted");
    case "revision_conflict":
      return t("agent.save.reason.revision_conflict");
    default:
      return reason ?? t("agent.save.reason.other");
  }
}

/**
 * What a session started now runs with, read from the server, and the save
 * that is waiting for its release or was refused, beside it. The page holds
 * no rule for combining them.
 */
export function EffectiveBehavior({
  detail,
  manages,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
  /** Where a saved release is turned on. */
  readonly toRelease: ReactNode;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const titleId = useId();
  const [outcome, setOutcome] = useState<string | null>(null);
  // The release the button was pressed for: a later save does not swap it
  // under an open preview.
  const [previewing, setPreviewing] = useState<AgentRelease | null>(null);
  const { applied, draft } = detail.effective_behavior;
  const waiting = detail.draft;
  // A published agent's saved release waits to be tried and turned on, as an
  // unpublished agent's waits to be published above the tabs.
  const saved =
    detail.active_release && waiting?.failure === null
      ? previewRelease(detail)
      : undefined;
  const previewButton = useRef<HTMLButtonElement>(null);
  // The retry button is gone once its save is kept; the keyboard goes on to
  // the next step instead of the page, unless it went elsewhere meanwhile.
  const retried = useRef(false);
  useEffect(() => {
    if (!saved || !retried.current) return;
    retried.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body)
      previewButton.current?.focus();
  }, [saved]);

  const resave = useMutation<SaveAgentResponse, ApiError, "retry" | "discard">({
    mutationFn: (mode) => {
      const source =
        mode === "retry" ? draftVersion(detail) : shownVersion(detail);
      const connection =
        mode === "retry"
          ? waiting?.connection_id
          : detail.active_release?.connection_id;
      if (!source || !connection) throw new Error("nothing to save again");
      return unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: { path: { id: detail.agent.id } },
          body: {
            card: cardFromDraft(draftFromCard(source.card), source.card),
            connection_id: connection,
            // A retry saves what nobody has tried yet, so it is turned on
            // only by its own button; a discard puts back what runs now.
            ...(mode === "retry" ? { activate: false } : {}),
          },
        }),
      ) as Promise<SaveAgentResponse>;
    },
    onMutate: () => setOutcome(null),
    onSuccess: async ({ release, ...updated }, mode) => {
      retried.current = mode === "retry" && release.status === "saved";
      setOutcome(
        release.status === "failed"
          ? t("agent.save.failed", {
              reason: saveFailureText(t, release.reason),
            })
          : release.status === "superseded"
            ? t("agent.save.superseded")
            : release.status === "saved"
              ? t("agent.save.savedOnly", {
                  version:
                    updated.versions.find((v) => v.id === release.version_id)
                      ?.version_no ?? "",
                })
              : t("agent.draft.done"),
      );
      queryClient.setQueryData(
        queryKeysOf(client).agent(detail.agent.id),
        updated,
      );
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
    onError: (error) => setOutcome(agentRefusal(t, error, role)),
  });

  const values = (v: BehaviorValues) => [
    {
      label: t("agent.effective.connection"),
      value: (
        <Code size="inherit" className="[overflow-wrap:anywhere]">
          {v.connection_id}
        </Code>
      ),
    },
    {
      label: t("agentCard.model"),
      value: <Code size="inherit">{v.model}</Code>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Card role="region" className="min-w-0 px-4" aria-labelledby={titleId}>
        <Heading id={titleId}>{t("agent.effective.title")}</Heading>
        <Text as="span" variant="meta">
          {applied ? t("agent.effective.hint") : t("agent.effective.none")}
        </Text>
        {applied ? (
          <KeyValueList variant="grid" stack="sm" items={values(applied)} />
        ) : null}
      </Card>
      {waiting ? (
        <Alert
          variant={waiting.failure ? "red" : "amber"}
          data-status={saved ? "saved" : undefined}
        >
          <div className="flex min-w-0 flex-col gap-2">
            <Heading>
              {waiting.failure
                ? t("agent.draft.failedTitle")
                : saved
                  ? t("agent.draftPending.title")
                  : t("agent.draft.pendingTitle")}
            </Heading>
            <output>
              {waiting.failure
                ? t("agent.save.failed", {
                    reason: saveFailureText(t, waiting.failure),
                  })
                : saved
                  ? t("agent.draft.saved")
                  : t("agent.draft.pending")}
            </output>
            {draft ? (
              <KeyValueList variant="grid" stack="sm" items={values(draft)} />
            ) : null}
            {outcome ? <output>{outcome}</output> : null}
          </div>
          {manages ? (
            <AlertActions>
              {saved ? (
                <>
                  <Button
                    ref={previewButton}
                    type="button"
                    variant="outline"
                    onClick={() => setPreviewing(saved)}
                  >
                    {t("agents.flow.preview")}
                  </Button>
                  {toRelease}
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={resave.isPending}
                  onClick={() => resave.mutate("retry")}
                >
                  {t("agent.draft.retry")}
                </Button>
              )}
              {detail.active_release ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resave.isPending}
                  onClick={() => resave.mutate("discard")}
                >
                  {t("agent.draft.discard")}
                </Button>
              ) : null}
            </AlertActions>
          ) : null}
        </Alert>
      ) : outcome ? (
        <output>{outcome}</output>
      ) : null}
      <PreviewDialog
        release={previewing}
        agentName={detail.agent.name}
        onClose={() => setPreviewing(null)}
      />
    </div>
  );
}
