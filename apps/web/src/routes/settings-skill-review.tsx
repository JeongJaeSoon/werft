import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type {
  ReviewSkillVersionRequest,
  SkillVersion,
  SkillVersionChangeResponse,
  SkillVersionFiles,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Code,
  CodeBlock,
  ConfirmDialog,
  Heading,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RowLines,
  RowList,
  RowListItem,
  SettingsSection,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { DIFF_LINE } from "../components/revision-diff.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { formatBytes } from "./session-outputs.tsx";
import { triggerText } from "./settings-skill-detail.tsx";
import { useSkillWrite } from "./settings-skills.tsx";
import {
  digestShort,
  REVIEW_BADGE,
  REVIEW_LABEL,
  skillFilesKey,
  skillFilesQuery,
  versionLabel,
} from "./skills-data.ts";

type SkillFile = SkillVersionFiles["files"][number];

const CHANGE_LABEL = {
  added: "skills.reviewPage.change.added",
  changed: "skills.reviewPage.change.changed",
  unchanged: "skills.reviewPage.change.unchanged",
} as const satisfies Record<SkillFile["change"], string>;

const CHANGE_BADGE = {
  added: "blue",
  changed: "amber",
  unchanged: "gray",
} as const satisfies Record<SkillFile["change"], string>;

/** The path inside the skill's own directory, without `skills/<name>/`. */
const relativeOf = (name: string, path: string) =>
  path.startsWith(`skills/${name}/`)
    ? path.slice(`skills/${name}/`.length)
    : path;

/**
 * What runs is read first (decision skills-and-mcp.md 7): files under
 * `scripts/` and files with the execute bit, then the rest, each by path.
 */
export function reviewOrder(
  name: string,
  files: readonly SkillFile[],
): SkillFile[] {
  const runs = (file: SkillFile) =>
    file.executable || relativeOf(name, file.path).startsWith("scripts/");
  return [...files.filter(runs), ...files.filter((file) => !runs(file))];
}

const diffKind = (line: string) =>
  line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "same";

export function SkillVersionScreen() {
  const { t } = useI18n();
  const { client } = useWerft();
  const { name: asked, versionId } = useParams({
    from: "/authed/settings/workspace/skills/$name/versions/$versionId",
  });
  const files = useQuery(skillFilesQuery(client, versionId));
  // The version id decides what is approved, so its own skill names the page,
  // whatever name the address carries.
  const name = files.data?.version.name ?? asked;
  const label = files.data ? versionLabel(t, files.data.version) : versionId;
  const title = t("skills.reviewPage.title", { name, version: label });
  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to="/settings/workspace/skills" activeOptions={{ exact: true }}>
          {t("skills.title")}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbLink asChild>
        <Link
          to="/settings/workspace/skills/$name"
          params={{ name }}
          activeOptions={{ exact: true }}
        >
          {name}
        </Link>
      </PageBreadcrumbLink>
      <PageBreadcrumbCurrent>{label}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );
  if (files.isPending)
    return (
      <Page title={title} breadcrumb={breadcrumb}>
        <Skeleton width="60%" label={t("status.loading.title")} />
      </Page>
    );
  if (files.isError)
    return (
      <Page title={title} breadcrumb={breadcrumb}>
        <LoadFailure error={files.error} onRetry={() => void files.refetch()} />
      </Page>
    );
  return (
    <Page
      title={title}
      breadcrumb={breadcrumb}
      actions={
        <Badge variant={REVIEW_BADGE[files.data.version.review]}>
          {t(REVIEW_LABEL[files.data.version.review])}
        </Badge>
      }
    >
      <ReviewBody name={name} data={files.data} />
    </Page>
  );
}

function ReviewBody({
  name,
  data,
}: {
  readonly name: string;
  readonly data: SkillVersionFiles;
}) {
  const { t } = useI18n();
  const { version, previous_approved: previous } = data;
  const ordered = reviewOrder(name, data.files);
  return (
    <div className="flex flex-col gap-[var(--werft-space-section)]">
      <div className="flex flex-col gap-2">
        <Text variant="sub">
          {previous
            ? t("skills.reviewPage.against", {
                version: versionLabel(t, previous),
              })
            : t("skills.reviewPage.first")}
        </Text>
        {version.git ? (
          <Text variant="sub" className="wrap-anywhere">
            {t("skills.reviewPage.trigger", {
              commit: digestShort(version.git.commit),
              trigger: triggerText(t, version.git.trigger),
            })}
          </Text>
        ) : null}
        <ReviewActions
          versionId={version.id}
          label={versionLabel(t, version)}
          review={version.archived_at === null ? version.review : null}
        />
      </div>
      <SettingsSection
        title={t("skills.reviewPage.files", { count: ordered.length })}
        description={t("skills.reviewPage.filesDescription")}
      >
        <RowList
          aria-label={t("skills.reviewPage.files", { count: ordered.length })}
        >
          {ordered.map((file) => (
            <FileView key={file.path} name={name} file={file} />
          ))}
        </RowList>
      </SettingsSection>
      {data.removed.length > 0 ? (
        <SettingsSection title={t("skills.reviewPage.removed")}>
          <RowList aria-label={t("skills.reviewPage.removed")}>
            {data.removed.map((file) => (
              <RowListItem key={file.path}>
                <RowLines>
                  <Code className="wrap-anywhere">
                    {relativeOf(name, file.path)}
                  </Code>
                  <Text as="span" variant="meta" className="wrap-anywhere">
                    sha256 {file.sha256.slice(0, 12)}
                  </Text>
                </RowLines>
              </RowListItem>
            ))}
          </RowList>
        </SettingsSection>
      ) : null}
    </div>
  );
}

