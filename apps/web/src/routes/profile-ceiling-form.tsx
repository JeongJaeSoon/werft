import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, type components, unwrap } from "@werft-ai/client";
import type {
  InstallationProfileOptionsResponse,
  PermissionMode,
  ProfileSummary,
  RuntimeKind,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import { workspaceProfileNameStep } from "@werft-ai/core/forms";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { ChangeReview } from "./profile-editor.tsx";
import {
  DenyChecklist,
  reasonOf,
  toolField,
  toolRefusalKey,
} from "./tool-names.tsx";
import {
  allBlockedOf,
  askAgain,
  ceilingTools,
  denyRequest,
  NO_PICKS,
  type ToolPicks,
} from "./profile-tools-model.ts";

// The OpenAPI body, whose optional fields take no explicit undefined.
type CeilingRequest = components["schemas"]["CreateInstallationProfileRequest"];

type CeilingField =
  | "name"
  | "connection_id"
  | "runtime_kind"
  | "runtime_version"
  | "models"
  | "model"
  | "title_model"
  | "deny"
  | "permission_mode"
  | "project_settings";

const FIELDS: readonly CeilingField[] = [
  "name",
  "connection_id",
  "runtime_kind",
  "runtime_version",
  "models",
  "model",
  "title_model",
  "deny",
  "permission_mode",
  "project_settings",
];

interface Draft {
  readonly name: string;
  readonly connection_id: string;
  readonly runtime_kind: RuntimeKind;
  readonly runtime_version: string;
  /** One model per line, the way the form holds it. */
  readonly models: string;
  readonly model: string;
  readonly title_model: string;
  readonly tools: ToolPicks;
  readonly permission_mode: PermissionMode;
  readonly claude_md: boolean;
}

const lines = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ),
];

function modesOf(
  options: InstallationProfileOptionsResponse,
  kind: RuntimeKind,
): readonly PermissionMode[] {
  return (
    options.runtimes.find((runtime) => runtime.runtime_kind === kind)
      ?.permission_modes ?? []
  );
}

const opensMode = (
  options: InstallationProfileOptionsResponse,
  mode: PermissionMode,
) => mode !== "bypassPermissions" || options.unattended_allowed;

function draftOf(
  options: InstallationProfileOptionsResponse,
  operators: readonly ProfileSummary[],
  template: ProfileSummary | undefined,
  name: string,
): Draft {
  const runtime =
    template &&
    options.runtimes.some((item) => item.runtime_kind === template.runtime_kind)
      ? template.runtime_kind
      : (options.runtimes[0]?.runtime_kind as RuntimeKind);
  const modes = modesOf(options, runtime).filter((mode) =>
    opensMode(options, mode),
  );
  const mode =
    template && modes.includes(template.permission_mode)
      ? template.permission_mode
      : ((["auto", "default"] as const).find((item) => modes.includes(item)) ??
        modes[0] ??
        "default");
  const connection = template?.installation?.connection_id;
  return {
    name,
    // A template whose connection is gone starts empty: another connection
    // means another provider and billing, which the owner has to pick.
    connection_id: template
      ? connection && options.connections.some((item) => item.id === connection)
        ? connection
        : ""
      : (options.connections[0]?.id ?? ""),
    runtime_kind: runtime,
    runtime_version:
      template?.runtime_version ??
      operators.find((item) => item.runtime_kind === runtime)
        ?.runtime_version ??
      "",
    models: template?.models.join("\n") ?? "",
    model: template?.model ?? "",
    title_model: template?.installation?.title_model ?? "",
    tools: NO_PICKS,
    permission_mode: mode,
    // Repository CLAUDE.md/AGENTS.md is the only way left to steer an agent,
    // so a blank form starts with it on; a template keeps its own value.
    claude_md: template?.installation?.project_settings.claude_md ?? true,
  };
}

/** Where the server's refusal belongs: beside a field, or above the buttons. */
type Refusal =
  | { readonly field: CeilingField; readonly text: string }
  | {
      readonly field: null;
      readonly text: string;
      readonly latestId?: string | undefined;
    };

/**
 * The form for a new installation ceiling: a first version, or with
 * `previous` the next version after it. `template` fills the fields.
 */
