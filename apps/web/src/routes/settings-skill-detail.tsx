import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type {
  CheckSkillResponse,
  PutSkillAttachmentRequest,
  Skill,
  SkillAttachmentResponse,
  SkillGitSource,
  SkillSyncCheck,
  SkillSyncResponse,
  SkillSyncTrigger,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Code,
  EmptyState,
  Field,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  NativeSelect,
  NativeSelectOption,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RelativeTime,
  RowAction,
  SettingRow,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { useEffect, useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { SkillSourceIcon } from "../components/skill-source.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";
import { useSkillWrite } from "./settings-skills.tsx";
import {
  type AttachMode,
  attachable,
  digestShort,
  MODE_LABEL,
  MODES,
  REVIEW_BADGE,
  REVIEW_LABEL,
  skillsQuery,
  versionLabel,
} from "./skills-data.ts";

const LIST = "/settings/workspace/skills";
const QUEUED_POLL_MS = 3_000;
const QUEUED_WAIT_MS = 2 * 60_000;
// The version select's value for "keeps following the current version".
const FOLLOW = "follow";

const TRIGGER_LABEL = {
  register: "skills.sync.trigger.register",
  webhook: "skills.sync.trigger.webhook",
  daily: "skills.sync.trigger.daily",
  manual: "skills.sync.trigger.manual",
  resume: "skills.sync.trigger.resume",
} as const satisfies Record<SkillSyncTrigger["kind"], string>;

export const RESULT_LABEL = {
  created: "skills.sync.result.created",
  unchanged: "skills.sync.result.unchanged",
  source_missing: "skills.sync.result.source_missing",
  rejected: "skills.sync.result.rejected",
  github_unavailable: "skills.sync.result.github_unavailable",
  paused: "skills.sync.result.paused",
} as const satisfies Record<SkillSyncCheck["result"], string>;

const WEBHOOK_NOTICE = {
  no_public_url: "skills.sync.webhook.no_public_url",
  no_secret: "skills.sync.webhook.no_secret",
} as const satisfies Record<
  Exclude<SkillGitSource["webhook"], "ready">,
  string
>;

export const triggerText = (t: Translate, trigger: SkillSyncTrigger) =>
  t(TRIGGER_LABEL[trigger.kind]);

// version, source, review, registered, actions; a phone keeps the version
// (with its review) and the actions.
const VERSION_COLUMNS = [
  "minmax(0,1fr) minmax(0,1fr) max-content max-content max-content",
  "minmax(0,1fr) max-content",
] as const;

export function SkillDetailScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const { name } = useParams({
    from: "/authed/settings/workspace/skills/$name",
  });
  const skills = useQuery(skillsQuery(client));
  const skill = skills.data?.items.find((item) => item.name === name);
  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to={LIST} activeOptions={{ exact: true }}>
          {t("skills.title")}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{name}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
  if (skills.isPending)
    return (
      <Page title={name} breadcrumb={breadcrumb}>
        <Skeleton width="60%" label={t("status.loading.title")} />
      </Page>
    );
  if (skills.isError)
    return (
      <Page title={name} breadcrumb={breadcrumb}>
        <LoadFailure
          error={skills.error}
          onRetry={() => void skills.refetch()}
        />
      </Page>
    );
  if (skill === undefined)
    return (
      <Page title={name} breadcrumb={breadcrumb}>
        <EmptyState framed title={t("skills.notFound")} />
      </Page>
    );
  return (
    <Page
      title={name}
      breadcrumb={breadcrumb}
      actions={<SkillSourceIcon source={skill.source} />}
    >
      <div className="flex flex-col gap-[var(--werft-space-section)]">
        {skill.git ? (
          <SyncPanel
            key={skill.name}
            name={skill.name}
            git={skill.git}
            readAt={skills.dataUpdatedAt}
          />
        ) : null}
        {/* Keyed so a move to another skill starts its form afresh. */}
        <WorkspaceAttachment key={skill.name} skill={skill} />
        <Versions skill={skill} readAt={skills.dataUpdatedAt} />
      </div>
    </Page>
  );
}

function SyncPanel({
  name,
  git,
  readAt,
}: {
  readonly name: string;
  readonly git: SkillGitSource;
  readonly readAt: number;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("workspace.manage");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const refused = (text: string) => setOutcome({ kind: "error", text });
  // `queued` means a check is running and this one runs once more after it:
  // the last check moves twice, the second time with the asked-for result.
  // Read the list again until then, for at most QUEUED_WAIT_MS.
  const lastAt = git.last_check?.at ?? null;
  const [queued, setQueued] = useState<{
    readonly seen: string | null;
    readonly moves: number;
    readonly until: number;
  } | null>(null);
  useEffect(() => {
    if (queued === null || lastAt === queued.seen) return;
    setQueued(
      queued.moves + 1 >= 2
        ? null
        : { ...queued, seen: lastAt, moves: queued.moves + 1 },
    );
  }, [queued, lastAt]);
  useQuery({
    ...skillsQuery(client),
    refetchInterval: () =>
      queued !== null && Date.now() < queued.until ? QUEUED_POLL_MS : false,
  });
  const waitQueued = () =>
    setQueued({ seen: lastAt, moves: 0, until: Date.now() + QUEUED_WAIT_MS });
  const check = useSkillWrite(
    () =>
      unwrap(
        client.POST("/v1/workspace/skills/{name}/sync/check", {
          params: { path: { name } },
        }),
      ) as Promise<CheckSkillResponse>,
    {
      onDone: (answer) => {
        if (answer.outcome === "queued") waitQueued();
        setOutcome({
          kind: "notice",
          text:
            answer.outcome === "queued" || answer.last_check === null
              ? t("skills.sync.queued")
              : t("skills.sync.checked", {
                  result: t(RESULT_LABEL[answer.last_check.result]),
                }),
        });
      },
      onRefused: refused,
    },
  );
  const toggle = useSkillWrite(
    (enabled: boolean) =>
      unwrap(
        client.PUT("/v1/workspace/skills/{name}/sync", {
          params: {
            path: { name },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { enabled },
        }),
      ) as Promise<SkillSyncResponse>,
    {
      onDone: (answer, enabled) => {
        // Resuming checks once; behind a running check that one is queued
        // and the answer still carries the old last check.
        if (
          enabled &&
          answer.receipt_id !== null &&
          (answer.git.last_check?.at ?? null) === lastAt
        )
          waitQueued();
        setOutcome({
          kind: "notice",
          text: t(
            enabled ? "skills.sync.resumed.done" : "skills.sync.paused.done",
          ),
        });
      },
      onRefused: refused,
    },
  );
  const busy = check.isPending || toggle.isPending;
  const last = git.last_check;
  const where = t("skills.sync.sourceValue", {
    repository: git.repository,
    path: git.path === "" ? t("skills.sync.root") : git.path,
    ref: git.ref,
  });
  return (
    <SettingsSection
      title={t("skills.sync.title")}
      description={t("skills.sync.description")}
      rows={
        <>
          <SettingRow
            title={t("skills.sync.source")}
            meta={<Code className="wrap-anywhere">{where}</Code>}
          />
          <SettingRow
            title={t("skills.sync.state")}
            badge={
              <Badge variant={git.sync_enabled ? "green" : "gray"}>
                {t(git.sync_enabled ? "skills.sync.on" : "skills.sync.paused")}
              </Badge>
            }
            description={
              git.sync_enabled ? undefined : t("skills.sync.pausedHint")
            }
            actions={
              manages ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => toggle.mutate(!git.sync_enabled)}
                >
                  {toggle.isPending
                    ? t(
                        git.sync_enabled
                          ? "skills.sync.pausing"
                          : "skills.sync.resuming",
                      )
                    : t(
                        git.sync_enabled
                          ? "skills.sync.pause"
                          : "skills.sync.resume",
                      )}
                </Button>
              ) : undefined
            }
          />
          <SettingRow
            title={t("skills.sync.lastCheck")}
            meta={
              last === null ? (
                t("skills.sync.never")
              ) : (
                <Text as="span" variant="meta" className="wrap-anywhere">
                  <RelativeTime value={last.at} locale={locale} now={readAt} />
                  {" · "}
                  {t("skills.sync.lastCheckValue", {
                    trigger: triggerText(t, last.trigger),
                    result: t(RESULT_LABEL[last.result]),
                  })}
                  {last.commit ? ` · ${last.commit.slice(0, 12)}` : ""}
                </Text>
              )
            }
            actions={
              manages ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => check.mutate(undefined)}
                >
                  {check.isPending
                    ? t("skills.sync.checking")
                    : t("skills.sync.checkNow")}
                </Button>
              ) : undefined
            }
          />
        </>
      }
    >
      <OutcomeLine outcome={outcome} live />
      {git.webhook === "ready" ? null : (
        <Alert variant="amber" role="status">
          <AlertDescription>{t(WEBHOOK_NOTICE[git.webhook])}</AlertDescription>
        </Alert>
      )}
    </SettingsSection>
  );
}

