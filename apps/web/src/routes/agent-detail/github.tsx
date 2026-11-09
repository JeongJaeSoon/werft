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
  cn,
  DangerZone,
  DangerZoneRow,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Heading,
  IconTile,
  Input,
  Link,
  NativeSelect,
  NativeSelectOption,
  RelativeTime,
  RowAction,
  RowList,
  SettingRow,
  SettingsSection,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
  Text,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { GitHubMark } from "../../components/brand-marks.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import { type Notify, useToast } from "../../components/toast.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../../i18n/i18n.tsx";
import { SECTIONS, SETTINGS_CARD } from "../workspace-settings.tsx";
import {
  githubKey,
  receiptTitle,
  useAgentGitHubActivity,
} from "./github-activity.ts";
import {
  AgentPullRequestSettingsCard,
  PULL_REQUEST_SECTION,
} from "./github-pull-request.tsx";
import { RepositoryList } from "./github-repositories.tsx";
import { useRepositoryToggles } from "./github-repository-toggles.ts";
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

// The workspace's Integrations > GitHub order (GitHub with the repositories
// under it, features, pull requests), then what only an agent has: push
// approval, its receipts and the danger zone.
const SECTION = {
  github: "github-overview",
  repositories: "github-repositories",
  features: "github-features",
  pullRequest: PULL_REQUEST_SECTION,
  push: "github-push",
  activity: "github-activity",
  danger: "github-danger",
} as const;
// Under the features section; not in the side nav.
const ALLOWLIST_ID = "github-allowlist";
type SectionKey = keyof typeof SECTION;
const MANAGE_KEYS: readonly SectionKey[] = ["activity", "danger"];
// Workflow | ref pattern | remove; narrow, the ref moves under the workflow.
const ALLOW_COLUMNS = "minmax(0,1fr) minmax(0,1fr) 88px";
const ALLOW_COLUMNS_READ = "minmax(0,1fr) minmax(0,1fr)";
const ALLOW_NARROW = "minmax(0,1fr) 88px";
const ALLOW_NARROW_READ = "minmax(0,1fr)";
const WIDE_ONLY_480 = "[@container(min-width:480px)]:hidden";
// Receipt (what, with its detail line under it) | when.
const ACTIVITY_COLUMNS = "minmax(0,1fr) 112px";
const FOCUS_TARGET = "scroll-mt-4 outline-none";
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

export function pendingCount(
  base: Settings,
  draft: Settings,
  basePushAttached: PushAttached = "ask",
  draftPushAttached: PushAttached = basePushAttached,
): number {
  return (
    Number(basePushAttached !== draftPushAttached) +
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
  repository,
}: {
  readonly receipt: Receipt;
  readonly detail: AgentDetail;
  readonly repository: string | undefined;
}) {
  const { t, locale } = useI18n();
  const result = (receipt.result ?? {}) as {
    session_id?: string;
    release_id?: string;
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
    repository ?? null,
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
  const detailLine =
    parts.length > 0 || result.session_id ? (
      <Text as="span" variant="sub" className="[overflow-wrap:anywhere]">
        {parts.join(" · ")}
        {result.session_id ? (
          <>
            {parts.length > 0 ? " · " : null}
            <Link asChild>
              <RouterLink to="/sessions/$id" params={{ id: result.session_id }}>
                {t("agentGitHub.activity.session")}{" "}
                <Code>{result.session_id.slice(0, 8)}</Code>
              </RouterLink>
            </Link>
          </>
        ) : null}
      </Text>
    ) : null;
  return (
    <GridTableRow>
      <GridTableCell>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="span" weight="medium">
              {receiptTitle(receipt, t)}
            </Text>
            {receipt.status === "failed" ? (
              <Badge variant="red">{t("agentGitHub.refused")}</Badge>
            ) : null}
          </div>
          {detailLine}
        </div>
      </GridTableCell>
      <GridTableCell align="end">
        <RelativeTime
          value={receipt.created_at}
          locale={locale}
          className="text-caption text-muted-foreground"
        />
      </GridTableCell>
    </GridTableRow>
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
  const repositories = new Map(
    (activity.data?.receipt_repositories ?? []).map((held) => [
      held.receipt_id,
      held.repository,
    ]),
  );
  return (
    <div id={SECTION.activity} tabIndex={-1} className={FOCUS_TARGET}>
      <SettingsSection
        title={t("agentGitHub.section.activity")}
        description={t("agentGitHub.activityHint")}
      >
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
          <div className="rounded-card border bg-card p-4">
            <Text as="span" variant="sub">
              {t("agentGitHub.activityEmpty")}
            </Text>
          </div>
        ) : (
          <GridTable
            aria-label={t("agentGitHub.section.activity")}
            columns={ACTIVITY_COLUMNS}
            framed
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("agentGitHub.table.receipt")}
              </GridTableColumnHeader>
              <GridTableColumnHeader align="end">
                {t("agentGitHub.table.at")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {activity.data.items.map((receipt) => (
              <ReceiptRow
                key={receipt.id}
                receipt={receipt}
                detail={detail}
                repository={repositories.get(receipt.id)}
              />
            ))}
          </GridTable>
        )}
      </SettingsSection>
    </div>
  );
}

