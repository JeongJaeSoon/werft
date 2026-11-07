import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import { type ApiError, type components, unwrap } from "@werft-ai/client";
import type { AgentDetail } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Code,
  ConfirmDialog,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Link,
  NativeSelect,
  NativeSelectOption,
  RelativeTime,
  RowAction,
  RowList,
  RowListItem,
  Section,
  SettingRow,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../../i18n/i18n.tsx";
import {
  githubKey,
  receiptTitle,
  useAgentGitHubActivity,
} from "./github-activity.ts";
import { AppRepositoryPicker } from "./github-app-repositories.tsx";
import { AgentPullRequestSettingsCard } from "./github-pull-request.tsx";
import { type Notify, useToast } from "./toast.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

type GitHubTabData = components["schemas"]["AgentGitHubResponse"];
type Settings = NonNullable<GitHubTabData["github"]>;
type Feature = keyof Settings["features"];
type AllowEntry = Settings["actions_allow"][number];
type Receipt = components["schemas"]["Receipt"];
type PushAttached = GitHubTabData["push_attached"];
const PUSH_ATTACHED: readonly PushAttached[] = ["allow", "ask", "deny"];
type Draft = {
  readonly settings: Settings;
  readonly start: string | null;
  readonly pushAttached: PushAttached;
  // What the draft was made from. A refetch after another save cannot turn
  // the draft into an overwrite: the revision it sends is the one it read.
  readonly from: {
    readonly base: Settings;
    readonly start: string | null;
    readonly pushAttached: PushAttached;
    readonly revision: number | null;
  };
};

const SECTION = {
  use: "github-use",
  repositories: "github-repositories",
  details: "github-details",
  activity: "github-activity",
} as const;
// Inside the collapsed details; not in the side nav.
const DETAIL_ID = {
  start: "github-start",
  permissions: "github-permissions",
  allowlist: "github-allowlist",
  push: "github-push",
} as const;
type SectionKey = keyof typeof SECTION;
// The order the mockup lists them in: what most agents turn on first.
// checks and issues stay in the contract but have no work behind them yet
// (github-agent.md LATER), so they are not offered.
const FEATURES = [
  "review",
  "actions",
  "workflows",
] as const satisfies readonly Feature[];
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const ALLOW_MAX = 32;
const REF_MAX = 255;

