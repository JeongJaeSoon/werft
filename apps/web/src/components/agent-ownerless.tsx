import type { Agent } from "@werft-ai/contracts";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  formatTimestamp,
} from "@werft-ai/ui";
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
 * stop, and the way to the admins tab where someone is named.
 */
export function OwnerlessAlert({
  agent,
  onAdmins,
}: {
  readonly agent: Pick<Agent, "ownerless" | "ownerless_since">;
  readonly onAdmins: () => void;
}) {
  const { t, locale } = useI18n();
  if (!agent.ownerless) return null;
  const blockAt = ownerlessBlockAt(agent);
  return (
    <Alert variant="amber" className="border-0">
      <AlertTitle>{t("agent.ownerless.title")}</AlertTitle>
      <AlertDescription>
        {blockAt === null
          ? t("agent.ownerless.datePending")
          : t("agent.ownerless.blockOn", {
              at: formatTimestamp(blockAt, locale),
            })}{" "}
        {t("agent.ownerless.takeoverHint")}
        <span className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onAdmins}>
            {t("agent.ownerless.toAdmins")}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
