/**
 * Checkpoint object versions across a backup and a restore.
 *
 * A checkpoint names every object by S3 version, and a version id
 * is the store's to assign: no PUT can ask for one, so a restored bucket
 * holds the same bytes under new ids. Replication would keep them, but only
 * between two live buckets; a backup is a directory. The restore therefore
 * re-pins: it finds the version each byte-identical object got in the new
 * bucket, rewrites each committed manifest with those versions under the
 * key it always had, and holds everything. See docs/operator/backup-restore.md.
 *
 * Two passes live here, both refusing rather than guessing:
 *
 * - `captureCheckpointObjects` (backup) reads what every checkpoint row pins
 *   — at its version, not whatever the key holds now — and makes the backup
 *   directory carry those bytes. A key overwritten or delete-marked after
 *   its checkpoint committed would otherwise be backed up as the damage.
 * - `planRepin` + `applyRepin` (restore) verify every row against the
 *   restored bucket before writing anything, then write the manifests, read
 *   them back and hold every version. The caller commits the DB rows.
 *
 * Archived session event chunks (`session_event_archives`) go through the
 * same two passes: captured at their version, found again by their bytes in
 * the restored bucket and held there.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import {
  MAX_RESTORE_PROFILES,
  type PlatformPrompt,
  type RuntimeConfig,
} from "@werft-ai/contracts";
import {
  acceptedRuntimeVersions,
  allowedRun,
  type CatalogProfile,
  claimToolLists,
  runtimeConfigOf,
  type SessionCatalog,
  sessionProfile,
  type ToolList,
} from "@werft-ai/platform";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  CheckpointOutput,
  CompatibilityMismatch,
  ObjectRef,
  RuntimeFingerprint,
  TranscriptRevision,
} from "@werft-ai/runtime-core";
import { storedOutputs } from "@werft-ai/runtime-core";

/** One `checkpoints` row, as far as its objects are concerned. */
export type CheckpointRow = {
  readonly manifestRef: string;
  readonly manifestSha256: string;
  readonly manifestVersion: string | null;
  readonly revision: number;
  readonly sessionId: string;
};

export type Codecs = Readonly<Record<string, CheckpointCodec>>;

export class CheckpointPinError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `${problems.length} checkpoint object problem(s):\n  ${problems.join("\n  ")}`,
    );
    this.name = "CheckpointPinError";
  }
}

function recordCheckpointPinProblem(
  problems: string[],
  owner: string,
  error: unknown,
) {
  if (error instanceof CheckpointPinError) {
    problems.push(...error.problems.map((problem) => `${owner}: ${problem}`));
  } else {
    problems.push(`${owner}: ${(error as Error).message}`);
  }
}

/**
 * What a worker image stamps a checkpoint with (verify-restore.sh --image):
 * its engine build, and the profile digest its own code computes from each
 * session's claim (apps/worker/src/image-runtime.ts).
 */
export type ImageRuntime = Omit<RuntimeFingerprint, "profileSha256"> & {
  readonly profiles: Readonly<
    Record<
      string,
      | {
          profileSha256: string;
          legacyProfileSha256?: string;
          /** What the earlier digest schemes the image resumes compute. */
          earlierSchemeProfileSha256s?: readonly string[];
        }
      | { error: string }
    >
  >;
};

export function parseImageRuntime(text: string): ImageRuntime {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`image runtime is not JSON: ${text}`);
  }
  const record = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Record<string, unknown>;
  const field = (name: keyof Omit<ImageRuntime, "profiles">) => {
    const value = record[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`image runtime has no ${name}: ${text}`);
    }
    return value;
  };
  const build = {
    cliVersion: field("cliVersion"),
    engine: field("engine"),
    sdkVersion: field("sdkVersion"),
  };
  const { profiles } = record;
  if (
    typeof profiles !== "object" ||
    profiles === null ||
    Array.isArray(profiles) ||
    !Object.values(profiles).every(
      (profile) =>
        typeof profile?.profileSha256 === "string" ||
        typeof profile?.error === "string",
    )
  ) {
    throw new Error(`image runtime has no profiles: ${text}`);
  }
  return { ...build, profiles: profiles as ImageRuntime["profiles"] };
}

/**
 * The runtime a restore plan is asked for: what the target image computes
 * for the session, or, with no image named, exactly the runtime the
 * checkpoint was sealed under. Throws when the image computed no digest.
 */
export function planRuntime(
  sealed: RuntimeFingerprint,
  image: ImageRuntime | undefined,
  sessionId: string,
): RuntimeFingerprint {
  if (image === undefined) return sealed;
  const profile = Object.hasOwn(image.profiles, sessionId)
    ? image.profiles[sessionId]
    : undefined;
  if (profile === undefined) {
    throw new Error("the target image was given no claim for this session");
  }
  if ("error" in profile) {
    throw new Error(
      `the target image computed no profile digest: ${profile.error}`,
    );
  }
  const { profiles: _profiles, ...build } = image;
  return { ...build, profileSha256: profile.profileSha256 };
}

