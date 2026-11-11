import { type ApiError, isApiError } from "@werft-ai/client";
import type {
  AuthMeResponse,
  AuthorizationAction,
  ListMembersResponse,
  MemberActions,
  MemberRow,
  MemberVerdict,
  SessionScope,
  WorkspaceRole,
} from "@werft-ai/contracts";
import { useMe as useMeQuery } from "@werft-ai/react";
import {
  errorKey,
  isMessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";

/** The roles a member can be given; client.test.ts pins it to the contract. */
export const WORKSPACE_ROLE_VALUES: readonly WorkspaceRole[] = [
  "owner",
  "admin",
  "member",
];

const OFFERED: MemberVerdict = { allowed: true };

/*
 * What the member list offers. An API older than a field leaves it out, and
 * production hands such an answer on (validate "warn"): offer everything and
 * let the server's refusal speak, rather than fail the screen or lock it.
 */

/** What may be done to the member on a row. */
export function offeredActions(member: MemberRow): MemberActions {
  return (
    member.actions ?? {
      change_role: { owner: OFFERED, admin: OFFERED, member: OFFERED },
      disable: OFFERED,
      enable: OFFERED,
    }
  );
}

/**
 * The roles an invite may carry; POST /v1/invites refuses any other. An API
 * older than the field leaves it out: offer every role and let the server's
 * refusal speak, rather than lock the owner out too.
 */
export function offeredInviteRoles(
  page: Pick<ListMembersResponse, "assignable_roles"> | undefined,
): readonly WorkspaceRole[] {
  return page?.assignable_roles ?? WORKSPACE_ROLE_VALUES;
}

/** The signed-in principal; screens under the authenticated layout only. */
export function useMe(): AuthMeResponse | undefined {
  return useMeQuery().data;
}

/** The signed-in user's role; an API key principal has none. */
export function useRole(): string | undefined {
  const principal = useMe()?.principal;
  return principal?.kind === "user" ? principal.role : undefined;
}

/**
 * Whether the signed-in role holds a management action on the workspace, as
 * the server's role table says (/v1/auth/me). Only for hiding a menu whose
 * whole screen needs it; an agent's admin holds more on that agent.
 */
export function useHasPermission(action: AuthorizationAction): boolean {
  return useMe()?.permissions.includes(action) ?? false;
}

/**
 * Whether the effective scopes allow an action. This only decides what the
 * page offers; the server decides what happens, and its 403 is shown as is.
 */
export function useCan(scope: SessionScope): boolean {
  return useMe()?.scopes.includes(scope) ?? false;
}

/**
 * Management powers the server checks by role, not by session scope: the
 * ones a screen withholds, each with words in the catalog (`permission.*`).
 */
export type ManagedPermission = Extract<
  AuthorizationAction,
  | "member.manage"
  | "team.manage"
  | "agent.create"
  | "agent.manage"
  | "agent.admin.manage"
  | "api_key.manage"
  | "api_key.manage_own"
  | "audit_retention.manage"
  | "workspace.manage"
  | "installation.settings.manage"
  | "achievement_rule.manage"
  | "session.control"
  | "account.link"
>;

/**
 * Why a management action is withheld, or undefined when it is not.
 *
 * The answer comes from the server: `probe` is the screen's own list query,
 * which needs the same permission, so a role this page has never heard of
 * still gets its buttons the moment the server lets it list. The role from
 * /v1/auth/me only names who is asking in the reason. A refused mutation
 * shows the same sentence through `permissionReason`.
 */
export function usePermissionReason(
  permission: ManagedPermission,
  probe: { readonly isSuccess: boolean; readonly error: unknown },
): string | undefined {
  const { t } = useI18n();
  const role = useRole();
  if (probe.isSuccess) return undefined;
  if (isApiError(probe.error, "FORBIDDEN"))
    return permissionReason(t, permission, role);
  return t("guard.checking");
}

export function permissionReason(
  t: Translate,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  const named = t(`permission.${permission}`);
  return role === undefined
    ? t("guard.missingPermission", { permission: named })
    : t("guard.missingPermissionAs", {
        permission: named,
        role: roleLabel(t, role),
      });
}

/** A role's name; one this build has no words for is shown as the server sent it. */
export function roleLabel(t: Translate, role: string): string {
  const key = `role.${role}`;
  return isMessageKey(key) ? t(key) : role;
}

/**
 * What a refused management call says: a 403 reads like the reason on the
 * disabled button. The server's sentence is English and names the action's
 * identifier, so it stays off the page.
 */
export function refusalText(
  t: Translate,
  error: ApiError,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN") return permissionReason(t, permission, role);
  return t(errorKey(error.code));
}
