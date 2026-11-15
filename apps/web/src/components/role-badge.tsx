import type { WorkspaceRole } from "@werft-ai/contracts";
import { Badge, type BadgeProps } from "@werft-ai/ui";
import { roleLabel } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const ROLE_VARIANT = {
  owner: "violet",
  admin: "blue",
  member: "gray",
} as const satisfies Record<WorkspaceRole, BadgeProps["variant"]>;

/** A workspace role as a pill: owner violet, admin blue, member grey. */
export function RoleBadge({ role }: { readonly role: WorkspaceRole }) {
  const { t } = useI18n();
  return (
    <Badge variant={ROLE_VARIANT[role]} data-role={role}>
      {roleLabel(t, role)}
    </Badge>
  );
}