/**
 * The claim fields a worker hashes into a checkpoint's profile digest, as
 * the API would hand them to this session now: its owner and its profile
 * from the catalog (worker-gateway.ts `resolveProfile`). A session the
 * catalog no longer lets run — the pair gone, the repository re-pointed, the
 * profile edited since the session was created — is refused, as a claim
 * would refuse it (worker-unit-of-work.ts `runnablePairOf`, 258).
 * The tools are the ones the claim runs (catalog.ts claimToolLists).
 * The token is a stand-in; the digest leaves the credential out.
 */
export function sessionClaim(
  session: ClaimedSession,
  catalog: SessionCatalog,
): SessionClaim {
  const profile = runnableProfile(session, catalog);
  const lists = claimToolLists(profile, session.releaseTools);
  return claimOf(
    session,
    profile,
    (lists.runs === "release" ? lists.release : null) ?? lists.profile,
  );
}

/**
 * The claims a target image is asked for besides sessionClaim, keyed for
 * alternateDigests, in the order and under the cap the gateway's
 * `restoreRuntimesOf` offers restore configs: the session's own profile
 * with the tool list it does not run (keyed by ownToolsKey), and every
 * earlier profile (earlierProfileClaims). Refused as sessionClaim refuses.
 */
export function restoreClaims(
  session: ClaimedSession & {
    readonly id: string;
    // Whether the release pins GitHub settings (mcp-egress.ts sessionGitHubMcpOf).
    readonly githubAttached: boolean;
  },
  earlier: readonly EarlierProfile[],
  catalog: SessionCatalog,
): [key: string, claim: SessionClaim][] {
  return listClaims(session, [
    {
      profile: runnableProfile(session, catalog),
      key: (list) => ownToolsKey(session.id, list),
      own: true,
    },
    ...earlierProfilesOf(session.id, earlier, catalog),
  ]);
}

type EarlierProfile = {
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly model: string | null;
};

type ListedProfile = {
  profile: CatalogProfile;
  key: (list: ToolList) => string;
  own: boolean;
};

// Every profile list before any release list, as the gateway orders them.
// With the built-in `github` server the gateway spends two restore configs
// on a list (with and without it) and one on the list it runs (without);
// a claim is offered only when all of its configs fit, so the count errs
// towards a FAIL rather than a PASS the claim would not back.
function listClaims(
  session: ClaimOwner & {
    readonly githubAttached: boolean;
    readonly releaseTools: readonly string[] | null;
  },
  profiles: readonly ListedProfile[],
): [key: string, claim: SessionClaim][] {
  const perList = session.githubAttached ? 2 : 1;
  let used = 0;
  const claims: [string, SessionClaim][] = [];
  for (const list of ["profile", "release"] as const) {
    for (const { profile, key, own } of profiles) {
      const lists = claimToolLists(profile, session.releaseTools);
      const tools = lists[list];
      if (tools === null) continue;
      const running = own && lists.runs === list;
      used += running ? perList - 1 : perList;
      if (used > MAX_RESTORE_PROFILES) return claims;
      if (running) continue;
      claims.push([key(list), claimOf(session, profile, tools)]);
    }
  }
  return claims;
}

export type ClaimedSession = ClaimOwner & {
  readonly branch: string | null;
  readonly model: string | null;
  readonly profileFingerprint: string | null;
  readonly profileId: string | null;
  // The release's runtime_config_snapshot.tools; null without a release.
  readonly releaseTools: readonly string[] | null;
  readonly repoUrl: string | null;
  readonly repositoryId: string | null;
};

/** What every claim of a session carries whichever profile it is made for. */
type ClaimOwner = {
  readonly ownerId: string;
  readonly repositoryMode: "repository" | "none";
  // The row's platform_prompt as stored, unread: the image's claim schema
  // judges it as a worker would. Null for a revision 0 session.
  readonly platformPrompt: unknown;
};

/** A `sessions` row with its release and the release's card, as read for a plan. */
export type SessionRow = {
  platform_prompt: unknown;
  branch: string | null;
  id: string;
  model: string | null;
  owner_id: string;
  profile_fingerprint: string | null;
  profile_id: string | null;
  release_github: boolean | null;
  release_id: string | null;
  release_tools: unknown;
  repo_url: string | null;
  repository_id: string | null;
  repository_mode: "repository" | "none";
};

