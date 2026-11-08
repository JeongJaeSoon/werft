import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, type components, unwrap } from "@werft-ai/client";
import type {
  CreateWorkspaceProfileRequest,
  DerivedFields,
  ListProfilesResponse,
  ProfileSummary,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import {
  WORKSPACE_PROFILE_POLICY,
  workspaceProfileNameStep,
  workspaceProfileStep,
} from "@werft-ai/core/forms";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  Text,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { ProfileOptions, pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  DenyChecklist,
  reasonOf,
  toolField,
  toolRefusalKey,
} from "./profile-tools.tsx";
import {
  allBlockedOf,
  askAgain,
  denyRequest,
  latestVersion,
  NO_PICKS,
  type ToolPicks,
  workspaceTools,
} from "./profile-tools-model.ts";

export type EditorStart =
  | { readonly mode: "new"; readonly base: ProfileSummary }
  | {
      readonly mode: "version" | "remake";
      readonly from: ProfileSummary;
      readonly base: ProfileSummary;
    };

// The one write path's body: an admin sends none of the owner's fields.
type ProfileRequest = components["schemas"]["CreateInstallationProfileRequest"];

type Draft = Omit<
  CreateWorkspaceProfileRequest,
  "name" | "tools" | "deny" | "accept_added_tools"
> & {
  readonly name: string;
  readonly tools: ToolPicks;
};

const EDITOR_FIELDS = [
  "base_profile_id",
  "models",
  "model",
  "deny",
  "permission_mode",
] as const;
type EditorField = (typeof EDITOR_FIELDS)[number];

const draftOf = (
  base: ProfileSummary,
  name: string,
  derived: DerivedFields,
): Draft => ({
  name,
  base_profile_id: base.id,
  model: derived.model,
  models: [...derived.models],
  tools: NO_PICKS,
  permission_mode: derived.permission_mode,
});

const fromBase = (base: ProfileSummary, name: string): Draft =>
  draftOf(base, name, WORKSPACE_PROFILE_POLICY.initial(base));

const fromVersion = (from: ProfileSummary, base: ProfileSummary): Draft =>
  draftOf(
    base,
    from.installation?.name ?? "",
    WORKSPACE_PROFILE_POLICY.carry(from, base),
  );

/** Whether a version over `base` may run `auto`; a new profile starts on such a base. */
export const allowsAuto = (base: ProfileSummary): boolean =>
  WORKSPACE_PROFILE_POLICY.choices(base).permission_modes.includes("auto");

export function ProfileEditor({
  start,
  operators,
  latest,
  onSaved,
  onCancel,
}: {
  readonly start: EditorStart;
  readonly operators: readonly ProfileSummary[];
  /** The latest version under `name`, which the server weighs new tools against. */
  readonly latest: (name: string) => ProfileSummary | undefined;
  readonly onSaved: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const fixed = start.mode !== "new";
  const [draft, setDraft] = useState<Draft>(() =>
    start.mode === "new"
      ? fromBase(start.base, "")
      : fromVersion(start.from, start.base),
  );
  const [submitted, setSubmitted] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const [error, setError] = useState<{
    readonly field: EditorField | null;
    readonly text: string;
  } | null>(null);
  const base = operators.find((item) => item.id === draft.base_profile_id);
  const choices = base ? WORKSPACE_PROFILE_POLICY.choices(base) : undefined;
  // Listed disabled, so the console says why they are missing.
  const closedModes = (["auto", "bypassPermissions"] as const).filter(
    (mode) => !choices?.permission_modes.includes(mode),
  );
  const bypassChosen = draft.permission_mode === "bypassPermissions";
  const riskId = useId();

  const name = workspaceProfileNameStep.safeParse(draft.name);
  const nameError = name.success ? undefined : t("profiles.editor.nameInvalid");
  const modelsError =
    draft.models.length === 0 ? t("profiles.editor.modelsEmpty") : undefined;
  const previous = name.success ? latest(name.data) : undefined;
  const tools = base
    ? workspaceTools(
        base,
        start.mode === "new" ? undefined : start.from,
        previous,
      )
    : null;
  const choice = tools === null ? null : denyRequest(tools, draft.tools);
  const toolsError =
    choice !== null && "unaccepted" in choice
      ? t("profiles.tools.unaccepted", { tools: choice.unaccepted.join(", ") })
      : undefined;

  const save = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    ProfileRequest
  >({
    mutationFn: (body) =>
      unwrap(client.POST("/v1/installation-profiles", { body })),
    onMutate: () => {
      setError(null);
      setUnchanged(false);
    },
    onSuccess: async ({ profile, receipt_id }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
      // Nothing was written: the latest version already runs this.
      if (receipt_id === null) {
        setUnchanged(true);
        return;
      }
      onSaved(profile.id);
    },
    onError: async (failure) => {
      if (
        reasonOf(failure) === "added_tool_not_accepted" &&
        tools !== null &&
        name.success
      ) {
        // The server weighed the name's latest version, which may have
        // landed after this list was read.
        // Read past the shared query: a failed read must not put the page,
        // and this form with it, into its load-failure state.
        const fresh = await (
          unwrap(client.GET("/v1/profiles")) as Promise<ListProfilesResponse>
        ).catch(() => undefined);
        if (fresh)
          queryClient.setQueryData(queryKeysOf(client).profiles, fresh);
        const latestNow =
          (fresh && latestVersion(fresh.items, name.data)) ?? previous;
        if (latestNow !== undefined)
          setDraft((now) => ({
            ...now,
            tools: askAgain(tools, now.tools, latestNow),
          }));
      }
      setError(saveRefusal(failure));
    },
  });

  function saveRefusal(failure: ApiError): {
    field: EditorField | null;
    text: string;
  } {
    const details = (failure.details ?? {}) as {
      readonly reason_code?: unknown;
      readonly field?: unknown;
    };
    const path =
      typeof details.field === "string"
        ? details.field.split(".")[0]
        : undefined;
    const field =
      EDITOR_FIELDS.find((item) => item === toolField(path)) ?? null;
    const toolRefusal = toolRefusalKey(details.reason_code);
    if (toolRefusal) return { field: "deny", text: t(toolRefusal) };
    if (details.reason_code === "unknown_base")
      return { field, text: t("profiles.error.unknownBase") };
    if (details.reason_code === "widens_base")
      return { field, text: t("profiles.error.widens") };
    if (field === "base_profile_id")
      return { field, text: t("profiles.error.baseUnusable") };
    if (details.reason_code === "name_taken")
      return { field: null, text: t("profiles.error.nameTaken") };
    if (failure.code === "REVISION_CONFLICT")
      return { field: null, text: t("profiles.error.versionTaken") };
    return {
      field: null,
      text: refusalText(t, failure, "workspace.manage", role),
    };
  }
  // A refusal for a field this form does not draw goes above the buttons.
  const drawn = (field: EditorField) =>
    field === "base_profile_id"
      ? !fixed
      : field === "model"
        ? draft.models.length > 1
        : field === "deny"
          ? tools !== null
          : choices !== undefined;
  const beside = (field: EditorField) =>
    error?.field === field && drawn(field) ? error.text : undefined;
  const banner = unchanged
    ? t("profiles.unchanged")
    : error !== null && (error.field === null || !drawn(error.field))
      ? error.text
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (save.isPending || !name.success || modelsError || toolsError) return;
    // A refetch can take the base out of service under the open form.
    if (!base || !pickable(base)) {
      setError({
        field: "base_profile_id",
        text: t("profiles.error.baseUnusable"),
      });
      return;
    }
    if (choice === null || "unaccepted" in choice) {
      setError({ field: null, text: t("profiles.tools.baseNoCatalog") });
      return;
    }
    // The operator catalog has no such caps; the request does.
    const request = workspaceProfileStep.safeParse({
      name: name.data,
      base_profile_id: draft.base_profile_id,
      model: draft.model,
      models: draft.models,
      permission_mode: draft.permission_mode,
      ...choice,
    });
    if (!request.success) {
      const tooMany = request.error.issues.some(
        (issue) =>
          issue.path.length === 1 &&
          (issue.path[0] === "models" || issue.path[0] === "deny"),
      );
      setError({
        field: null,
        text: t(
          tooMany ? "profiles.editor.tooLarge" : "profiles.editor.tooLong",
        ),
      });
      return;
    }
    // A new profile names the one it narrows; a new version of one names
    // the version before it, whose source the server keeps.
    const { base_profile_id, previous_id: _own, ...rest } = request.data;
    save.mutate({
      ...rest,
      ...(start.mode === "new"
        ? { derived_from: base_profile_id }
        : { previous_id: start.from.id }),
    });
  };

  const toggle = (list: readonly string[], item: string, on: boolean) =>
    on ? [...list, item] : list.filter((other) => other !== item);
  const setModels = (models: readonly string[]) =>
    setDraft({
      ...draft,
      models: [...models],
      model: models.includes(draft.model) ? draft.model : (models[0] ?? ""),
    });

  // The review compares with the version it follows, or the base picked now.
  const before = start.mode === "new" ? base : start.from;
  const join = (values: readonly string[], empty = "—") =>
    values.length === 0 ? empty : values.join(", ");

  return (
    <form
      className="flex flex-col gap-[var(--werft-space-block)]"
      noValidate
      onSubmit={submit}
    >
      {fixed ? null : (
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.editor.base")}</FieldLabel>
          <NativeSelect
            value={draft.base_profile_id}
            disabled={save.isPending}
            onChange={(event) => {
              const next = operators.find(
                (item) => item.id === event.target.value,
              );
              if (next) setDraft(fromBase(next, draft.name));
            }}
          >
            <ProfileOptions profiles={operators} label={(item) => item.id} />
          </NativeSelect>
          <FieldError>{beside("base_profile_id")}</FieldError>
        </Field>
      )}
      {base ? <BaseSummary base={base} /> : null}

      <Alert variant="blue" className="border-0 bg-transparent p-0">
        <AlertDescription>
          {t("profiles.editor.autoRulesNote")}
        </AlertDescription>
      </Alert>

      <Field>
        <FieldLabel>{t("profiles.editor.name")}</FieldLabel>
        <Input
          name="profile-name"
          autoComplete="off"
          maxLength={40}
          value={draft.name}
          readOnly={fixed || save.isPending}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <FieldDescription>{t("profiles.editor.nameHint")}</FieldDescription>
        <FieldError>{submitted ? nameError : undefined}</FieldError>
      </Field>

      {choices ? (
        <>
          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-2">
              {t("profiles.editor.models")}
            </FieldLegend>
            {/* One choice and no error make this the second-last child,
                whose pull-up would undo the legend's margin. */}
            <FieldDescription className="nth-last-2:mt-0">
              {t("profiles.editor.modelsHint")}
            </FieldDescription>
            {choices.models.map((model) => (
              <Field key={model} orientation="horizontal">
                <Checkbox
                  checked={draft.models.includes(model)}
                  disabled={save.isPending}
                  onCheckedChange={(checked) =>
                    setModels(toggle(draft.models, model, checked === true))
                  }
                />
                <FieldContent>
                  <FieldLabel className="font-mono">{model}</FieldLabel>
                </FieldContent>
              </Field>
            ))}
            <FieldError>
              {(submitted ? modelsError : undefined) ?? beside("models")}
            </FieldError>
          </FieldSet>

          {draft.models.length > 1 ? (
            <Field className="w-auto max-w-full">
              <FieldLabel>{t("profiles.editor.defaultModel")}</FieldLabel>
              <NativeSelect
                value={draft.model}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft({ ...draft, model: event.target.value })
                }
              >
                {draft.models.map((model) => (
                  <NativeSelectOption key={model} value={model}>
                    {model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldError>{beside("model")}</FieldError>
            </Field>
          ) : null}

          {tools === null ? (
            <Alert variant="amber" className="border-0">
              <AlertDescription>
                {t("profiles.tools.baseNoCatalog")}
              </AlertDescription>
            </Alert>
          ) : (
            <DenyChecklist
              model={tools}
              picks={draft.tools}
              onPicks={(picks) => setDraft({ ...draft, tools: picks })}
              disabled={save.isPending}
              previousId={previous?.id}
              error={(submitted ? toolsError : undefined) ?? beside("deny")}
            />
          )}

          <Field className="w-auto max-w-full">
            <FieldLabel>{t("profiles.editor.permissionMode")}</FieldLabel>
            <NativeSelect
              value={draft.permission_mode}
              disabled={save.isPending}
              aria-describedby={bypassChosen ? riskId : undefined}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permission_mode: event.target
                    .value as Draft["permission_mode"],
                })
              }
            >
              {choices.permission_modes.map((mode) => (
                <NativeSelectOption key={mode} value={mode}>
                  {mode}
                </NativeSelectOption>
              ))}
              {closedModes.map((mode) => (
                <NativeSelectOption key={mode} value={mode} disabled>
                  {mode}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{t("profiles.editor.modeHint")}</FieldDescription>
            {closedModes.map((mode) => (
              <FieldDescription key={mode}>
                {t(
                  mode === "auto"
                    ? "profiles.editor.autoClosed"
                    : "profiles.editor.bypassClosed",
                )}
              </FieldDescription>
            ))}
            <FieldError>{beside("permission_mode")}</FieldError>
          </Field>
          {bypassChosen ? (
            <Alert id={riskId} variant="amber" className="border-0">
              <AlertDescription>
                {t("profiles.editor.bypassRisk")}
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}

      <Field className="w-auto max-w-full">
        <div className="flex items-center gap-2">
          <FieldLabel>{t("profiles.editor.scriptCeiling")}</FieldLabel>
          <Badge variant="gray">{t("profiles.editor.scriptLater")}</Badge>
        </div>
        <NativeSelect disabled value="none" onChange={() => undefined}>
          <NativeSelectOption value="none">
            {t("profiles.editor.scriptNone")}
          </NativeSelectOption>
        </NativeSelect>
        <FieldDescription>{t("profiles.editor.scriptHint")}</FieldDescription>
      </Field>

      <ChangeReview
        against={start.mode === "new" ? draft.base_profile_id : start.from.id}
        rows={[
          {
            id: "models",
            label: t("profiles.editor.models"),
            before: join(before?.models ?? []),
            after: join(draft.models),
          },
          {
            id: "model",
            label: t("profiles.editor.defaultModel"),
            before: before?.model ?? "",
            after: draft.model,
          },
          {
            id: "deny",
            label: t("profiles.tools.blocked"),
            before:
              before?.deny == null
                ? ""
                : join(
                    [...before.deny, ...(before.mcp_deny ?? [])],
                    t("profiles.tools.noneBlocked"),
                  ),
            after:
              tools === null
                ? ""
                : join(
                    allBlockedOf(tools, draft.tools),
                    t("profiles.tools.noneBlocked"),
                  ),
          },
          {
            id: "mode",
            label: t("profiles.editor.permissionMode"),
            before: before?.permission_mode ?? "",
            after: draft.permission_mode,
          },
        ]}
      />

      {banner === null ? null : (
        <Alert variant="red" role="alert" className="border-0">
          <AlertDescription>{banner}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <Text variant="meta">{t("profiles.editor.saveNote")}</Text>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            aria-disabled={save.isPending || undefined}
            onClick={() => {
              if (!save.isPending) onCancel();
            }}
          >
            {t("common.cancel")}
          </Button>
          {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
          <Button type="submit" aria-disabled={save.isPending || undefined}>
            {save.isPending
              ? t("profiles.editor.saving")
              : start.mode === "new"
                ? t("profiles.ceiling.save")
                : t("profiles.editor.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The fields that differ from what a new profile starts from; the rest are left out. */
export function ChangeReview({
  against,
  rows,
}: {
  /** The profile the values are compared with. */
  readonly against: string;
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly before: string;
    readonly after: string;
  }[];
}) {
  const { t } = useI18n();
  const changed = rows.filter((row) => row.before !== row.after);
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-0 w-full border-b pb-2">
        {t("profiles.review.title")}
      </FieldLegend>
      <FieldDescription>
        {t(
          changed.length === 0
            ? "profiles.review.none"
            : "profiles.review.text",
          {
            id: against,
          },
        )}
      </FieldDescription>
      {changed.length === 0 ? null : (
        <KeyValueList
          items={changed.map((row) => ({
            id: row.id,
            label: row.label,
            value: t("profiles.review.change", {
              before: row.before || "—",
              after: row.after || "—",
            }),
          }))}
        />
      )}
    </FieldSet>
  );
}

function BaseSummary({ base }: { readonly base: ProfileSummary }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <span className="border-b pb-2 font-medium text-body">
        {t("profiles.editor.baseHeading", { id: base.id })}
      </span>
      <KeyValueList
        items={[
          {
            id: "engine",
            label: t("profiles.editor.engineModel"),
            value: t("profiles.editor.engineModelValue", {
              version: base.runtime_version,
              model: base.models.join(", "),
            }),
          },
          {
            id: "mode",
            label: t("profiles.editor.permissionMode"),
            value: <span className="font-mono">{base.permission_mode}</span>,
          },
          {
            id: "tools",
            label: t("profiles.tools.running"),
            value:
              base.tools.length === 0 ? (
                t("profiles.noTools")
              ) : (
                <span className="flex flex-wrap gap-1">
                  {base.tools.map((tool) => (
                    <Badge key={tool} variant="mono">
                      {tool}
                    </Badge>
                  ))}
                </span>
              ),
          },
          ...(base.mcp_deny?.length
            ? [
                {
                  id: "mcp-deny",
                  label: t("profiles.tools.mcp.blocked"),
                  value: (
                    <span className="flex flex-wrap gap-1">
                      {base.mcp_deny.map((tool) => (
                        <Badge key={tool} variant="mono">
                          {tool}
                        </Badge>
                      ))}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}
