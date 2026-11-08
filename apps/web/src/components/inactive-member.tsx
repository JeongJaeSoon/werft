import { Badge } from "@werft-ai/ui";
import type { JSX } from "react";

import { useI18n } from "../i18n/i18n.tsx";

/**
 * The row fill of a member whose access is off, shared by every members-area
 * table. `hover` is the token the row's own hover uses, so a clickable row
 * steps to `active` to keep its pointer feedback.
 */
export const INACTIVE_ROW_CLASS =
  "bg-hover has-[[data-slot=grid-table-row-opener]]:hover:bg-active";

/** Names the state in text next to the name; the fill alone never says it. */
export function InactiveBadge({
  className,
}: {
  readonly className?: string;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <Badge variant="gray" className={className}>
      {t("members.state.disabled")}
    </Badge>
  );
}
