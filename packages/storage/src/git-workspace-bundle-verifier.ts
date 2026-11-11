import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspaceBundleVerifier } from "@werft-ai/platform";
import {
  checkpointBundleRefs,
  gitBundleOffersFrom,
  manifestSourcesOf,
  PEELED_REF_FORMAT,
  peeledCommits,
} from "@werft-ai/runtime-core";

import {
  defaultGitRunner,
  type GitCommandResult,
  type GitCommandRunner,
  type GitResourceLimits,
} from "./git-runner.ts";

export type GitWorkspaceBundleVerifierOptions = {
  readonly gitRunner?: GitCommandRunner;
  /**
   * Address space each git process may use. What bounds a bundle's cost is
   * its largest object, not its size on the wire: index-pack holds a delta's
   * base and result whole, and a delta header declares whatever result size
   * it likes.
   */
  readonly maxGitMemoryBytes?: number;
  /**
   * Most objects a pack may declare before it is refused unread. The byte
   * ceiling the service applies bounds the input, not the work: a pack of
   * tiny deltas can declare millions of objects, and index-pack's memory
   * and index size grow with the count, not the bytes. Real workspaces at
   * the byte ceiling hold thousands, so the default leaves a wide margin.
   */
  readonly maxPackObjects?: number;
  /**
   * Where the throwaway repository lives; defaults to the OS temp directory.
   * Tests point it at a directory they can list to prove nothing is left.
   */
  readonly tempRoot?: string;
  /**
   * Ceiling for each git invocation on a bundle of up to
   * `GIT_VERIFY_TIMEOUT_REFERENCE_BYTES`; a larger one gets proportionally
   * more (`gitVerifyTimeoutMs`). A git still running past that is wedged,
   * not busy.
   */
  readonly timeoutMs?: number;
};

export const DEFAULT_GIT_VERIFY_TIMEOUT_MS = 60_000;
/**
 * The bundle size the fixed timeout covers; larger bundles receive time in
 * direct proportion through `gitVerifyTimeoutMs`.
 */
const GIT_VERIFY_TIMEOUT_REFERENCE_BYTES = 256 * 1024 * 1024;

/**
 * Each git's timeout, and so its CPU limit, for a bundle of `bytes`:
 * `timeoutMs` up to the reference size, and the same time per byte above it.
 */
export function gitVerifyTimeoutMs(
  bytes: number,
  timeoutMs = DEFAULT_GIT_VERIFY_TIMEOUT_MS,
): number {
  return Math.max(
    timeoutMs,
    Math.ceil((bytes / GIT_VERIFY_TIMEOUT_REFERENCE_BYTES) * timeoutMs),
  );
}
const DEFAULT_MAX_PACK_OBJECTS = 1_000_000;
/**
 * 1.5 GiB. Git may hold a base and resolved result near
 * `core.bigFileThreshold` at once. The cap leaves margin for that valid case
 * and refuses multi-gigabyte results declared by a small delta.
 */
export const DEFAULT_MAX_GIT_MEMORY_BYTES = 1536 * 1024 * 1024;

/**
 * Headroom over the largest file git should write, for what the estimate in
 * `gitLimits` does not itemise (index-pack's temporary names, the ref files).
 */
const FILE_SIZE_SLACK_BYTES = 1024 * 1024;

/**
 * `git check-ref-format`'s rules, so that any name git itself would write
 * into a bundle passes and anything git would reject in a refspec never
 * reaches one: `HEAD`, or a `refs/`-rooted path whose components are
 * non-empty, do not start with a dot, do not end with a dot or `.lock`, and
 * contain no control character, space, `~`, `^`, `:`, `?`, `*`, `[`,
 * backslash, `..` or `@{`. A leading dash is refused as well, so the name
 * can never read as an option.
 */
export function gitRefNameAcceptable(ref: string): boolean {
  if (ref === "HEAD") return true;
  if (!ref.startsWith("refs/") || ref.endsWith("/")) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("@{")) {
    return false;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git's rule
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  return ref
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".") &&
        !component.endsWith(".lock"),
    );
}

