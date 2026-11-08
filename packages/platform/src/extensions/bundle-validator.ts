import { createHash } from "node:crypto";

/**
 * Registration-time validator for skill-only extension bundles (94S-866).
 *
 * The engine loads a bundle as a Claude plugin directory, and a plugin
 * directory is a code-execution surface: `hooks/hooks.json` and `.mcp.json`
 * run even with `settingSources: []`. So nothing is filtered out of the upload;
 * the validator rebuilds the tree from an allow-list and the rebuilt tree is
 * the only thing that is hashed, stored and handed to the engine.
 */

export type BundleInputKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "device";

export type BundleInputFile = {
  /** Slash-separated path relative to the bundle root, as found in the archive. */
  path: string;
  kind: BundleInputKind;
  /** POSIX permission bits; only the execute bit is read. */
  mode: number;
  bytes: Uint8Array;
};

export type BundleLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

export type BundleIssueCode =
  | "bad_slug"
  | "too_many_files"
  | "file_too_large"
  | "bundle_too_large"
  | "unsafe_path"
  | "path_collision"
  | "unsupported_entry_kind"
  | "denied_path"
  | "path_not_allowed"
  | "missing_skill_file"
  | "no_skills"
  | "bad_plugin_json"
  | "bad_frontmatter"
  | "disallowed_frontmatter_key"
  | "dynamic_context";

export type BundleIssue = {
  path: string;
  code: BundleIssueCode;
  message: string;
};

export type CanonicalBundleFile = {
  path: string;
  /** Normalised: 0o755 when any execute bit was set, otherwise 0o644. */
  mode: 0o644 | 0o755;
  bytes: Uint8Array;
  sha256: string;
};

export type BundleManifest = {
  schema: 1;
  slug: string;
  /** Sorted by name. Only values derived from the content go in. */
  skills: { name: string; has_scripts: boolean }[];
};

export type ValidatedBundle = {
  slug: string;
  /** The tree the engine reads, sorted by path. */
  files: CanonicalBundleFile[];
  manifest: BundleManifest;
  /** `<slug>:<skill>` names the engine must report in system/init.skills. */
  expectedSkills: string[];
  /** sha256 of the canonical file list, in the format 94S-865 stores. */
  digest: string;
  /** Root CLAUDE.md / AGENTS.md are not bundle content; they are offered as instruction candidates. */
  instructionCandidates: { name: "CLAUDE.md" | "AGENTS.md"; text: string }[];
};

export type BundleValidation =
  | { ok: true; bundle: ValidatedBundle }
  | { ok: false; issues: BundleIssue[] };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FRONTMATTER_VALUE = 1024;
