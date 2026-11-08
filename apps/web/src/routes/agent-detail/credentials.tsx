import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  ActivationCredentialUnboundDetails,
  AgentDetail,
  CreateCredentialBindingResponse,
  CredentialBindingView,
  RevokeCredentialBindingResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
  Code,
  ConfirmDialog,
  cn,
  EmptyState,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, type RefObject, useState } from "react";
import { agentListsFilter, queryKeysOf } from "../../api/queries.ts";
import { permissionReason, useRole } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { StatusScreen } from "../../components/status-screen.tsx";
import { type Translate, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { mcpSettingsKey, mcpSettingsQuery } from "./mcp-settings.ts";

/** Under the agent's key, so whatever refreshes the agent refreshes these. */
const bindingsKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "credential-bindings"] as const;

export function credentialBindingsQuery(client: ApiClient, agentId: string) {
  return queryOptions({
    queryKey: bindingsKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/credential-bindings", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
}

/**
 * The credential names an agent may use (design 4.4, D11). There is no
 * free-text field on purpose: a lowercase token pasted as a "name" would pass
 * the name pattern and reach the cache and the screen. Only names the cards
 * or the server already hold can be bound.
 */
export function Credentials({
  detail,
  missing,
  titleRef,
  result,
  onOutcome,
}: {
  readonly detail: AgentDetail;
  /** Names a refused activation reported as unbound. */
  readonly missing: readonly string[];
  /** Focused when another section sends the person here. */
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const manages = useManagesAgent();
  const agentId = detail.agent.id;
  // The list's summaries say which names are bound.
  const invalidateBindings = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: bindingsKey(client, agentId) }),
      // The settings answer says which of their names are bound.
      queryClient.invalidateQueries({
        queryKey: mcpSettingsKey(client, agentId),
      }),
      queryClient.invalidateQueries(agentListsFilter(client)),
    ]);
  const [revoking, setRevoking] = useState<CredentialBindingView | null>(null);

  const bindings = useQuery(credentialBindingsQuery(client, agentId));
  // The settings are what name a credential; a manager who cannot read them
  // sees only the bindings.
  const settings = useQuery(mcpSettingsQuery(client, agentId));
  const named = settings.data?.settings.credential_refs ?? [];

  const refused = (error: ApiError) =>
    error.code === "CREDENTIAL_REF_IN_USE"
      ? t("agent.credentials.inUse")
      : agentRefusal(t, error, role);

  const bind = useMutation<CreateCredentialBindingResponse, ApiError, string>({
    mutationFn: (ref) =>
      unwrap(
        client.POST("/v1/agents/{id}/credential-bindings", {
          params: { path: { id: agentId } },
          body: { credential_ref: ref },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (answer) => {
      onOutcome({
        kind: "notice",
        text: t(
          answer.created
            ? "agent.credentials.bound"
            : "agent.credentials.alreadyBound",
          { name: answer.binding.credential_ref },
        ),
      });
      await invalidateBindings();
    },
    onError: (error) => onOutcome({ kind: "error", text: refused(error) }),
  });

  const revoke = useMutation<
    RevokeCredentialBindingResponse,
    ApiError,
    CredentialBindingView
  >({
    mutationFn: (binding) =>
      unwrap(
        client.DELETE("/v1/agents/{id}/credential-bindings/{binding_id}", {
          params: { path: { id: agentId, binding_id: binding.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    // The dialog closes first and the result comes after the refetch: the
    // row whose button opened the dialog is gone by then, and a result
    // focused while the dialog still held focus would be lost.
    onSuccess: async (answer) => {
      setRevoking(null);
      await invalidateBindings();
      onOutcome({
        kind: "notice",
        text: t("agent.credentials.revoked", {
          name: answer.binding.credential_ref,
        }),
      });
    },
    onError: (error) => {
      setRevoking(null);
      onOutcome({ kind: "error", text: refused(error) });
    },
  });

  const active = (bindings.data?.items ?? []).filter(
    (binding) => binding.revoked_at === null,
  );
  const bound = new Set(active.map((binding) => binding.credential_ref));
  const unbound = [...new Set([...missing, ...named])].filter(
    (ref) => !bound.has(ref),
  );
  const busy = bind.isPending || revoke.isPending;

  return (
    <Section
      title={t("agent.credentials.title")}
      titleProps={{ ref: titleRef, tabIndex: -1 }}
      description={t("agent.credentials.intro")}
    >
      <div className={SECTION_BODY}>
        {bindings.isPending ? (
          <StatusScreen kind="loading" />
        ) : bindings.error ? (
          isApiError(bindings.error, "FORBIDDEN") ? (
            <Text variant="sub">
              {permissionReason(t, "agent.manage", role)}
            </Text>
          ) : (
            <LoadFailure
              error={bindings.error}
              onRetry={() => void bindings.refetch()}
            />
          )
        ) : (
          <>
            {unbound.length > 0 ? (
              <RowList aria-label={t("agent.credentials.unboundList")}>
                {unbound.map((ref) => (
                  <RowListItem
                    key={ref}
                    className={cn(
                      missing.includes(ref) &&
                        "border-[var(--werft-tone-attention-border)]",
                    )}
                    data-missing={missing.includes(ref)}
                  >
                    <RowLines>
                      <Text
                        as="span"
                        weight="medium"
                        className="block break-words"
                      >
                        <Code size="inherit">{ref}</Code>
                      </Text>
                      <Text
                        as="span"
                        variant="meta"
                        className="block [overflow-wrap:anywhere]"
                      >
                        {missing.includes(ref)
                          ? t("agent.credentials.neededToActivate")
                          : t("agent.credentials.namedByCard")}
                      </Text>
                    </RowLines>
                    {manages ? (
                      <RowAction
                        disabled={busy}
                        aria-label={t("agent.credentials.bindFor", {
                          name: ref,
                        })}
                        onClick={() => bind.mutate(ref)}
                      >
                        {t("agent.credentials.bind")}
                      </RowAction>
                    ) : null}
                  </RowListItem>
                ))}
              </RowList>
            ) : null}
            {active.length === 0 ? (
              <EmptyState
                title={t(
                  unbound.length === 0
                    ? "agent.credentials.noneNamed"
                    : "agent.credentials.empty",
                )}
              />
            ) : (
              <RowList aria-label={t("agent.credentials.boundList")}>
                {active.map((binding) => (
                  <RowListItem key={binding.id}>
                    <RowLines>
                      <Text
                        as="span"
                        weight="medium"
                        className="block break-words"
                      >
                        <Code size="inherit">{binding.credential_ref}</Code>
                      </Text>
                      <Text
                        as="span"
                        variant="meta"
                        className="block [overflow-wrap:anywhere]"
                      >
                        {t("agent.credentials.running", {
                          count: binding.running_sessions,
                        })}
                      </Text>
                    </RowLines>
                    {manages ? (
                      <RowAction
                        variant="danger"
                        disabled={busy}
                        aria-label={t("agent.credentials.revokeFor", {
                          name: binding.credential_ref,
                        })}
                        onClick={() => setRevoking(binding)}
                      >
                        {t("agent.credentials.revoke")}
                      </RowAction>
                    ) : null}
                  </RowListItem>
                ))}
              </RowList>
            )}
          </>
        )}
        {result}
        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(open) => {
            if (!open) setRevoking(null);
          }}
          title={t("agent.credentials.revokeTitle", {
            name: revoking?.credential_ref ?? "",
          })}
          consequence={revokeConsequence(t, revoking)}
          confirmLabel={t("agent.credentials.revoke")}
          cancelLabel={t("common.cancel")}
          tone="danger"
          busy={revoke.isPending}
          onConfirm={() => {
            if (revoking) revoke.mutate(revoking);
          }}
        />
      </div>
    </Section>
  );
}

/**
 * The names a 409 CREDENTIAL_UNBOUND from activation reports, or null for any
 * other error. Only names this agent already holds are kept, those its
 * settings list and those one of its cards still carries: the server checked
 * them against the name pattern when they were saved, and anything else in a
 * malformed answer never reaches the screen or a bind.
 */
export function unboundRefs(
  error: ApiError,
  detail: AgentDetail,
  settingsRefs: readonly string[] = [],
): readonly string[] | null {
  if (error.code !== "CREDENTIAL_UNBOUND") return null;
  const details = error.details as Partial<ActivationCredentialUnboundDetails>;
  if (details?.reason_code !== "credential_unbound") return [];
  const missing: unknown = details.missing;
  if (!Array.isArray(missing)) return [];
  const named = new Set([
    ...settingsRefs,
    ...detail.versions.flatMap(
      (version) => version.card.capabilities.credential_refs ?? [],
    ),
  ]);
  return missing.filter((ref) => named.has(ref));
}

/** Why activation stopped, with the way to the step that fixes it. */
export function CredentialUnbound({
  missing,
  onGo,
}: {
  readonly missing: readonly string[];
  readonly onGo: () => void;
}) {
  const { t } = useI18n();
  return (
    <Alert asChild variant="red" data-status="conflict" role="alert">
      <section>
        <AlertTitle asChild>
          <h3 className="m-0">{t("agent.unbound.title")}</h3>
        </AlertTitle>
        <AlertDescription>
          {missing.length > 0
            ? t("agent.unbound.body", { names: missing.join(", ") })
            : t("agent.unbound.bodyUnnamed")}
        </AlertDescription>
        <AlertActions>
          <Button type="button" variant="outline" onClick={onGo}>
            {t("agent.unbound.go")}
          </Button>
        </AlertActions>
      </section>
    </Alert>
  );
}

function revokeConsequence(
  t: Translate,
  binding: CredentialBindingView | null,
): string {
  const next = t("agent.credentials.revokeConsequence");
  return binding !== null && binding.running_sessions > 0
    ? `${next} ${t("agent.credentials.revokeRunning", { count: binding.running_sessions })}`
    : next;
}