export function claimedSessionOf(
  row: SessionRow,
): ClaimedSession & { readonly id: string; readonly githubAttached: boolean } {
  return {
    id: row.id,
    branch: row.branch,
    model: row.model,
    ownerId: row.owner_id,
    profileFingerprint: row.profile_fingerprint,
    profileId: row.profile_id,
    // As the claim's binding reads them (worker-unit-of-work.ts releaseToolsOf).
    releaseTools:
      row.release_id === null
        ? null
        : Array.isArray(row.release_tools) &&
            row.release_tools.every((tool) => typeof tool === "string")
          ? (row.release_tools as string[])
          : [],
    // Counted as attached whenever pinned, unreadable or not: one config too
    // many only makes the count stricter.
    githubAttached: row.release_github === true,
    repoUrl: row.repo_url,
    repositoryId: row.repository_id,
    repositoryMode: row.repository_mode,
    platformPrompt: row.platform_prompt ?? null,
  };
}

function runnableProfile(
  session: ClaimedSession,
  catalog: SessionCatalog,
): CatalogProfile {
  const without = session.repositoryMode === "none";
  const run =
    session.profileId === null || (!without && session.repositoryId === null)
      ? null
      : allowedRun(catalog, session.profileId, session.repositoryId);
  if (
    run === null ||
    (run.repository !== null &&
      (run.repository.url !== session.repoUrl ||
        run.repository.branch !== session.branch))
  ) {
    throw new Error(
      without
        ? `profile ${session.profileId ?? "(none)"} may not run without a repository in the catalog`
        : `profile ${session.profileId ?? "(none)"} and repository ${session.repositoryId ?? "(none)"} at the session's URL and branch are not an allowed pair in the catalog`,
    );
  }
  const profile = sessionProfile(
    run.profile,
    { fingerprint: session.profileFingerprint, model: session.model },
    acceptedRuntimeVersions(catalog),
  );
  if (profile === null) {
    throw new Error(
      `profile ${session.profileId} has other settings in the catalog than the session was created with`,
    );
  }
  return profile;
}

/**
 * The claim fields the digest reads. A session without a repository is told
 * apart by its workspace; a claim without one is taken for a session with a
 * repository, so those keep the shape their digests were made from.
 */
export type SessionClaim = {
  principal: { owner_scope: string };
  runtime_config: RuntimeConfig;
  workspace?: { repository: null };
};

// The instructions ride on every claim of the session, as the worker
// protocol has them on runtime_config and each restore config, and only
// when there are some: a claim without them keeps the digest it had before
// the field.
function claimOf(
  session: ClaimOwner,
  profile: CatalogProfile,
  tools: readonly string[],
): SessionClaim {
  const hasRepository = session.repositoryMode === "repository";
  const runtimeConfig = runtimeConfigOf(
    profile,
    "verify-restore-stand-in",
    hasRepository,
    tools,
  );
  return {
    principal: { owner_scope: session.ownerId },
    runtime_config: {
      ...runtimeConfig,
      ...(session.platformPrompt === null
        ? {}
        : { platform_prompt: session.platformPrompt as PlatformPrompt }),
    },
    ...(hasRepository ? {} : { workspace: { repository: null } }),
  };
}

/**
 * The image claim key for a profile a session ran before its profile was
 * changed; the image hashes every key it is given the same way.
 */
export function earlierProfileKey(sessionId: string, profileId: string) {
  return `${sessionId}#${profileId}`;
}

/**
 * The image claim key for a tool list of the session's own profile; an
 * earlier profile's release list is keyed `${earlierProfileKey}@release`.
 */
export function ownToolsKey(sessionId: string, list: ToolList) {
  return `${sessionId}@${list}`;
}

/**
 * The claims for the profiles a session's restorable checkpoints were made
 * under other than the one it runs now (`earlier`, newest first), keyed by
 * earlierProfileKey for the profile's tools and `@release` after it for the
 * release's, and chosen as the gateway's claim chooses them: the catalog
 * must still hold the profile with the same fingerprint, the repository
 * need not allow it any longer, every profile list comes before any release
 * list, and no more than MAX_RESTORE_PROFILES are offered.
 */
export function earlierProfileClaims(
  session: ClaimOwner & {
    readonly id: string;
    readonly releaseTools: readonly string[] | null;
  },
  earlier: readonly EarlierProfile[],
  catalog: SessionCatalog,
): [key: string, claim: SessionClaim][] {
  return listClaims(
    { ...session, githubAttached: false },
    earlierProfilesOf(session.id, earlier, catalog),
  );
}

function earlierProfilesOf(
  sessionId: string,
  earlier: readonly EarlierProfile[],
  catalog: SessionCatalog,
): ListedProfile[] {
  return earlier.flatMap(({ profileId, profileFingerprint: made, model }) => {
    const listed = Object.hasOwn(catalog.profiles, profileId)
      ? catalog.profiles[profileId]
      : undefined;
    const profile = listed
      ? sessionProfile(
          listed,
          { fingerprint: made, model },
          acceptedRuntimeVersions(catalog),
        )
      : null;
    if (!profile) return [];
    const key = earlierProfileKey(sessionId, profileId);
    return [
      {
        profile,
        key: (list: ToolList) => (list === "profile" ? key : `${key}@release`),
        own: false,
      },
    ];
  });
}

