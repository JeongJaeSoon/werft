import { MCP_TOOL_PREFIX } from "../kollegium/agents.ts";
import { isMcpToolName, type ToolCatalogView } from "./profile-tools.ts";

/**
 * The deny rules a profile or an organization may write, in the engine's own
 * rule spelling. v1 takes the narrow set the engine documents and the
 * platform can explain to a person:
 *
 * - a whole built-in tool by its catalog name (`WebSearch`), an older name
 *   stored as the current one;
 * - `Bash(<prefix>)`, `Read(<path>)`, `Edit(<path>)`, `WebFetch(domain:<host>)`;
 * - a whole `mcp__<server>__<tool>` name, which the platform's MCP path
 *   enforces and the engine is never given.
 *
 * Tool-name globs (`B*`, `mcp__*`) are refused: the engine takes those out
 * of the model's tool list too, so they would blur the line between a whole
 * tool and a pattern. A rule the engine would drop without a word is refused
 * here, because a length limit does not make a wrong rule safe.
 */
export const PERMISSION_RULES_MAX = 64;
export const PERMISSION_RULE_MAX_LENGTH = 256;

/** The tools a scoped rule `Tool(…)` has an effect on. */
const SCOPED_TOOLS = ["Bash", "Read", "Edit", "WebFetch"] as const;

export type PermissionRuleKind = "tool" | "pattern" | "mcp";

export type PermissionRule = {
  /** The rule as stored: the tool part is the catalog's current name. */
  readonly rule: string;
  readonly kind: PermissionRuleKind;
  readonly tool: string;
  /** A suspicious but legal input: stored, and shown to the person. */
  readonly warning?: "path_root_relative";
};

export type PermissionRuleRefusalCode =
  | "rule_syntax"
  | "rule_no_effect"
  | "rule_too_long"
  | "too_many_rules";

export type PermissionRuleRefusal = {
  readonly reason_code: PermissionRuleRefusalCode;
  readonly rule: string;
  readonly message: string;
};

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const SCOPED = /^([A-Za-z][A-Za-z0-9_]*)\(([\s\S]+)\)$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A host the engine compares by the spelling a URL parser leaves. A URL reads
 * a host whose last label is a number or `0x…` as an IPv4 address and writes it
 * as a dotted quad, so `127.1` or `2130706433` would never match the request
 * to `127.0.0.1`; only the dotted quad itself is a rule that can match.
 */
function isPlainHost(host: string): boolean {
  const labels = host.split(".");
  const last = labels[labels.length - 1] ?? "";
  if (!/^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/.test(last)) return true;
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^(?:0|[1-9][0-9]{0,2})$/.test(label) && Number(label) <= 255,
    )
  );
}

/**
 * Every `)` closes an earlier `(`, none is left open, and a `)` that closes
 * the outermost pair is the last character or is followed by another `(`.
 */
function wellNested(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
      if (depth === 0 && i < text.length - 1 && text[i + 1] !== "(") {
        return false;
      }
    }
  }
  return depth === 0;
}

function refuse(
  reason_code: PermissionRuleRefusalCode,
  rule: string,
  message: string,
): { readonly refusal: PermissionRuleRefusal } {
  return { refusal: { reason_code, rule, message } };
}

function currentName(catalog: ToolCatalogView, name: string): string {
  const aliases = catalog.aliases ?? {};
  return Object.hasOwn(aliases, name) ? (aliases[name] ?? name) : name;
}

