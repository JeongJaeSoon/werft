/**
 * The seccomp profile a Codex worker runs under: Docker's default profile as
 * it applies to a container with no capabilities, plus the five syscalls
 * Codex's bubblewrap sandbox needs to build its namespaces (`clone` with
 * namespace flags, `unshare`, `mount`, `umount2`, `pivot_root`).
 *
 *   bun scripts/codex-seccomp-profile.ts <moby default.json>          rewrite
 *   bun scripts/codex-seccomp-profile.ts <moby default.json> --check  compare
 *
 * The input is seccomp/default.json of moby/profiles at the commit pinned
 * below (Apache-2.0), the profile Docker 29 vendors. It is a template: rules
 * carry `includes`/`excludes` by capability and architecture that dockerd
 * resolves at container start. kubelet and containerd read a Localhost
 * profile as plain OCI JSON, so the output is that template resolved once:
 * for no capabilities, on amd64 and arm64 with their 32-bit modes.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE_COMMIT = "245180c51918481c0525424b3ee025d2b435d46c";
const SOURCE_SHA256 =
  "785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334";

export const PROFILE_PATHS = [
  "packages/adapters/execution/local-docker/src/codex-sandbox-seccomp.json",
  "deploy/helm/werft/files/codex-sandbox-seccomp.json",
];

const ARCHES = new Set(["amd64", "x86", "x32", "arm64", "arm"]);
const ARCHITECTURES = [
  "SCMP_ARCH_X86_64",
  "SCMP_ARCH_X86",
  "SCMP_ARCH_X32",
  "SCMP_ARCH_AARCH64",
  "SCMP_ARCH_ARM",
];
const SANDBOX_SYSCALLS = ["clone", "unshare", "mount", "umount2", "pivot_root"];

type Rule = {
  names: string[];
  action: string;
  args?: unknown[];
  errnoRet?: number;
  comment?: string;
  includes?: { caps?: string[]; arches?: string[]; minKernel?: string };
  excludes?: { caps?: string[]; arches?: string[] };
};

export function codexSeccompProfile(template: {
  defaultAction: string;
  defaultErrnoRet: number;
  syscalls: Rule[];
}) {
  const syscalls = template.syscalls
    .filter(({ includes = {}, excludes = {} }) => {
      if ((includes.caps ?? []).length > 0) return false;
      if (includes.arches && !includes.arches.some((a) => ARCHES.has(a))) {
        return false;
      }
      return !(excludes.arches ?? []).some((a) => ARCHES.has(a));
    })
    // The masked `clone` rule refuses namespace flags; the rule below allows
    // every flag instead.
    .filter(({ names }) => !(names.length === 1 && names[0] === "clone"))
    .map(({ names, action, args, errnoRet }) => ({
      names,
      action,
      ...(args === undefined ? {} : { args }),
      ...(errnoRet === undefined ? {} : { errnoRet }),
    }));
  return {
    defaultAction: template.defaultAction,
    defaultErrnoRet: template.defaultErrnoRet,
    architectures: ARCHITECTURES,
    syscalls: [
      ...syscalls,
      { names: SANDBOX_SYSCALLS, action: "SCMP_ACT_ALLOW" },
    ],
  };
}

if (import.meta.main) {
  const [input, flag] = process.argv.slice(2);
  if (!input) {
    console.error(
      "usage: bun scripts/codex-seccomp-profile.ts <default.json> [--check]",
    );
    process.exit(2);
  }
  const bytes = readFileSync(input);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SOURCE_SHA256) {
    console.error(
      `${input} is not seccomp/default.json of moby/profiles ${SOURCE_COMMIT} (sha256 ${digest})`,
    );
    process.exit(1);
  }
  const text = `${JSON.stringify(codexSeccompProfile(JSON.parse(bytes.toString("utf8"))), null, 2)}\n`;
  let stale = false;
  for (const path of PROFILE_PATHS) {
    if (flag === "--check") {
      if (readFileSync(path, "utf8") !== text) {
        console.error(`${path} is stale`);
        stale = true;
      }
    } else {
      writeFileSync(path, text);
    }
  }
  process.exit(stale ? 1 : 0);
}
