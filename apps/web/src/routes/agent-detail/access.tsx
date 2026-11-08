import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { PutAgentMcpSettingsResponse } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  Field,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  RowAction,
  RowLines,
  RowList,
  RowListItem,
  Section,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { agentListsFilter } from "../../api/queries.ts";
import { permissionReason, useRole } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { StatusScreen } from "../../components/status-screen.tsx";
import { type MessageKey, useI18n } from "../../i18n/i18n.tsx";
import { credentialBindingsQuery } from "./credentials.tsx";
import { githubKey } from "./github-activity.ts";
import {
  type Added,
  addRef,
  addTool,
  editOf,
  type McpEdit,
  mcpSettingsKey,
  mcpSettingsQuery,
  refusalKey,
  sameEdit,
  saveBody,
  withServer,
} from "./mcp-settings.ts";

/** A draft remembers the revision it started from, to tell a later save. */
interface Draft {
  readonly edit: McpEdit;
  readonly revision: number | null;
}

/**
 * The agent's MCP server, the tools it may call and the credential names it
 * needs (design Z5 §8). They are saved apart from the card: no release is made
 * and nothing here holds a credential value, only names.
 */
export function McpSettings({
  agentId,
  result,
  onOutcome,
}: {
  readonly agentId: string;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const role = useRole();
  const manages = useManagesAgent();
  const settings = useQuery(mcpSettingsQuery(client, agentId));
  const [draft, setDraft] = useState<Draft | null>(null);
  const failure = useRef<HTMLDivElement>(null);

  const save = useMutation<PutAgentMcpSettingsResponse, ApiError, Draft | null>(
    {
      mutationFn: (current) => {
        const data = settings.data;
        if (!data) throw new Error("unsavable");
        return unwrap(
          client.PUT("/v1/agents/{id}/mcp/settings", {
            params: { path: { id: agentId } },
            body: saveBody(
              current?.edit ?? editOf(data),
              current?.revision ?? data.settings_revision,
            ),
          }),
        );
      },
      onMutate: () => onOutcome(null),
      onSuccess: async (answer) => {
        setDraft(null);
        onOutcome({
          kind: "notice",
          text: t(
            answer.receipt_id === null
              ? "agentAccess.savedUnchanged"
              : "agentAccess.saved",
          ),
        });
        // The save made no release, so only what it changed is read again:
        // the settings, the access-change list, the bound badges, the rows.
        await Promise.all([
          cache.invalidateQueries({
            queryKey: mcpSettingsKey(client, agentId),
          }),
          cache.invalidateQueries({ queryKey: githubKey(client, agentId) }),
          cache.invalidateQueries({
            queryKey: credentialBindingsQuery(client, agentId).queryKey,
          }),
          cache.invalidateQueries(agentListsFilter(client)),
        ]);
      },
      onError: async () => {
        failure.current?.focus();
        await cache.invalidateQueries({
          queryKey: mcpSettingsKey(client, agentId),
        });
      },
    },
  );

  if (settings.isPending) {
    return (
      <Section title={t("agentAccess.mcp.title")}>
        <div className={SECTION_BODY}>
          <StatusScreen kind="loading" />
        </div>
      </Section>
    );
  }
  if (settings.error) {
    return (
      <Section title={t("agentAccess.mcp.title")}>
        <div className={SECTION_BODY}>
          {isApiError(settings.error, "FORBIDDEN") ? (
            <Text variant="sub">
              {permissionReason(t, "agent.manage", role)}
            </Text>
          ) : (
            <LoadFailure
              error={settings.error}
              onRetry={() => void settings.refetch()}
            />
          )}
        </div>
      </Section>
    );
  }

  const data = settings.data;
  const base = editOf(data);
  const edit = draft?.edit ?? base;
  const changed = !sameEdit(edit, base);
  // Another save landed after the draft was made.
  const stale = draft !== null && draft.revision !== data.settings_revision;
  const firstSave = manages && data.source === "release";
  const busy = save.isPending;
  const readOnly = !manages || busy;

  const change = (next: McpEdit) => {
    if (readOnly) return;
    if (sameEdit(next, base) && draft?.revision === data.settings_revision) {
      setDraft(null);
      return;
    }
    setDraft({
      edit: next,
      revision: draft?.revision ?? data.settings_revision,
    });
  };

  const message = stale
    ? t("agentAccess.stale")
    : save.error
      ? save.error.code === "REVISION_CONFLICT"
        ? t("agentAccess.conflict")
        : t("agentAccess.saveRefused", { reason: t(refusalKey(save.error)) })
      : null;
  const listed = data.available_servers ?? [];
  const servers =
    edit.server && !listed.includes(edit.server)
      ? [...listed, edit.server]
      : listed;
  const bound = new Set(data.bound_credential_refs);

  return (
    <Section
      title={t("agentAccess.mcp.title")}
      description={t("agentAccess.intro")}
    >
      <div className={SECTION_BODY}>
        {result}
        {data.source === "release" ? (
          <Alert>
            <AlertDescription>
              {t(
                data.active_release_id === null
                  ? "agentAccess.noRelease"
                  : "agentAccess.fromRelease",
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {manages ? null : (
          <Text variant="sub">{t("agentAccess.readOnly")}</Text>
        )}

        <Field>
          <FieldLabel>{t("agentAccess.server")}</FieldLabel>
          <NativeSelect
            value={edit.server ?? ""}
            disabled={readOnly}
            onChange={(event) =>
              change(withServer(edit, event.target.value || null))
            }
          >
            <NativeSelectOption value="">
              {t("agentAccess.serverNone")}
            </NativeSelectOption>
            {servers.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {listed.includes(id)
                  ? id
                  : t("agentAccess.serverGone", { server: id })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {edit.server !== base.server && base.tools.length > 0 ? (
            <Text as="span" variant="meta">
              {t("agentAccess.serverChangeClears")}
            </Text>
          ) : null}
        </Field>

        <NameList
          label={t("agentAccess.tools")}
          hint={t("agentAccess.toolsHint")}
          listLabel={t("agentAccess.toolsList")}
          empty={t("agentAccess.toolsEmpty")}
          names={edit.tools}
          removeLabel={(name) => t("agentAccess.toolRemove", { name })}
          onRemove={(name) =>
            change({ ...edit, tools: edit.tools.filter((n) => n !== name) })
          }
          add={
            manages && edit.server !== null
              ? {
                  inputLabel: t("agentAccess.toolInput"),
                  placeholder: t("agentAccess.toolPlaceholder"),
                  button: t("agentAccess.toolAdd"),
                  disabled: readOnly,
                  tryAdd: (raw) => {
                    const added = addTool(edit, raw);
                    if ("edit" in added) change(added.edit);
                    return added;
                  },
                }
              : null
          }
        />

        <NameList
          label={t("agentAccess.creds")}
          hint={t("agentAccess.credsHint")}
          listLabel={t("agentAccess.credsList")}
          empty={t("agentAccess.credsEmpty")}
          names={edit.refs}
          removeLabel={(name) => t("agentAccess.credRemove", { name })}
          onRemove={(name) =>
            change({ ...edit, refs: edit.refs.filter((n) => n !== name) })
          }
          badge={(name) => (
            <Badge variant={bound.has(name) ? "green" : "gray"}>
              {t(bound.has(name) ? "agentAccess.bound" : "agentAccess.unbound")}
            </Badge>
          )}
          add={
            manages
              ? {
                  inputLabel: t("agentAccess.credInput"),
                  placeholder: t("agentAccess.credPlaceholder"),
                  button: t("agentAccess.credAdd"),
                  disabled: readOnly,
                  tryAdd: (raw) => {
                    const added = addRef(edit, raw);
                    if ("edit" in added) change(added.edit);
                    return added;
                  },
                }
              : null
          }
        />

        {manages && (changed || firstSave || message) ? (
          <Alert
            variant={message ? "red" : "blue"}
            role="region"
            aria-label={t(
              firstSave && !changed
                ? "agentAccess.pending.firstTitle"
                : "agentAccess.pending.title",
            )}
          >
            <AlertTitle>
              {t(
                firstSave && !changed
                  ? "agentAccess.pending.firstTitle"
                  : "agentAccess.pending.title",
              )}
            </AlertTitle>
            <AlertDescription>
              {t("agentAccess.pending.body")}
              {message ? (
                <div ref={failure} tabIndex={-1} className="mt-2 outline-none">
                  <FieldError>{message}</FieldError>
                </div>
              ) : null}
            </AlertDescription>
            <AlertActions>
              <Button
                type="button"
                size="sm"
                disabled={(!changed && !firstSave) || stale || busy}
                onClick={() => save.mutate(draft)}
              >
                {t(
                  busy
                    ? "agentAccess.pending.saving"
                    : "agentAccess.pending.save",
                )}
              </Button>
              {draft !== null || message ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    save.reset();
                  }}
                >
                  {t(
                    stale || save.error?.code === "REVISION_CONFLICT"
                      ? "agentAccess.pending.reload"
                      : "agentAccess.pending.revert",
                  )}
                </Button>
              ) : null}
            </AlertActions>
          </Alert>
        ) : null}
      </div>
    </Section>
  );
}

interface Adder {
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly button: string;
  readonly disabled: boolean;
  readonly tryAdd: (raw: string) => Added;
}

/** A field's names, one per row, with the way to add and remove them. */
function NameList({
  label,
  hint,
  listLabel,
  empty,
  names,
  removeLabel,
  onRemove,
  badge,
  add,
}: {
  readonly label: string;
  readonly hint: string;
  readonly listLabel: string;
  readonly empty: string;
  readonly names: readonly string[];
  readonly removeLabel: (name: string) => string;
  readonly onRemove: (name: string) => void;
  readonly badge?: (name: string) => ReactNode;
  readonly add: Adder | null;
}) {
  const { t } = useI18n();
  const sortedNames = [...names].sort();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Text as="span" weight="medium">
          {label}
        </Text>
        <Text as="span" variant="meta">
          {hint}
        </Text>
      </div>
      {sortedNames.length === 0 ? (
        <Text variant="sub">{empty}</Text>
      ) : (
        <RowList aria-label={listLabel}>
          {sortedNames.map((name) => (
            <RowListItem key={name}>
              <RowLines>
                <Text as="span" weight="medium" className="block break-words">
                  <Code size="inherit">{name}</Code>
                </Text>
              </RowLines>
              {badge ? badge(name) : null}
              {add ? (
                <RowAction
                  variant="danger"
                  disabled={add.disabled}
                  aria-label={removeLabel(name)}
                  onClick={() => onRemove(name)}
                >
                  {t("agentAccess.remove")}
                </RowAction>
              ) : null}
            </RowListItem>
          ))}
        </RowList>
      )}
      {add ? <NameAdder add={add} /> : null}
    </div>
  );
}

function NameAdder({ add }: { readonly add: Adder }) {
  const { t } = useI18n();
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<{
    key: MessageKey;
    vars?: Record<string, string>;
  } | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const added = add.tryAdd(raw);
    if ("edit" in added) {
      setRaw("");
      setError(null);
    } else {
      setError({
        key: added.error,
        ...(added.vars ? { vars: added.vars } : {}),
      });
    }
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"
    >
      <Field>
        <FieldLabel>{add.inputLabel}</FieldLabel>
        <Input
          value={raw}
          placeholder={add.placeholder}
          className="font-mono"
          disabled={add.disabled}
          onChange={(event) => setRaw(event.target.value)}
        />
        {error ? <FieldError>{t(error.key, error.vars)}</FieldError> : null}
      </Field>
      <Button type="submit" variant="outline" disabled={add.disabled}>
        <Plus aria-hidden="true" strokeWidth={1.5} />
        {add.button}
      </Button>
    </form>
  );
}
