/**
 * The runtime this image stamps a checkpoint with, per claim, for
 * `scripts/verify-restore.sh --image`. The engine build is the
 * image's constant; the profile digest is computed here by this image's own
 * code, so an image that hashes a profile differently from the one that
 * sealed a checkpoint shows as incompatible before a worker is asked to
 * restore it.
 *
 *   docker run --rm -i --network none --entrypoint bun <image> \
 *     run apps/worker/src/image-runtime.ts < claims.json
 *
 * stdin: `{ "<session id>": { "principal": …, "runtime_config": …, "workspace"?: … } }`, the
 * claim fields the digest reads, as the API would hand them out.
 */

import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import type { RuntimeFingerprint } from "@werft-ai/runtime-core";

import { claimFingerprint, imageRuntime } from "./composition.ts";
import type { WorkerConfig } from "./config.ts";

// `workspace` only tells a session without a repository apart; absent, the
// claim is a session with one.
const claimSchema = bootstrapClaimResponseSchema
  .pick({ principal: true, runtime_config: true, workspace: true })
  .partial({ workspace: true });

// `legacyProfileSha256` is the digest under the frozen pre-strip prompt, which
// a worker sends as an alternate when it restores an older checkpoint.
type ImageProfile =
  | { profileSha256: string; legacyProfileSha256: string }
  | { error: string };

// Where the engine runs is the launcher's per host, not the claim's; these
// stand in for it.
const HOST_STAND_IN: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy.invalid",
  runtime: {
    claudeConfigDir: "/home/bun/.claude",
    cwd: "/workspace",
    home: "/home/bun",
    providerMaxRetries: 0,
  },
};

export const imageClaimFingerprint = claimFingerprint(HOST_STAND_IN);
const imageLegacyClaimFingerprint = claimFingerprint(HOST_STAND_IN, true);

export function imageRuntimeOf(
  claims: unknown,
  fingerprint: (
    claim: Parameters<typeof imageClaimFingerprint>[0],
  ) => RuntimeFingerprint = imageClaimFingerprint,
  legacyFingerprint: (
    claim: Parameters<typeof imageClaimFingerprint>[0],
  ) => RuntimeFingerprint = imageLegacyClaimFingerprint,
) {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new Error("claims must be an object keyed by session id");
  }
  const profiles: Record<string, ImageProfile> = {};
  for (const [sessionId, claim] of Object.entries(claims)) {
    const parsed = claimSchema.safeParse(claim);
    try {
      profiles[sessionId] = parsed.success
        ? {
            profileSha256: fingerprint(parsed.data).profileSha256,
            legacyProfileSha256: legacyFingerprint(parsed.data).profileSha256,
          }
        : {
            error: `claim refused: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`,
          };
    } catch (error) {
      profiles[sessionId] = { error: (error as Error).message };
    }
  }
  return { ...JSON.parse(imageRuntime().imageFingerprint()), profiles };
}

if (import.meta.main) {
  console.log(
    JSON.stringify(imageRuntimeOf(JSON.parse(await Bun.stdin.text()))),
  );
}