/** Whether a ref pattern can name an `agent/` branch, which never runs. */
export function refusesAgentRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash < 0) return false;
  const head = ref
    .slice(0, slash)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${head}$`).test("agent");
}

const sameEntry = (a: AllowEntry, b: AllowEntry) =>
  a.workflow === b.workflow && (a.ref ?? null) === (b.ref ?? null);

/** How many things the draft changes from the settings it was made from. */
export function pendingCount(
  base: Settings,
  draft: Settings,
  baseStart: string | null = null,
  draftStart: string | null = null,
  basePushAttached: PushAttached = "ask",
  draftPushAttached: PushAttached = basePushAttached,
): number {
  const repos = new Set(base.repositories);
  const drafted = new Set(draft.repositories);
  return (
    Number(baseStart !== draftStart) +
    Number(basePushAttached !== draftPushAttached) +
    [...drafted].filter((id) => !repos.has(id)).length +
    [...repos].filter((id) => !drafted.has(id)).length +
    Number(base.push_approval !== draft.push_approval) +
    FEATURES.filter((f) => base.features[f] !== draft.features[f]).length +
    draft.actions_allow.filter(
      (entry) => !base.actions_allow.some((held) => sameEntry(held, entry)),
    ).length +
    base.actions_allow.filter(
      (entry) => !draft.actions_allow.some((held) => sameEntry(held, entry)),
    ).length
  );
}

function failure(error: unknown, t: Translate): string {
  const code = (error as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
  return t(errorKey(code));
}

function ReceiptRow({
  receipt,
  detail,
}: {
  readonly receipt: Receipt;
  readonly detail: AgentDetail;
}) {
  const { t, locale } = useI18n();
  const result = (receipt.result ?? {}) as {
    session_id?: string;
    release_id?: string;
    repository_id?: string;
    purpose?: string;
    workflow?: string;
    ref?: string;
    reason_code?: string;
  };
  const release = detail.releases.find((r) => r.id === result.release_id);
  const parts = [
    result.workflow
      ? result.ref
        ? `${result.workflow} @ ${result.ref}`
        : result.workflow
      : null,
    result.repository_id ?? null,
    result.purpose && receipt.operation === "mint_github_token"
      ? t(`agentGitHub.purpose.${result.purpose}` as MessageKey)
      : null,
    result.reason_code
      ? t(`agentGitHub.refusal.${result.reason_code}` as MessageKey)
      : null,
    result.reason_code === "ambiguous_app" ||
    result.reason_code === "pinned_app_removed"
      ? t(`agentGitHub.refusalNext.${result.reason_code}`)
      : null,
    release
      ? t("agentGitHub.activity.release", { release: release.label })
      : null,
    receipt.operation === "set_agent_github"
      ? t("agentGitHub.activity.byAdmin")
      : null,
  ].filter((part): part is string => part !== null);
  // Every row keeps one detail line, so the session link joins it instead
  // of adding a second one.
  return (
    <SettingRow
      title={receiptTitle(receipt, t)}
      badge={
        receipt.status === "failed" ? (
          <Badge variant="red">{t("agentGitHub.refused")}</Badge>
        ) : undefined
      }
      description={
        <>
          {parts.join(" · ")}
          {result.session_id ? (
            <>
              {parts.length > 0 ? " · " : null}
              <Link asChild>
                <RouterLink
                  to="/sessions/$id"
                  params={{ id: result.session_id }}
                >
                  {t("agentGitHub.activity.session")}{" "}
                  <Code>{result.session_id.slice(0, 8)}</Code>
                </RouterLink>
              </Link>
            </>
          ) : null}
        </>
      }
      status={
        <RelativeTime
          value={receipt.created_at}
          locale={locale}
          className="text-caption text-muted-foreground"
        />
      }
    />
  );
}

function Activity({
  agentId,
  detail,
}: {
  readonly agentId: string;
  readonly detail: AgentDetail;
}) {
  const { t } = useI18n();
  const activity = useAgentGitHubActivity(agentId);
  return (
    <Section
      id={SECTION.activity}
      tabIndex={-1}
      className="scroll-mt-4 outline-none"
      title={t("agentGitHub.section.activity")}
      description={t("agentGitHub.activityHint")}
    >
      <div className={SECTION_BODY}>
        {activity.error ? (
          <LoadFailure
            error={activity.error}
            kept={activity.data !== undefined}
            onRetry={() => void activity.refetch()}
          />
        ) : null}
        {activity.data === undefined ? (
          activity.error ? null : (
            <Skeleton className="h-32 w-full" />
          )
        ) : activity.data.items.length === 0 ? (
          <Text as="span" variant="sub">
            {t("agentGitHub.activityEmpty")}
          </Text>
        ) : (
          <RowList
            variant="joined"
            aria-label={t("agentGitHub.section.activity")}
          >
            {activity.data.items.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} detail={detail} />
            ))}
          </RowList>
        )}
      </div>
    </Section>
  );
}

function EnabledRow({
  agentId,
  enabled,
  notify,
}: {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const manages = useManagesAgent();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: (next: boolean) =>
      unwrap(
        client.PUT("/v1/agents/{id}/github/enabled", {
          params: { path: { id: agentId } },
          body: { enabled: next },
        }),
      ),
    onSuccess: async (saved) => {
      setConfirming(false);
      notify(
        t(saved.enabled ? "agentGitHub.enabledOn" : "agentGitHub.enabledOff"),
      );
      await cache.invalidateQueries({ queryKey: githubKey(client, agentId) });
    },
  });
  return (
    <>
      <RowList variant="joined">
        <SettingRow
          title={t("agentGitHub.enabled")}
          badge={<Badge variant="gray">{t("agentGitHub.badge.now")}</Badge>}
          description={t("agentGitHub.enabledHint")}
          meta={
            update.error && !confirming ? (
              <FieldError>{failure(update.error, t)}</FieldError>
            ) : undefined
          }
          status={
            <Text as="span" variant="sub">
              {t(enabled ? "agentGitHub.on" : "agentGitHub.off")}
            </Text>
          }
          control={
            manages ? (
              <Switch
                aria-label={t("agentGitHub.enabled")}
                checked={enabled}
                aria-disabled={update.isPending}
                onCheckedChange={(checked) => {
                  if (update.isPending) return;
                  if (checked) update.mutate(true);
                  else setConfirming(true);
                }}
              />
            ) : undefined
          }
        />
      </RowList>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("agentGitHub.disableTitle")}
        consequence={t("agentGitHub.disableBody")}
        confirmLabel={t("agentGitHub.disableConfirm")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={update.isPending}
        onConfirm={() => update.mutate(false)}
      >
        {update.error ? (
          <FieldError>{failure(update.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function AllowAdd({
  entries,
  disabled,
  onAdd,
}: {
  readonly entries: readonly AllowEntry[];
  readonly disabled: boolean;
  readonly onAdd: (entry: AllowEntry) => void;
}) {
  const { t } = useI18n();
  const [workflow, setWorkflow] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const entry: AllowEntry = {
      workflow: workflow.trim(),
      ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
    };
    const refused: MessageKey | null = !WORKFLOW_FILE.test(entry.workflow)
      ? "agentGitHub.workflowInvalid"
      : entry.ref !== undefined && entry.ref.length > REF_MAX
        ? "agentGitHub.refInvalid"
        : entry.ref !== undefined && refusesAgentRef(entry.ref)
          ? "agentGitHub.refAgent"
          : entries.some((held) => sameEntry(held, entry))
            ? "agentGitHub.duplicate"
            : entries.length >= ALLOW_MAX
              ? "agentGitHub.full"
              : null;
    setError(refused);
    if (refused) return;
    onAdd(entry);
    setWorkflow("");
    setRef("");
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border p-4"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field>
          <FieldLabel>{t("agentGitHub.workflow")}</FieldLabel>
          <Input
            value={workflow}
            placeholder="release.yml"
            className="font-mono"
            disabled={disabled}
            onChange={(event) => setWorkflow(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>{t("agentGitHub.ref")}</FieldLabel>
          <Input
            value={ref}
            placeholder="release/*"
            className="font-mono"
            disabled={disabled}
            onChange={(event) => setRef(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={disabled}>
          <Plus aria-hidden="true" strokeWidth={1.5} />
          {t("agentGitHub.add")}
        </Button>
      </div>
      <Text as="span" variant="meta">
        {t("agentGitHub.refHint")}
      </Text>
      {error ? <FieldError>{t(error)}</FieldError> : null}
    </form>
  );
}

function GitHubSettings({
  agentId,
  detail,
  data,
  notify,
  sectionKeys,
}: {
  readonly agentId: string;
  readonly detail: AgentDetail;
  readonly data: GitHubTabData;
  readonly notify: Notify;
  readonly sectionKeys: (keys: readonly SectionKey[]) => void;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const manages = useManagesAgent();
  const [draft, setDraft] = useState<Draft | null>(null);
  // The settings the server holds, or what a first save starts from.
  const base = draft?.from.base ?? data.github ?? data.legacy_defaults;
  // `null` is a real start value, so `??` would swap it for the server's.
  const baseStart = draft ? draft.from.start : data.start_repository_id;
  const basePushAttached = draft ? draft.from.pushAttached : data.push_attached;
  const settings = draft?.settings ?? base;
  const start = draft ? draft.start : baseStart;
  const pushAttached = draft ? draft.pushAttached : basePushAttached;
  const saveError = useRef<HTMLDivElement>(null);
  const pendingRegion = useRef<HTMLDivElement>(null);
  const editable = manages && data.enabled && base !== null;
  // No row yet: the defaults shown are themselves worth saving.
  const firstSave = editable && data.github === null;
  // Another save landed after the draft was made.
  const stale =
    draft !== null && draft.from.revision !== data.settings_revision;

  const save = useMutation<unknown, ApiError>({
    mutationFn: () => {
      const toSave: Draft | null =
        draft ??
        (firstSave && base
          ? {
              settings: base,
              start: baseStart,
              pushAttached: basePushAttached,
              from: {
                base,
                start: baseStart,
                pushAttached: basePushAttached,
                revision: data.settings_revision,
              },
            }
          : null);
      if (!toSave) throw new Error("unsavable");
      return unwrap(
        client.PUT("/v1/agents/{id}/github/settings", {
          params: { path: { id: agentId } },
          body: {
            expected_revision: toSave.from.revision,
            settings: toSave.settings,
            start_repository_id: toSave.start,
            push_attached: toSave.pushAttached,
          },
        }),
      );
    },
    onSuccess: async () => {
      setDraft(null);
      notify(t("agentGitHub.saved"));
      await cache.invalidateQueries({ queryKey: githubKey(client, agentId) });
    },
    onError: async () => {
      saveError.current?.focus();
      await cache.invalidateQueries({ queryKey: githubKey(client, agentId) });
    },
  });
  const saveFailure = stale
    ? t("agentGitHub.stale")
    : save.error
      ? save.error.code === "REVISION_CONFLICT"
        ? t("agentGitHub.conflict")
        : t("agentGitHub.saveRefused", { reason: failure(save.error, t) })
      : null;

  const readOnly = !editable || save.isPending;
  const edit = (
    change: (current: Settings) => Settings,
    nextStart: (current: string | null) => string | null = (s) => s,
    nextAttached: PushAttached = pushAttached,
  ) => {
    if (readOnly || !settings || !base) return;
    const next = change(settings);
    // A start repository the list no longer holds falls back to none.
    const nextStartId = nextStart(start);
    const kept =
      nextStartId !== null && next.repositories.includes(nextStartId)
        ? nextStartId
        : null;
    // Undone by hand: drop the draft so the tab follows the agent again.
    if (
      pendingCount(
        base,
        next,
        baseStart,
        kept,
        basePushAttached,
        nextAttached,
      ) === 0
    ) {
      setDraft(null);
      return;
    }
    setDraft({
      settings: next,
      start: kept,
      pushAttached: nextAttached,
      from: draft?.from ?? {
        base,
        start: baseStart,
        pushAttached: basePushAttached,
        revision: data.settings_revision,
      },
    });
  };
  const pending =
    base && draft
      ? pendingCount(
          base,
          draft.settings,
          baseStart,
          draft.start,
          basePushAttached,
          draft.pushAttached,
        )
      : 0;
  // A first save turns the github MCP on whatever else it changes, so it
  // keeps its own title instead of a change count.
  const pendingTitle = firstSave
    ? t("agentGitHub.pending.firstTitle")
    : t("agentGitHub.pending.title", { count: pending });
  const actionsOn = settings?.features.actions ?? false;
  const keys: SectionKey[] = [
    "use",
    ...(settings ? (["repositories", "details"] as const) : []),
    "activity",
  ];
  // Joined, so a new array with the same sections does not report again.
  const joined = keys.join();
  useLayoutEffect(
    () => sectionKeys(joined.split(",") as SectionKey[]),
    [sectionKeys, joined],
  );

  return (
    <>
      <section
        className="flex flex-col gap-[var(--werft-space-block)]"
        aria-label={t("agentGitHub.status")}
      >
        <RowList variant="joined">
          <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
            <Badge variant={data.enabled ? "green" : "gray"}>
              {t(
                data.enabled ? "agentGitHub.state.on" : "agentGitHub.state.off",
              )}
            </Badge>
            <span>
              {base === null || data.github === null
                ? t("agentGitHub.status.repositoriesLegacy")
                : t("agentGitHub.status.repositories", {
                    count: data.github.repositories.length,
                  })}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {t("agentGitHub.status.pushApproval")}
              </span>
              <span>
                {base
                  ? t(
                      // A release without settings still asks a person,
                      // whatever a first save would start from.
                      data.github === null || base.push_approval
                        ? "agentGitHub.on"
                        : "agentGitHub.off",
                    )
                  : "—"}
              </span>
            </span>
          </RowListItem>
        </RowList>
      </section>
      {manages && (pending > 0 || firstSave || saveFailure) ? (
        <Alert
          ref={pendingRegion}
          tabIndex={-1}
          variant={saveFailure ? "red" : "blue"}
          role="region"
          aria-label={pendingTitle}
          className="outline-none"
        >
          <AlertTitle>{pendingTitle}</AlertTitle>
          <AlertDescription>
            {t("agentGitHub.pending.body")}
            {saveFailure ? (
              <div ref={saveError} tabIndex={-1} className="mt-2 outline-none">
                <FieldError>{saveFailure}</FieldError>
              </div>
            ) : null}
          </AlertDescription>
          <AlertActions>
            <Button
              type="button"
              size="sm"
              disabled={
                (pending === 0 && !firstSave) || stale || save.isPending
              }
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("agentGitHub.pending.saving")
                : t("agentGitHub.pending.save")}
            </Button>
            {draft !== null || saveFailure ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setDraft(null);
                  save.reset();
                  // The region stays for a first save but this button goes.
                  if (firstSave) pendingRegion.current?.focus();
                }}
              >
                {t(
                  stale || save.error?.code === "REVISION_CONFLICT"
                    ? "agentGitHub.pending.reload"
                    : "agentGitHub.pending.revert",
                )}
              </Button>
            ) : null}
          </AlertActions>
        </Alert>
      ) : null}
      {data.github === null && base ? (
        <Alert>
          <AlertDescription>{t("agentGitHub.legacy")}</AlertDescription>
        </Alert>
      ) : null}

      <Section
        id={SECTION.use}
        tabIndex={-1}
        className="scroll-mt-4 outline-none"
        title={t("agentGitHub.section.use")}
      >
        <div className={SECTION_BODY}>
          <EnabledRow
            agentId={agentId}
            enabled={data.enabled}
            notify={notify}
          />
          {data.enabled ? null : (
            <Text as="span" variant="sub">
              {t("agentGitHub.offNote")}
            </Text>
          )}
        </div>
      </Section>

      {settings ? (
        <div className="flex flex-col gap-8">
          <Section
            id={SECTION.repositories}
            tabIndex={-1}
            className="scroll-mt-4 outline-none"
            title={t("agentGitHub.section.repositories")}
            badge={<Badge variant="blue">{t("agentGitHub.badge.next")}</Badge>}
            description={t("agentGitHub.repositoriesHint")}
          >
            <div className={SECTION_BODY}>
              {data.options.repository_ceiling_unset ? (
                <Text as="span" variant="sub">
                  {t("agentGitHub.ceilingUnset")}
                </Text>
              ) : null}
              {data.options.repositories.length === 0 ? (
                <Text as="span" variant="sub">
                  {t("agentGitHub.repositoriesNone")}
                </Text>
              ) : (
                <RowList variant="joined">
                  {data.options.repositories.map((repository) => {
                    const on = settings.repositories.includes(repository.id);
                    const blocked = !repository.available && !on;
                    return (
                      <SettingRow
                        key={repository.id}
                        title={repository.id}
                        badge={
                          repository.installed.author === false ? (
                            <Badge variant="amber">
                              {t("agentGitHub.appNotInstalled")}
                            </Badge>
                          ) : undefined
                        }
                        description={
                          <span className="[overflow-wrap:anywhere]">
                            {repository.url}
                            {repository.reason
                              ? ` · ${t(`agentGitHub.repositoryReason.${repository.reason}`)}`
                              : null}
                          </span>
                        }
                        status={
                          <Text as="span" variant="sub">
                            {t(
                              on
                                ? "agentGitHub.repositoryUse"
                                : "agentGitHub.repositoryUnused",
                            )}
                          </Text>
                        }
                        control={
                          <Switch
                            aria-label={repository.id}
                            checked={on}
                            disabled={readOnly || blocked}
                            onCheckedChange={(checked) =>
                              edit((current) => ({
                                ...current,
                                repositories: checked
                                  ? [...current.repositories, repository.id]
                                  : current.repositories.filter(
                                      (id) => id !== repository.id,
                                    ),
                              }))
                            }
                          />
                        }
                      />
                    );
                  })}
                </RowList>
              )}
              {manages ? (
                <AppRepositoryPicker
                  agentId={agentId}
                  chosen={settings.repositories}
                  disabled={readOnly}
                  onPicked={async (catalogId, name) => {
                    edit((current) =>
                      current.repositories.includes(catalogId)
                        ? current
                        : {
                            ...current,
                            repositories: [...current.repositories, catalogId],
                          },
                    );
                    notify(t("agentGitHub.picked", { name }));
                    await cache.invalidateQueries({
                      queryKey: githubKey(client, agentId),
                    });
                  }}
                />
              ) : null}
              <Text as="span" variant="meta">
                {t("agentGitHub.repositoriesFoot")}
              </Text>
            </div>
          </Section>

          <details
            id={SECTION.details}
            tabIndex={-1}
            className="group scroll-mt-4 outline-none"
          >
            <summary className="cursor-pointer text-control font-medium">
              {t("agentGitHub.section.details")}
              <Text as="span" variant="meta" className="ml-2">
                {t("agentGitHub.detailsHint")}
              </Text>
            </summary>
            <div className="mt-4 flex flex-col gap-8">
              <Section
                id={DETAIL_ID.start}
                tabIndex={-1}
                className="scroll-mt-4 outline-none"
                title={t("agentGitHub.section.start")}
                badge={
                  <Badge variant="blue">{t("agentGitHub.badge.next")}</Badge>
                }
                description={t("agentGitHub.startHint")}
              >
                <div className={SECTION_BODY}>
                  <Field>
                    <FieldLabel>{t("agentGitHub.startLabel")}</FieldLabel>
                    <NativeSelect
                      value={start ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        edit(
                          (current) => current,
                          () =>
                            event.target.value === ""
                              ? null
                              : event.target.value,
                        )
                      }
                    >
                      <NativeSelectOption value="">
                        {t("agentGitHub.startNone")}
                      </NativeSelectOption>
                      {settings.repositories.map((id) => (
                        <NativeSelectOption key={id} value={id}>
                          {id}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
              </Section>

              <Section
                id={DETAIL_ID.permissions}
                tabIndex={-1}
                className="scroll-mt-4 outline-none"
                title={t("agentGitHub.section.permissions")}
                badge={
                  <Badge variant="blue">{t("agentGitHub.badge.next")}</Badge>
                }
                description={t("agentGitHub.permissionsHint")}
              >
                <div className={SECTION_BODY}>
                  <RowList variant="joined">
                    <SettingRow
                      title={t("agentGitHub.base")}
                      badge={
                        <Badge variant="gray">
                          {t("agentGitHub.badge.default")}
                        </Badge>
                      }
                      description={t("agentGitHub.baseHint")}
                      status={
                        <Text as="span" variant="sub">
                          {t("agentGitHub.baseState")}
                        </Text>
                      }
                    />
                    {FEATURES.map((feature) => {
                      const option = data.options.features[feature];
                      const on = settings.features[feature];
                      // GitHub refuses a review where the reviewer App is not installed.
                      const uninstalled =
                        feature === "review" && option.available
                          ? settings.repositories.filter(
                              (id) =>
                                data.options.repositories.find(
                                  (repository) => repository.id === id,
                                )?.installed.reviewer === false,
                            )
                          : [];
                      return (
                        <SettingRow
                          key={feature}
                          title={t(`agentGitHub.feature.${feature}`)}
                          badge={
                            uninstalled.length > 0 ? (
                              <Badge variant="amber">
                                {t("agentGitHub.appNotInstalled")}
                              </Badge>
                            ) : undefined
                          }
                          // A locked feature shows why in place of its hint, so
                          // every row keeps one detail line.
                          description={
                            option.reason ? (
                              <>
                                {t(
                                  `agentGitHub.featureReason.${option.reason}`,
                                )}{" "}
                                {option.reason ===
                                "github_host_unsupported" ? null : (
                                  <Link asChild>
                                    <RouterLink to="/settings/workspace/github">
                                      {t("agentGitHub.settingsLink")}
                                    </RouterLink>
                                  </Link>
                                )}
                              </>
                            ) : uninstalled.length > 0 ? (
                              <>
                                {t("agentGitHub.reviewerNotInstalled", {
                                  repositories: uninstalled.join(", "),
                                })}{" "}
                                <Link asChild>
                                  <RouterLink to="/settings/workspace/github">
                                    {t("agentGitHub.settingsLink")}
                                  </RouterLink>
                                </Link>
                              </>
                            ) : (
                              t(`agentGitHub.feature.${feature}Hint`)
                            )
                          }
                          status={
                            <Text as="span" variant="sub">
                              {t(on ? "agentGitHub.on" : "agentGitHub.off")}
                            </Text>
                          }
                          control={
                            <Switch
                              aria-label={t(`agentGitHub.feature.${feature}`)}
                              checked={on}
                              disabled={readOnly || (!option.available && !on)}
                              onCheckedChange={(checked) =>
                                edit((current) => ({
                                  ...current,
                                  features: {
                                    ...current.features,
                                    [feature]: checked,
                                  },
                                  // The release refuses a list with Actions off.
                                  ...(feature === "actions" && !checked
                                    ? { actions_allow: [] }
                                    : {}),
                                }))
                              }
                            />
                          }
                        />
                      );
                    })}
                  </RowList>
                  {settings.features.workflows && settings.features.actions ? (
                    <Alert variant="amber">
                      <AlertDescription>
                        {t("agentGitHub.workflowsActions")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  <Text as="span" variant="meta">
                    {t("agentGitHub.ceilingNote")}{" "}
                    <Link asChild>
                      <RouterLink to="/settings/workspace/github">
                        {t("agentGitHub.settingsLink")}
                      </RouterLink>
                    </Link>
                  </Text>
                </div>
              </Section>

              {actionsOn ? (
                <Section
                  id={DETAIL_ID.allowlist}
                  tabIndex={-1}
                  className="scroll-mt-4 outline-none"
                  title={t("agentGitHub.section.allowlist")}
                  badge={
                    <Badge variant="blue">{t("agentGitHub.badge.next")}</Badge>
                  }
                  description={t("agentGitHub.allowlistHint")}
                >
                  <div className={SECTION_BODY}>
                    {settings.actions_allow.length === 0 ? (
                      <Text as="span" variant="sub">
                        {t("agentGitHub.allowlistEmpty")}
                      </Text>
                    ) : (
                      <RowList
                        variant="joined"
                        aria-label={t("agentGitHub.section.allowlist")}
                      >
                        {settings.actions_allow.map((entry) => (
                          <SettingRow
                            key={`${entry.workflow}@${entry.ref ?? ""}`}
                            title={
                              <Code className="font-medium text-control">
                                {entry.workflow}
                              </Code>
                            }
                            badge={
                              base?.actions_allow.some((held) =>
                                sameEntry(held, entry),
                              ) ? undefined : (
                                <Badge variant="blue">
                                  {t("agentGitHub.badge.unsaved")}
                                </Badge>
                              )
                            }
                            description={
                              entry.ref === undefined
                                ? t("agentGitHub.refDefault")
                                : t("agentGitHub.refPattern", {
                                    ref: entry.ref,
                                  })
                            }
                            actions={
                              manages ? (
                                <RowAction
                                  disabled={readOnly}
                                  aria-label={t("agentGitHub.removeLabel", {
                                    workflow: entry.workflow,
                                  })}
                                  onClick={() =>
                                    edit((current) => ({
                                      ...current,
                                      actions_allow:
                                        current.actions_allow.filter(
                                          (held) => !sameEntry(held, entry),
                                        ),
                                    }))
                                  }
                                >
                                  {t("agentGitHub.remove")}
                                </RowAction>
                              ) : undefined
                            }
                          />
                        ))}
                      </RowList>
                    )}
                    {manages ? (
                      <AllowAdd
                        entries={settings.actions_allow}
                        disabled={readOnly}
                        onAdd={(entry) =>
                          edit((current) => ({
                            ...current,
                            actions_allow: [...current.actions_allow, entry],
                          }))
                        }
                      />
                    ) : null}
                    <Alert>
                      <AlertDescription>
                        {t("agentGitHub.allowlistNote")}
                      </AlertDescription>
                    </Alert>
                  </div>
                </Section>
              ) : null}

              <Section
                id={DETAIL_ID.push}
                tabIndex={-1}
                className="scroll-mt-4 outline-none"
                title={t("agentGitHub.section.push")}
                badge={
                  <Badge variant="blue">{t("agentGitHub.badge.next")}</Badge>
                }
              >
                <div className={SECTION_BODY}>
                  <RowList variant="joined">
                    <SettingRow
                      title={t("agentGitHub.pushApproval")}
                      description={t("agentGitHub.pushApprovalHint")}
                      status={
                        <Text as="span" variant="sub">
                          {t(
                            settings.push_approval
                              ? "agentGitHub.on"
                              : "agentGitHub.off",
                          )}
                        </Text>
                      }
                      control={
                        <Switch
                          aria-label={t("agentGitHub.pushApproval")}
                          checked={settings.push_approval}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            edit((current) => ({
                              ...current,
                              push_approval: checked,
                            }))
                          }
                        />
                      }
                    />
                  </RowList>
                  {settings.push_approval ? null : (
                    <Alert variant="amber">
                      <AlertDescription>
                        {t("agentGitHub.pushApprovalOff")}
                      </AlertDescription>
                    </Alert>
                  )}
                  <Field>
                    <FieldLabel>{t("agentGitHub.pushAttached")}</FieldLabel>
                    <NativeSelect
                      value={pushAttached}
                      disabled={readOnly}
                      aria-label={t("agentGitHub.pushAttached")}
                      onChange={(event) =>
                        edit(
                          (current) => current,
                          (s) => s,
                          event.target.value as PushAttached,
                        )
                      }
                    >
                      {PUSH_ATTACHED.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {t(`agentGitHub.pushAttached.${value}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Text as="span" variant="meta">
                      {t("agentGitHub.pushAttachedHint")}
                    </Text>
                  </Field>
                  {pushAttached === "allow" ? (
                    <Alert variant="amber">
                      <AlertDescription>
                        {t("agentGitHub.pushAttachedAllowNote")}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
              </Section>
            </div>
          </details>
        </div>
      ) : null}
      <Activity agentId={agentId} detail={detail} />
    </>
  );
}

