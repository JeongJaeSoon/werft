import { useQuery } from "@tanstack/react-query";
import type { components } from "@werft-ai/client";
import type { AgentDetail, AgentRelease } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  ConfirmDialog,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  RelativeTime,
  RowAction,
  Section,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useState } from "react";
import { memberSummariesQuery } from "../../api/queries.ts";
import { useHasPermission } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { withNodes } from "../../components/with-nodes.tsx";
import { type Translate, useI18n } from "../../i18n/i18n.tsx";
import {
  mcpChange,
  receiptTitle,
  useAgentGitHubActivity,
} from "./github-activity.ts";
import { previousRelease, releaseChanges } from "./release-changes.ts";
import { ReleaseChangesSummary } from "./release-changes-view.tsx";
import {
  type RollbackPreview,
  rollbackPreview,
} from "./rollback-preview.ts";

const COLUMNS = [
  "minmax(10rem,1.6fr) 96px minmax(0,1.2fr) minmax(0,1fr) 120px",
  "minmax(0,1fr) 120px",
] as const;

/** The connection the agent runs on now: its active release's, else its newest. */
export function releasedConnection(
  detail: AgentDetail,
): string | undefined {
  const active = detail.releases.find(
    (release) => release.id === detail.agent.active_release_id,
  );
  return (active ?? detail.releases.at(-1))?.connection_id;
}

type Receipt = components["schemas"]["Receipt"];

function McpChangeLines({ receipt }: { readonly receipt: Receipt }) {
  const { t } = useI18n();
  const change = mcpChange(receipt, t);
  return (
    <>
      <Text as="span" variant="meta" className="wrap-anywhere">
        {change.before === null
          ? t("agentAccess.activity.first")
          : `${t("agentAccess.activity.before")}: ${change.before}`}
      </Text>
      <Text as="span" variant="meta" className="wrap-anywhere">
        {t("agentAccess.activity.after")}: {change.after}
      </Text>
    </>
  );
}

type Entry =
  | {
      readonly kind: "release";
      readonly at: string;
      readonly item: AgentRelease;
    }
  | { readonly kind: "access"; readonly at: string; readonly item: Receipt };

