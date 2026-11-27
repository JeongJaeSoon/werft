import { createHash } from "node:crypto";
import {
  type BundleInputFile,
  type BundleInputKind,
  bundleDigest,
  comparePaths,
} from "@werft-ai/runtime-core";

/**
 * Registration-time validator for skill-only extension bundles.
 *
 * The engine loads a bundle as a Claude plugin directory, and a plugin
 * directory is a code-execution surface: `hooks/hooks.json` and `.mcp.json`
 * run even with `settingSources: []`. So nothing is filtered out of the upload;
 * the validator rebuilds the tree from an allow-list and the rebuilt tree is
 * the only thing that is hashed, stored and handed to the engine.
 */

export type { BundleInputFile, BundleInputKind };

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
  | "dynamic_context"
  | "engine_manifest"
  | "multiple_skills";

/**
 * `upload` is a tree a person sent: one skill, no engine manifest of theirs.
 * `stored` is a tree the validator rebuilt, read again (it carries the
 * validator's own `.claude-plugin/plugin.json`), or a bundle from before
 * skills.
 */
export type BundleInputMode = "upload" | "stored";

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
  /** sha256 of the canonical file list, in the stored format. */
  digest: string;
  /** Root CLAUDE.md / AGENTS.md are not bundle content; they are offered as instruction candidates. */
  instructionCandidates: { name: "CLAUDE.md" | "AGENTS.md"; text: string }[];
};

export type BundleValidation =
  | { ok: true; bundle: ValidatedBundle }
  | { ok: false; issues: BundleIssue[] };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FRONTMATTER_VALUE = 1024;
/** The Agent Skills specification's bound on `compatibility`. */
const MAX_COMPATIBILITY = 500;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY = 64;
/**
 * Also the order SKILL.md is re-emitted in. The specification's fields sit
 * between the two that bundles had from the start, so a tree without them
 * re-emits the bytes it always did.
 */
