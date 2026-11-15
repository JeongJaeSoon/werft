import { StatusDot } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * Which names the card asks for and no live binding holds. Whether a bound
 * credential still works is not reported, so a bound one is "connected", not
 * "healthy".
 */
export function CredentialNeed({
  refs,
  bound,
}: {
  readonly refs: readonly string[];
  readonly bound: readonly string[];
}) {
  const { t } = useI18n();
  const missing = refs.filter((ref) => !bound.includes(ref)).length;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot status={missing > 0 ? "failed" : "done"} />
      {refs.length === 0
        ? t("agents.cards.credentialsNone")
        : missing > 0
          ? t("agents.cards.credentialsMissing", { count: missing })
          : t("agents.cards.credentialsBound", { count: refs.length })}
    </span>
  );
}