const SKILL_KEYS = [
  "name",
  "description",
  "disable-model-invocation",
  "user-invocable",
] as const;
const PLUGIN_KEYS = ["name", "version", "description"] as const;
/** Extensions that cannot be handed to an interpreter by name alone. */
const DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
]);
/** Any path segment with one of these names is refused wherever it sits. */
const DENIED_SEGMENTS = new Set([
  "hooks",
  "bin",
  "agents",
  "commands",
  "node_modules",
  "hooks.json",
  ".mcp.json",
  "mcpservers",
  "package.json",
  "package-lock.json",
]);
const SETTINGS_FILE = /^settings.*\.json$/i;
const MANIFEST_NAME = "agent-platform-bundle.json";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function validateExtensionBundle(
  input: { slug: string; files: BundleInputFile[] },
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): BundleValidation {
  const issues: BundleIssue[] = [];
  const issue = (path: string, code: BundleIssueCode, message: string) => {
    issues.push({ path, code, message });
  };

  if (!NAME.test(input.slug)) {
    issue(
      "",
      "bad_slug",
      "Bundle slug must be lowercase letters, digits and dashes, 1-64 characters.",
    );
  }
  if (input.files.length > limits.maxFiles) {
    issue("", "too_many_files", `More than ${limits.maxFiles} entries.`);
    return { ok: false, issues };
  }
  let total = 0;
  for (const file of input.files) total += file.bytes.byteLength;
  if (total > limits.maxTotalBytes) {
    issue(
      "",
      "bundle_too_large",
      `Unpacked size exceeds ${limits.maxTotalBytes} bytes.`,
    );
    return { ok: false, issues };
  }

  const seen = new Map<string, string>();
  const kept: BundleInputFile[] = [];
  for (const file of input.files) {
    const path = file.path;
    const unsafe = unsafePathReason(path);
    if (unsafe) {
      issue(path, "unsafe_path", unsafe);
      continue;
    }
    if (file.kind === "directory") continue;
    if (file.kind !== "file") {
      issue(
        path,
        "unsupported_entry_kind",
        `A ${file.kind} entry is not allowed.`,
      );
      continue;
    }
    const key = path.toLowerCase();
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      issue(
        path,
        "path_collision",
        earlier === path
          ? "Duplicate entry."
          : `Collides with ${earlier} on a case-insensitive file system.`,
      );
      continue;
    }
    seen.set(key, path);
    if (file.bytes.byteLength > limits.maxFileBytes) {
      issue(
        path,
        "file_too_large",
        `Larger than ${limits.maxFileBytes} bytes.`,
      );
      continue;
    }
    kept.push(file);
  }

  const out = new Map<string, CanonicalBundleFile>();
  const skills = new Map<
    string,
    { hasScripts: boolean; hasSkillFile: boolean }
  >();
  const instructionCandidates: ValidatedBundle["instructionCandidates"] = [];
  let pluginJson: Record<string, string> = {};

  for (const file of kept) {
    const path = file.path;
    const segments = path.split("/");

    if (path === MANIFEST_NAME) continue; // the control plane writes its own
    if (path === "CLAUDE.md" || path === "AGENTS.md") {
      const text = decodeText(file.bytes);
      if (text === null)
        issue(path, "path_not_allowed", "Not valid UTF-8 text.");
      else instructionCandidates.push({ name: path, text });
      continue;
    }

    const denied = segments.find(
      (segment) =>
        DENIED_SEGMENTS.has(segment.toLowerCase()) ||
        SETTINGS_FILE.test(segment),
    );
    if (denied !== undefined) {
      issue(
        path,
        "denied_path",
        `${denied} can run code or widen permissions and is never accepted.`,
      );
      continue;
    }

    if (path === ".claude-plugin/plugin.json") {
      const parsed = parsePluginJson(file.bytes, issue, path);
      if (parsed) pluginJson = parsed;
      continue;
    }

    const match = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (!match || !NAME.test(match[1] ?? "")) {
      issue(
        path,
        "path_not_allowed",
        "Only .claude-plugin/plugin.json and skills/<name>/... are accepted.",
      );
      continue;
    }
    const skill = match[1] as string;
    const rest = match[2] as string;
    const state = skills.get(skill) ?? {
      hasScripts: false,
      hasSkillFile: false,
    };
    skills.set(skill, state);

    if (rest === "SKILL.md") {
      const canonical = canonicalSkillFile(file.bytes, skill, issue, path);
      if (canonical) {
        state.hasSkillFile = true;
        out.set(path, canonicalFile(path, 0o644, canonical));
      }
      continue;
    }

    const executable = (file.mode & 0o111) !== 0;
    if (executable || !isDocument(rest) || startsWithShebang(file.bytes)) {
      state.hasScripts = true;
    }
    out.set(path, canonicalFile(path, executable ? 0o755 : 0o644, file.bytes));
  }

  for (const [name, state] of skills) {
    if (
      !state.hasSkillFile &&
      !issues.some((i) => i.path === `skills/${name}/SKILL.md`)
    ) {
      issue(
        `skills/${name}`,
        "missing_skill_file",
        "A skill directory needs a SKILL.md.",
      );
    }
  }
  if (skills.size === 0 && issues.length === 0) {
    issue("", "no_skills", "The bundle has no skills/<name>/SKILL.md.");
  }
  if (issues.length > 0) return { ok: false, issues };

  const slug = input.slug;
  const pluginBytes = encoder.encode(
    `${JSON.stringify({ name: slug, ...pluginJson }, null, 2)}\n`,
  );
  out.set(
    ".claude-plugin/plugin.json",
    canonicalFile(".claude-plugin/plugin.json", 0o644, pluginBytes),
  );

  const files = [...out.values()].sort((a, b) => comparePaths(a.path, b.path));
  const skillList = [...skills.entries()]
    .map(([name, state]) => ({ name, has_scripts: state.hasScripts }))
    .sort((a, b) => comparePaths(a.name, b.name));
  return {
    ok: true,
    bundle: {
      slug,
      files,
      manifest: { schema: 1, slug, skills: skillList },
      expectedSkills: skillList.map((skill) => `${slug}:${skill.name}`),
      digest: bundleDigest(files),
      instructionCandidates: instructionCandidates.sort((a, b) =>
        comparePaths(a.name, b.name),
      ),
    },
  };
}