const SKILL_KEYS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "disable-model-invocation",
  "user-invocable",
] as const;
/** Directories an engine reads as its own plugin manifest. */
const ENGINE_MANIFEST_DIRS = new Set([".claude-plugin", ".codex-plugin"]);
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
  mode: BundleInputMode = "stored",
): BundleValidation {
  const upload = mode === "upload";
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
  const dirs: string[] = [];
  for (const file of input.files) {
    const path = file.path;
    const unsafe = unsafePathReason(path);
    if (unsafe) {
      issue(path, "unsafe_path", unsafe);
      continue;
    }
    if (file.kind !== "directory" && path.endsWith("/")) {
      issue(path, "unsafe_path", "A file path cannot end with a slash.");
      continue;
    }
    if (file.kind === "directory") {
      // A directory entry is held to the same policy as a file: a bundle that
      // names hooks/ is refused even if the entry would carry no bytes.
      const dir = path.endsWith("/") ? path.slice(0, -1) : path;
      const policy = (upload && engineManifest(dir)) || pathPolicy(dir);
      if (policy) issue(path, policy.code, policy.message);
      else dirs.push(dir);
      continue;
    }
    if (file.kind !== "file") {
      issue(
        path,
        "unsupported_entry_kind",
        `A ${file.kind} entry is not allowed.`,
      );
      continue;
    }
    const key = fold(path);
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

  // A path that is a file cannot also be a directory above another entry.
  for (const entry of [...kept.map((f) => f.path), ...dirs]) {
    const parts = entry.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const clash = seen.get(fold(parent));
      if (clash !== undefined) {
        issue(entry, "path_collision", `${clash} is a file, not a directory.`);
        break;
      }
    }
  }
  for (const dir of dirs) {
    const clash = seen.get(fold(dir));
    if (clash !== undefined) {
      issue(dir, "path_collision", `Collides with the file ${clash}.`);
    }
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

    if (path === MANIFEST_NAME) continue; // the control plane writes its own
    if (path === "CLAUDE.md" || path === "AGENTS.md") {
      const text = decodeText(file.bytes);
      if (text === null)
        issue(path, "path_not_allowed", "Not valid UTF-8 text.");
      else instructionCandidates.push({ name: path, text });
      continue;
    }

    const policy = (upload && engineManifest(path)) || pathPolicy(path);
    if (policy) {
      issue(path, policy.code, policy.message);
      continue;
    }

    if (path === ".claude-plugin/plugin.json") {
      const parsed = parsePluginJson(file.bytes, issue, path);
      if (parsed) pluginJson = parsed;
      continue;
    }

    const match = /^skills\/([^/]+)\/(.+)$/.exec(path);
    if (!match) {
      issue(path, "path_not_allowed", ALLOWED_SHAPES);
      continue;
    }
    const skill = match[1] as string;
    const rest = match[2] as string;
    // Only the skill root's SKILL.md is re-emitted; a copy deeper down could be
    // discovered by the engine and would carry bytes we never parsed.
    if (
      rest !== "SKILL.md" &&
      fold(rest.slice(rest.lastIndexOf("/") + 1)) === "skill.md"
    ) {
      if (upload) {
        issue(
          path,
          "multiple_skills",
          "A skill is one directory; this SKILL.md is another skill.",
        );
      } else {
        issue(
          path,
          "path_not_allowed",
          "SKILL.md is only accepted at skills/<name>/SKILL.md.",
        );
      }
      continue;
    }
    const state = skills.get(skill) ?? {
      hasScripts: false,
      hasSkillFile: false,
    };
    skills.set(skill, state);

    if (rest === "SKILL.md") {
      const canonical = canonicalSkillFile(
        file.bytes,
        skill,
        issue,
        path,
        upload,
      );
      if (canonical) {
        state.hasSkillFile = true;
        out.set(path, canonicalFile(path, 0o644, canonical));
      }
      continue;
    }

    const executable = (file.mode & 0o111) !== 0;
    if (runsAsScript(rest, file.mode, file.bytes)) state.hasScripts = true;
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
  if (upload && skills.size > 1) {
    issue("", "multiple_skills", "A skill upload holds exactly one skill.");
  } else if (upload && skills.size === 1 && !skills.has(input.slug)) {
    issue("", "bad_slug", "The skill's directory must be its name.");
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

export { bundleDigest };

const ALLOWED_SHAPES =
  "Only .claude-plugin/plugin.json and skills/<name>/... are accepted.";

/** The allow-list for a file or directory path (no trailing slash). */
function pathPolicy(
  path: string,
): { code: BundleIssueCode; message: string } | null {
  const denied = path
    .split("/")
    .find(
      (segment) =>
        DENIED_SEGMENTS.has(fold(segment)) || SETTINGS_FILE.test(fold(segment)),
    );
  if (denied !== undefined) {
    return {
      code: "denied_path",
      message: `${denied} can run code or widen permissions and is never accepted.`,
    };
  }
  const skillDir = /^skills\/([^/]+)(\/.*)?$/.exec(path);
  const ok =
    path === ".claude-plugin" ||
    path === ".claude-plugin/plugin.json" ||
    path === "skills" ||
    (skillDir !== null && NAME.test(skillDir[1] ?? ""));
  return ok ? null : { code: "path_not_allowed", message: ALLOWED_SHAPES };
}

/**
 * An engine's plugin manifest in an upload: the stored tree gets the
 * validator's own `.claude-plugin/plugin.json`, never one a person wrote.
 */
function engineManifest(
  path: string,
): { code: BundleIssueCode; message: string } | null {
  const segments = path.split("/");
  const manifest =
    segments.some((segment) => ENGINE_MANIFEST_DIRS.has(fold(segment))) ||
    /^skills\/[^/]+\/plugin\.json$/i.test(path) ||
    fold(path) === "plugin.json";
  return manifest
    ? {
        code: "engine_manifest",
        message:
          "An engine's plugin manifest is not accepted; a skill is its SKILL.md directory.",
      }
    : null;
}

/** Case folding wider than toLowerCase: U+017F and U+03C2 fold to s and sigma. */
function fold(value: string): string {
  return value.toUpperCase().toLowerCase();
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

/** A file an engine could run: an execute bit, a shebang, or not a document. */
export function runsAsScript(
  path: string,
  mode: number,
  bytes: Uint8Array,
): boolean {
  return (mode & 0o111) !== 0 || !isDocument(path) || startsWithShebang(bytes);
}

/** A path whose extension names a document (`.md`, `.txt`, `.json`, …). */
export function isDocument(path: string): boolean {
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
  // Copied so a caller mutating its input buffer cannot desync bytes and hash.
  // Buffer.slice() shares memory; constructing a Uint8Array always copies.
  const owned = new Uint8Array(bytes);
  return {
    path,
    mode,
    bytes: owned,
    sha256: createHash("sha256").update(owned).digest("hex"),
  };
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
 * comments or duplicate keys. An upload may also give `description` as a
 * block scalar; it is re-emitted quoted, so a stored tree never holds one and
 * the stored mode keeps reading what every release before it read.
 */
function canonicalSkillFile(
  bytes: Uint8Array,
  directory: string,
  report: Report,
  path: string,
  upload: boolean,
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

  const values = new Map<string, string | boolean | Map<string, string>>();
  let ok = true;
  const front = lines.slice(1, end);
  for (let at = 0; at < front.length; at++) {
    const line = front[at] as string;
    if (line === "") continue;
    let parsed: [string, string | boolean | Map<string, string>] | string;
    const header = upload ? BLOCK_HEADER.exec(line) : null;
    if (line === "metadata:") {
      const block = metadataBlock(front, at + 1);
      at = block.next - 1;
      parsed = block.problem ?? ["metadata", block.entries];
    } else if (header !== null) {
      const block = blockScalar(
        front,
        at + 1,
        header[1] === ">",
        header[2] === "-",
      );
      at = block.next - 1;
      parsed =
        block.problem ??
        (block.value.length > MAX_FRONTMATTER_VALUE
          ? '"description" is too long.'
          : ["description", block.value]);
    } else {
      parsed = parseFrontmatterLine(line);
    }
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
        key === "allowed-tools"
          ? '"allowed-tools" would widen the agent\'s tool permissions and is not accepted.'
          : `Frontmatter key "${key}" is not allowed.`,
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
  if (
    values.get("disable-model-invocation") === true &&
    values.get("user-invocable") === false
  ) {
    report(
      path,
      "bad_frontmatter",
      'With "disable-model-invocation: true" and "user-invocable: false" neither a person nor the model could call the skill.',
    );
    ok = false;
  }
  for (const field of ["license", "compatibility"]) {
    const fieldValue = values.get(field);
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      report(path, "bad_frontmatter", `"${field}" must be a string.`);
      ok = false;
    }
  }
  const compatibility = values.get("compatibility");
  if (
    typeof compatibility === "string" &&
    compatibility.length > MAX_COMPATIBILITY
  ) {
    report(
      path,
      "bad_frontmatter",
      `"compatibility" is longer than ${MAX_COMPATIBILITY} characters.`,
    );
    ok = false;
  }
  const metadata = values.get("metadata");
  if (metadata !== undefined && !(metadata instanceof Map)) {
    report(
      path,
      "bad_frontmatter",
      '"metadata" must be a block of indented key: value lines.',
    );
    ok = false;
  }
  if (!ok) return null;

  const head = ["---"];
  for (const key of SKILL_KEYS) {
    const value = values.get(key);
    if (value instanceof Map) {
      head.push(`${key}:`);
      for (const [entry, text] of value) {
        head.push(`  ${entry}: ${quoted(text)}`);
      }
    } else if (value !== undefined) {
      head.push(`${key}: ${quoted(value)}`);
    }
  }
  head.push("---");
  return encoder.encode(`${[...head, ...body].join("\n")}`);
}

/**
 * The lines under `metadata:`: one level, every line indented by the same
 * spaces, each a single-line `key: value` held to the same rules as a
 * top-level line. A value is always a string (`true` stays the text "true").
 * The block ends at the first line that is not indented.
 */
function metadataBlock(
  front: readonly string[],
  from: number,
): { entries: Map<string, string>; next: number; problem: string | null } {
  const entries = new Map<string, string>();
  let indent: string | null = null;
  let problem: string | null = null;
  let at = from;
  for (; at < front.length; at++) {
    const line = front[at] as string;
    const lead = /^ +/.exec(line)?.[0];
    if (lead === undefined) break;
    indent ??= lead;
    if (problem !== null) continue;
    if (lead !== indent) {
      problem = '"metadata" takes one level of keys, all indented alike.';
      continue;
    }
    const parsed = parseFrontmatterLine(line.slice(lead.length));
    if (typeof parsed === "string") {
      problem = `metadata: ${parsed}`;
      continue;
    }
    const [key, value] = parsed;
    if (key.length > MAX_METADATA_KEY) {
      problem = `metadata key "${truncate(key)}" is longer than ${MAX_METADATA_KEY} characters.`;
    } else if (entries.has(key)) {
      problem = `Duplicate metadata key "${key}".`;
    } else if (entries.size === MAX_METADATA_KEYS) {
      problem = `"metadata" holds more than ${MAX_METADATA_KEYS} keys.`;
    } else {
      entries.set(key, String(value));
    }
  }
  if (problem === null && entries.size === 0) {
    problem = '"metadata" needs at least one indented key: value line.';
  }
  return { entries, next: at, problem };
}

/** Only these four headers: no indentation indicator, no keep chomping, no comment. */
const BLOCK_HEADER = /^description:[ ]+([|>])(-?)[ ]*$/;
const span = (from: number, to: number) =>
  `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
/** Not a YAML 1.2 nb-char: outside the printable set, or a byte order mark. */
const NOT_PRINTABLE = new RegExp(
  `[${span(0x00, 0x08)}${span(0x0b, 0x0c)}${span(0x0e, 0x1f)}${span(0x7f, 0x84)}${span(0x86, 0x9f)}${span(0xfeff, 0xfeff)}${span(0xfffe, 0xffff)}]`,
);

/**
 * The lines of a YAML block scalar. What it takes it reads as YAML 1.2 does;
 * it takes less. The indent is the first non-blank line's spaces and the block
 * ends at the first non-blank line indented less. A tab anywhere in a line's
 * leading whitespace is refused, even after the indent where YAML would keep
 * it as text, since YAML never indents with one and readers disagree on it.
 */
function blockScalar(
  front: readonly string[],
  from: number,
  folded: boolean,
  strip: boolean,
): { value: string; next: number; problem: string | null } {
  const lines: string[] = [];
  let indent = 0;
  let widestLeadingBlank = 0;
  let at = from;
  for (; at < front.length; at++) {
    const line = front[at] as string;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead.includes("\t")) {
      return {
        value: "",
        next: at + 1,
        problem: '"description" is indented with a tab.',
      };
    }
    if (lead.length === line.length) {
      if (indent === 0) {
        widestLeadingBlank = Math.max(widestLeadingBlank, line.length);
        lines.push("");
      } else {
        lines.push(line.slice(indent));
      }
      continue;
    }
    if (indent === 0) {
      if (lead.length === 0) break;
      indent = lead.length;
      if (widestLeadingBlank > indent) {
        return {
          value: "",
          next: at + 1,
          problem:
            '"description" has a blank line indented more than its text.',
        };
      }
    }
    if (lead.length < indent) break;
    lines.push(line.slice(indent));
  }

  let value = "";
  let blanks = 0;
  let seen = false;
  let moreIndented = false;
  for (const text of lines) {
    if (text === "") {
      blanks++;
      continue;
    }
    if (!folded) {
      value += "\n".repeat(seen ? blanks + 1 : blanks);
    } else if (text.startsWith(" ")) {
      // A more-indented line keeps the breaks around it.
      moreIndented = true;
      value += "\n".repeat(seen ? blanks + 1 : blanks);
    } else if (moreIndented) {
      moreIndented = false;
      value += "\n".repeat(blanks + 1);
    } else if (blanks === 0) {
      if (seen) value += " ";
    } else {
      value += "\n".repeat(blanks);
    }
    value += text;
    seen = true;
    blanks = 0;
  }
  if (seen && !strip) value += "\n";
  if (NOT_PRINTABLE.test(value)) {
    return {
      value: "",
      next: at,
      problem: '"description" holds a character YAML does not allow.',
    };
  }
  return { value, next: at, problem: null };
}

// JSON.stringify leaves U+2028 and U+2029 raw, and the line parser does not
// read them as part of a value.
const LINE_SEPARATORS = new RegExp(
  `[${String.fromCharCode(0x2028, 0x2029)}]`,
  "g",
);
function quoted(value: string | boolean): string {
  return JSON.stringify(value).replace(
    LINE_SEPARATORS,
    (char) => `\\u${char.charCodeAt(0).toString(16)}`,
  );
}

// The value is measured, not the line: the stored tree re-quotes every string,
// so an upload and its stored tree are judged alike.
function parseFrontmatterLine(
  line: string,
): [string, string | boolean] | string {
  const parsed = parseFrontmatterValue(line);
  if (
    typeof parsed !== "string" &&
    typeof parsed[1] === "string" &&
    parsed[1].length > MAX_FRONTMATTER_VALUE
  ) {
    return `"${parsed[0]}" is too long.`;
  }
  return parsed;
}

function parseFrontmatterValue(
  line: string,
): [string, string | boolean] | string {
  const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.+?)[ \t]*$/.exec(line);
  if (!match) return `Unsupported frontmatter line: ${truncate(line)}`;
  const key = match[1] as string;
  const raw = match[2] as string;
  if (raw === "true" || raw === "false") return [key, raw === "true"];
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
