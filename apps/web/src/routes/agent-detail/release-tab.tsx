import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  ActivateAgentResponse,
  AgentDetail,
  AgentRelease,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
} from "@werft-ai/ui";
import { useState } from "react";
import { agentQuery, queryKeysOf } from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { useProfileDisplay } from "../../components/profile-options.tsx";
import { RevisionDiff } from "../../components/revision-diff.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { CredentialUnbound, unboundRefs } from "./credentials.tsx";
import { mcpSettingsQuery } from "./mcp-settings.ts";
import { type Placed, PlacedOutcome, TakesFocus } from "./placement.tsx";
import { Releases } from "./releases.tsx";
import { rolledBackText, trackingOf } from "./rollback-preview.ts";

/** What the screen showed when its activation lost the race. */
interface Conflict {
  readonly seenRevision: number;
  readonly seenActiveReleaseId: string | null;
}

/**
 * Activating a release. Its state outlives the release tab: the access tab
 * reads the credential names a refused activation found unbound.
 */
export function useReleaseActivation({
  detail,
  manages,
  onOutcome,
  openRelease,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly openRelease: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const profile = useProfileDisplay();
  const { agent } = detail;
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // The names the last refused activation found unbound.
  const [unbound, setUnbound] = useState<readonly string[] | null>(null);
  const settingsRefs =
    useQuery({ ...mcpSettingsQuery(client, agent.id), enabled: manages }).data
      ?.settings.credential_refs ?? [];
  const releaseLabel = (releaseId: string | null) => {
    const release = detail.releases.find((r) => r.id === releaseId);
    return release
      ? t("agent.releaseLabel", {
          release: release.label,
          profile: profile.show(release.runtime_profile_id),
        })
      : t("agent.noActive");
  };

  // A read in flight began before the rollback and would answer with the old
  // values, so it is dropped first. Null when the read fails.
  const readAfterRollback = async () => {
    const options = agentQuery(client, agent.id);
    await queryClient.cancelQueries({ queryKey: options.queryKey });
    return queryClient
      .fetchQuery({ ...options, staleTime: 0, retry: false })
      .catch(() => null);
  };

  const activate = useMutation<
    ActivateAgentResponse,
    ApiError,
    {
      release: AgentRelease;
      expected: number;
      seenActive: string | null;
      before: {
        tracking: NonNullable<AgentDetail["profile_tracking"]>;
        modelSource: AgentDetail["model_source"];
      };
    }
  >({
    mutationFn: ({ release, expected }) =>
      unwrap(
        client.POST("/v1/agents/{id}/activate", {
          params: { path: { id: agent.id } },
          body: { release_id: release.id, expected_revision: expected },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setUnbound(null);
    },
    onSuccess: async (result, { before }) => {
      setConflict(null);
      if (result.receipt_id === null) {
        onOutcome({ kind: "notice", text: t("agent.alreadyActive") });
      } else {
        const after = await readAfterRollback();
        onOutcome({
          kind: "notice",
          text: after
            ? rolledBackText(t, {
                release: releaseLabel(result.active_release_id),
                before,
                after,
              })
            : t("agent.rolledBack.unchecked", {
                release: releaseLabel(result.active_release_id),
              }),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).agents,
      });
    },
    onError: async (error, { release, expected, seenActive, before }) => {
      // The server may have committed before the answer was lost, so the
      // outcome is read, never assumed.
      if (error.code === "NETWORK_ERROR") {
        const after = await readAfterRollback();
        const done = after?.agent.active_release_id === release.id;
        onOutcome(
          after === null
            ? {
                kind: "error",
                text: t("agent.rollback.unknown", {
                  release: releaseLabel(release.id),
                }),
              }
            : done
              ? {
                  kind: "notice",
                  text: rolledBackText(t, {
                    release: releaseLabel(release.id),
                    before,
                    after,
                  }),
                }
              : after.agent.activation_revision === expected
                ? {
                    kind: "error",
                    text: `${agentRefusal(t, error, role, profile.show)} ${t("agent.rollback.kept")}`,
                  }
                : {
                    // The pointer moved but not to the target: this rollback
                    // may have applied and then been replaced.
                    kind: "error",
                    text: t("agent.rollback.movedMeanwhile", {
                      release: releaseLabel(release.id),
                    }),
                  },
        );
        await queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agents,
        });
        return;
      }
      // Someone else moved the pointer since this page loaded. Retrying with
      // a fresh revision would silently undo their choice, so stop and let
      // the person look at what changed first.
      if (error.code === "REVISION_CONFLICT") {
        setConflict({
          seenRevision: expected,
          seenActiveReleaseId: seenActive,
        });
        openRelease();
        return;
      }
      const missing = unboundRefs(error, detail, settingsRefs);
      if (missing) {
        setUnbound(missing);
        openRelease();
        return;
      }
      onOutcome({
        kind: "error",
        text: `${agentRefusal(t, error, role, profile.show)} ${t("agent.rollback.kept")}`,
      });
    },
  });

  return {
    unbound,
    conflict,
    releaseLabel,
    activating: activate.isPending ? activate.variables?.release.id : undefined,
    activate: (release: AgentRelease) =>
      activate.mutate({
        release,
        expected: agent.activation_revision,
        seenActive: agent.active_release_id,
        before: {
          tracking: trackingOf(detail),
          modelSource: detail.model_source,
        },
      }),
  };
}

export function ReleaseTab({
  detail,
  shown,
  placed,
  activation,
  onReload,
  onGoCredentials,
}: {
  readonly detail: AgentDetail;
  readonly shown: boolean;
  readonly placed: Placed | null;
  readonly activation: ReturnType<typeof useReleaseActivation>;
  readonly onReload: () => void;
  readonly onGoCredentials: () => void;
}) {
  const { t } = useI18n();
  const { agent } = detail;
  const { conflict, unbound, releaseLabel } = activation;
  const versionNo = (versionId: string) =>
    detail.versions.find((version) => version.id === versionId)?.version_no;
  const seenRelease = detail.releases.find(
    (release) => release.id === conflict?.seenActiveReleaseId,
  );
  const reloaded =
    conflict !== null && agent.activation_revision !== conflict.seenRevision;
  return (
    <Releases
      detail={detail}
      shown={shown}
      versionNo={versionNo}
      result={
        <>
          <PlacedOutcome placed={placed} at="releases" />
          <TakesFocus on={unbound}>
            {unbound ? (
              <CredentialUnbound missing={unbound} onGo={onGoCredentials} />
            ) : null}
          </TakesFocus>
          <TakesFocus on={conflict}>
            {conflict ? (
              <Alert asChild variant="red" data-status="conflict" role="alert">
                <section>
                  <AlertTitle asChild>
                    <h3 className="m-0">{t("agent.conflict.title")}</h3>
                  </AlertTitle>
                  <AlertDescription>
                    {reloaded
                      ? t("agent.conflict.reloaded", {
                          seen: releaseLabel(conflict.seenActiveReleaseId),
                          now: releaseLabel(agent.active_release_id),
                        })
                      : t("agent.conflict.body")}
                  </AlertDescription>
                  {reloaded ? (
                    <RevisionDiff
                      before={
                        detail.versions.find(
                          (v) => v.id === seenRelease?.version_id,
                        )?.card ?? null
                      }
                      after={
                        detail.active_release
                          ? (detail.versions.find(
                              (v) => v.id === detail.active_release?.version_id,
                            )?.card ?? null)
                          : null
                      }
                      beforeLabel={releaseLabel(conflict.seenActiveReleaseId)}
                      afterLabel={releaseLabel(agent.active_release_id)}
                    />
                  ) : (
                    <AlertActions>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={onReload}
                      >
                        {t("agent.conflict.reload")}
                      </Button>
                    </AlertActions>
                  )}
                </section>
              </Alert>
            ) : null}
          </TakesFocus>
        </>
      }
      activating={activation.activating}
      onActivate={activation.activate}
    />
  );
}
