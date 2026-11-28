import type { CanonicalBundleFile } from "./bundle-validator.ts";
import type { SkillGateFindingRecord } from "./ports/skill-repository-store.ts";
import type { SecretScanner } from "./secret-scan.ts";
import type { SkillGateFinding } from "./skill-gate.ts";
import type { SkillGateRunner } from "./skill-gate-runner.ts";
import { storable } from "./skill-repository-listing.ts";

// The gate a version of a registered repository's skill passes before it is
// stored: the fixed rules (skill-gate.ts) and the secret scan, both run away
// from the caller's event loop. A run with no answer is never a pass.

export type RepositorySkillGate = {
  runner: SkillGateRunner;
  secrets: SecretScanner;
  /** Hosts of the installation's egress allowlist, read for each run. */
  allowedHosts: () => ReadonlySet<string>;
};

export type RepositoryGateJudgment =
  | {
      kind: "passed";
      warnings: SkillGateFindingRecord[];
      notices: SkillGateFindingRecord[];
    }
  | { kind: "blocked"; blocks: SkillGateFindingRecord[] }
  /** The gate or the scan did not answer; `detail` is for logs. */
  | { kind: "unavailable"; detail: string };

const MAX_LISTED = 20;

/** A finding as it is stored and shown: nothing PostgreSQL refuses in it. */
const kept = (finding: SkillGateFinding): SkillGateFindingRecord => ({
  rule: finding.rule,
  paths: finding.paths.map(storable),
  samples: finding.samples.map(storable),
});

export async function judgeRepositoryVersion(
  gate: RepositorySkillGate,
  input: {
    /** The approved version the diff starts from; null when there is none. */
    before: readonly CanonicalBundleFile[] | null;
    after: readonly CanonicalBundleFile[];
    repositoryRootFiles: readonly string[];
  },
): Promise<RepositoryGateJudgment> {
  const run = await gate.runner.run({
    ...input,
    allowedHosts: gate.allowedHosts(),
  });
  if (run.kind === "failed") {
    return { kind: "unavailable", detail: `gate ${run.reason}` };
  }
  const blocks = run.result.blocks.map(kept);
  // The scanner is given text and the media the gate lets in, nothing else:
  // a version with a refused file is blocked without it.
  if (run.result.blocks.some((finding) => finding.rule === "file_type")) {
    return { kind: "blocked", blocks };
  }
  const scan = await gate.secrets.scan(
    input.after.map((file) => ({ path: file.path, bytes: file.bytes })),
  );
  if (scan.kind === "failed") {
    return { kind: "unavailable", detail: `secret scan ${scan.reason}` };
  }
  if (scan.findings.length > 0) {
    // The scanner's rule and the file, never the value it matched.
    const unique = (values: string[]) =>
      [...new Set(values)].slice(0, MAX_LISTED).map(storable);
    blocks.push({
      rule: "secret",
      paths: unique(scan.findings.map((finding) => finding.path)),
      samples: unique(scan.findings.map((finding) => finding.rule)),
    });
  }
  if (blocks.length > 0) return { kind: "blocked", blocks };
  return {
    kind: "passed",
    warnings: run.result.warnings.map(kept),
    notices: run.result.notices.map(kept),
  };
}