/** Turning GitHub on or off for the agent: on in the header, off in the danger zone. */
function useEnabled(agentId: string, notify: Notify) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
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
  return { update, confirming, setConfirming };
}

function TileMark({ className }: { readonly className?: string }) {
  return (
    <GitHubMark
      className={cn(className, "text-(--werft-color-tile-foreground)")}
    />
  );
}

function AllowAddDialog({
  open,
  onOpenChange,
  entries,
  onAdd,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly entries: readonly AllowEntry[];
  readonly onAdd: (entry: AllowEntry) => void;
}) {
  const { t } = useI18n();
  const ids = { workflow: useId(), ref: useId(), refHint: useId() };
  const [workflow, setWorkflow] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const reset = () => {
    setWorkflow("");
    setRef("");
    setError(null);
  };
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
    reset();
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("agentGitHub.add")}</DialogTitle>
          <DialogDescription>
            {t("agentGitHub.allowlistHint")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field>
            <FieldLabel htmlFor={ids.workflow}>
              {t("agentGitHub.workflow")}
            </FieldLabel>
            <Input
              id={ids.workflow}
              value={workflow}
              placeholder="release.yml"
              className="font-mono"
              onChange={(event) => setWorkflow(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.ref}>{t("agentGitHub.ref")}</FieldLabel>
            <Input
              id={ids.ref}
              value={ref}
              placeholder="release/*"
              className="font-mono"
              aria-describedby={ids.refHint}
              onChange={(event) => setRef(event.target.value)}
            />
            <Text as="span" variant="meta" id={ids.refHint}>
              {t("agentGitHub.refHint")}
            </Text>
          </Field>
          {error ? <FieldError>{t(error)}</FieldError> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("agentGitHub.addSubmit")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
  const toggles = useRepositoryToggles(agentId);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The settings the server holds, or what a first save starts from.
  const base = draft?.from.base ?? data.github ?? data.legacy_defaults;
  // `null` is a real start value, so `??` would swap it for the server's.
  const baseStart = draft ? draft.from.start : data.start_repository_id;
  const basePushAttached = draft ? draft.from.pushAttached : data.push_attached;
  const settings = draft?.settings ?? base;
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
    nextAttached: PushAttached = pushAttached,
  ) => {
    if (readOnly || !settings || !base) return;
    const next = change(settings);
    // Undone by hand: drop the draft so the tab follows the agent again.
    if (pendingCount(base, next, basePushAttached, nextAttached) === 0) {
      setDraft(null);
      return;
    }
    setDraft({
      settings: next,
      start: baseStart,
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
      ? pendingCount(base, draft.settings, basePushAttached, draft.pushAttached)
      : 0;
  // A first save turns the github MCP on whatever else it changes, so it
  // keeps its own title instead of a change count.
  const pendingTitle = firstSave
    ? t("agentGitHub.pending.firstTitle")
    : t("agentGitHub.pending.title", { count: pending });
  const actionsOn = settings?.features.actions ?? false;
  const keys: SectionKey[] = [
    "github",
    ...(settings ? (["repositories", "features"] as const) : []),
    "pullRequest",
    ...(settings ? (["push"] as const) : []),
    "activity",
    ...(manages && data.enabled ? (["danger"] as const) : []),
  ];
  // Joined, so a new array with the same sections does not report again.
  const joined = keys.join();
  useLayoutEffect(
    () => sectionKeys(joined.split(",") as SectionKey[]),
    [sectionKeys, joined],
  );
  const enabled = useEnabled(agentId, notify);
  const [adding, setAdding] = useState(false);
  const titleId = useId();
  const settingsLink = (
    <Link asChild>
      <RouterLink to="/settings/workspace/integrations/github">
        {t("agentGitHub.settingsLink")}
      </RouterLink>
    </Link>
  );
  const onOff = (on: boolean) => (
    <Text as="span" variant="sub">
      {t(on ? "agentGitHub.on" : "agentGitHub.off")}
    </Text>
  );
  // Turning on fails under the header; turning off, in the danger zone.
  const enableError =
    enabled.update.error && !enabled.confirming && !data.enabled ? (
      <FieldError>{failure(enabled.update.error, t)}</FieldError>
    ) : null;

  return (
    <>
      {/* The workspace's GitHub card: the connection, then the repositories. */}
      <section
        id={SECTION.github}
        tabIndex={-1}
        aria-labelledby={titleId}
        className={cn(SECTIONS, FOCUS_TARGET)}
      >
        <div className={SETTINGS_CARD}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
            <IconTile icon={TileMark} hue="slate" size="two-line" />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-2">
                <Heading id={titleId} level={2}>
                  GitHub
                </Heading>
                <Badge variant={data.enabled ? "green" : "gray"}>
                  {t(
                    data.enabled
                      ? "agentGitHub.state.on"
                      : "agentGitHub.state.off",
                  )}
                </Badge>
              </div>
              <Text variant="sub">
                {[
                  base === null || data.github === null
                    ? t("agentGitHub.status.repositoriesLegacy")
                    : t("agentGitHub.status.repositories", {
                        count: data.github.repositories.length,
                      }),
                  `${t("agentGitHub.status.pushApproval")} ${
                    base
                      ? t(
                          // A release without settings still asks a person,
                          // whatever a first save would start from.
                          data.github === null || base.push_approval
                            ? "agentGitHub.on"
                            : "agentGitHub.off",
                        )
                      : "—"
                  }`,
                ].join(" · ")}
              </Text>
            </div>
            {manages && !data.enabled ? (
              <Button
                type="button"
                size="sm"
                aria-disabled={enabled.update.isPending || undefined}
                onClick={() => {
                  if (!enabled.update.isPending) enabled.update.mutate(true);
                }}
              >
                {t("agentGitHub.turnOn")}
              </Button>
            ) : null}
          </div>
          <Text variant="sub">{t("agentGitHub.overviewHint")}</Text>
          {enableError}
          {data.enabled ? null : (
            <Text as="span" variant="sub">
              {t("agentGitHub.offNote")}
            </Text>
          )}
        </div>
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
                <div
                  ref={saveError}
                  tabIndex={-1}
                  className="mt-2 outline-none"
                >
                  <FieldError>{saveFailure}</FieldError>
                </div>
              ) : null}
            </AlertDescription>
            <AlertActions>
              <Button
                type="button"
                size="sm"
                disabled={
                  (pending === 0 && !firstSave) ||
                  stale ||
                  save.isPending ||
                  toggles.pending
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
        {settings ? (
          <div id={SECTION.repositories} tabIndex={-1} className={FOCUS_TARGET}>
            <SettingsSection
              titleAs="h3"
              title={t("github.repos.title")}
              description={t("agentGitHub.repositoriesHint")}
            >
              {data.options.repository_ceiling_unset ? (
                <Text as="span" variant="sub">
                  {t("agentGitHub.ceilingUnset")}
                </Text>
              ) : null}
              <RepositoryList
                agentId={agentId}
                data={data}
                chosen={
                  (data.github ?? data.legacy_defaults)?.repositories ?? []
                }
                manages={manages}
                editable={editable}
                toggles={toggles}
              />
              <Text as="span" variant="meta">
                {t("agentGitHub.repositoriesFoot")}
              </Text>
            </SettingsSection>
          </div>
        ) : null}
      </section>

      {settings ? (
        <div id={SECTION.features} tabIndex={-1} className={FOCUS_TARGET}>
          <SettingsSection
            title={t("github.ceiling.title")}
            description={t("agentGitHub.permissionsHint")}
          >
            <RowList variant="joined">
              <SettingRow
                title={t("agentGitHub.base")}
                badge={
                  <Badge variant="gray">{t("agentGitHub.badge.default")}</Badge>
                }
                description={t("agentGitHub.baseHint")}
                actions={
                  <Text as="div" variant="meta">
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
                    ? data.options.repositories
                        .filter(
                          (repository) =>
                            settings.repositories.includes(repository.id) &&
                            repository.installed.reviewer === false,
                        )
                        .map(
                          (repository) =>
                            repository.repository ?? repository.url,
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
                          {t(`agentGitHub.featureReason.${option.reason}`)}{" "}
                          {option.reason === "github_host_unsupported"
                            ? null
                            : settingsLink}
                        </>
                      ) : uninstalled.length > 0 ? (
                        <>
                          {t("agentGitHub.reviewerNotInstalled", {
                            repositories: uninstalled.join(", "),
                          })}{" "}
                          {settingsLink}
                        </>
                      ) : (
                        t(`agentGitHub.feature.${feature}Hint`)
                      )
                    }
                    status={onOff(on)}
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
              {t("agentGitHub.ceilingNote")} {settingsLink}
            </Text>
            {actionsOn ? (
              <div id={ALLOWLIST_ID} tabIndex={-1} className={FOCUS_TARGET}>
                <SettingsSection
                  titleAs="h3"
                  title={t("agentGitHub.section.allowlist")}
                  description={t("agentGitHub.allowlistHint")}
                  actions={
                    manages ? (
                      <Button
                        type="button"
                        size="sm"
                        aria-haspopup="dialog"
                        disabled={readOnly}
                        onClick={() => setAdding(true)}
                      >
                        <Plus aria-hidden="true" strokeWidth={1.5} />
                        {t("agentGitHub.add")}
                      </Button>
                    ) : null
                  }
                >
                  {settings.actions_allow.length === 0 ? (
                    <div className="rounded-card border bg-card p-4">
                      <Text as="span" variant="sub">
                        {t("agentGitHub.allowlistEmpty")}
                      </Text>
                    </div>
                  ) : (
                    <GridTable
                      aria-label={t("agentGitHub.section.allowlist")}
                      columns={manages ? ALLOW_COLUMNS : ALLOW_COLUMNS_READ}
                      narrowAt={480}
                      narrowColumns={manages ? ALLOW_NARROW : ALLOW_NARROW_READ}
                      framed
                    >
                      <GridTableHeader>
                        <GridTableColumnHeader>
                          {t("agentGitHub.table.workflow")}
                        </GridTableColumnHeader>
                        <GridTableColumnHeader hideNarrow>
                          {t("agentGitHub.table.ref")}
                        </GridTableColumnHeader>
                        {manages ? (
                          <GridTableColumnHeader action>
                            <span className="sr-only">
                              {t("agentGitHub.table.remove")}
                            </span>
                          </GridTableColumnHeader>
                        ) : null}
                      </GridTableHeader>
                      {settings.actions_allow.map((entry) => {
                        const refText =
                          entry.ref === undefined
                            ? t("agentGitHub.refDefault")
                            : t("agentGitHub.refPattern", { ref: entry.ref });
                        return (
                          <GridTableRow
                            key={`${entry.workflow}@${entry.ref ?? ""}`}
                          >
                            <GridTableCell>
                              <div className="flex min-w-0 flex-col gap-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <Code className="font-medium text-control [overflow-wrap:anywhere]">
                                    {entry.workflow}
                                  </Code>
                                  {base?.actions_allow.some((held) =>
                                    sameEntry(held, entry),
                                  ) ? null : (
                                    <Badge variant="blue">
                                      {t("agentGitHub.badge.unsaved")}
                                    </Badge>
                                  )}
                                </div>
                                <Text
                                  as="span"
                                  variant="meta"
                                  className={WIDE_ONLY_480}
                                >
                                  {refText}
                                </Text>
                              </div>
                            </GridTableCell>
                            <GridTableCell hideNarrow>
                              <Text
                                as="span"
                                variant="sub"
                                className="[overflow-wrap:anywhere]"
                              >
                                {refText}
                              </Text>
                            </GridTableCell>
                            {manages ? (
                              <GridTableCell align="end">
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
                              </GridTableCell>
                            ) : null}
                          </GridTableRow>
                        );
                      })}
                    </GridTable>
                  )}
                  <Alert>
                    <AlertDescription>
                      {t("agentGitHub.allowlistNote")}
                    </AlertDescription>
                  </Alert>
                </SettingsSection>
                <AllowAddDialog
                  open={adding}
                  onOpenChange={setAdding}
                  entries={settings.actions_allow}
                  onAdd={(entry) =>
                    edit((current) => ({
                      ...current,
                      actions_allow: [...current.actions_allow, entry],
                    }))
                  }
                />
              </div>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      <AgentPullRequestSettingsCard agentId={agentId} notify={notify} />

      {settings ? (
        <div id={SECTION.push} tabIndex={-1} className={FOCUS_TARGET}>
          <SettingsSection
            title={t("agentGitHub.section.push")}
            description={t("agentGitHub.pushHint")}
          >
            <RowList variant="joined">
              <SettingRow
                title={t("agentGitHub.pushApproval")}
                description={t("agentGitHub.pushApprovalHint")}
                status={onOff(settings.push_approval)}
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
              <PushAttachedRow
                value={pushAttached}
                disabled={readOnly}
                onChange={(next) => edit((current) => current, next)}
              />
            </RowList>
            {settings.push_approval ? null : (
              <Alert variant="amber">
                <AlertDescription>
                  {t("agentGitHub.pushApprovalOff")}
                </AlertDescription>
              </Alert>
            )}
            {pushAttached === "allow" ? (
              <Alert variant="amber">
                <AlertDescription>
                  {t("agentGitHub.pushAttachedAllowNote")}
                </AlertDescription>
              </Alert>
            ) : null}
          </SettingsSection>
        </div>
      ) : null}

      <Activity agentId={agentId} detail={detail} />

      {manages && data.enabled ? (
        <DangerZone
          id={SECTION.danger}
          tabIndex={-1}
          className={FOCUS_TARGET}
          title={t("agentGitHub.danger")}
        >
          <DangerZoneRow
            title={t("agentGitHub.disableRow")}
            description={t("agentGitHub.enabledHint")}
            actionLabel={t("agentGitHub.disableConfirm")}
            actionName={t("agentGitHub.disableRow")}
            disabled={enabled.update.isPending}
            onAction={() => enabled.setConfirming(true)}
          />
        </DangerZone>
      ) : null}
      {enabled.update.error && !enabled.confirming && data.enabled ? (
        <FieldError>{failure(enabled.update.error, t)}</FieldError>
      ) : null}
      <ConfirmDialog
        open={enabled.confirming}
        onOpenChange={enabled.setConfirming}
        title={t("agentGitHub.disableTitle")}
        consequence={t("agentGitHub.disableBody")}
        confirmLabel={t("agentGitHub.disableConfirm")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={enabled.update.isPending}
        onConfirm={() => enabled.update.mutate(false)}
      >
        {enabled.update.error ? (
          <FieldError>{failure(enabled.update.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function PushAttachedRow({
  value,
  disabled,
  onChange,
}: {
  readonly value: PushAttached;
  readonly disabled: boolean;
  readonly onChange: (next: PushAttached) => void;
}): ReactNode {
  const { t } = useI18n();
  const hintId = useId();
  return (
    <SettingRow
      title={t("agentGitHub.pushAttached")}
      description={<span id={hintId}>{t("agentGitHub.pushAttachedHint")}</span>}
      control={
        <NativeSelect
          size="sm"
          value={value}
          disabled={disabled}
          aria-label={t("agentGitHub.pushAttached")}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value as PushAttached)}
        >
          {PUSH_ATTACHED.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {t(`agentGitHub.pushAttached.${option}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      }
    />
  );
}

const SECTION_LABEL = {
  github: "agentGitHub.section.github",
  repositories: "github.repos.title",
  features: "github.ceiling.title",
  pullRequest: "github.pullRequest.title",
  push: "agentGitHub.section.push",
  activity: "agentGitHub.section.activity",
  danger: "agentGitHub.danger",
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
  const [keys, setKeys] = useState<readonly SectionKey[]>([
    "github",
    "pullRequest",
    "activity",
  ]);
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
              {keys.filter((k) => !MANAGE_KEYS.includes(k)).map(link)}
            </SideNavGroup>
            <SideNavGroup label={t("agentGitHub.manage")}>
              {keys.filter((k) => MANAGE_KEYS.includes(k)).map(link)}
            </SideNavGroup>
          </SideNav>
        }
      >
        <div ref={watchPage} className={SECTIONS}>
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
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}