/**
 * The digests the target image computes for the given profile keys (current
 * and frozen-legacy each), the ones a worker of it would send as
 * alternate_profile_sha256s; the caller drops the current runtime's. A
 * profile it could not hash is left out, as the gateway leaves out one the
 * catalog no longer holds.
 */
export function alternateDigests(
  image: ImageRuntime,
  keys: readonly string[],
): string[] {
  return keys.flatMap((key) => {
    const profile = Object.hasOwn(image.profiles, key)
      ? image.profiles[key]
      : undefined;
    if (profile === undefined || !("profileSha256" in profile)) return [];
    return [
      profile.profileSha256,
      ...(profile.legacyProfileSha256 === undefined
        ? []
        : [profile.legacyProfileSha256]),
      ...(profile.earlierSchemeProfileSha256s ?? []),
    ];
  });
}

/** Which digests a restore on the target image offers, as one comparable string. */
export function candidatesDigest(
  runtime: RuntimeFingerprint,
  alternates: readonly string[],
): string {
  const offered = [...new Set([runtime.profileSha256, ...alternates])].sort();
  return createHash("sha256").update(offered.join("\n")).digest("hex");
}

/**
 * Whether the digest a checkpoint was sealed with is one the target image
 * offers, the engine build being the same. For a checkpoint no restore plan
 * is asked for (one a pointer does not name): the same match the worker
 * makes in `runtimeFor`, short of the gateway's verdict.
 */
export function sealedMatchesCandidates(
  sealed: RuntimeFingerprint,
  runtime: RuntimeFingerprint,
  alternates: readonly string[],
): { ok: true } | { ok: false; kind: "build" | "digest"; detail: string } {
  const build = (["engine", "sdkVersion", "cliVersion"] as const).filter(
    (field) => sealed[field] !== runtime[field],
  );
  if (build.length > 0) {
    return {
      ok: false,
      kind: "build",
      detail: `sealed on another engine build (${build.join(", ")} differ)`,
    };
  }
  if (
    sealed.profileSha256 !== runtime.profileSha256 &&
    !alternates.includes(sealed.profileSha256)
  ) {
    return {
      ok: false,
      kind: "digest",
      detail: `sealed under profile digest ${sealed.profileSha256}, which the target image does not compute for any config of the session`,
    };
  }
  return { ok: true };
}