function WorkspaceAttachment({ skill }: { readonly skill: Skill }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const manages = useHasPermission("workspace.manage");
  const attached = skill.workspace_attachment;
  const version = skill.versions.find(
    (item) => item.id === attached?.version_id,
  );
  const [mode, setMode] = useState<AttachMode>(attached?.mode ?? "required");
  // Start on what the workspace names now, so changing only the mode keeps
  // the version, or keeps following; the newest one otherwise.
  const [versionId, setVersionId] = useState(() =>
    attached?.follows
      ? FOLLOW
      : (attached?.version_id ?? attachable(skill, mode)[0]?.id ?? ""),
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const refused = (text: string) => setOutcome({ kind: "error", text });
  const versions = attachable(skill, mode);
  // Only an attachment that follows already may keep doing so here; starting
  // to follow is a later screen's. Forbidden cannot follow.
  const followable = attached?.follows === true && mode !== "forbidden";
  // The list may have moved (a new approval, an archive) since the pick.
  const picked =
    versionId === FOLLOW && followable
      ? FOLLOW
      : versions.some((item) => item.id === versionId)
        ? versionId
        : (versions[0]?.id ?? "");
  const save = useSkillWrite(
    (body: PutSkillAttachmentRequest) =>
      unwrap(
        client.PUT("/v1/workspace/skills/{name}/attachment", {
          params: { path: { name: skill.name } },
          body,
        }),
      ) as Promise<SkillAttachmentResponse>,
    {
      onDone: () =>
        setOutcome({
          kind: "notice",
          text: t("agentSkills.saved", { name: skill.name }),
        }),
      onRefused: refused,
    },
  );
  const detach = useSkillWrite(
    () =>
      unwrap(
        client.DELETE("/v1/workspace/skills/{name}/attachment", {
          params: { path: { name: skill.name } },
        }),
      ) as Promise<SkillAttachmentResponse>,
    {
      onDone: () =>
        setOutcome({
          kind: "notice",
          text: t("agentSkills.removed", { name: skill.name }),
        }),
      onRefused: refused,
    },
  );
  const busy = save.isPending || detach.isPending;
  return (
    <SettingsSection
      title={t("skills.workspace.title")}
      description={t("skills.workspace.description")}
      onSubmit={(event) => {
        event.preventDefault();
        if (picked === "" || busy) return;
        save.mutate(
          picked === FOLLOW && mode !== "forbidden"
            ? { follow: true, mode }
            : { version_id: picked, mode },
        );
      }}
      rows={
        <SettingRow
          title={t("skills.workspace.scope")}
          meta={
            attached === null
              ? t("skills.workspace.none")
              : t("skills.workspace.value", {
                  mode: t(MODE_LABEL[attached.mode]),
                  version: attached.follows
                    ? t("skills.workspace.follows")
                    : version
                      ? versionLabel(t, version)
                      : "",
                })
          }
          actions={
            manages && attached !== null ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => detach.mutate(undefined)}
              >
                {t("agentSkills.remove")}
              </Button>
            ) : undefined
          }
        />
      }
      foot={
        manages ? (
          <div className="flex w-full min-w-0 flex-col gap-3">
            <OutcomeLine outcome={outcome} live />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel>{t("agentSkills.version")}</FieldLabel>
                <NativeSelect
                  value={picked}
                  disabled={versions.length === 0 && !followable}
                  onChange={(event) => setVersionId(event.target.value)}
                >
                  {followable ? (
                    <NativeSelectOption value={FOLLOW}>
                      {t("skills.workspace.follows")}
                    </NativeSelectOption>
                  ) : null}
                  {versions.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {versionLabel(t, item)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel>{t("agentSkills.mode")}</FieldLabel>
                <NativeSelect
                  value={mode}
                  onChange={(event) =>
                    setMode(event.target.value as AttachMode)
                  }
                >
                  {MODES.map((item) => (
                    <NativeSelectOption key={item} value={item}>
                      {t(MODE_LABEL[item])}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <div>
              <Button
                type="submit"
                variant="outline"
                disabled={picked === "" || busy}
              >
                {save.isPending
                  ? t("agentSkills.saving")
                  : t("agentSkills.save")}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    />
  );
}

function Versions({
  skill,
  readAt,
}: {
  readonly skill: Skill;
  readonly readAt: number;
}) {
  const { t, locale } = useI18n();
  // The files read behind the link needs workspace.manage.
  const manages = useHasPermission("workspace.manage");
  // Newest first: the one awaiting review is the one read.
  const versions = [...skill.versions].reverse();
  return (
    <SettingsSection
      title={t("skills.versions.title")}
      description={t("skills.versions.description")}
    >
      <GridTable
        className="[--werft-row-padding-x:var(--werft-space-4)]"
        aria-label={t("skills.versions.title")}
        columns={VERSION_COLUMNS[0]}
        align={["start", "start", "start", "start", "action"]}
        narrowAt={640}
        narrowColumns={VERSION_COLUMNS[1]}
        framed
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("skills.versions.column.version")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("skills.versions.column.source")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("skills.versions.column.review")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow>
            {t("skills.versions.column.registered")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("skills.versions.column.actions")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {versions.map((version) => {
          const label = versionLabel(t, version);
          const review = (
            <Badge variant={REVIEW_BADGE[version.review]}>
              {t(REVIEW_LABEL[version.review])}
            </Badge>
          );
          const pending =
            version.review === "pending" && version.archived_at === null;
          return (
            <GridTableRow key={version.id}>
              <GridTableCell>
                <div className="flex min-w-0 flex-col items-start gap-[var(--werft-row-line-gap)]">
                  <Code className="wrap-anywhere">{label}</Code>
                  <div className="flex flex-wrap gap-1 [@container(min-width:641px)]:hidden">
                    {review}
                  </div>
                  {version.archived_at ? (
                    <Badge>{t("skills.archived")}</Badge>
                  ) : null}
                </div>
              </GridTableCell>
              <GridTableCell hideNarrow>
                <Text as="span" variant="meta" className="wrap-anywhere">
                  {version.git
                    ? t("skills.versions.commit", {
                        commit: digestShort(version.git.commit),
                      })
                    : t("skills.versions.upload")}
                </Text>
              </GridTableCell>
              <GridTableCell hideNarrow>{review}</GridTableCell>
              <GridTableCell hideNarrow>
                <Text as="span" variant="meta">
                  <RelativeTime
                    value={version.registered_at}
                    locale={locale}
                    now={readAt}
                  />
                </Text>
              </GridTableCell>
              <GridTableCell>
                {manages ? (
                  <RowAction
                    asChild
                    aria-label={t(
                      pending
                        ? "skills.versions.reviewFor"
                        : "skills.versions.filesFor",
                      { version: label },
                    )}
                  >
                    <Link
                      to="/settings/workspace/skills/$name/versions/$versionId"
                      params={{ name: skill.name, versionId: version.id }}
                    >
                      {t(
                        pending
                          ? "skills.versions.review"
                          : "skills.versions.files",
                      )}
                    </Link>
                  </RowAction>
                ) : null}
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
    </SettingsSection>
  );
}