function FileView({
  name,
  file,
}: {
  readonly name: string;
  readonly file: SkillFile;
}) {
  const { t, locale } = useI18n();
  const path = relativeOf(name, file.path);
  const size = formatBytes(file.size_bytes, locale);
  return (
    <RowListItem>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Heading level={3} className="min-w-0 font-medium text-control">
            <Code size="inherit" className="wrap-anywhere">
              {path}
            </Code>
          </Heading>
          <Badge variant={CHANGE_BADGE[file.change]}>
            {t(CHANGE_LABEL[file.change])}
          </Badge>
          {file.executable ? (
            <Badge variant="violet">{t("skills.reviewPage.executable")}</Badge>
          ) : null}
          <Text as="span" variant="meta" numeric>
            {size}
          </Text>
        </div>
        {file.text === null ? (
          <Text variant="meta" className="wrap-anywhere">
            {t("skills.reviewPage.binary", { size, sha: file.sha256 })}
          </Text>
        ) : (
          <>
            {file.change === "changed" ? (
              <FileDiff path={path} diff={file.diff} />
            ) : null}
            <div className="flex min-w-0 flex-col gap-1">
              <Text as="span" variant="meta">
                {t("skills.reviewPage.content")}
              </Text>
              <ScrollCode label={t("skills.reviewPage.contentOf", { path })}>
                {file.text}
              </ScrollCode>
            </div>
          </>
        )}
      </div>
    </RowListItem>
  );
}

// A capped, scrolling block of code a keyboard has to reach, like Table's
// scroller.
function ScrollCode({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <CodeBlock
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-h-96 overflow-auto focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
    >
      {children}
    </CodeBlock>
  );
}

function FileDiff({
  path,
  diff,
}: {
  readonly path: string;
  readonly diff: string | null;
}) {
  const { t } = useI18n();
  // The server gives no diff for an execute bit alone or a change too large.
  if (diff === null || diff === "")
    return <Text variant="meta">{t("skills.reviewPage.noDiff")}</Text>;
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <figcaption>
        <Text as="span" variant="meta">
          {t("skills.reviewPage.diff")}
        </Text>
      </figcaption>
      <ScrollCode label={t("skills.reviewPage.diffOf", { path })}>
        {lines.map((line, index) => {
          const kind = line.startsWith("@@") ? "same" : diffKind(line);
          return (
            <span
              // Lines repeat, so position is the only stable identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className={DIFF_LINE[kind]}
              data-kind={kind}
            >
              {kind === "same" ? null : (
                <span className="sr-only">
                  {t(kind === "added" ? "diff.added" : "diff.removed")}
                </span>
              )}
              {line}
              {"\n"}
            </span>
          );
        })}
      </ScrollCode>
    </figure>
  );
}

function ReviewActions({
  versionId,
  label,
  review: state,
}: {
  readonly versionId: string;
  readonly label: string;
  /** Null for an archived version, which is not reviewed. */
  readonly review: SkillVersion["review"] | null;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const cache = useQueryClient();
  const manages = useHasPermission("workspace.manage");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The button just used goes once the re-read shows the decision; focus
  // moves to the one that stays, so a keyboard keeps its place.
  const actions = useRef<HTMLDivElement>(null);
  const [refocusOn, setRefocusOn] = useState<SkillVersion["review"] | null>(
    null,
  );
  const review = useSkillWrite(
    (decision: ReviewSkillVersionRequest["decision"]) =>
      unwrap(
        client.POST("/v1/workspace/skills/versions/{id}/review", {
          params: { path: { id: versionId } },
          body: { decision },
        }),
      ) as Promise<SkillVersionChangeResponse>,
    {
      onDone: (_answer, decision) => {
        setConfirming(false);
        setRefocusOn(decision);
        setOutcome({
          kind: "notice",
          text: t(
            decision === "approved"
              ? "skills.reviewPage.approved"
              : "skills.reviewPage.rejected",
            { version: label },
          ),
        });
        void cache.invalidateQueries({
          queryKey: skillFilesKey(client, versionId),
        });
      },
      onRefused: (text) => {
        setConfirming(false);
        setOutcome({ kind: "error", text });
      },
    },
  );
  // The write stays pending, its buttons off, until the list re-read ends;
  // the files re-read can show the decision before that.
  const writing = review.isPending;
  useEffect(() => {
    if (refocusOn === null || state !== refocusOn || writing) return;
    actions.current?.querySelector("button")?.focus();
    setRefocusOn(null);
  }, [refocusOn, state, writing]);
  return (
    <>
      <OutcomeLine outcome={outcome} live />
      {/* Rejecting an approved version stays allowed: it is the recall. */}
      {manages && state !== null ? (
        <div ref={actions} className="flex flex-wrap gap-2">
          {state === "approved" ? null : (
            <Button
              type="button"
              disabled={review.isPending}
              onClick={() => review.mutate("approved")}
            >
              {review.isPending && review.variables === "approved"
                ? t("skills.reviewPage.approving")
                : t("skills.reviewPage.approve")}
            </Button>
          )}
          {state === "rejected" ? null : (
            <Button
              type="button"
              variant="outline"
              disabled={review.isPending}
              onClick={() => setConfirming(true)}
            >
              {t("skills.reviewPage.reject")}
            </Button>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("skills.reviewPage.rejectTitle", { version: label })}
        consequence={t("skills.reviewPage.rejectDescription")}
        confirmLabel={
          review.isPending
            ? t("skills.reviewPage.rejecting")
            : t("skills.reviewPage.reject")
        }
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={review.isPending}
        onConfirm={() => review.mutate("rejected")}
      />
    </>
  );
}
