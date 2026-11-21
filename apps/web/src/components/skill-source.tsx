import type { Skill } from "@werft-ai/contracts";
import { cn, GitHubMark } from "@werft-ai/ui";
import { Upload } from "lucide-react";
import { useI18n } from "../i18n/i18n.tsx";

const SOURCE_LABEL = {
  github: "skills.source.github",
  upload: "skills.source.upload",
} as const;

/**
 * Where a skill comes from, at a glance: the GitHub mark or an upload arrow.
 * Each skill has one source for life, so one mark names it.
 */
export function SkillSourceIcon({
  source,
  className,
}: {
  readonly source: Skill["source"];
  readonly className?: string;
}) {
  const { t } = useI18n();
  const label = t(SOURCE_LABEL[source]);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-source={source}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-control border bg-muted text-muted-foreground",
        className,
      )}
    >
      {source === "github" ? (
        <GitHubMark className="size-3.5 text-foreground" />
      ) : (
        <Upload aria-hidden="true" className="size-3.5" strokeWidth={2} />
      )}
    </span>
  );
}
