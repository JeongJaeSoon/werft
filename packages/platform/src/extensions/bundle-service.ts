import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import { WORKSPACE_MANAGER_ROLES } from "@werft-ai/contracts";
import {
  BundleArchiveError,
  type CheckpointObjectStore,
  packBundleTar,
  unpackBundleTar,
} from "@werft-ai/runtime-core";
import type { Principal } from "../musterrolle/index.ts";
import {
  type BundleInputFile,
  type BundleIssue,
  type BundleLimits,
  DEFAULT_BUNDLE_LIMITS,
  type ValidatedBundle,
  validateExtensionBundle,
} from "./bundle-validator.ts";
import type {
  AttachmentReceiptResult,
  ExtensionAttachment,
  ExtensionBundle,
  ExtensionBundleSource,
  ExtensionBundleStore,
  GitVersionInput,
  ReviewExtensionBundleResult,
} from "./ports/extension-bundle-store.ts";
import type { ExtensionMode } from "./resolve.ts";
import { checkBaseline, checkSkillVersion } from "./skill-checks.ts";

/** A GitHub version as the sync hands it in; the checks are run here. */
export type GitRegistration = Omit<GitVersionInput, "protection"> & {
  protection?: Omit<NonNullable<GitVersionInput["protection"]>, "checks">;
};

/** Who may register, review and attach bundles; the web console and API routes say the same. */
export const EXTENSION_MANAGER_ROLES: readonly WorkspaceRole[] =
  WORKSPACE_MANAGER_ROLES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * `workspaces/<id>/bundles/<digest>.tar`. Both parts are checked here, so a
 * crafted id cannot add a path segment and reach into another workspace. A
 * session prefix token never covers this prefix.
 */
export function bundleObjectKey(workspaceId: string, digest: string): string {
  if (!UUID.test(workspaceId)) {
    throw new Error("A bundle object key needs a lowercase workspace uuid.");
  }
  if (!DIGEST.test(digest)) {
    throw new Error("A bundle object key needs a sha256 hex digest.");
  }
  return `workspaces/${workspaceId}/bundles/${digest}.tar`;
}

/** The stored object is damaged or no longer validates; never serve it. */
export class BundleIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleIntegrityError";
  }
}

export type RegisterBundleResult =
  | { outcome: "rejected"; issues: BundleIssue[] }
  | { outcome: "registered"; bundle: ExtensionBundle; receiptId: string }
  | { outcome: "already_registered"; bundle: ExtensionBundle }
  | {
      outcome:
        | "actor_inactive"
        | "outranked"
        | "name_taken"
        | "source_mismatch"
        | "paused"
        | "lease_lost";
    };

/**
 * The only way a bundle gets into the store. The upload is thrown away after
 * validation: what is hashed, packed and stored is the tree the validator
 * rebuilt, so a bundle with hooks/, .mcp.json or bin/ has no path in.
 */