export function CeilingForm({
  options,
  operators,
  template,
  previous,
  cancelTo,
  onSaved,
}: {
  readonly options: InstallationProfileOptionsResponse;
  readonly operators: readonly ProfileSummary[];
  readonly template: ProfileSummary | undefined;
  readonly previous: ProfileSummary | undefined;
  readonly cancelTo: string | undefined;
  readonly onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const queryClient = useQueryClient();
  // An imported ceiling has no name; its next version takes a new one.
  const fixedName = previous?.installation?.name ?? null;
  const [initial] = useState(() =>
    draftOf(options, operators, template, fixedName ?? ""),
  );
  const [draft, setDraft] = useState<Draft>(initial);
  // The review compares with the template as saved: `initial` already swapped
  // out what this installation no longer offers, and that swap is a change.
  const saved: Draft = template
    ? {
        ...initial,
        connection_id: template.installation?.connection_id ?? "",
        runtime_kind: template.runtime_kind,
        runtime_version: template.runtime_version,
        permission_mode: template.permission_mode,
      }
    : initial;
  const [submitted, setSubmitted] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const riskId = useId();
  const modelsId = useId();

  const modes = modesOf(options, draft.runtime_kind);
  const models = lines(draft.models);
  const model = models.includes(draft.model) ? draft.model : (models[0] ?? "");

  const name = workspaceProfileNameStep.safeParse(draft.name);
  const runtimeVersion = draft.runtime_version.trim();
  const titleModel = draft.title_model.trim();
  const tools = ceilingTools(options, draft.runtime_kind, runtimeVersion, {
    previous,
    template,
  });
  const choice = tools === null ? null : denyRequest(tools, draft.tools);
  const supported = [
    ...new Set(
      (options.tool_catalogs ?? [])
        .filter((catalog) => catalog.runtime_kind === draft.runtime_kind)
        .map((catalog) => catalog.runtime_version),
    ),
  ];
  // Shown before any save: the checklist cannot be drawn without it.
  const noCatalog =
    tools !== null
      ? undefined
      : supported.length === 0
        ? t("profiles.tools.noCatalogs")
        : t("profiles.tools.noCatalog", {
            version: runtimeVersion,
            versions: supported.join(", "),
          });
  const connectionOffered = options.connections.some(
    (item) => item.id === draft.connection_id,
  );
  const local: Partial<Record<CeilingField, string>> = {
    ...(name.success ? {} : { name: t("profiles.editor.nameInvalid") }),
    ...(connectionOffered
      ? {}
      : { connection_id: t("profiles.ceiling.connectionDropped") }),
    ...(runtimeVersion.length === 0 || runtimeVersion.length > 200
      ? { runtime_version: t("profiles.ceiling.runtimeVersionInvalid") }
      : {}),
    ...(models.length === 0
      ? { models: t("profiles.editor.modelsEmpty") }
      : models.length > 32
        ? { models: t("profiles.editor.tooLarge") }
        : models.some((item) => item.length > 200)
          ? { models: t("profiles.editor.tooLong") }
          : {}),
    ...(noCatalog
      ? { deny: noCatalog }
      : choice !== null && "unaccepted" in choice
        ? {
            deny: t("profiles.tools.unaccepted", {
              tools: choice.unaccepted.join(", "),
            }),
          }
        : {}),
    ...(titleModel.length > 200
      ? { title_model: t("profiles.editor.tooLong") }
      : {}),
  };
  const errorOf = (field: CeilingField) =>
    (submitted ? local[field] : undefined) ??
    (refusal?.field === field ? refusal.text : undefined);
  // Said at once, not only after a save: the empty select needs its reason.
  const connectionError = connectionOffered
    ? errorOf("connection_id")
    : local.connection_id;

  const save = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    CeilingRequest
  >({
    mutationFn: (body) =>
      unwrap(client.POST("/v1/installation-profiles", { body })),
    onMutate: () => {
      setRefusal(null);
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
      const refused = refusalOf(failure);
      if (
        refused.field === "deny" &&
        reasonOf(failure) === "added_tool_not_accepted" &&
        tools !== null &&
        previous !== undefined
      )
        setDraft((now) => ({
          ...now,
          tools: askAgain(tools, now.tools, previous),
        }));
      // The link opens the latest version from the list; this one may not
      // have it yet.
      if (refused.field === null && refused.latestId)
        await queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).profiles,
        });
      setRefusal(refused);
    },
  });

  function refusalOf(failure: ApiError): Refusal {
    const details = (failure.details ?? {}) as {
      readonly reason_code?: unknown;
      readonly field?: unknown;
      readonly latest_id?: unknown;
    };
    // A schema issue names its path, `models.3` say.
    const path =
      typeof details.field === "string"
        ? details.field.split(".")[0]
        : undefined;
    const named = FIELDS.find((field) => field === toolField(path));
    const beside = (text: string): Refusal =>
      named ? { field: named, text } : { field: null, text };
    const toolRefusal = toolRefusalKey(details.reason_code);
    if (toolRefusal) return { field: "deny", text: t(toolRefusal) };
    switch (details.reason_code) {
      case "unknown_connection":
        return beside(t("profiles.ceiling.error.unknownConnection"));
      case "runtime_not_installed":
        return beside(t("profiles.ceiling.error.runtimeNotInstalled"));
      case "unattended_not_allowed":
        return beside(t("profiles.ceiling.error.unattendedNotAllowed"));
      case "name_taken":
        return { field: "name", text: t("profiles.error.nameTaken") };
      case "model_not_in_models":
        return beside(t("profiles.ceiling.error.modelNotInModels"));
      case "unknown_previous":
        return {
          field: null,
          text: t("profiles.ceiling.error.unknownPrevious"),
        };
      case "invalid_profile":
        return beside(t("profiles.ceiling.error.invalid"));
      case "id_taken":
        return { field: "name", text: t("profiles.ceiling.error.idTaken") };
      case "stale_previous":
        return typeof details.latest_id === "string"
          ? {
              field: null,
              text: t("profiles.ceiling.error.stalePrevious", {
                id: details.latest_id,
              }),
              latestId: details.latest_id,
            }
          : { field: null, text: t("profiles.ceiling.error.noVersion") };
    }
    if (failure.code === "FORBIDDEN")
      return { field: null, text: t("profiles.ceiling.ownerOnly") };
    return { field: null, text: t(errorKey(failure.code)) };
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (
      save.isPending ||
      !name.success ||
      Object.keys(local).length > 0 ||
      choice === null ||
      "unaccepted" in choice
    )
      return;
    const body: CeilingRequest = {
      name: name.data,
      connection_id: draft.connection_id,
      runtime_kind: draft.runtime_kind,
      runtime_version: runtimeVersion,
      model,
      models,
      ...choice,
      permission_mode: draft.permission_mode,
      project_settings: { claude_md: draft.claude_md },
    };
    if (titleModel) body.title_model = titleModel;
    if (previous) body.previous_id = previous.id;
    save.mutate(body);
  };

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const bypassChosen = draft.permission_mode === "bypassPermissions";
  const bypassClosed =
    modes.includes("bypassPermissions") && !options.unattended_allowed;
  const pending = save.isPending;
  const join = (values: readonly string[], empty = "—") =>
    values.length === 0 ? empty : values.join(", ");

  return (
    <form
      className="flex flex-col gap-[var(--werft-space-block)]"
      noValidate
      onSubmit={submit}
    >
      <Field>
        <FieldLabel>{t("profiles.editor.name")}</FieldLabel>
        <Input
          name="ceiling-name"
          autoComplete="off"
          maxLength={40}
          value={draft.name}
          readOnly={fixedName !== null || pending}
          aria-invalid={errorOf("name") ? true : undefined}
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldDescription>
          {name.success
            ? t("profiles.ceiling.preview", {
                name: name.data,
                version:
                  Math.max(
                    0,
                    ...operators
                      .filter((item) => item.installation?.name === name.data)
                      .map((item) => item.installation?.version ?? 0),
                  ) + 1,
              })
            : t("profiles.editor.nameHint")}
        </FieldDescription>
        <FieldError>{errorOf("name")}</FieldError>
      </Field>

      <Field className="w-auto max-w-full">
        <FieldLabel>{t("profiles.ceiling.connection")}</FieldLabel>
        <NativeSelect
          // A refreshed option list may drop the chosen id; show the empty
          // placeholder, not the first option React would fall back to.
          value={connectionOffered ? draft.connection_id : ""}
          disabled={pending}
          aria-invalid={connectionError ? true : undefined}
          onChange={(event) => set({ connection_id: event.target.value })}
        >
          {connectionOffered ? null : (
            <NativeSelectOption value="" disabled>
              {t("profiles.ceiling.connectionPick")}
            </NativeSelectOption>
          )}
          {options.connections.map((connection) => (
            <NativeSelectOption key={connection.id} value={connection.id}>
              {t("profiles.ceiling.connectionOption", {
                id: connection.id,
                kind: connection.kind,
                billing: t(`profiles.billing.${connection.billing}`),
              })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          {t("profiles.ceiling.connectionHint")}
        </FieldDescription>
        <FieldError>{connectionError}</FieldError>
      </Field>

      <div className="flex flex-wrap gap-4">
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.runtime")}</FieldLabel>
          <NativeSelect
            value={draft.runtime_kind}
            disabled={pending}
            aria-invalid={errorOf("runtime_kind") ? true : undefined}
            onChange={(event) => {
              const kind = event.target.value as RuntimeKind;
              const next = modesOf(options, kind);
              set({
                runtime_kind: kind,
                permission_mode: next.includes(draft.permission_mode)
                  ? draft.permission_mode
                  : (next.find((mode) => opensMode(options, mode)) ??
                    draft.permission_mode),
              });
            }}
          >
            {options.runtimes.map((runtime) => (
              <NativeSelectOption
                key={runtime.runtime_kind}
                value={runtime.runtime_kind}
              >
                {runtime.runtime_kind}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{errorOf("runtime_kind")}</FieldError>
        </Field>
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.runtimeVersion")}</FieldLabel>
          <Input
            name="runtime-version"
            autoComplete="off"
            className="font-mono"
            value={draft.runtime_version}
            readOnly={pending}
            aria-invalid={errorOf("runtime_version") ? true : undefined}
            onChange={(event) => set({ runtime_version: event.target.value })}
          />
          <FieldError>{errorOf("runtime_version")}</FieldError>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={modelsId}>
          {t("profiles.editor.models")}
        </FieldLabel>
        <Textarea
          id={modelsId}
          className="font-mono"
          rows={3}
          value={draft.models}
          readOnly={pending}
          aria-invalid={errorOf("models") ? true : undefined}
          onChange={(event) => set({ models: event.target.value })}
        />
        <FieldDescription>{t("profiles.ceiling.modelsHint")}</FieldDescription>
        <FieldError>{errorOf("models")}</FieldError>
      </Field>

      <div className="flex flex-wrap gap-4">
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.editor.defaultModel")}</FieldLabel>
          <NativeSelect
            // Empty until a model is listed; keep it a field, not a sliver.
            className="min-w-48"
            value={model}
            disabled={pending || models.length === 0}
            aria-invalid={errorOf("model") ? true : undefined}
            onChange={(event) => set({ model: event.target.value })}
          >
            {models.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{errorOf("model")}</FieldError>
        </Field>
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.titleModel")}</FieldLabel>
          <Input
            name="title-model"
            autoComplete="off"
            className="font-mono"
            value={draft.title_model}
            readOnly={pending}
            aria-invalid={errorOf("title_model") ? true : undefined}
            onChange={(event) => set({ title_model: event.target.value })}
          />
          <FieldDescription>
            {t("profiles.ceiling.titleModelHint")}
          </FieldDescription>
          <FieldError>{errorOf("title_model")}</FieldError>
        </Field>
      </div>

      {tools === null ? (
        <Alert variant="amber" className="border-0">
          <AlertDescription>{noCatalog}</AlertDescription>
        </Alert>
      ) : (
        <DenyChecklist
          model={tools}
          picks={draft.tools}
          onPicks={(picks) => set({ tools: picks })}
          disabled={pending}
          previousId={previous?.id}
          error={errorOf("deny")}
        />
      )}

      <Field className="w-auto max-w-full">
        <FieldLabel>{t("profiles.editor.permissionMode")}</FieldLabel>
        <NativeSelect
          value={draft.permission_mode}
          disabled={pending}
          aria-invalid={errorOf("permission_mode") ? true : undefined}
          aria-describedby={bypassChosen ? riskId : undefined}
          onChange={(event) =>
            set({ permission_mode: event.target.value as PermissionMode })
          }
        >
          {modes.map((mode) => (
            <NativeSelectOption
              key={mode}
              value={mode}
              disabled={!opensMode(options, mode)}
            >
              {mode}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {bypassClosed ? (
          <FieldDescription>
            {t("profiles.ceiling.bypassClosed")}
          </FieldDescription>
        ) : null}
        <FieldError>{errorOf("permission_mode")}</FieldError>
      </Field>
      {bypassChosen ? (
        <Alert id={riskId} variant="amber" className="border-0">
          <AlertDescription>{t("profiles.editor.bypassRisk")}</AlertDescription>
        </Alert>
      ) : null}

      <Field orientation="horizontal">
        <Checkbox
          checked={draft.claude_md}
          disabled={pending}
          onCheckedChange={(checked) => set({ claude_md: checked === true })}
        />
        <FieldContent>
          <FieldLabel>{t("profiles.ceiling.claudeMd")}</FieldLabel>
          <FieldDescription>
            {t("profiles.ceiling.claudeMdHint")}
          </FieldDescription>
        </FieldContent>
      </Field>

      {template ? (
        <ChangeReview
          against={template.id}
          rows={[
            {
              id: "connection",
              label: t("profiles.ceiling.connection"),
              before: saved.connection_id,
              after: draft.connection_id,
            },
            {
              id: "runtime",
              label: t("profiles.ceiling.runtime"),
              before: `${saved.runtime_kind} ${saved.runtime_version.trim()}`,
              after: `${draft.runtime_kind} ${runtimeVersion}`,
            },
            {
              id: "models",
              label: t("profiles.editor.models"),
              before: join(lines(saved.models)),
              after: join(models),
            },
            {
              id: "model",
              label: t("profiles.editor.defaultModel"),
              before: saved.model,
              after: model,
            },
            {
              id: "title",
              label: t("profiles.ceiling.titleModel"),
              before: saved.title_model.trim(),
              after: titleModel,
            },
            {
              id: "deny",
              label: t("profiles.tools.blocked"),
              before:
                template.deny == null
                  ? ""
                  : join(
                      [...template.deny, ...(template.mcp_deny ?? [])],
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
              before: saved.permission_mode,
              after: draft.permission_mode,
            },
            {
              id: "claude-md",
              label: t("profiles.ceiling.claudeMd"),
              before: t(saved.claude_md ? "profiles.on" : "profiles.off"),
              after: t(draft.claude_md ? "profiles.on" : "profiles.off"),
            },
          ]}
        />
      ) : null}

      {unchanged ? (
        <Alert variant="amber" role="status" className="border-0">
          <AlertDescription>{t("profiles.unchanged")}</AlertDescription>
        </Alert>
      ) : null}

      {refusal === null || refusal.field !== null ? null : (
        <Alert variant="red" role="alert" className="border-0">
          <AlertDescription>
            {refusal.text}
            {refusal.latestId ? (
              <>
                {" "}
                <Link
                  className="font-medium underline underline-offset-4"
                  to="/profiles/new"
                  search={{
                    from: refusal.latestId,
                    mode: "version",
                  }}
                >
                  {t("profiles.ceiling.error.openLatest")}
                </Link>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <FieldDescription>{t("profiles.ceiling.saveNote")}</FieldDescription>
        <div className="flex gap-2">
          {cancelTo === undefined ? (
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to="/profiles"
            >
              {t("common.cancel")}
            </Link>
          ) : (
            <Link
              className={buttonVariants({ variant: "ghost" })}
              to="/profiles/$profileId"
              params={{ profileId: cancelTo }}
            >
              {t("common.cancel")}
            </Link>
          )}
          {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
          <Button type="submit" aria-disabled={pending || undefined}>
            {pending ? t("profiles.editor.saving") : t("profiles.ceiling.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