export function Releases({
  detail,
  versionNo,
  result,
  activating,
  onActivate,
  shown,
}: {
  readonly detail: AgentDetail;
  readonly versionNo: (versionId: string) => number | undefined;
  readonly result: ReactNode;
  readonly activating: string | undefined;
  readonly onActivate: (release: AgentRelease) => void;
  /** Whether the tab is open; every tab stays mounted. */
  readonly shown: boolean;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const manages = useManagesAgent();
  const [confirming, setConfirming] = useState<AgentRelease | null>(null);
  // Only roles that list members get names; anyone else reads "a member".
  // Read when the tab opens, not with every visit to the agent, and only
  // for the people who made a release.
  const listsMembers = useHasPermission("member.manage");
  const authors = [
    ...new Set(
      detail.releases.flatMap((item) =>
        item.created_by ? [item.created_by] : [],
      ),
    ),
  ];
  const members = useQuery({
    ...memberSummariesQuery(client, authors),
    enabled: listsMembers && shown && authors.length > 0,
  });
  const names = new Map(
    (members.data?.items ?? []).map((m) => [m.user_id, m.display_name]),
  );
  const activity = useAgentGitHubActivity(detail.agent.id, shown);
  const entries: Entry[] = [
    ...detail.releases.map(
      (item): Entry => ({ kind: "release", at: item.created_at, item }),
    ),
    ...(activity.data?.items ?? [])
      .filter(
        (receipt) =>
          (receipt.operation === "set_agent_github" ||
            receipt.operation === "set_agent_mcp") &&
          receipt.status !== "failed",
      )
      .map((item): Entry => ({ kind: "access", at: item.created_at, item })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const cards = new Map(detail.versions.map((v) => [v.id, v.card]));
  const at = (iso: string) => <RelativeTime value={iso} locale={locale} />;
  const preview = confirming ? rollbackPreview(confirming) : null;

  return (
    <Section
      title={t("agent.releases.title")}
      description={t("agent.releases.auto")}
    >
      <div className={SECTION_BODY}>
        {result}
        {entries.length === 0 ? (
          <EmptyState
            title={t("agent.releases.empty")}
            description={t("agent.releases.emptyBody")}
          />
        ) : (
          <GridTable
            aria-label={t("agent.releases.title")}
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
            framed={true}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("agent.releases.colVersion")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colStatus")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colActivated")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colBy")}
              </GridTableColumnHeader>
              <GridTableColumnHeader action>
                <span className="sr-only">
                  {t("agent.releases.colActions")}
                </span>
              </GridTableColumnHeader>
            </GridTableHeader>
            {entries.map((entry) => {
              if (entry.kind === "access") {
                return (
                  <GridTableRow key={entry.item.id} data-kind="access">
                    <GridTableCell>
                      <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                        <Text as="span" weight="medium">
                          {t("agent.releases.access")}
                        </Text>
                        <Text as="span" variant="sub" className="wrap-anywhere">
                          {receiptTitle(entry.item, t)} ·{" "}
                          {t(
                            entry.item.operation === "set_agent_mcp"
                              ? "agent.releases.accessNoReleaseMcp"
                              : "agent.releases.accessNoRelease",
                          )}
                        </Text>
                        {entry.item.operation === "set_agent_mcp" ? (
                          <McpChangeLines receipt={entry.item} />
                        ) : null}
                        <span className="hidden text-caption tabular-nums [@container(max-width:860px)]:block">
                          {at(entry.item.created_at)}
                        </span>
                      </div>
                    </GridTableCell>
                    <GridTableCell hideNarrow>{null}</GridTableCell>
                    <GridTableCell hideNarrow className="tabular-nums">
                      {at(entry.item.created_at)}
                    </GridTableCell>
                    <GridTableCell hideNarrow>{null}</GridTableCell>
                    <GridTableCell align="end">{null}</GridTableCell>
                  </GridTableRow>
                );
              }
              const item = entry.item;
              const active = item.id === detail.agent.active_release_id;
              const name =
                item.label ??
                t("agent.versionLabel", {
                  version: versionNo(item.version_id) ?? "?",
                });
              const label = t("agent.releaseLabel", {
                release: name,
                connection: item.connection_id,
              });
              // `== null`: an API from before these fields omits them mid-rollout.
              const activated =
                item.activated_at == null ? (
                  <Text as="span" variant="sub">
                    {t("agent.releases.noteNone")}
                  </Text>
                ) : item.deactivated_at == null ? (
                  at(item.activated_at)
                ) : (
                  withNodes((vars) => t("agent.releases.activePeriod", vars), {
                    from: at(item.activated_at),
                    to: at(item.deactivated_at),
                  })
                );
              // The narrow list is caption sized; Text sub would make its line taller.
              const listedActivated =
                item.activated_at == null ? (
                  <span className="text-muted-foreground">
                    {t("agent.releases.noteNone")}
                  </span>
                ) : (
                  activated
                );
              const by =
                (item.created_by ? names.get(item.created_by) : undefined) ??
                t("agent.releases.byMember");
              const previous = previousRelease(detail.releases, item);
              const changes = (
                <ReleaseChangesSummary
                  release={item}
                  previous={previous}
                  changes={
                    previous
                      ? releaseChanges(previous, item, (id) => cards.get(id))
                      : []
                  }
                  by={item.created_by ? by : t("agent.releases.byUnknown")}
                />
              );
              const status = (
                <Badge variant={active ? "green" : "gray"}>
                  {active
                    ? t("agent.releases.active")
                    : item.activated_at
                      ? t("agent.releases.previous")
                      : t("agent.releases.never")}
                </Badge>
              );
              return (
                <GridTableRow key={item.id} data-active={active}>
                  <GridTableCell>
                    <div className="flex min-w-0 flex-col gap-[var(--werft-row-line-gap)]">
                      <Text
                        as="span"
                        weight="medium"
                        className="tabular-nums wrap-anywhere"
                      >
                        {name}{" "}
                        <span className="text-muted-foreground">
                          {t("agent.versionShort", {
                            version: versionNo(item.version_id) ?? "?",
                          })}
                        </span>
                      </Text>
                      {changes}
                      {/* GridTable's narrowAt={860}, where the other columns drop. */}
                      <span className="hidden [@container(max-width:860px)]:flex">
                        {status}
                      </span>
                      <dl className="m-0 hidden flex-col gap-[var(--werft-row-line-gap)] text-caption [@container(max-width:860px)]:flex">
                        {(
                          [
                            ["colActivated", listedActivated],
                            ["colBy", by],
                          ] as const
                        ).map(([key, value]) => (
                          <div
                            key={key}
                            className="flex min-w-0 flex-wrap gap-x-2"
                          >
                            <dt className="text-muted-foreground">
                              {t(`agent.releases.${key}`)}
                            </dt>
                            <dd className="m-0 min-w-0 tabular-nums">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </GridTableCell>
                  <GridTableCell hideNarrow>{status}</GridTableCell>
                  <GridTableCell hideNarrow className="flex-wrap tabular-nums">
                    {activated}
                  </GridTableCell>
                  <GridTableCell hideNarrow className="wrap-anywhere">
                    {by}
                  </GridTableCell>
                  <GridTableCell align="end">
                    {active || !manages ? null : (
                      <RowAction
                        disabled={activating !== undefined}
                        aria-label={t("agent.releases.rollbackFor", {
                          release: label,
                        })}
                        onClick={() => setConfirming(item)}
                      >
                        {activating === item.id
                          ? t("agent.releases.rollingBack")
                          : t("agent.releases.rollback")}
                      </RowAction>
                    )}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
          </GridTable>
        )}
      </div>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("agent.rollback.title", { release: confirming?.label ?? "" })}
        consequence={<RollbackConsequence t={t} preview={preview} />}
        confirmLabel={t("agent.releases.rollback")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          if (confirming) onActivate(confirming);
          setConfirming(null);
        }}
      />
    </Section>
  );
}

function RollbackConsequence({
  t,
  preview,
}: {
  readonly t: Translate;
  readonly preview: RollbackPreview | null;
}) {
  return (
    <span className="flex flex-col gap-2">
      <span>{t("agent.rollback.content")}</span>
      {preview ? (
        <span data-slot="rollback-connection">
          {t("agent.rollback.connection", { connection: preview.connection })}
        </span>
      ) : null}
      <span>{t("agent.rollback.settingsKept")}</span>
      <span>{t("agent.rollback.mayRefuse")}</span>
    </span>
  );
}