/**
 * The git-backed `WorkspaceBundleVerifier`: proves the bundle's pack really
 * holds the commit it claims, which is the one thing bytes alone cannot show.
 *
 * `git bundle verify` only reads the header, so a pack whose header was
 * rewritten passes it. A fetch into an empty bare repository does not: git
 * indexes every object, fsck-checks it, and then walks from the ref tip to
 * make sure every reachable object arrived. `rev-list --objects` afterwards
 * repeats that walk for the commit the manifest pinned, so the verdict covers
 * the pinned commit rather than whichever ref the bundle happened to name.
 *
 * Two kinds of failure, kept apart because the service turns a verdict into
 * a permanent rejection and a throw into a retryable outage. Git refusing the
 * pack — a missing or corrupt object, a tip the pack did not deliver — is a
 * verdict about the bundle and comes back `unusable`. Everything else — no
 * temp space, no git binary, a spawn failure, a repository that would not
 * initialise, a git killed by a signal or by the timeout, a git or helper
 * that ran out of the memory, file size or CPU it is allowed, or a failure
 * this code does not recognise — is thrown, so a healthy checkpoint is never
 * retired over a full disk or a busy host. Recognition is by git's own
 * wording under `LC_ALL=C`; the list is git's refusals, not the OS errors, so
 * that an unknown message errs toward a retry rather than a rejection.
 *
 * Running out of a limit is a fault rather than a verdict for the same
 * reason the timeout is: "Out of memory" reads the same whether the pack
 * asked for too much or the host had too little, and a limit sized wrong
 * must not retire a healthy checkpoint for good. A hostile bundle is retried
 * instead, and every retry costs no more than the limits allow.
 *
 * Nothing about this run outlives it: the repository is created under a fresh
 * temp directory and removed whichever way the run ends.
 */
