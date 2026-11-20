import type {
  AgentSkillList,
  PutSkillAttachmentRequest,
  RegisterSkillRequest,
  RegisterSkillResponse,
  RevertSkillResponse,
  ReviewSkillVersionRequest,
  SkillAttachmentResponse,
  SkillGitSource,
  SkillList,
  SkillVersion,
  SkillVersionChangeResponse,
  SkillVersionFiles,
} from "@werft-ai/contracts";
import type { CheckpointObjectStore } from "@werft-ai/runtime-core";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";
import {
  createExtensionBundleService,
  EXTENSION_MANAGER_ROLES,
} from "./bundle-service.ts";
import type {
  BundleInputFile,
  BundleIssue,
  BundleLimits,
  CanonicalBundleFile,
} from "./bundle-validator.ts";
import { unifiedLineDiff } from "./line-diff.ts";
import type {
  AttachmentReceiptResult,
  ExtensionBundle,
  ExtensionBundleStore,
} from "./ports/extension-bundle-store.ts";

// Skills (decision skills-and-mcp.md 2–4, 7): one SKILL.md directory per
// registration, stored as a single-skill bundle whose slug is the skill's
// name. Every write is a signed-in console user's; reads follow the
// workspace's and the agent's read rights.

const refused = (reasonCode: string, message: string, details = {}) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
    ...details,
  });

const SELF_REVIEW = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Another workspace manager reviews or archives the version you registered",
    undefined,
    { reason_code: "self_review" },
  );

// Registration order: two uploads in flight can take their numbers in the
// other order from their `registered_at` (each is its transaction's start).
const byVersion = (a: ExtensionBundle, b: ExtensionBundle) =>
  (a.version ?? 0) - (b.version ?? 0) ||
  a.registeredAt.getTime() - b.registeredAt.getTime();

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function skillVersionViewOf(bundle: ExtensionBundle): SkillVersion {
  return {
    id: bundle.id,
    name: bundle.name,
    version: bundle.version,
    digest: bundle.digest,
    source: bundle.source,
    git:
      bundle.git === null
        ? null
        : {
            repository_id: bundle.git.repositoryId,
            path: bundle.git.path,
            ref: bundle.git.ref,
            commit: bundle.git.commit,
            trigger: {
              kind: bundle.git.trigger.kind,
              delivery_id: bundle.git.trigger.deliveryId,
              user_id: bundle.git.trigger.userId,
            },
          },
    size_bytes: bundle.sizeBytes,
    has_scripts: bundle.manifest.skills.some((skill) => skill.has_scripts),
    review: bundle.review,
    registered_by: bundle.registeredBy,
    registered_at: bundle.registeredAt.toISOString(),
    reviewed_by: bundle.reviewedBy,
    reviewed_at: bundle.reviewedAt?.toISOString() ?? null,
    archived_at: bundle.archivedAt?.toISOString() ?? null,
    current: bundle.current,
  };
}

export type SkillServiceDeps = {
  authorization: AuthorizationPolicy;
  store: ExtensionBundleStore;
  objects: Pick<CheckpointObjectStore, "get" | "putImmutable">;
  limits?: BundleLimits;
  newId?: () => string;
  /** GitHub skills' sources as the list shows them, by name. */
  gitSources?: (workspaceId: string) => Promise<Map<string, SkillGitSource>>;
};