const SECTION_LABEL = {
  use: "agentGitHub.section.use",
  repositories: "agentGitHub.section.repositories",
  details: "agentGitHub.section.details",
  activity: "agentGitHub.section.activity",
} as const satisfies Record<SectionKey, MessageKey>;

export default function GitHubTab({
  detail,
}: {
  readonly detail: AgentDetail;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const { notify, toast } = useToast();
  const agentId = detail.agent.id;
  const github = useQuery({
    queryKey: githubKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });
  const [keys, setKeys] = useState<readonly SectionKey[]>(["use", "activity"]);
  const [current, setCurrent] = useCurrentSection(keys.map((k) => SECTION[k]));
  const jumped = useRef<string>(undefined);
  const [fits, watchPage] = usePageFits();
  const sectionKeys = useRef((next: readonly SectionKey[]) =>
    setKeys((held) => (held.join() === next.join() ? held : next)),
  ).current;

  if (github.isPending) {
    return (
      <div className="flex min-h-96 flex-col gap-6" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (github.data === undefined) {
    return (
      <LoadFailure error={github.error} onRetry={() => void github.refetch()} />
    );
  }
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${SECTION[key]}`}
      current={current === SECTION[key] ? "location" : undefined}
      onClick={(event) => {
        // Stay off the URL hash: the router owns the location.
        event.preventDefault();
        const target = document.getElementById(SECTION[key]);
        target?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        target?.focus({ preventScroll: true });
        jumped.current = SECTION[key];
        setCurrent(SECTION[key]);
      }}
    >
      {t(SECTION_LABEL[key])}
    </SideNavLink>
  );
  const here = keys.find((key) => SECTION[key] === current);
  return (
    <>
      <SideNavLayout
        nav={
          <SideNav
            aria-label={t("agentGitHub.sectionNav")}
            className={fits ? "lg:hidden" : undefined}
            current={here ? t(SECTION_LABEL[here]) : undefined}
            onPick={() =>
              document
                .getElementById(jumped.current ?? "")
                ?.focus({ preventScroll: true })
            }
          >
            <SideNavGroup>
              {keys.filter((k) => k !== "activity").map(link)}
            </SideNavGroup>
            <SideNavGroup label={t("agentGitHub.manage")}>
              {keys.filter((k) => k === "activity").map(link)}
            </SideNavGroup>
          </SideNav>
        }
      >
        <div ref={watchPage} className="flex flex-col gap-8">
          {github.error ? (
            <LoadFailure
              error={github.error}
              kept
              onRetry={() => void github.refetch()}
            />
          ) : null}
          <GitHubSettings
            agentId={agentId}
            detail={detail}
            data={github.data}
            notify={notify}
            sectionKeys={sectionKeys}
          />
          <AgentPullRequestSettingsCard agentId={agentId} notify={notify} />
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}