export function createExtensionBundleService(deps: {
  store: ExtensionBundleStore;
  objects: Pick<CheckpointObjectStore, "get" | "putImmutable">;
  limits?: BundleLimits;
  newId?: () => string;
}) {
  const { store, objects } = deps;
  const limits = deps.limits ?? DEFAULT_BUNDLE_LIMITS;
  const newId = deps.newId ?? randomUUID;

  const service = {
    /**
     * `skill: true` registers one skill as the next version of its name: the upload is checked as a person's
     * tree, so it holds one skill and no engine manifest.
     */
    async register(input: {
      principal: Principal;
      slug: string;
      files: BundleInputFile[];
      label: string;
      source: ExtensionBundleSource;
      skill?: boolean;
      /** A GitHub version; without `newSource`, the principal is the sync. */
      git?: GitRegistration;
    }): Promise<RegisterBundleResult> {
      const workspaceId = input.principal.ownerId;
      const skill = input.skill === true;
      const validation = validateExtensionBundle(
        { slug: input.slug, files: input.files },
        limits,
        skill ? "upload" : "stored",
      );
      if (!validation.ok) {
        return { outcome: "rejected", issues: validation.issues };
      }
      const { bundle } = validation;
      // The validator adds plugin.json to what it was given, so a tree at the
      // file-count limit grows past it. Judge the tree that will be stored by
      // the same rules `read` applies, or it would be stored and never served.
      const again = validateExtensionBundle(
        {
          slug: bundle.slug,
          files: bundle.files.map((file) => ({
            path: file.path,
            kind: "file" as const,
            mode: file.mode,
            bytes: file.bytes,
          })),
        },
        limits,
      );
      if (!again.ok) return { outcome: "rejected", issues: again.issues };
      if (again.bundle.digest !== bundle.digest) {
        throw new BundleIntegrityError(
          "The validated tree does not validate to its own digest.",
        );
      }
      // A GitHub version is a skill version: the source checks run there.
      if (input.git !== undefined && !skill) {
        throw new Error("a GitHub version must be registered as a skill");
      }
      const synced = input.git !== undefined && !input.git.newSource;
      if (!synced) {
        const may = await store.mayManage({
          workspaceId,
          principal: input.principal,
          managerRoles: EXTENSION_MANAGER_ROLES,
        });
        if (may !== "ok") return { outcome: may };
      }
      const tar = packBundleTar(bundle.files);
      // Object first: a row without its object is a bundle nothing can serve,
      // while an object without a row is only garbage for the sweep to find.
      const key = bundleObjectKey(workspaceId, bundle.digest);
      const put = await objects.putImmutable(key, tar, {
        contentAddressed: true,
      });
      if (put.outcome === "conflict") {
        throw new BundleIntegrityError(
          `Object ${key} already holds different bytes.`,
        );
      }
      let git: GitVersionInput | undefined;
      if (input.git !== undefined) {
        const { protection, ...rest } = input.git;
        git = rest;
        if (protection !== undefined) {
          // Against what the reviewer's diff starts from; the write compares
          // the baseline again under the lock.
          const baseline = checkBaseline(
            (await store.list(workspaceId)).filter(
              (row) => row.name === bundle.slug,
            ),
            null,
          );
          const before =
            baseline === null
              ? null
              : await service.read(workspaceId, baseline.digest);
          git.protection = {
            ...protection,
            checks: {
              baselineId: baseline?.id ?? null,
              findings: checkSkillVersion(before?.files ?? null, bundle.files),
            },
          };
        }
      }
      const result = await store.register({
        id: newId(),
        receiptId: newId(),
        workspaceId,
        name: bundle.slug,
        digest: bundle.digest,
        label: input.label,
        source: input.source,
        sizeBytes: tar.byteLength,
        manifest: bundle.manifest,
        principal: input.principal,
        managerRoles: EXTENSION_MANAGER_ROLES,
        ...(skill ? { skill: true } : {}),
        ...(git === undefined ? {} : { git }),
      });
      switch (result.outcome) {
        case "registered":
          return {
            outcome: result.outcome,
            bundle: result.bundle,
            receiptId: result.receiptId,
          };
        case "already_registered":
          return { outcome: result.outcome, bundle: result.bundle };
        default:
          return { outcome: result.outcome };
      }
    },

    /**
     * The bundle as the engine would read it. The stored tar is unpacked and
     * validated again and must come out with the digest it was stored under,
     * so an object that was swapped or damaged fails closed here.
     */
    async read(
      workspaceId: string,
      digest: string,
    ): Promise<ValidatedBundle | null> {
      const row = await store.findByDigest(workspaceId, digest);
      if (row === null) return null;
      const key = bundleObjectKey(workspaceId, digest);
      const tar = await objects.get(key);
      if (tar === undefined) {
        throw new BundleIntegrityError(`Object ${key} is missing.`);
      }
      let files: BundleInputFile[];
      try {
        files = unpackBundleTar(tar);
      } catch (error) {
        if (error instanceof BundleArchiveError) {
          throw new BundleIntegrityError(`Object ${key}: ${error.message}`);
        }
        throw error;
      }
      const validation = validateExtensionBundle(
        { slug: row.name, files },
        limits,
      );
      if (!validation.ok) {
        throw new BundleIntegrityError(
          `Object ${key} no longer validates: ${validation.issues[0]?.code}`,
        );
      }
      if (validation.bundle.digest !== digest) {
        throw new BundleIntegrityError(
          `Object ${key} does not match its digest.`,
        );
      }
      return validation.bundle;
    },

    async archive(
      workspaceId: string,
      digest: string,
    ): Promise<Uint8Array | null> {
      const bundle = await this.read(workspaceId, digest);
      return bundle === null ? null : packBundleTar(bundle.files);
    },

    review(input: {
      principal: Principal;
      bundleId: string;
      review: "approved" | "rejected";
    }): Promise<ReviewExtensionBundleResult> {
      return store.review({
        receiptId: newId(),
        workspaceId: input.principal.ownerId,
        bundleId: input.bundleId,
        review: input.review,
        principal: input.principal,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
    },

    recordAttachment(input: {
      principal: Principal;
      bundleId: string;
      scope?: "agent" | "workspace";
      agentId?: string;
      mode?: ExtensionMode;
      kind: "attach" | "detach";
    }): Promise<AttachmentReceiptResult> {
      return store.recordAttachment({
        receiptId: newId(),
        workspaceId: input.principal.ownerId,
        bundleId: input.bundleId,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        kind: input.kind,
        principal: input.principal,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
    },

    listAttachments(input: {
      workspaceId: string;
      agentId?: string;
    }): Promise<ExtensionAttachment[]> {
      return store.listAttachments(input);
    },
  };
  return service;
}
