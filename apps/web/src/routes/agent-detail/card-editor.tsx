import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentVersion,
  SaveAgentResponse,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Section,
  Textarea,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  agentListsFilter,
  connectionsQuery,
  queryKeysOf,
} from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "../../auth/limits.ts";
import {
  AGENT_FORM,
  AgentCardFields,
  type CardDraft,
  cardFromDraft,
  draftFromCard,
} from "../../components/agent-card-form.tsx";
import { releaseOf } from "../../components/agent-preview.tsx";
import { agentRefusal } from "../../components/agent-refusal.ts";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { saveFailureText } from "./effective-behavior.tsx";
import { releasedConnection } from "./releases.tsx";
import { draftVersion, latestVersion, shownVersion } from "./versions.tsx";

export function CardEditor({
  detail,
  result,
  onOutcome,
  onPreview,
  onClose,
  connectionId,
  onConnectionChange,
}: {
  readonly detail: AgentDetail;
  readonly connectionId: string | undefined;
  readonly onConnectionChange: (connectionId: string) => void;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  /** Opens a preview of the release a save-only save made. */
  readonly onPreview: (release: AgentRelease) => void;
  /**
   * Back to the read-only card: on cancel, or after a save nothing was typed
   * after. Only a cancel hands the keyboard back; a save's result takes it.
   */
  readonly onClose: (cancelled: boolean) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const latest = openVersion(detail);
  // The edit is tied to the version it started from, not to whatever a
  // background refetch last brought in, so unsaved input is never replaced.
  const [edit, setEdit] = useState(() => startEdit(detail));
  const base = detail.versions.find((v) => v.id === edit.baseId);
  const cardChanged = (e: Edit) =>
    e.draft !== null &&
    JSON.stringify(e.draft) !==
      JSON.stringify(base ? draftFromCard(base.card) : null);
  const dirty =
    edit.name !== edit.baseName ||
    edit.description !== edit.baseDescription ||
    cardChanged(edit);
  const stale = (latest?.id ?? null) !== edit.seenLatestId;
  if (
    (stale ||
      detail.agent.name !== edit.baseName ||
      descriptionOf(detail) !== edit.baseDescription) &&
    !dirty
  )
    setEdit(startEdit(detail));
  const setName = (name: string) => setEdit((e) => ({ ...e, name }));
  const setDescription = (description: string) =>
    setEdit((e) => ({ ...e, description }));
  const setDraft = (draft: CardDraft) => setEdit((e) => ({ ...e, draft }));
  const { name, description, draft } = edit;
  const catalog = useQuery(connectionsQuery(client));
  const latestEdit = useRef(edit);
  latestEdit.current = edit;
  const title = useRef<HTMLHeadingElement>(null);
  // The editor replaces the button that opened it.
  useEffect(() => title.current?.focus(), []);

  // The connection the save releases on: the one picked here, else the one
  // the agent runs. None: the card is kept and nothing is released.
  // An edit opened on a refused or waiting save starts from that save's
  // connection too, so fixing its card does not release it elsewhere.
  const startConnection =
    detail.draft?.connection_id ?? releasedConnection(detail);
  const releaseConnection = connectionId ?? startConnection;
  const unpublished = detail.agent.active_release_id === null;
  const save = useMutation<SaveAgentResponse, ApiError, Submitted>({
    mutationFn: ({
      baseName,
      baseDescription,
      name,
      description,
      draft,
      sendsCard,
      saveOnly,
      connection,
    }) => {
      const sentCard = draft ? cardFromDraft(draft, base?.card) : undefined;
      return unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: {
            path: { id: detail.agent.id },
          },
          body: {
            // Only what the user changed: sending the value the edit started
            // from would undo a change made elsewhere since.
            ...(name.trim() !== baseName ? { name: name.trim() } : {}),
            ...(description.trim() !== baseDescription
              ? { description: description.trim() }
              : {}),
            // Name and description alone change the row, not the version.
            ...(sendsCard && sentCard
              ? {
                  card: sentCard,
                  ...(connection ? { connection_id: connection } : {}),
                  // An unpublished agent is published only by its own
                  // button, never by a settings save.
                  ...(saveOnly || unpublished ? { activate: false } : {}),
                }
              : {}),
          },
        }),
      ) as Promise<SaveAgentResponse>;
    },
    onMutate: () => onOutcome(null),
    onSuccess: async (updated, submitted) => {
      // The server keeps one version per card content, so the card just saved
      // may be an older version rather than the highest one.
      const { release } = updated;
      // The response names the version the save kept.
      const versionOf = (id: string | null | undefined) =>
        updated.versions.find((v) => v.id === id);
      const saved = submitted.sendsCard
        ? release.version_id === null
          ? savedVersion(detail, updated, submitted)
          : versionOf(release.version_id)
        : undefined;
      const isNew =
        saved !== undefined && !detail.versions.some((v) => v.id === saved.id);
      onOutcome(
        release.status === "failed"
          ? {
              kind: "error",
              text: saved
                ? t("agent.save.failedVersion", {
                    version: saved.version_no,
                    reason: saveFailureText(t, release.reason),
                  })
                : t("agent.save.failed", {
                    reason: saveFailureText(t, release.reason),
                  }),
            }
          : {
              kind: "notice",
              text: !submitted.sendsCard
                ? t("agent.identitySaved")
                : release.status === "applied"
                  ? t("agent.save.applied", {
                      version: saved?.version_no ?? "",
                    })
                  : release.status === "saved"
                    ? t("agent.save.savedOnly", {
                        version: saved?.version_no ?? "",
                      })
                    : release.status === "superseded"
                      ? t("agent.save.superseded")
                      : isNew
                        ? t("agent.saved", { version: saved.version_no })
                        : saved && saved.id !== submitted.baseId
                          ? t("agent.savedExisting", {
                              version: saved.version_no,
                            })
                          : t("agent.savedNoChange"),
            },
      );
      if (sameEdit(latestEdit.current, submitted)) onClose(false);
      // Input typed while the request was in flight stays; it is now an edit
      // of the version just saved, or of the one it started from when only
      // the row changed.
      const now =
        saved ?? updated.versions.find((v) => v.id === submitted.baseId);
      setEdit((current) =>
        sameEdit(current, submitted)
          ? startEdit(updated, now)
          : {
              ...current,
              baseId: now?.id ?? null,
              seenLatestId: openVersion(updated)?.id ?? null,
              // A field not typed in since the submit follows the server, so
              // a change made elsewhere is not sent back as the user's on the
              // next save; one typed in since keeps the input.
              baseName: updated.agent.name,
              name:
                current.name === submitted.name
                  ? updated.agent.name
                  : current.name,
              baseDescription: descriptionOf(updated),
              description:
                current.description === submitted.description
                  ? descriptionOf(updated)
                  : current.description,
            },
      );
      const { release: _release, ...stored } = updated;
      queryClient.setQueryData(
        queryKeysOf(client).agent(detail.agent.id),
        stored,
      );
      // A superseded save lost to a newer one: its release is not the draft.
      if (
        submitted.saveOnly &&
        (release.status === "saved" || release.status === "unchanged")
      ) {
        // A save that changed nothing made no release: the one already made
        // for what it saved is tried, the active one included. With no
        // connection sent the agent's own stays.
        const connection =
          submitted.connection ??
          stored.draft?.connection_id ??
          stored.active_release?.connection_id;
        const tried =
          stored.releases.find((r) => r.id === release.release_id) ??
          (connection
            ? releaseOf(stored, release.version_id, connection)
            : undefined);
        if (tried) onPreview(tried);
      }
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: agentRefusal(t, error, role),
      }),
  });

  // A save with nothing changed still sends the card, which the server
  // answers with the same version, as a request needs some field.
  const connectionChanged =
    connectionId !== undefined && connectionId !== startConnection;
  const sendsCard =
    cardChanged(edit) ||
    connectionChanged ||
    (edit.name.trim() === edit.baseName &&
      edit.description.trim() === edit.baseDescription);
  // Both save buttons submit the form, so its checks hold for either.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saveOnly =
      (event.nativeEvent as SubmitEvent).submitter?.dataset.saveOnly === "true";
    if (saveOnly ? saveOnlyDisabled : disabled) return;
    save.mutate({
      ...edit,
      sendsCard: sendsCard || saveOnly,
      saveOnly,
      connection: releaseConnection,
    });
  };
  const disabled =
    save.isPending ||
    // A save of the name or description alone sends no card,
    // so the run settings' checks do not hold it back.
    (draft !== null && sendsCard && !catalog.isSuccess);
  // It always sends the card, so the checks always hold it.
  const saveOnlyDisabled = save.isPending || !catalog.isSuccess;

  return (
    <Section
      title={t("agent.card.title")}
      titleProps={{ ref: title, tabIndex: -1, className: "outline-none" }}
      description={t("agent.card.intro")}
    >
      <div className={SECTION_BODY}>
        {stale && latest ? (
          <Alert variant="amber">
            <output>
              {t("agent.card.stale", { version: latest.version_no })}
            </output>
            <AlertActions>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEdit(startEdit(detail))}
              >
                {t("agent.card.takeLatest")}
              </Button>
            </AlertActions>
          </Alert>
        ) : null}
        <form className={AGENT_FORM} onSubmit={submit}>
          <FieldSet className="gap-4">
            <FieldLegend>{t("agent.card.identity")}</FieldLegend>
            <FieldDescription>{t("agent.card.identityHint")}</FieldDescription>
            <Field>
              <FieldLabel>{t("agents.name")}</FieldLabel>
              <Input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{t("agents.description")}</FieldLabel>
              <Textarea
                maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </FieldSet>
          {draft ? (
            <FieldSet className="gap-4">
              <FieldLegend>{t("agent.card.run")}</FieldLegend>
              <FieldDescription>{t("agent.card.runHint")}</FieldDescription>
              <AgentCardFields
                draft={draft}
                catalog={catalog}
                connectionId={releaseConnection ?? ""}
                onConnectionChange={onConnectionChange}
                onChange={setDraft}
              />
            </FieldSet>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={disabled}>
              {save.isPending ? t("agent.card.saving") : t("agent.card.save")}
            </Button>
            {draft !== null ? (
              <Button
                type="submit"
                variant="outline"
                data-save-only="true"
                disabled={saveOnlyDisabled}
              >
                {t("agent.card.saveOnly")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                onOutcome(null);
                onClose(true);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
        {result}
      </div>
    </Section>
  );
}

interface Edit {
  readonly baseId: string | null;
  /** The newest version when the edit started; a newer one means another save. */
  readonly seenLatestId: string | null;
  readonly baseName: string;
  readonly baseDescription: string;
  readonly name: string;
  readonly description: string;
  readonly draft: CardDraft | null;
}

interface Submitted extends Edit {
  /** Whether the card differs from its base; else only the row is saved. */
  readonly sendsCard: boolean;
  /** Saves without turning the release on, then previews it. */
  readonly saveOnly: boolean;
  /** The connection picked when it was sent; none keeps the agent's. */
  readonly connection: string | undefined;
}

const sameEdit = (a: Edit, b: Edit) =>
  a.name === b.name &&
  a.description === b.description &&
  JSON.stringify(a.draft) === JSON.stringify(b.draft);

const descriptionOf = (detail: AgentDetail) => detail.agent.description ?? "";
/**
 * The version an edit starts from: a save waiting for its release (or refused),
 * else the one new sessions run. Not the highest number, which a refused save
 * leaves ahead of what runs.
 */
const openVersion = (detail: AgentDetail) =>
  draftVersion(detail) ?? shownVersion(detail);

function startEdit(detail: AgentDetail, from?: AgentVersion): Edit {
  const open = openVersion(detail);
  const base = from ?? open;
  return {
    baseId: base?.id ?? null,
    seenLatestId: open?.id ?? null,
    baseName: detail.agent.name,
    baseDescription: descriptionOf(detail),
    name: detail.agent.name,
    description: descriptionOf(detail),
    draft: base ? draftFromCard(base.card) : null,
  };
}

function savedVersion(
  before: AgentDetail,
  after: AgentDetail,
  submitted: Edit,
): AgentVersion | undefined {
  const baseCard = before.versions.find((v) => v.id === submitted.baseId)?.card;
  // Both sides go through the same normalisation the request did, rules
  // included, so a card that only differs in what the server trims matches.
  const normal = (draft: CardDraft, card?: AgentCard) =>
    JSON.stringify(cardFromDraft(draft, card));
  const sent = submitted.draft ? normal(submitted.draft, baseCard) : null;
  const matching = after.versions.filter(
    (version) => normal(draftFromCard(version.card), version.card) === sent,
  );
  return (
    latestVersion({ ...after, versions: matching }) ?? latestVersion(after)
  );
}