/** One rule as stored, or why it is refused. */
export function parsePermissionRule(
  catalog: ToolCatalogView,
  raw: string,
):
  | { readonly parsed: PermissionRule }
  | { readonly refusal: PermissionRuleRefusal } {
  const rule = raw.trim();
  if (rule === "") return refuse("rule_syntax", raw, "A rule is not empty");
  if (rule.length > PERMISSION_RULE_MAX_LENGTH) {
    return refuse(
      "rule_too_long",
      raw.slice(0, 32),
      `A rule is at most ${PERMISSION_RULE_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL.test(rule)) {
    return refuse("rule_syntax", rule, `${rule} holds a control character`);
  }
  const known = new Set(catalog.tools.map((tool) => tool.name));

  if (rule.startsWith(MCP_TOOL_PREFIX)) {
    if (!isMcpToolName(rule)) {
      return refuse(
        "rule_syntax",
        rule,
        `${rule} is not a whole ${MCP_TOOL_PREFIX}<server>__<tool> name, and an MCP rule is matched by whole name only`,
      );
    }
    return { parsed: { rule, kind: "mcp", tool: rule } };
  }

  const scoped = SCOPED.exec(rule);
  if (scoped === null) {
    if (!TOOL_NAME.test(rule)) {
      return refuse(
        "rule_syntax",
        rule,
        `${rule} is neither a tool name nor Tool(argument): a glob over tool names is not taken`,
      );
    }
    const tool = currentName(catalog, rule);
    if (!known.has(tool)) {
      return refuse(
        "rule_no_effect",
        rule,
        `${rule} is not a built-in tool of this catalog, so the engine would drop the rule`,
      );
    }
    return { parsed: { rule: tool, kind: "tool", tool } };
  }

  const tool = currentName(catalog, scoped[1] ?? "");
  const argument = scoped[2] ?? "";
  if (!(SCOPED_TOOLS as readonly string[]).includes(tool) || !known.has(tool)) {
    return refuse(
      "rule_no_effect",
      rule,
      `${tool}(…) has no effect: a rule with an argument is taken for ${SCOPED_TOOLS.join(", ")} only`,
    );
  }
  const bare = argument.trim();
  if (bare === "" || bare === "*" || bare === ":*") {
    return refuse(
      "rule_syntax",
      rule,
      `${rule} blocks the whole tool: write ${tool} without an argument`,
    );
  }
  // An exact or prefix rule is compared with its edge space kept, so it never
  // matches the command it was meant for. A glob rule is matched loosely.
  if (argument !== bare && !argument.includes("*")) {
    return refuse(
      "rule_syntax",
      rule,
      `${rule} has a space inside the parentheses at its edge, which the engine keeps as part of the match`,
    );
  }
  // The engine's list splitter ends a rule at an unbalanced parenthesis, and
  // at a closing one that is followed by more text, so `Bash(echo (x) hello)`
  // or `Read(./a(b) c)` is stored as two other rules and the deny is lost. A
  // shell prefix has no use for one; a path may hold balanced pairs that end
  // the rule or lead straight into another pair.
  if (tool === "Bash" ? /[()]/.test(argument) : !wellNested(argument)) {
    return refuse(
      "rule_syntax",
      rule,
      `${rule} holds a parenthesis the engine would read as the end of the rule`,
    );
  }
  if (tool === "Bash") {
    // `:*` ends a prefix rule and takes no space before it. Anywhere else, or
    // beside a `*` glob, the engine reads it as literal text.
    const at = argument.indexOf(":*");
    if (
      at !== -1 &&
      (at !== argument.length - 2 || /\s$|\*/.test(argument.slice(0, at)))
    ) {
      return refuse(
        "rule_syntax",
        rule,
        `${rule} uses :* anywhere but as the end of a prefix with no space and no * before it`,
      );
    }
  } else if (tool === "Read" || tool === "Edit") {
    if (argument.includes(":*")) {
      return refuse(
        "rule_syntax",
        rule,
        `${tool}(path) takes no :* ; the :* prefix form is for Bash only`,
      );
    }
  }
  if (tool === "WebFetch") {
    const host = argument.startsWith("domain:")
      ? argument.slice("domain:".length)
      : null;
    if (host === null || !HOST.test(host) || !isPlainHost(host)) {
      return refuse(
        "rule_syntax",
        rule,
        "WebFetch takes WebFetch(domain:<host>) with a plain host name or a dotted-quad IPv4 address",
      );
    }
  }
  const root =
    (tool === "Read" || tool === "Edit") &&
    argument.startsWith("/") &&
    !argument.startsWith("//");
  return {
    parsed: {
      rule: `${tool}(${argument})`,
      kind: "pattern",
      tool,
      ...(root ? { warning: "path_root_relative" as const } : {}),
    },
  };
}

/**
 * A list of rules as stored: each one parsed and repeats dropped, in the
 * order given. The list is capped as a whole because the engine takes it as
 * one argument.
 */
export function parsePermissionRules(
  catalog: ToolCatalogView,
  raws: readonly string[],
):
  | { readonly rules: PermissionRule[] }
  | { readonly refusal: PermissionRuleRefusal } {
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];
  for (const raw of raws) {
    const result = parsePermissionRule(catalog, raw);
    if ("refusal" in result) return result;
    if (seen.has(result.parsed.rule)) continue;
    seen.add(result.parsed.rule);
    rules.push(result.parsed);
  }
  if (rules.length > PERMISSION_RULES_MAX) {
    return refuse(
      "too_many_rules",
      "",
      `A list holds at most ${PERMISSION_RULES_MAX} rules`,
    );
  }
  return { rules };
}