export function createSkillService(deps: SkillServiceDeps) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const bundles = createExtensionBundleService(deps);
  const workspace = (caller: Caller) =>
    ({ kind: "workspace", id: caller.ownerId }) as const;
  const agentManagerRoles = MANAGEMENT_ROLES["agent.manage"] ?? [];

  function webUser(caller: Caller): void {
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      !caller.actor?.userId
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Skills are changed from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
  }

  async function version(caller: Caller, id: string) {
    const bundle = await store.find(caller.ownerId, id);
    if (bundle === null) throw NOT_FOUND();
    return bundle;
  }

  async function versionOfName(caller: Caller, name: string, id: string) {
    const bundle = await version(caller, id);
    if (bundle.name !== name) {
      throw refused(
        "version_name_mismatch",
        `Version ${id} is a version of "${bundle.name}", not "${name}"`,
      );
    }
    return bundle;
  }

  function attachmentRefusal(
    result: Exclude<AttachmentReceiptResult, { outcome: "recorded" }>,
  ): never {
    switch (result.outcome) {
      case "bundle_not_found":
      case "agent_not_found":
        throw NOT_FOUND();
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      case "not_approved":
        throw refused(
          "version_not_approved",
          "Only an approved version is attached; forbidding a name needs none",
        );
      case "archived":
        throw refused(
          "version_archived",
          "An archived version is not attached",
        );
      case "not_attached":
        throw new Error("a detach outcome reached the attach path");
    }
  }

  async function attach(
    caller: Caller,
    scope: { agentId: string } | null,
    name: string,
    request: PutSkillAttachmentRequest,
  ): Promise<SkillAttachmentResponse> {
    const follow = "follow" in request;
    const versions = (await store.list(caller.ownerId)).filter(
      (row) => row.name === name,
    );
    // A following row names the skill; the store takes any of its versions.
    const bundle = follow
      ? versions[0]
      : await versionOfName(caller, name, request.version_id);
    if (bundle === undefined) throw NOT_FOUND();
    const result = await store.recordAttachment({
      receiptId: newId(),
      workspaceId: caller.ownerId,
      bundleId: bundle.id,
      follow,
      ...(scope === null
        ? { scope: "workspace" as const }
        : { scope: "agent" as const, agentId: scope.agentId }),
      mode: request.mode,
      kind: "attach",
      principal: caller,
      managerRoles:
        scope === null ? EXTENSION_MANAGER_ROLES : agentManagerRoles,
    });
    if (result.outcome !== "recorded") attachmentRefusal(result);
    // Read again: an approval since the read above may have moved it.
    const current = follow
      ? (await store.list(caller.ownerId)).find(
          (row) => row.name === name && row.current,
        )
      : undefined;
    return {
      name,
      scope: scope === null ? "workspace" : "agent",
      agent_id: scope?.agentId ?? null,
      attachment: {
        version_id: follow ? (current?.id ?? null) : bundle.id,
        follows: follow,
        mode: request.mode,
      },
      receipt_id: result.receiptId,
    };
  }

  async function detach(
    caller: Caller,
    scope: { agentId: string } | null,
    name: string,
  ): Promise<SkillAttachmentResponse> {
    const attached = (
      await store.listAttachments({
        workspaceId: caller.ownerId,
        ...(scope === null ? {} : { agentId: scope.agentId }),
      })
    ).find(
      (row) =>
        row.name === name &&
        row.scope === (scope === null ? "workspace" : "agent"),
    );
    const response = {
      name,
      scope: scope === null ? ("workspace" as const) : ("agent" as const),
      agent_id: scope?.agentId ?? null,
      attachment: null,
    };
    const bundleId = attached?.follows
      ? (await store.list(caller.ownerId)).find((row) => row.name === name)?.id
      : attached?.bundle?.id;
    if (attached === undefined || bundleId === undefined) {
      return { ...response, receipt_id: null };
    }
    const result = await store.recordAttachment({
      receiptId: newId(),
      workspaceId: caller.ownerId,
      bundleId,
      follow: attached.follows,
      ...(scope === null
        ? { scope: "workspace" as const }
        : { scope: "agent" as const, agentId: scope.agentId }),
      kind: "detach",
      principal: caller,
      managerRoles:
        scope === null ? EXTENSION_MANAGER_ROLES : agentManagerRoles,
    });
    // An agent deleted since the read took its attachments with it.
    if (
      result.outcome === "not_attached" ||
      result.outcome === "agent_not_found"
    ) {
      return { ...response, receipt_id: null };
    }
    if (result.outcome !== "recorded") attachmentRefusal(result);
    return { ...response, receipt_id: result.receiptId };
  }

  return {
    async list(caller: Caller): Promise<SkillList> {
      await requirePermitted(authorization, caller, "workspace.read", {
        ...workspace(caller),
      });
      const [rows, attachments, sources] = await Promise.all([
        store.list(caller.ownerId),
        store.listAttachments({ workspaceId: caller.ownerId }),
        deps.gitSources?.(caller.ownerId) ??
          Promise.resolve(new Map<string, SkillGitSource>()),
      ]);
      const byName = new Map<string, ExtensionBundle[]>();
      for (const row of rows) {
        byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
      }
      return {
        items: [...byName.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, versions]) => {
            const attached = attachments.find(
              (row) => row.scope === "workspace" && row.name === name,
            );
            const git = sources.get(name) ?? null;
            return {
              name,
              source: git === null ? ("upload" as const) : ("github" as const),
              git,
              pending_count: versions.filter(
                (row) => row.review === "pending" && row.archivedAt === null,
              ).length,
              versions: versions.sort(byVersion).map(skillVersionViewOf),
              workspace_attachment:
                attached === undefined
                  ? null
                  : {
                      version_id: attached.bundle?.id ?? null,
                      follows: attached.follows,
                      mode: attached.mode,
                    },
            };
          }),
      };
    },

    async register(
      caller: Caller,
      request: RegisterSkillRequest,
    ): Promise<RegisterSkillResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      const root = `skills/${request.name}/`;
      const files: BundleInputFile[] = request.files.map((file) => ({
        path: `${root}${file.path}`,
        kind: "file",
        mode: file.executable === true ? 0o755 : 0o644,
        bytes: new Uint8Array(Buffer.from(file.content_base64, "base64")),
      }));
      const result = await bundles.register({
        principal: caller,
        slug: request.name,
        files,
        label: request.name,
        source: "upload",
        skill: true,
      });
      switch (result.outcome) {
        case "rejected":
          throw refused("skill_invalid", "The skill did not pass the checks", {
            issues: result.issues.map((issue: BundleIssue) => ({
              path: issue.path.startsWith(root)
                ? issue.path.slice(root.length)
                : issue.path,
              code: issue.code,
              message: issue.message,
            })),
          });
        case "name_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            `"${request.name}" is the name of an extension bundle registered before skills`,
            undefined,
            { reason_code: "name_taken" },
          );
        case "source_mismatch":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            `"${request.name}" is a skill from GitHub; its versions come from its repository`,
            undefined,
            { reason_code: "source_mismatch" },
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "paused":
        case "lease_lost":
          throw new Error(`an upload reached the ${result.outcome} path`);
        case "registered":
          return {
            outcome: "registered",
            version: skillVersionViewOf(result.bundle),
            receipt_id: result.receiptId,
          };
        case "already_registered":
          return {
            outcome: "already_registered",
            version: skillVersionViewOf(result.bundle),
            receipt_id: null,
          };
      }
    },

    /**
     * The stored tree, every file whole, and what changed since the version
     * of the name last approved before this one: what a reviewer approves.
     */
    async files(caller: Caller, id: string): Promise<SkillVersionFiles> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      const bundle = await version(caller, id);
      const named = (await store.list(caller.ownerId))
        .filter((row) => row.name === bundle.name)
        .sort(byVersion);
      const at = named.findIndex((row) => row.id === bundle.id);
      const previous =
        named
          .slice(0, Math.max(0, at))
          .filter((row) => row.review === "approved")
          .at(-1) ?? null;
      const tree = await bundles.read(caller.ownerId, bundle.digest);
      if (tree === null) throw NOT_FOUND();
      const before =
        previous === null
          ? null
          : await bundles.read(caller.ownerId, previous.digest);
      const old = new Map<string, CanonicalBundleFile>(
        (before?.files ?? []).map((file) => [file.path, file]),
      );
      return {
        version: skillVersionViewOf(bundle),
        previous_approved:
          previous === null ? null : skillVersionViewOf(previous),
        files: tree.files.map((file) => {
          const text = textOf(file.bytes);
          const earlier = old.get(file.path);
          const change =
            earlier === undefined
              ? ("added" as const)
              : earlier.sha256 === file.sha256 && earlier.mode === file.mode
                ? ("unchanged" as const)
                : ("changed" as const);
          const earlierText =
            earlier === undefined ? null : textOf(earlier.bytes);
          return {
            path: file.path,
            executable: file.mode === 0o755,
            size_bytes: file.bytes.byteLength,
            sha256: file.sha256,
            text,
            change,
            diff:
              change === "changed" &&
              earlier?.sha256 !== file.sha256 &&
              text !== null &&
              earlierText !== null
                ? unifiedLineDiff(earlierText, text)
                : null,
          };
        }),
        removed: (before?.files ?? [])
          .filter((file) => !tree.files.some((now) => now.path === file.path))
          .map((file) => ({
            path: file.path,
            size_bytes: file.bytes.byteLength,
            sha256: file.sha256,
          })),
      };
    },

    async review(
      caller: Caller,
      id: string,
      request: ReviewSkillVersionRequest,
    ): Promise<SkillVersionChangeResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      const result = await bundles.review({
        principal: caller,
        bundleId: id,
        review: request.decision,
      });
      switch (result.outcome) {
        case "reviewed":
          return {
            version: skillVersionViewOf(result.bundle),
            receipt_id: result.receiptId,
          };
        case "unchanged":
          return {
            version: skillVersionViewOf(result.bundle),
            receipt_id: null,
          };
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "self_review":
          throw SELF_REVIEW();
        case "archived":
          throw refused(
            "version_archived",
            "An archived version is not reviewed",
          );
      }
    },

    async archive(
      caller: Caller,
      id: string,
    ): Promise<SkillVersionChangeResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      const result = await store.archive({
        receiptId: newId(),
        workspaceId: caller.ownerId,
        bundleId: id,
        principal: caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
      switch (result.outcome) {
        case "archived":
          return {
            version: skillVersionViewOf(result.bundle),
            receipt_id: result.receiptId,
          };
        case "unchanged":
          return {
            version: skillVersionViewOf(result.bundle),
            receipt_id: null,
          };
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "self_review":
          throw SELF_REVIEW();
        case "attached":
          throw refused(
            "version_attached",
            "A version a workspace or agent attaches is not archived; take it back first",
          );
        case "in_use":
          throw refused(
            "version_in_use",
            "A session that has not ended runs this version",
          );
        case "current":
          throw refused(
            "version_current",
            "The skill's current version is not archived; revert or reject it first",
          );
      }
    },

    /** Moves the current version one step back (decision skills-and-mcp.md 3). */
    async revert(caller: Caller, name: string): Promise<RevertSkillResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      const result = await store.revert({
        receiptId: newId(),
        workspaceId: caller.ownerId,
        name,
        principal: caller,
        managerRoles: EXTENSION_MANAGER_ROLES,
      });
      switch (result.outcome) {
        case "reverted":
          return {
            name,
            from: skillVersionViewOf(result.from),
            to: skillVersionViewOf(result.to),
            receipt_id: result.receiptId,
          };
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "no_previous_version":
          throw refused(
            "no_previous_version",
            "No approved version that is not archived comes before the current one",
          );
      }
    },

    async putWorkspaceAttachment(
      caller: Caller,
      name: string,
      request: PutSkillAttachmentRequest,
    ): Promise<SkillAttachmentResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      return attach(caller, null, name, request);
    },

    async deleteWorkspaceAttachment(
      caller: Caller,
      name: string,
    ): Promise<SkillAttachmentResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "workspace.manage", {
        ...workspace(caller),
      });
      return detach(caller, null, name);
    },

    async listAgent(caller: Caller, agentId: string): Promise<AgentSkillList> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const rows = await store.listAttachments({
        workspaceId: caller.ownerId,
        agentId,
      });
      return {
        items: rows.map((row) => ({
          name: row.name,
          scope: row.scope,
          mode: row.mode,
          follows: row.follows,
          version: row.bundle === null ? null : skillVersionViewOf(row.bundle),
        })),
      };
    },

    async putAgentAttachment(
      caller: Caller,
      agentId: string,
      name: string,
      request: PutSkillAttachmentRequest,
    ): Promise<SkillAttachmentResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "agent.manage", {
        kind: "agent",
        id: agentId,
      });
      return attach(caller, { agentId }, name, request);
    },

    async deleteAgentAttachment(
      caller: Caller,
      agentId: string,
      name: string,
    ): Promise<SkillAttachmentResponse> {
      webUser(caller);
      await requirePermitted(authorization, caller, "agent.manage", {
        kind: "agent",
        id: agentId,
      });
      return detach(caller, { agentId }, name);
    },
  };
}

export type SkillService = ReturnType<typeof createSkillService>;
