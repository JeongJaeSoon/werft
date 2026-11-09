import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import type { CheckpointObjectStore } from "@werft-ai/runtime-core";
import type { Principal } from "../musterrolle/policy.ts";
import type {
  AttachmentReceiptResult,
  ExtensionAttachment,
  ExtensionBundle,
  ExtensionBundleSource,
  ExtensionBundleStore,
  ReviewExtensionBundleResult,
} from "../ports/extension-bundle-store.ts";
import {
  BundleArchiveError,
  packBundleTar,
  unpackBundleTar,
} from "./bundle-archive.ts";
import {
  type BundleInputFile,
  type BundleIssue,
  type BundleLimits,
  DEFAULT_BUNDLE_LIMITS,
  type ValidatedBundle,
  validateExtensionBundle,
} from "./bundle-validator.ts";
import type { ExtensionMode } from "./resolve.ts";

/** Who may register, review and attach bundles; the web console and API routes say the same. */
export const EXTENSION_MANAGER_ROLES: readonly WorkspaceRole[] = [
  "owner",
  "admin",
];

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
  | { outcome: "registered" | "already_registered"; bundle: ExtensionBundle }
  | { outcome: "actor_inactive" | "outranked" };

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

  return {
    async register(input: {
      principal: Principal;
      slug: string;
      files: BundleInputFile[];
      label: string;
      source: ExtensionBundleSource;
    }): Promise<RegisterBundleResult> {
      const workspaceId = input.principal.ownerId;
      const validation = validateExtensionBundle(
        { slug: input.slug, files: input.files },
        limits,
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
      const may = await store.mayManage({
        workspaceId,
        principal: input.principal,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
      if (may !== "ok") return { outcome: may };
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
      });
      switch (result.outcome) {
        case "registered":
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
}

export type ExtensionBundleService = ReturnType<
  typeof createExtensionBundleService
>;