export function createGitWorkspaceBundleVerifier(
  options: GitWorkspaceBundleVerifierOptions = {},
): WorkspaceBundleVerifier {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_VERIFY_TIMEOUT_MS;
  const maxPackObjects = options.maxPackObjects ?? DEFAULT_MAX_PACK_OBJECTS;
  const maxGitMemoryBytes =
    options.maxGitMemoryBytes ?? DEFAULT_MAX_GIT_MEMORY_BYTES;
  return {
    policy: JSON.stringify({ maxGitMemoryBytes, maxPackObjects, timeoutMs }),
    async verify({ bases = [], bytes, commit, key, path, sources = [] }) {
      // The structural read is the cheap gate: no git process for bytes that
      // are not a whole chain of bundles offering the commit, and it hands
      // back the refs to fetch and the object count each pack declares.
      const earlier = new Set<string>();
      const links: Array<{ bytes: number; path: string; refs: string[] }> = [];
      let objects = 0;
      for (const [index, link] of [...bases, { bytes, key, path }].entries()) {
        const tip = index === bases.length;
        const offer = await gitBundleOffersFrom(
          createReadStream(link.path),
          tip ? commit : undefined,
          earlier,
        );
        const unusable = (reason: string) => ({
          status: "unusable" as const,
          reason: bases.length === 0 ? reason : `${link.key}: ${reason}`,
        });
        if (offer.status !== "offers") return unusable(offer.reason);
        const refs = [...offer.refs];
        // The ref name goes into a refspec and, if git objects to it, into
        // stderr. Only a name git itself would accept gets that far, so a
        // bundle cannot choose what the failure below looks like.
        const odd = refs.find((ref) => !gitRefNameAcceptable(ref));
        if (odd !== undefined) {
          return unusable(
            `git bundle ref name is not one git would accept: ${JSON.stringify(odd)}`,
          );
        }
        for (const oid of offer.tips) earlier.add(oid);
        objects += offer.objects;
        links.push({ bytes: link.bytes, path: link.path, refs });
      }
      if (objects > maxPackObjects) {
        return {
          status: "unusable",
          reason: `git bundle declares ${objects} objects, over the ${maxPackObjects} the control plane will index`,
        };
      }
      const directory = await mkdtemp(
        join(options.tempRoot ?? tmpdir(), "bundle-verify-"),
      );
      const total = links.reduce((sum, link) => sum + link.bytes, 0);
      // Each fetch gets the time its own bundle earns, and the walk over the
      // whole history the time all of them do.
      const git = (args: readonly string[], cwd: string, budgetBytes = total) =>
        gitRunner(args, {
          clearGitEnvironment: true,
          cwd,
          env: {
            // The verdict must not depend on whoever runs the control plane:
            // no user config, no system config, no prompts, and git's
            // messages in the one language `refused` below reads.
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
            // Whatever git puts aside goes where the finally below removes it.
            TMPDIR: directory,
          },
          limits: gitLimits(
            total,
            objects,
            gitVerifyTimeoutMs(budgetBytes, timeoutMs),
            bases.length > 0,
          ),
          timeoutMs: gitVerifyTimeoutMs(budgetBytes, timeoutMs),
        });
      try {
        const repository = join(directory, "repo.git");
        const init = await git(
          ["init", "--quiet", "--bare", repository],
          directory,
        );
        if (init.exitCode !== 0) {
          throw new Error(
            `git init failed with exit code ${init.exitCode}: ${init.stderr.trim()}`,
          );
        }
        // fsck on the way in rejects malformed objects; the connectivity check
        // fetch runs by default rejects a tip the pack does not deliver.
        // Maintenance is off because fetch otherwise detaches
        // `git maintenance run --auto`, which outlives this call and can
        // recreate the repository after it has been removed. One index-pack
        // thread keeps a verification to one core; left alone it takes one
        // per CPU.
        // In chain order, every ref of each, as a restore fetches them: a
        // link's tips are where the next one's prerequisites are looked for,
        // and any ref of the last may be all that lands the commit.
        for (const [index, link] of links.entries()) {
          const fetch = await git(
            [
              "-c",
              "fetch.fsckObjects=true",
              "-c",
              "transfer.fsckObjects=true",
              "-c",
              "maintenance.auto=false",
              "-c",
              "gc.auto=0",
              "-c",
              "pack.threads=1",
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              // Absolute: fetch runs inside the repository, not where the
              // service put the file.
              resolve(link.path),
              ...link.refs.map(
                (ref, at) => `${ref}:refs/verify/chain/${index}/${at}`,
              ),
            ],
            repository,
            link.bytes,
          );
          if (fetch.exitCode !== 0) return refused("git fetch", fetch);
        }
        // The header lets the commit be an earlier link's tip, because a tag
        // over it is just another ref there. The last link's refs are what a
        // restore checks out, so they meet the rule it applies
        // (`checkpointBundleRefs`): its worktree ref lands the commit, as a
        // ref or a tag over one.
        const last = links.length - 1;
        const landed = await git(
          [
            "for-each-ref",
            `--format=${PEELED_REF_FORMAT}`,
            `refs/verify/chain/${last}/`,
          ],
          repository,
        );
        if (landed.exitCode !== 0) return refused("git for-each-ref", landed);
        const peeled = peeledCommits(landed.stdout);
        const checked = checkpointBundleRefs(
          (links[last]?.refs ?? []).map((ref, at) => [
            ref,
            peeled.get(`refs/verify/chain/${last}/${at}`) ?? null,
          ]),
          commit.toLowerCase(),
        );
        if (checked.status === "invalid") {
          return {
            status: "unusable",
            reason:
              bases.length === 0 ? checked.reason : `${key}: ${checked.reason}`,
          };
        }
        const carried = manifestSourcesOf(checked.refs);
        const missing = sources.find(
          (named) =>
            !carried.some(
              (source) =>
                source.name === named.name && source.commit === named.commit,
            ),
        );
        if (missing !== undefined) {
          return {
            status: "unusable",
            reason: `the manifest's source branch ${missing.name} is not at ${missing.commit} in the bundle`,
          };
        }
        const walk = await git(
          [
            "rev-list",
            "--objects",
            "--quiet",
            `${commit}^{commit}`,
            ...sources.map((source) => `${source.commit}^{commit}`),
            "--",
          ],
          repository,
        );
        if (walk.exitCode !== 0) return refused("git rev-list", walk);
        return { status: "restorable" };
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };

  /**
   * Disk needs no total: a bundle is always unpacked by index-pack, never
   * into loose objects, so what git writes is a copy of the pack (no bigger
   * than the bundle), its index (one entry per declared object, up to 40
   * bytes each for SHA-256) and a reverse index smaller than that. Capping
   * each file at the larger of the two keeps that true of whatever git is
   * handed. A later link of a chain is a thin pack, which index-pack
   * completes with the delta bases it names from the links before it, each
   * one whole: on top of everything the chain carries, the cap leaves room
   * for one base as large as git may hold in memory to resolve. CPU gets
   * the wall-clock budget: one thread cannot use more.
   */
  function gitLimits(
    bundleBytes: number,
    objects: number,
    budgetMs: number,
    thin: boolean,
  ): GitResourceLimits {
    return {
      cpuSeconds: Math.ceil(budgetMs / 1000),
      fileSizeBytes:
        Math.max(bundleBytes, 1024 + objects * 40) +
        (thin ? maxGitMemoryBytes : 0) +
        FILE_SIZE_SLACK_BYTES,
      memoryBytes: maxGitMemoryBytes,
    };
  }
}

/**
 * How git words a refusal of the pack or of the commit, under `LC_ALL=C`.
 * Specific diagnostics only: `fetch` names a corrupt or truncated pack, a
 * malformed object or a tip the pack did not deliver; `rev-list` names a
 * commit that never arrived. Generic words such as "pack" or "index-pack"
 * also appear when git fails to fork or open a directory, so they are not
 * here.
 */
const GIT_REFUSALS = [
  // fetch: connectivity and fsck.
  "did not send all necessary objects",
  "bad object",
  "missing blob",
  "missing tree",
  "missing commit",
  "missing tag",
  "fsck error",
  "not all child objects",
  "object of unexpected type",
  "did not receive expected object",
  // index-pack: the pack itself, as builtin/index-pack.c words it.
  "pack signature mismatch",
  "pack version",
  "premature end of pack file",
  "early eof",
  "unexpected end of",
  "pack has junk at the end",
  "pack is corrupted",
  "pack has bad object",
  "bad pack",
  "is corrupt",
  "inflate returned",
  "serious inflate inconsistency",
  "unresolved deltas",
  "delta base offset",
  "bad object header",
  "bad object type",
  "unknown object type",
  "invalid object",
  "not a valid object",
  "sha1 collision",
  "pack too large",
  // A later link of a chain whose prerequisites the earlier ones lack.
  "lacks these prerequisite commits",
  // rev-list: the pinned commit never arrived.
  "bad revision",
  "does not appear to be a git repository",
  // Belt and braces behind gitRefNameAcceptable: a ref the gate passed and git
  // still will not fetch is the bundle's doing, not the host's.
  "invalid refspec",
];

/**
 * The host getting in git's way, wherever the message otherwise lands. These
 * take precedence: `cannot fork() for git index-pack: Resource temporarily
 * unavailable` mentions the pack helper and is still not about the pack.
 */
const HOST_FAULTS = [
  "resource temporarily unavailable",
  "cannot fork",
  "permission denied",
  "no space left on device",
  "disk quota exceeded",
  "too many open files",
  "input/output error",
  "cannot allocate memory",
  "out of memory",
  "read-only file system",
  // index-pack reading an object size wider than its size_t: a
  // limit of the git that runs, like memory, so the same bytes can be a
  // valid object to a wider git.
  "too large for this platform",
];

/**
 * How fetch reports a helper killed outright — by a file-size or CPU limit,
 * or by anyone else — which never got to say what it thought of the pack.
 * Matched only among the last two lines, which are always git's own: fsck
 * echoes bundle content (a `.gitmodules` URL, say) earlier in stderr. The
 * words in `HOST_FAULTS` can still be echoed that way, because narrowing
 * them risks the opposite mistake of retiring a checkpoint over a host
 * fault; a bundle that talks itself into a retry costs one capped attempt,
 * and stops it repeating.
 */
const HELPER_KILLED = /^error: [\w-]+ died of signal \d+$/;

function refused(
  command: string,
  result: GitCommandResult,
): { status: "unusable"; reason: string } {
  const detail = result.stderr.trim();
  const message = `${command} failed with exit code ${result.exitCode}: ${detail}`;
  if (result.timedOut) throw new Error(message);
  if (result.signal !== undefined) {
    throw new Error(`${command} was killed by ${result.signal}`);
  }
  // git's last words are the ones that say why it stopped, and they are what
  // the cut dropped: a pack that made fsck talk past the limit and then ran
  // git out of memory would otherwise be judged by its complaints alone.
  if (result.truncated) {
    throw new Error(`${message} (output cut short, so not classified)`);
  }
  if (
    detail
      .split("\n")
      .slice(-2)
      .some((line) => HELPER_KILLED.test(line))
  ) {
    throw new Error(message);
  }
  const lowered = detail.toLowerCase();
  if (HOST_FAULTS.some((fault) => lowered.includes(fault))) {
    throw new Error(message);
  }
  if (GIT_REFUSALS.some((refusal) => lowered.includes(refusal))) {
    return { status: "unusable", reason: message };
  }
  throw new Error(`${message} (not a refusal git is known to give a bundle)`);
}
