import type {
  AchievementCategory,
  AchievementEvidenceKind,
  AchievementJudgeSettings,
  AchievementRule,
  AchievementRuleRequest,
  AchievementType,
} from "@werft-ai/contracts";
import type { TeamActor } from "../../access-control/ports/team-store.ts";

type Write = { actor: TeamActor; receiptId: string };

/** The actor is no longer a live owner or admin when the write commits. */
type Inactive = { outcome: "actor_inactive" };

/** A rule's category or type is not a non-archived one of the workspace. */
type UnknownReference = { outcome: "unknown_category" | "unknown_type" };

export type CreateAchievementCategoryResult =
  | { outcome: "created"; category: AchievementCategory }
  | { outcome: "name_taken" }
  | Inactive;

export type UpdateAchievementCategoryResult =
  | { outcome: "updated" | "unchanged"; category: AchievementCategory }
  | { outcome: "not_found" | "name_taken" }
  | Inactive;

export type ArchiveAchievementCategoryResult =
  | { outcome: "archived" | "unchanged"; category: AchievementCategory }
  | { outcome: "not_found" | "category_in_use" }
  | Inactive;

export type CreateAchievementTypeResult =
  | { outcome: "created"; type: AchievementType }
  | { outcome: "key_taken" | "limit_reached" }
  | Inactive;

export type UpdateAchievementTypeResult =
  | { outcome: "updated" | "unchanged"; type: AchievementType }
  | { outcome: "not_found" }
  | Inactive;

export type ArchiveAchievementTypeResult =
  | { outcome: "archived" | "unchanged"; type: AchievementType }
  | { outcome: "not_found" | "builtin" | "type_in_use" }
  | Inactive;

export type WriteAchievementRuleResult =
  | { outcome: "created"; rule: AchievementRule }
  | { outcome: "not_found" | "type_in_use" | "limit_reached" }
  | UnknownReference
  | Inactive;

export type SetAchievementRuleDisabledResult =
  | { outcome: "changed" | "unchanged"; rule: AchievementRule }
  | { outcome: "not_found" | "type_in_use" | "limit_reached" }
  | UnknownReference
  | Inactive;

/**
 * Categories, types and rules of one workspace. Every write runs in one
 * transaction with its receipt, which names ids and versions only.
 */
export interface AchievementRuleStore {
  listCategories(workspaceId: string): Promise<AchievementCategory[]>;
  listTypes(workspaceId: string): Promise<AchievementType[]>;
  /** The latest version of every family. */
  listRules(workspaceId: string): Promise<AchievementRule[]>;

  createCategory(
    input: Write & { name: string },
  ): Promise<CreateAchievementCategoryResult>;
  updateCategory(
    input: Write & { categoryId: string; name?: string; position?: number },
  ): Promise<UpdateAchievementCategoryResult>;
  archiveCategory(
    input: Write & { categoryId: string },
  ): Promise<ArchiveAchievementCategoryResult>;

  createType(
    input: Write & {
      key: string;
      name: string;
      evidenceKind: AchievementEvidenceKind;
    },
  ): Promise<CreateAchievementTypeResult>;
  updateType(
    input: Write & { typeId: string; name: string },
  ): Promise<UpdateAchievementTypeResult>;
  archiveType(
    input: Write & { typeId: string },
  ): Promise<ArchiveAchievementTypeResult>;

  /** Version 1 of a new family. */
  createRule(
    input: Write & { rule: AchievementRuleRequest },
  ): Promise<WriteAchievementRuleResult>;
  /** The family's next version; the one before it is superseded. */
  createRuleVersion(
    input: Write & { familyId: string; rule: AchievementRuleRequest },
  ): Promise<WriteAchievementRuleResult>;
  /** On the family's latest version only. */
  setRuleDisabled(
    input: Write & { familyId: string; disabled: boolean },
  ): Promise<SetAchievementRuleDisabledResult>;

  /** Null when the workspace does not exist. */
  getJudge(workspaceId: string): Promise<AchievementJudgeSettings | null>;
  setJudge(
    input: Write & { settings: AchievementJudgeSettings },
  ): Promise<{ outcome: "set"; settings: AchievementJudgeSettings } | Inactive>;
}
