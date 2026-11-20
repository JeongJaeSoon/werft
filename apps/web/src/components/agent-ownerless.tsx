import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Agent, Takeover } from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { shortSessionId } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  CompactList,
  CompactRow,
  formatTimestamp,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import { useId } from "react";
import { takeoversQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";

/** contracts AGENT_OWNERLESS_GRACE_DAYS; apps/web imports contracts as types only. */
export const OWNERLESS_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** When new runs stop: the mark plus the grace, or null before a pass marks it. */
export function ownerlessBlockAt(
  agent: Pick<Agent, "ownerless_since">,
): string | null {
  if (agent.ownerless_since === null) return null;
  const since = new Date(agent.ownerless_since).getTime();
  if (Number.isNaN(since)) return null;
  return new Date(since + OWNERLESS_GRACE_DAYS * DAY_MS).toISOString();
}

/** The row's "관리자 없음" mark; nothing while someone administers it. */
export function OwnerlessBadge({
  agent,
}: {
  readonly agent: Pick<Agent, "ownerless">;
}) {
  const { t } = useI18n();
  if (!agent.ownerless) return null;
  return <Badge variant="amber">{t("agent.ownerless.badge")}</Badge>;
}

/**
 * The detail page's warning on an agent no one administers: the date new runs
 * stop, and the way to the admins tab where someone is named. To whoever may
 * read the takeover list it also lists the agent's sessions awaiting a
 * takeover, which succession leaves waiting, so it stays while any remain.
 */
export function OwnerlessAlert({
  agent,
  onAdmins,
}: {
  readonly agent: Pick<Agent, "id" | "ownerless" | "ownerless_since">;
  readonly onAdmins: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useWerft();
  const readsTakeovers = useHasPermission("member.manage");
  const takeovers = useQuery({
    ...takeoversQuery(client, { agentId: agent.id }),
    enabled: readsTakeovers,
  });
  const page = readsTakeovers ? takeovers.data : undefined;
  const waiting = page?.items ?? [];
  // Unknown after succession is not "none": the reader is told and may retry.
  const failed = readsTakeovers && takeovers.isError;
  if (!agent.ownerless && waiting.length === 0 && !failed) return null;
  const blockAt = ownerlessBlockAt(agent);
  return (
    <Alert variant="amber" className="border-0">
      {agent.ownerless || waiting.length > 0 ? (
        <AlertTitle>
          {agent.ownerless
            ? t("agent.ownerless.title")
            : t("agent.takeovers.title")}
        </AlertTitle>
      ) : null}
      <AlertDescription className="flex flex-col gap-2">
        {agent.ownerless ? (
          <Text as="span" variant="sub">
            {blockAt === null
              ? t("agent.ownerless.datePending")
              : t("agent.ownerless.blockOn", {
                  at: formatTimestamp(blockAt, locale),
                })}{" "}
            {t("agent.ownerless.takeoverHint")}
          </Text>
        ) : null}
        {page && waiting.length > 0 ? (
          <TakeoverList items={waiting} total={page.total} />
        ) : failed ? (
          <Text as="span" variant="sub" role="alert">
            {t("agent.takeovers.failed")}{" "}
            <Button
              size="sm"
              variant="link"
              onClick={() => void takeovers.refetch()}
            >
              {t("common.retry")}
            </Button>
          </Text>
        ) : null}
        {agent.ownerless ? (
          <AlertActions>
            <Button size="sm" variant="outline" onClick={onAdmins}>
              {t("agent.ownerless.toAdmins")}
            </Button>
          </AlertActions>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function TakeoverList({
  items,
  total,
}: {
  readonly items: readonly Takeover[];
  readonly total: number;
}) {
  const { t, locale } = useI18n();
  const labelId = useId();
  return (
    <>
      <Text as="span" id={labelId} variant="body" weight="medium">
        {t("agent.takeovers.count", { count: total })}
      </Text>
      {total > items.length ? (
        <Text as="span" variant="meta">
          {t("agent.takeovers.oldestOnly", { shown: items.length })}
        </Text>
      ) : null}
      <CompactList aria-labelledby={labelId}>
        {items.map((item) => (
          <CompactRow key={item.session_id}>
            <Text as="span" variant="sub">
              <TextLink asChild className="font-mono font-normal">
                <Link
                  to="/sessions/$id"
                  params={{ id: item.session_id }}
                  title={item.session_id}
                >
                  {shortSessionId(item.session_id)}
                </Link>
              </TextLink>
              {" · "}
              {t("agent.takeovers.since", {
                at: formatTimestamp(item.takeover_required_at, locale),
              })}
            </Text>
          </CompactRow>
        ))}
      </CompactList>
    </>
  );
}
