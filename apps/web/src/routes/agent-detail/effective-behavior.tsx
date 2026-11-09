import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  BehaviorValues,
  SaveAgentResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  Badge,
  Button,
  Card,
  Code,
  Heading,
  KeyValueList,
  Text,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import {
  agentListsFilter,
  profilesQuery,
  queryKeysOf,
} from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import {
  cardFromDraft,
  draftFromCard,
} from "../../components/agent-card-form.tsx";
import { profileDisplay } from "../../components/profile-options.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { draftVersion, shownVersion } from "./versions.tsx";

type Translate = ReturnType<typeof useI18n>["t"];

/** Why a save was kept but not applied, in words; a code this page lacks shows as sent. */
export function saveFailureText(t: Translate, reason: string | null): string {
  switch (reason) {
    case "model_not_in_profile":
      return t("agent.save.reason.model_not_in_profile");
    case "tool_not_in_profile":
      return t("agent.save.reason.tool_not_in_profile");
    case "credential_unbound":
      return t("agent.save.reason.credential_unbound");
    case "release_refused":
      return t("agent.save.reason.release_refused");
    case "profile_unknown":
      return t("agent.save.reason.profile_unknown");
    case "retries_exhausted":
      return t("agent.save.reason.retries_exhausted");
    case "blocked":
    case "base_blocked":
      return t("agent.save.reason.blocked");
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
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const titleId = useId();
  const [outcome, setOutcome] = useState<string | null>(null);
  const { applied, draft } = detail.effective_behavior;
  const waiting = detail.draft;
  const none = t("agent.panel.none");

  const profiles = useQuery(profilesQuery(client));
  // Discarding saves what runs again. A followed profile whose default has
  // moved on no longer gives the running model, so that save would change
  // it: the running model is kept as a chosen one.
  const runningModel = detail.active_release
    ? shownVersion(detail)?.card.model
    : undefined;
  const followsRunning =
    detail.model_source === "profile" &&
    profiles.data?.items.find(
      (p) => p.id === detail.active_release?.runtime_profile_id,
    )?.model === runningModel;

  // Whether the profile still gives the running model is unknown until its
  // list has loaded; discarding before then could drop the follow.
  const knowsDefault = detail.model_source !== "profile" || profiles.isSuccess;

  const resave = useMutation<SaveAgentResponse, ApiError, "retry" | "discard">({
    mutationFn: (mode) => {
      const source =
        mode === "retry" ? draftVersion(detail) : shownVersion(detail);
      const profile =
        mode === "retry"
          ? waiting?.runtime_profile_id
          : detail.active_release?.runtime_profile_id;
      if (!source || !profile) throw new Error("nothing to save again");
      return unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: { path: { id: detail.agent.id } },
          body: {
            card: cardFromDraft(draftFromCard(source.card), source.card),
            runtime_profile_id: profile,
            model_source:
              mode === "retry"
                ? (waiting?.model_source ?? detail.model_source)
                : followsRunning
                  ? "profile"
                  : "fixed",
          },
        }),
      ) as Promise<SaveAgentResponse>;
    },
    onMutate: () => setOutcome(null),
    onSuccess: async ({ release, ...updated }) => {
      setOutcome(
        release.status === "failed"
          ? t("agent.save.failed", {
              reason: saveFailureText(t, release.reason),
            })
          : release.status === "superseded"
            ? t("agent.save.superseded")
            : t("agent.draft.done"),
      );
      queryClient.setQueryData(
        queryKeysOf(client).agent(detail.agent.id),
        updated,
      );
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
    onError: (error) =>
      setOutcome(
        agentRefusal(t, error, role, (id) =>
          profileDisplay(t, profiles.data?.items, id),
        ),
      ),
  });

  const values = (v: BehaviorValues) => [
    {
      label: t("agent.effective.profile"),
      // The id is the tooltip, and the text until the list names it: a slow
      // or refused list never hides the value.
      value: (
        <span className="[overflow-wrap:anywhere]" title={v.runtime_profile_id}>
          {profileDisplay(t, profiles.data?.items, v.runtime_profile_id)}
        </span>
      ),
    },
    {
      label: t("agentCard.model"),
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Code size="inherit">{v.model}</Code>
          <Badge variant="gray" className="font-normal">
            {v.model_source === "profile"
              ? t("agent.effective.followsProfile")
              : t("agent.effective.chosen")}
          </Badge>
        </span>
      ),
    },
    {
      label: t("agent.effective.titleModel"),
      value: v.title_model ? <Code size="inherit">{v.title_model}</Code> : none,
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
        <Alert variant={waiting.failure ? "red" : "amber"}>
          <div className="flex min-w-0 flex-col gap-2">
            <Heading>
              {waiting.failure
                ? t("agent.draft.failedTitle")
                : t("agent.draft.pendingTitle")}
            </Heading>
            <output>
              {waiting.failure
                ? t("agent.save.failed", {
                    reason: saveFailureText(t, waiting.failure),
                  })
                : t("agent.draft.pending")}
            </output>
            {draft ? (
              <KeyValueList variant="grid" stack="sm" items={values(draft)} />
            ) : null}
            {outcome ? <output>{outcome}</output> : null}
          </div>
          {manages ? (
            <AlertActions>
              <Button
                type="button"
                variant="outline"
                disabled={resave.isPending}
                onClick={() => resave.mutate("retry")}
              >
                {t("agent.draft.retry")}
              </Button>
              {detail.active_release ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={resave.isPending || !knowsDefault}
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
    </div>
  );
}