export function describeMismatches(
  mismatches: readonly CompatibilityMismatch[],
): string {
  return mismatches
    .map(({ expected, field, found }) => `${field} ${found} → ${expected}`)
    .join(", ");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Why the bytes read for a checkpoint are not the manifest its row records,
 * or null. A restore check is kept against the row's hash, so it must have
 * been made on bytes with that hash.
 */
export function manifestBindingProblem(
  bytes: Uint8Array,
  recordedSha256: string,
): string | null {
  const actual = sha256Hex(bytes);
  return actual === recordedSha256
    ? null
    : `manifest bytes hash to ${actual}, the row records ${recordedSha256}`;
}

/** Every object a manifest pins besides itself, in restore-plan order. */
export function refsOf(manifest: CheckpointManifest): ObjectRef[] {
  return [
    ...manifest.transcripts.root.parts,
    ...Object.keys(manifest.transcripts.subagents)
      .sort()
      .flatMap(
        (subpath) => manifest.transcripts.subagents[subpath]?.parts ?? [],
      ),
    // Bases live in the directories of the checkpoints that wrote them, and
    // this one restores only if every one of them does.
    ...(manifest.workspace.baseBundles ?? []),
    manifest.workspace.bundle,
    ...manifest.workspace.untracked,
    ...storedOutputs(manifest.outputs),
  ];
}

type PlannedObjects = {
  readonly artifacts: readonly { readonly objects: readonly ObjectRef[] }[];
  readonly manifestRef: string;
  readonly manifestVersion?: string | undefined;
};

type PinnedObject = Omit<ObjectRef, "version"> & {
  readonly version?: string | undefined;
};

/**
 * What verify-restore reads back for one ready restore plan: the manifest, the
 * plan's artifacts, and the stored outputs. A restore plan carries no outputs
 * (they are not restored into the workspace), but the manifest pins them and
 * the sessions API serves them by that version.
 */
export function pinnedObjectsOf(
  plan: PlannedObjects,
  manifest: CheckpointManifest,
  manifestBytes: Uint8Array,
): PinnedObject[] {
  return [
    {
      bytes: manifestBytes.byteLength,
      key: plan.manifestRef,
      sha256: sha256Hex(manifestBytes),
      version: plan.manifestVersion,
    },
    ...plan.artifacts.flatMap((artifact) => artifact.objects),
    ...storedOutputs(manifest.outputs),
  ];
}

/** One line per object that is unversioned, unreadable, altered or not held. */
export async function planProblems(
  objects: CheckpointObjectStore,
  pinned: readonly PinnedObject[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const object of pinned) {
    if (object.version === undefined) {
      problems.push(`${object.key} has no version in the plan`);
      continue;
    }
    const bytes = await objects.get(object.key, object.version);
    if (
      bytes === undefined ||
      bytes.byteLength !== object.bytes ||
      sha256Hex(bytes) !== object.sha256
    ) {
      problems.push(
        `${object.key} version ${object.version} does not read back`,
      );
      continue;
    }
    const head = await objects.head(object.key, object.version);
    if (head?.held !== true) {
      problems.push(`${object.key} version ${object.version} is not held`);
    }
  }
  return problems;
}

/**
 * Where a key lives under the backup's objects/ directory. Only keys that
 * map to exactly one plain path inside it are accepted: `normalize` leaves
 * a leading `..` in place, so those are refused by segment. Checkpoint keys
 * are `sessions/<id>/...` and never need more.
 */
export function backupPath(objectsDir: string, key: string): string {
  if (
    key === "" ||
    key.startsWith("/") ||
    normalize(key) !== key ||
    key.split("/").includes("..")
  ) {
    throw new CheckpointPinError([
      `object key ${JSON.stringify(key)} has no single path in a backup`,
    ]);
  }
  return join(objectsDir, key);
}

function decode(
  codecs: Codecs,
  row: CheckpointRow,
  bytes: Uint8Array,
): CheckpointManifest {
  let engine: unknown;
  try {
    engine = (
      JSON.parse(new TextDecoder().decode(bytes)) as { engine?: unknown }
    ).engine;
  } catch {
    engine = undefined;
  }
  const codec =
    typeof engine === "string" && Object.hasOwn(codecs, engine)
      ? codecs[engine]
      : undefined;
  if (codec === undefined) {
    throw new Error(`no codec for engine ${JSON.stringify(engine)}`);
  }
  const manifest = codec.decode(bytes);
  if (
    manifest.sessionId !== row.sessionId ||
    manifest.revision !== row.revision
  ) {
    throw new Error(
      `manifest is sealed for ${manifest.sessionId}@${manifest.revision}`,
    );
  }
  return manifest;
}

const label = (row: CheckpointRow) => `${row.sessionId}@${row.revision}`;

/**
 * One key must mean one byte string across every row: the backup keeps a
 * single file per key and the restored bucket a single current version.
 */
class Inventory {
  readonly #byKey = new Map<string, { bytes: number; sha256: string }>();

  constructor(private readonly problems: string[]) {}

  /** False when the key was already claimed with other bytes. */
  claim(owner: string, key: string, sha256: string, bytes: number): boolean {
    const seen = this.#byKey.get(key);
    if (seen === undefined) {
      this.#byKey.set(key, { bytes, sha256 });
      return true;
    }
    if (seen.sha256 === sha256 && seen.bytes === bytes) return true;
    this.problems.push(
      `${owner}: ${key} is pinned as ${sha256} here and as ${seen.sha256} by another checkpoint`,
    );
    return false;
  }
}

/**
 * A manifest key excluded from the restore sync must not also be an object
 * some checkpoint pins: validation lets a manifest name any key in its
 * session, including another checkpoint's manifest.
 */
function checkManifestKeysArePrivate(
  manifests: ReadonlyMap<string, string>,
  refs: Iterable<readonly [owner: string, key: string]>,
  problems: string[],
) {
  for (const [owner, key] of refs) {
    const manifestOf = manifests.get(key);
    if (manifestOf !== undefined) {
      problems.push(
        `${owner}: pins ${key}, which is the manifest of ${manifestOf}; a backup cannot re-pin a manifest another checkpoint depends on`,
      );
    }
  }
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomically(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.pinned-${process.pid}`;
  await writeFile(staged, bytes, { mode: 0o600 });
  await rename(staged, path);
}

/**
 * Backup side: makes `objectsDir` (already filled by a current-version sync)
 * carry, for every key a checkpoint row pins, exactly the pinned bytes.
 * Returns the keys whose file was replaced or added; the caller warns.
 *
 * Reads each manifest at the row's `manifest_version` and each ref at its
 * `version` (by key where either is absent: a row committed `unversioned`).
 * Throws `CheckpointPinError` listing every row that cannot be backed up
 * whole — missing version, bytes that do not hash, one key pinned with two
 * contents, or a manifest key another checkpoint pins — since a backup that
 * silently lost a checkpoint only fails at restore.
 */
export async function captureCheckpointObjects(input: {
  codecs: Codecs;
  objects: CheckpointObjectStore;
  objectsDir: string;
  rows: readonly CheckpointRow[];
}): Promise<{ replaced: string[] }> {
  const { codecs, objects, objectsDir, rows } = input;
  const problems: string[] = [];
  const inventory = new Inventory(problems);
  const manifests = new Map<string, string>();
  const pinnedRefs: Array<readonly [string, string]> = [];
  const replaced: string[] = [];
  const fetched = new Set<string>();

  async function keep(key: string, bytes: Uint8Array) {
    const path = backupPath(objectsDir, key);
    const onDisk = await readIfPresent(path);
    if (onDisk !== undefined && sha256Hex(onDisk) === sha256Hex(bytes)) return;
    await writeAtomically(path, bytes);
    replaced.push(key);
  }

  for (const row of rows) {
    const owner = label(row);
    try {
      const bytes = await objects.get(
        row.manifestRef,
        row.manifestVersion ?? undefined,
      );
      if (bytes === undefined) {
        problems.push(
          `${owner}: manifest ${row.manifestRef}${versionSuffix(row.manifestVersion)} is missing`,
        );
        continue;
      }
      if (sha256Hex(bytes) !== row.manifestSha256) {
        problems.push(
          `${owner}: manifest ${row.manifestRef} hashes to ${sha256Hex(bytes)}, the row says ${row.manifestSha256}`,
        );
        continue;
      }
      const manifest = decode(codecs, row, bytes);
      manifests.set(row.manifestRef, owner);
      if (
        !inventory.claim(
          owner,
          row.manifestRef,
          row.manifestSha256,
          bytes.byteLength,
        )
      ) {
        continue;
      }
      await keep(row.manifestRef, bytes);
      for (const ref of refsOf(manifest)) {
        pinnedRefs.push([owner, ref.key]);
        if (!inventory.claim(owner, ref.key, ref.sha256, ref.bytes)) continue;
        const token = `${ref.key}\u0000${ref.version ?? ""}`;
        if (fetched.has(token)) continue;
        fetched.add(token);
        const content = await objects.get(ref.key, ref.version);
        if (content === undefined) {
          problems.push(
            `${owner}: ${ref.key}${versionSuffix(ref.version)} is missing`,
          );
          continue;
        }
        const found = sha256Hex(content);
        if (found !== ref.sha256 || content.byteLength !== ref.bytes) {
          problems.push(
            `${owner}: ${ref.key}${versionSuffix(ref.version)} is ${content.byteLength} bytes hashing to ${found}; the manifest says ${ref.bytes} bytes, ${ref.sha256}`,
          );
          continue;
        }
        await keep(ref.key, content);
      }
    } catch (error) {
      recordCheckpointPinProblem(problems, owner, error);
    }
  }
  checkManifestKeysArePrivate(manifests, pinnedRefs, problems);
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return { replaced: [...new Set(replaced)].sort() };
}

function versionSuffix(version: string | null | undefined) {
  return version == null ? "" : ` (version ${version})`;
}

/** One row's manifest, re-pinned to the restored bucket, not yet written. */
export type RepinnedCheckpoint = {
  readonly manifest: CheckpointManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly row: CheckpointRow;
};

/**
 * Restore side, read-only: for every row, the backup's manifest (it must
 * hash to the row) with each ref's `version` replaced by the version the
 * restored bucket holds those exact bytes under. Nothing is written, so a
 * refusal leaves the bucket as the sync left it.
 *
 * The manifest keys themselves must be absent from the bucket — the restore
 * leaves them out of the sync so each can be created once, re-pinned, at the
 * key `manifestRefFor` gives it.
 */
export async function planRepin(input: {
  codecs: Codecs;
  objects: CheckpointObjectStore;
  objectsDir: string;
  rows: readonly CheckpointRow[];
}): Promise<RepinnedCheckpoint[]> {
  const { codecs, objects, objectsDir, rows } = input;
  const problems: string[] = [];
  const inventory = new Inventory(problems);
  const manifests = new Map<string, string>();
  const pinnedRefs: Array<readonly [string, string]> = [];
  // A key read once is the same current version for every row that pins it.
  const versions = new Map<string, string | undefined>();
  const planned: RepinnedCheckpoint[] = [];

  async function restoredVersion(
    owner: string,
    ref: ObjectRef,
  ): Promise<string | undefined> {
    if (versions.has(ref.key)) return versions.get(ref.key);
    let version: string | undefined;
    const head = await objects.head(ref.key);
    if (head === undefined) {
      problems.push(`${owner}: ${ref.key} is not in the restored bucket`);
    } else if (head.version === undefined) {
      problems.push(
        `${owner}: ${ref.key} has no version in the restored bucket; it needs versioning and Object Lock`,
      );
    } else {
      const bytes = await objects.get(ref.key, head.version);
      const found = bytes === undefined ? undefined : sha256Hex(bytes);
      if (
        bytes === undefined ||
        found !== ref.sha256 ||
        bytes.byteLength !== ref.bytes
      ) {
        problems.push(
          `${owner}: ${ref.key} (version ${head.version}) does not match the manifest (${ref.bytes} bytes, ${ref.sha256})`,
        );
      } else {
        version = head.version;
      }
    }
    versions.set(ref.key, version);
    return version;
  }

  for (const row of rows) {
    const owner = label(row);
    try {
      const bytes = await readIfPresent(
        backupPath(objectsDir, row.manifestRef),
      );
      if (bytes === undefined) {
        problems.push(`${owner}: backup has no manifest ${row.manifestRef}`);
        continue;
      }
      if (sha256Hex(bytes) !== row.manifestSha256) {
        problems.push(
          `${owner}: backup manifest ${row.manifestRef} hashes to ${sha256Hex(bytes)}, the row says ${row.manifestSha256}`,
        );
        continue;
      }
      const manifest = decode(codecs, row, bytes);
      manifests.set(row.manifestRef, owner);
      if (await objects.head(row.manifestRef)) {
        problems.push(
          `${owner}: ${row.manifestRef} already exists in the restored bucket; the re-pinned manifest must be its first write`,
        );
        continue;
      }
      let complete = true;
      const pin = async <T extends ObjectRef>(ref: T): Promise<T> => {
        pinnedRefs.push([owner, ref.key]);
        if (!inventory.claim(owner, ref.key, ref.sha256, ref.bytes)) {
          complete = false;
          return ref;
        }
        const version = await restoredVersion(owner, ref);
        if (version === undefined) {
          complete = false;
          return ref;
        }
        return { ...ref, version };
      };
      const pinRevision = async (
        revision: TranscriptRevision,
      ): Promise<TranscriptRevision> => ({
        ...revision,
        parts: await sequential(revision.parts, pin),
      });
      const subagents: Record<string, TranscriptRevision> = {};
      for (const subpath of Object.keys(
        manifest.transcripts.subagents,
      ).sort()) {
        const revision = manifest.transcripts.subagents[subpath];
        if (revision !== undefined)
          subagents[subpath] = await pinRevision(revision);
      }
      const repinned: CheckpointManifest = {
        ...manifest,
        ...(manifest.outputs === undefined
          ? {}
          : {
              outputs: await sequential(
                manifest.outputs,
                async (output): Promise<CheckpointOutput> =>
                  "omitted" in output ? output : pin(output),
              ),
            }),
        transcripts: {
          root: await pinRevision(manifest.transcripts.root),
          subagents,
        },
        workspace: {
          ...manifest.workspace,
          ...(manifest.workspace.baseBundles === undefined
            ? {}
            : {
                baseBundles: await sequential(
                  manifest.workspace.baseBundles,
                  pin,
                ),
              }),
          bundle: await pin(manifest.workspace.bundle),
          untracked: await sequential(manifest.workspace.untracked, pin),
        },
      };
      if (!complete) continue;
      const codec = codecs[manifest.engine];
      if (codec === undefined)
        throw new Error(`no codec for ${manifest.engine}`);
      const sealed = codec.encode(repinned);
      // The codec must read its own output back as the same checkpoint, or
      // the restored API would refuse what this wrote.
      decode(codecs, row, sealed.bytes);
      planned.push({
        manifest: repinned,
        manifestBytes: sealed.bytes,
        manifestSha256: sealed.sha256,
        row,
      });
    } catch (error) {
      recordCheckpointPinProblem(problems, owner, error);
    }
  }
  checkManifestKeysArePrivate(manifests, pinnedRefs, problems);
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return planned;
}

async function sequential<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await map(item));
  return out;
}

/** What the caller writes to the row once every checkpoint is applied. */
export type RepinnedRow = {
  readonly manifestSha256: string;
  readonly manifestVersion: string;
  readonly previousSha256: string;
  readonly revision: number;
  readonly sessionId: string;
};

/**
 * Restore side, writing: creates each re-pinned manifest at its key, reads it
 * back by the version the store answered, and holds every version the
 * checkpoint names. Only after all of that may the row say
 * `versions_held` — the same claim a locked finalize makes, backed by the
 * same work. Throws on the first failure; the caller must then abandon the
 * target, since neither uploads nor holds can be undone.
 */
export async function applyRepin(input: {
  objects: CheckpointObjectStore;
  planned: readonly RepinnedCheckpoint[];
}): Promise<RepinnedRow[]> {
  const { objects, planned } = input;
  const hold = objects.hold?.bind(objects);
  if (hold === undefined) {
    throw new Error("the restored object store cannot hold versions");
  }
  const held = new Set<string>();
  const holdOnce = async (key: string, version: string) => {
    const token = `${key}\u0000${version}`;
    if (held.has(token)) return;
    await hold(key, version);
    held.add(token);
  };
  const rows: RepinnedRow[] = [];
  for (const checkpoint of planned) {
    const { row } = checkpoint;
    const put = await objects.putImmutable(
      row.manifestRef,
      checkpoint.manifestBytes,
    );
    if (put.outcome !== "created" || put.version === undefined) {
      throw new Error(
        `${label(row)}: writing ${row.manifestRef} answered ${put.outcome}${put.outcome === "conflict" ? "" : put.version === undefined ? " without a version" : ""}`,
      );
    }
    const readBack = await objects.get(row.manifestRef, put.version);
    if (
      readBack === undefined ||
      sha256Hex(readBack) !== checkpoint.manifestSha256
    ) {
      throw new Error(
        `${label(row)}: ${row.manifestRef} (version ${put.version}) does not read back as written`,
      );
    }
    for (const ref of refsOf(checkpoint.manifest)) {
      if (ref.version === undefined) {
        throw new Error(`${label(row)}: ${ref.key} was left without a version`);
      }
      await holdOnce(ref.key, ref.version);
    }
    await holdOnce(row.manifestRef, put.version);
    rows.push({
      manifestSha256: checkpoint.manifestSha256,
      manifestVersion: put.version,
      previousSha256: row.manifestSha256,
      revision: row.revision,
      sessionId: row.sessionId,
    });
  }
  return rows;
}

/**
 * One `session_event_archives` row: once its events left the database the
 * object at that version is their only copy, so a backup and a restore pin
 * it the way they pin a checkpoint's objects.
 */
export type ArchiveRow = {
  readonly sessionId: string;
  readonly fromId: number;
  readonly objectKey: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly bytes: number;
};

const archiveLabel = (row: ArchiveRow) =>
  `archive ${row.sessionId}@${row.fromId}`;

/**
 * Backup side: makes `objectsDir` carry each archived chunk as recorded,
 * read at its version. Throws `CheckpointPinError` for a chunk that is
 * missing or does not hash to its row.
 */
export async function captureArchiveObjects(input: {
  objects: CheckpointObjectStore;
  objectsDir: string;
  rows: readonly ArchiveRow[];
}): Promise<{ replaced: string[] }> {
  const problems: string[] = [];
  const replaced: string[] = [];
  for (const row of input.rows) {
    const bytes = await input.objects.get(row.objectKey, row.versionId);
    if (
      bytes === undefined ||
      bytes.byteLength !== row.bytes ||
      sha256Hex(bytes) !== row.sha256
    ) {
      problems.push(
        `${archiveLabel(row)}: ${row.objectKey} (version ${row.versionId}) is ${bytes === undefined ? "missing" : `${bytes.byteLength} bytes hashing to ${sha256Hex(bytes)}`}; the row says ${row.bytes} bytes, ${row.sha256}`,
      );
      continue;
    }
    const path = backupPath(input.objectsDir, row.objectKey);
    const onDisk = await readIfPresent(path);
    if (onDisk !== undefined && sha256Hex(onDisk) === row.sha256) continue;
    await writeAtomically(path, bytes);
    replaced.push(row.objectKey);
  }
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return { replaced: replaced.sort() };
}

/** An archived chunk's version in the restored bucket. */
export type RepinnedArchive = { readonly row: ArchiveRow; version: string };

/**
 * Restore side, read-only: the version the restored bucket holds each
 * archived chunk's exact bytes under.
 */
export async function planArchiveRepin(input: {
  objects: CheckpointObjectStore;
  rows: readonly ArchiveRow[];
}): Promise<RepinnedArchive[]> {
  const problems: string[] = [];
  const planned: RepinnedArchive[] = [];
  for (const row of input.rows) {
    const head = await input.objects.head(row.objectKey);
    if (head?.version === undefined) {
      problems.push(
        `${archiveLabel(row)}: ${row.objectKey} ${head === undefined ? "is not in the restored bucket" : "has no version in the restored bucket"}`,
      );
      continue;
    }
    const bytes = await input.objects.get(row.objectKey, head.version);
    if (
      bytes === undefined ||
      bytes.byteLength !== row.bytes ||
      sha256Hex(bytes) !== row.sha256
    ) {
      problems.push(
        `${archiveLabel(row)}: ${row.objectKey} (version ${head.version}) does not match the row (${row.bytes} bytes, ${row.sha256})`,
      );
      continue;
    }
    planned.push({ row, version: head.version });
  }
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return planned;
}

/** Restore side, writing: holds every planned chunk version. */
export async function applyArchiveRepin(input: {
  objects: CheckpointObjectStore;
  planned: readonly RepinnedArchive[];
}): Promise<void> {
  const hold = input.objects.hold?.bind(input.objects);
  if (hold === undefined) {
    throw new Error("the restored object store cannot hold versions");
  }
  for (const { row, version } of input.planned) {
    await hold(row.objectKey, version);
  }
}
