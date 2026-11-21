import { useI18n } from "../i18n/i18n.tsx";
import { usePendingSkillCount } from "../routes/skills-data.ts";

/**
 * How many skill versions wait for review, beside a menu item. Only the
 * workspace managers approve, so only they see it (and only they ask).
 */
export function SkillPendingMarker() {
  const { t } = useI18n();
  const count = usePendingSkillCount();
  if (count === 0) return null;
  return (
    <>
      <span
        data-slot="nav-count"
        aria-hidden="true"
        className="ml-auto flex items-center gap-1.5 text-caption text-muted-foreground tabular-nums"
      >
        <span className="size-1.5 rounded-full bg-(--werft-color-accent)" />
        {count}
      </span>
      <span className="sr-only"> {t("skills.pendingMarker", { count })}</span>
    </>
  );
}