/** sha256 of one `<mode> <path> <file sha256>` line per file, in path order. */
export function bundleDigest(
  files: readonly Pick<CanonicalBundleFile, "path" | "mode" | "sha256">[],
): string {
  const lines = [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => `${file.mode.toString(8)} ${file.path} ${file.sha256}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

function unsafePathReason(path: string): string | null {
  if (path === "") return "Empty path.";
  if (path.normalize("NFC") !== path) return "Path is not Unicode NFC.";
  if (path.includes("\\")) return "Backslash in path.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return "Control character in path.";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "Absolute path.";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return "Path escapes or is not normalised.";
    }
  }
  return null;
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function isDocument(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return false;
  return DOCUMENT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function startsWithShebang(bytes: Uint8Array): boolean {
  return bytes[0] === 0x23 && bytes[1] === 0x21;
}

function canonicalFile(
  path: string,
  mode: 0o644 | 0o755,
  bytes: Uint8Array,
): CanonicalBundleFile {
  return {
    path,
    mode,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

type Report = (path: string, code: BundleIssueCode, message: string) => void;

function parsePluginJson(
  bytes: Uint8Array,
  report: Report,
  path: string,
): Record<string, string> | null {
  const text = decodeText(bytes);
  let value: unknown;
  try {
    value = text === null ? null : JSON.parse(text);
  } catch {
    value = null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    report(path, "bad_plugin_json", "plugin.json must be a JSON object.");
    return null;
  }
  const kept: Record<string, string> = {};
  let ok = true;
  for (const [key, entry] of Object.entries(value)) {
    if (!(PLUGIN_KEYS as readonly string[]).includes(key)) {
      report(
        path,
        "bad_plugin_json",
        `plugin.json key "${key}" is not allowed.`,
      );
      ok = false;
    } else if (
      typeof entry !== "string" ||
      entry.length > MAX_FRONTMATTER_VALUE
    ) {
      report(
        path,
        "bad_plugin_json",
        `plugin.json "${key}" must be a short string.`,
      );
      ok = false;
    } else if (key !== "name") {
      kept[key] = entry; // the name is always the bundle slug
    }
  }
  return ok ? kept : null;
}

/**
 * Re-emits SKILL.md from parsed values only, so the engine's parser and ours
 * cannot read the same bytes differently. Frontmatter is a strict subset of
 * YAML: single-line `key: value`, no anchors, aliases, tags, block scalars,
 * comments or duplicate keys.
 */
function canonicalSkillFile(
  bytes: Uint8Array,
  directory: string,
  report: Report,
  path: string,
): Uint8Array | null {
  const text = decodeText(bytes);
  if (text === null) {
    report(path, "bad_frontmatter", "SKILL.md is not valid UTF-8.");
    return null;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") {
    report(
      path,
      "bad_frontmatter",
      "SKILL.md must start with a --- frontmatter block.",
    );
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    report(path, "bad_frontmatter", "Frontmatter is not closed with ---.");
    return null;
  }

  const values = new Map<string, string | boolean>();
  let ok = true;
  for (const line of lines.slice(1, end)) {
    if (line === "") continue;
    const parsed = parseFrontmatterLine(line);
    if (typeof parsed === "string") {
      report(path, "bad_frontmatter", parsed);
      ok = false;
      continue;
    }
    const [key, value] = parsed;
    if (!(SKILL_KEYS as readonly string[]).includes(key)) {
      report(
        path,
        "disallowed_frontmatter_key",
        `Frontmatter key "${key}" is not allowed.`,
      );
      ok = false;
    } else if (values.has(key)) {
      report(path, "bad_frontmatter", `Duplicate frontmatter key "${key}".`);
      ok = false;
    } else {
      values.set(key, value);
    }
  }

  const body = lines.slice(end + 1);
  if (body.some((line) => line.includes("!`") || line.startsWith("```!"))) {
    report(
      path,
      "dynamic_context",
      "Dynamic context (!`cmd` or a ```! block) is not accepted.",
    );
    ok = false;
  }

  const name = values.get("name");
  const description = values.get("description");
  if (name !== directory) {
    report(
      path,
      "bad_frontmatter",
      `Frontmatter name must equal the directory name "${directory}".`,
    );
    ok = false;
  }
  if (typeof description !== "string" || description === "") {
    report(
      path,
      "bad_frontmatter",
      "Frontmatter needs a non-empty description.",
    );
    ok = false;
  }
  for (const flag of ["disable-model-invocation", "user-invocable"]) {
    const flagValue = values.get(flag);
    if (flagValue !== undefined && typeof flagValue !== "boolean") {
      report(path, "bad_frontmatter", `"${flag}" must be true or false.`);
      ok = false;
    }
  }
  if (!ok) return null;

  const head = ["---"];
  for (const key of SKILL_KEYS) {
    const value = values.get(key);
    if (value !== undefined) head.push(`${key}: ${JSON.stringify(value)}`);
  }
  head.push("---");
  return encoder.encode(`${[...head, ...body].join("\n")}`);
}

function parseFrontmatterLine(
  line: string,
): [string, string | boolean] | string {
  const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
  if (!match) return `Unsupported frontmatter line: ${truncate(line)}`;
  const key = match[1] as string;
  const raw = match[2] as string;
  if (raw === "true" || raw === "false") return [key, raw === "true"];
  if (raw.length > MAX_FRONTMATTER_VALUE) return `"${key}" is too long.`;
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return [key, parsed];
    } catch {
      // fall through to the shared message
    }
    return `"${key}" has an invalid double-quoted string.`;
  }
  if (raw.startsWith("'")) {
    if (
      raw.length >= 2 &&
      raw.endsWith("'") &&
      !/(?<!')'(?!')/.test(raw.slice(1, -1))
    ) {
      return [key, raw.slice(1, -1).replaceAll("''", "'")];
    }
    return `"${key}" has an invalid single-quoted string.`;
  }
  if (/^[&*!|>%@`[{#-]/.test(raw)) {
    return `"${key}" uses a YAML feature that is not accepted (anchor, alias, tag, block, flow or comment).`;
  }
  if (raw.includes(": ") || raw.includes(" #")) {
    return `"${key}" must be quoted when it contains ": " or " #".`;
  }
  return [key, raw];
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}
