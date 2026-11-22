import { queryOptions, useQuery } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentSkillList,
  PutSkillAttachmentRequest,
  Skill,
  SkillList,
  SkillVersion,
  SkillVersionFiles,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import { scopedKey } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import type { MessageKey, Translate } from "../i18n/i18n.tsx";

export const skillsKey = (client: ApiClient) => scopedKey(client, "skills");

export function skillsQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: skillsKey(client),
    queryFn: () =>
      unwrap(client.GET("/v1/workspace/skills")) as Promise<SkillList>,
    enabled,
    retry: false,
  });
}

export const skillFilesKey = (client: ApiClient, versionId: string) =>
  scopedKey(client, "skills", "files", versionId);

export function skillFilesQuery(client: ApiClient, versionId: string) {
  return queryOptions({
    queryKey: skillFilesKey(client, versionId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspace/skills/versions/{id}/files", {
          params: { path: { id: versionId } },
        }),
      ) as Promise<SkillVersionFiles>,
    retry: false,
  });
}

export const agentSkillsKey = (client: ApiClient, agentId: string) =>
  scopedKey(client, "agent-skills", agentId);

export function agentSkillsQuery(
  client: ApiClient,
  agentId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: agentSkillsKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/skills", {
          params: { path: { id: agentId } },
        }),
      ) as Promise<AgentSkillList>,
    enabled,
    retry: false,
  });
}

/**
 * Versions awaiting review across the workspace, for its managers only: they
 * are the ones who approve, and a member asks for nothing.
 */
export function usePendingSkillCount(): number {
  const { client } = useWerft();
  const manages = useHasPermission("workspace.manage");
  const skills = useQuery({
    ...skillsQuery(client, manages),
    select: (list) =>
      list.items.reduce((sum, skill) => sum + skill.pending_count, 0),
  });
  // A failed refetch keeps the old count, which may no longer hold.
  return manages && !skills.isError ? (skills.data ?? 0) : 0;
}

export const digestShort = (digest: string) => digest.slice(0, 12);

export function versionLabel(t: Translate, version: SkillVersion): string {
  const digest = digestShort(version.digest);
  return version.version === null
    ? t("skills.legacyVersion", { digest })
    : t("skills.versionLabel", { version: version.version, digest });
}

export const MODE_LABEL = {
  required: "skills.mode.required",
  optional: "skills.mode.optional",
  forbidden: "skills.mode.forbidden",
} as const satisfies Record<string, MessageKey>;

export type AttachMode = PutSkillAttachmentRequest["mode"];
export const MODES = [
  "required",
  "optional",
  "forbidden",
] as const satisfies AttachMode[];

/**
 * The versions a scope can name, newest first. `forbidden` only keeps the
 * name out, so it takes any unarchived version; the other modes take
 * approved ones.
 */
export const attachable = (skill: Skill, mode: AttachMode) =>
  skill.versions
    .filter(
      (item) =>
        item.archived_at === null &&
        (mode === "forbidden" || item.review === "approved"),
    )
    .reverse();

export const REVIEW_LABEL = {
  pending: "skills.review.pending",
  approved: "skills.review.approved",
  rejected: "skills.review.rejected",
  superseded: "skills.review.superseded",
} as const satisfies Record<SkillVersion["review"], MessageKey>;

export const REVIEW_BADGE = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  superseded: "gray",
} as const satisfies Record<SkillVersion["review"], string>;

const REFUSALS = {
  self_review: "skills.refused.self_review",
  version_archived: "skills.refused.version_archived",
  name_taken: "skills.refused.name_taken",
  source_mismatch: "skills.refused.source_mismatch",
  skill_invalid: "skills.refused.skill_invalid",
  ref_not_found: "skills.refused.ref_not_found",
  connection_required: "skills.refused.connection_required",
  connection_not_found: "skills.refused.connection_not_found",
  repository_not_installed: "skills.refused.repository_not_installed",
  path_not_found: "skills.refused.path_not_found",
  github_unreachable: "skills.refused.github_unreachable",
  github_rejected: "skills.refused.github_rejected",
  not_approved: "skills.refused.not_approved",
  version_not_approved: "skills.refused.version_not_approved",
  outranked: "skills.refused.outranked",
} as const satisfies Record<string, MessageKey>;

/** The words for a refusal whose reason this screen knows; null otherwise. */
export function skillRefusalKey(error: ApiError): MessageKey | null {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  return typeof reason === "string" && Object.hasOwn(REFUSALS, reason)
    ? REFUSALS[reason as keyof typeof REFUSALS]
    : null;
}
