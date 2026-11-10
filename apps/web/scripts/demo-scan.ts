/**
 * The check a fixture file passes before the demo is published: no
 * credential, no address outside example.test, no host or name from the
 * machine it was recorded on. CI runs it on every build of the demo.
 * Without --fixtures it checks the placeholder in this repository; with it,
 * the recording in a JeongJaeSoon/agent-platform-demo checkout given as
 * --root, whose .gitleaksignore names the file relative to that root.
 *
 *   bun apps/web/scripts/demo-scan.ts [--fixtures <file> --root <dir>]
 *   bun apps/web/scripts/demo-scan.ts [...] --write-ignores <gitleaks-report.json>
 */
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface Finding {
  readonly rule: string;
  readonly match: string;
  /** Position of the answer in `responses`; its key may hold the value too. */
  readonly answer?: number;
  /** 1-based line of the offending .gitleaksignore entry. */
  readonly ignoreLine?: number;
}

const PRIVATE_IPV4 =
  /\b(?:127\.0\.0\.1|localhost|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/gi;

const RULES: readonly (readonly [string, RegExp])[] = [
  ["platform token", /\bap[a-z]_[A-Za-z0-9_-]{20,}/g],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ["slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["slack app token", /\bxapp-[A-Za-z0-9-]{10,}/g],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g],
  ["aws key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g],
  ["bearer header", /\bBearer[ +][A-Za-z0-9._~+/-]{16,}/gi],
  // Patterns that open with a repeated class start only where a word starts;
  // otherwise a long run of letters is retried from every position.
  ["tailnet host", /(?<![\w.-])[\w.-]*\.ts\.net\b|\btailscale\b/gi],
  ["private address", PRIVATE_IPV4],
  ["machine name", /\b(?:jaesoon|94soon|soons?-mac[\w-]*|wjdwotns\w*)\b/gi],
  ["home path", /\/(?:Users|home)\/[\w.-]+/g],
  // The product's former name: stack defaults such as secret names still carry
  // it into a recording. A stopgap until the full rename. Any run of
  // non-alphanumerics may separate the words: `+` and UTF-8 spaces decode to
  // different characters in different stages, so a list of separators loses.
  ["former product name", /agent[^a-z0-9]*platform/gi],
];

const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ALLOWED_EMAIL = /@example\.test$/i;

/**
 * Addresses of the recording stack that a visitor's copy should not carry:
 * the Slack app's redirect URL names the local API port.
 */
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "https://console.example.test"],
];

/** Applied by the recorder before it writes the file. */
export function sanitize(text: string): string {
  return REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

export function scanFixtures(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Finding[] {
  const findings: Finding[] = [];
  Object.entries(fixtures.responses).forEach(([key, response], answer) => {
    for (const value of [key, ...strings(response)]) {
      const { stages, encoded } = reveal(value);
      // One value per string: its decoding stages repeat it.
      const seen = new Set<string>();
      const found = (rule: string, match: string) => {
        if (seen.has(`${rule}\n${match}`)) return;
        seen.add(`${rule}\n${match}`);
        findings.push({ rule, match, answer });
      };
      if (encoded) found("still encoded after the decoding cap", "");
      // Each stage alone: joined, the end of one and the start of the next
      // would read as one string.
      for (const text of stages) {
        for (const [rule, pattern] of RULES)
          for (const [match] of text.matchAll(pattern)) found(rule, match);
        for (const [match] of text.matchAll(EMAIL))
          if (!ALLOWED_EMAIL.test(match))
            found("email outside example.test", match);
        for (const [match] of text.matchAll(IPV6_CANDIDATE))
          if (isPrivateIpv6(match)) found("private address", match);
      }
    }
  });
  return findings;
}

/**
 * Every string in an answer, object keys included, as JavaScript reads it.
 * A stack rather than recursion: deep nesting must not end the scan.
 */
function strings(root: unknown): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") out.push(value);
    else if (typeof value === "object" && value !== null) {
      // Pushed in reverse so they come off in document order.
      const children = Array.isArray(value)
        ? value
        : Object.entries(value).flat();
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return out;
}

const DECODE_ROUNDS = 8;

/**
 * What a reader of the published demo could recover from a string. SSE
 * frames carry JSON as text, so its escapes are still literal; URLs and
 * fixture keys are percent-encoded, sometimes more than once, and either
 * can hide the other. Every stage is scanned, the raw text included, since a
 * decoding step can also join a value to its neighbour.
 */
function reveal(text: string): { stages: string[]; encoded: boolean } {
  const stages = [text];
  let current = text;
  for (let round = 0; round <= DECODE_ROUNDS; round += 1) {
    const before = current;
    // Each step is its own stage: the next one can glue a revealed value to
    // its neighbour.
    for (const step of [unescapeJson, percentDecode]) {
      const next = step(current);
      if (next === current) continue;
      if (round === DECODE_ROUNDS) return { stages, encoded: true };
      stages.push(next);
      current = next;
    }
    if (current === before) break;
  }
  return { stages, encoded: false };
}

function unescapeJson(text: string): string {
  return text.replace(
    /\\u([0-9a-f]{4})|\\([bfnrt"\\/])/gi,
    (_, hex: string | undefined, char: string | undefined) =>
      hex
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[char as "b"] ??
          (char as string)),
  );
}

/** Byte-wise, so one stray `%` does not leave the rest encoded. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const IPV6_CANDIDATE =
  /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;

/**
 * Loopback or unique local (fc00::/7). The URL parser validates and
 * normalises the address, so `0:0:0:0:0:0:0:1` and `::0001` read as `::1`
 * and clock times such as `12:30:45` are not addresses at all.
 */
function isPrivateIpv6(candidate: string): boolean {
  let host: string;
  try {
    host = new URL(`http://[${candidate}]/`).hostname;
  } catch {
    return false;
  }
  // The parser writes ::ffff:127.0.0.1 as [::ffff:7f00:1].
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (mapped) {
    const [hi, lo] = [mapped[1], mapped[2]].map((group) =>
      Number.parseInt(group ?? "", 16),
    ) as [number, number];
    const ipv4 = [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    return new RegExp(PRIVATE_IPV4.source, "i").test(ipv4);
  }
  return host === "[::1]" || /^\[f[cd]/i.test(host);
}

/** A demo without a signed-in session answer opens on an error screen. */
export function checkComplete(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Finding[] {
  const me = fixtures.responses["/v1/auth/me"] as
    | { status?: unknown; json?: unknown }
    | undefined;
  const signedIn =
    me?.status === 200 &&
    typeof me.json === "object" &&
    me.json !== null &&
    !Array.isArray(me.json) &&
    Object.keys(me.json).length > 0;
  return signedIn
    ? []
    : [
        {
          rule: "no signed-in /v1/auth/me answer (record the fixtures first)",
          match: "",
        },
      ];
}

/** The placeholder fixture file as gitleaks names it, from the repository root. */
export const FIXTURES_PATH = "apps/web/src/demo/fixtures.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BREAKDOWN_KEY_LINE = /^ {2,}"key": "([^"]*)",?$/;
const RESPONSE_LINE = /^ {4}"(\/v1\/[^"]*)": \{$/;

function agentIds(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Set<string> {
  const ids = new Set<string>();
  for (const [key, response] of Object.entries(fixtures.responses)) {
    if (!/^\/v1\/agents(?:\?|$)/.test(key)) continue;
    const items = (response as { json?: { items?: { id?: unknown }[] } }).json
      ?.items;
    for (const item of items ?? [])
      if (typeof item.id === "string") ids.add(item.id);
  }
  return ids;
}

/**
 * gitleaks' generic-api-key reads a usage breakdown's `"key": "<agent id>"`
 * as a credential. A .gitleaksignore entry for the fixture file may excuse
 * exactly that line and nothing else: the rule, a usage breakdown answer, a
 * UUID the recording's agent list names. A re-recording moves the lines, so
 * an entry left from the last one fails here instead of hiding a new value.
 */
export function checkIgnores(
  fixturesText: string,
  ignoreText: string,
  name = FIXTURES_PATH,
): Finding[] {
  const lines = fixturesText.split("\n");
  const agents = agentIds(JSON.parse(fixturesText));
  const findings: Finding[] = [];
  for (const [i, raw] of ignoreText.split("\n").entries()) {
    const entry = raw.trim();
    if (!entry.includes(name)) continue;
    const ignoreLine = i + 1;
    // gitleaks also honours `<commit>:<path>:<rule>:<line>`.
    if (!entry.startsWith(`${name}:`)) {
      findings.push({
        rule: "gitleaks ignore in another form",
        match: entry,
        ignoreLine,
      });
      continue;
    }
    const [rule, lineNumber] = entry.slice(name.length + 1).split(":");
    const index = Number(lineNumber) - 1;
    const line = lines[index] ?? "";
    let response = "";
    for (let i = index; i >= 0 && !response; i -= 1)
      response = RESPONSE_LINE.exec(lines[i] ?? "")?.[1] ?? "";
    const value = BREAKDOWN_KEY_LINE.exec(line)?.[1];
    const fail = (why: string) =>
      findings.push({
        rule: `gitleaks ignore ${why}`,
        match: entry,
        ignoreLine,
      });
    if (rule !== "generic-api-key") fail("for another rule");
    else if (value === undefined) fail("not on a breakdown key line");
    else if (!response.startsWith("/v1/usage/breakdown"))
      fail("outside a usage breakdown");
    else if (!UUID.test(value)) fail("on a value that is not a UUID");
    else if (!agents.has(value)) fail("on a UUID that is no recorded agent");
  }
  return findings;
}

/** The ignore file with the fixture's entries replaced by `entries`. */
export function withFixtureIgnores(
  ignoreText: string,
  entries: readonly string[],
  name = FIXTURES_PATH,
): string {
  const kept = ignoreText
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith(`${name}:`));
  return `${[...kept, ...[...entries].sort()].join("\n")}\n`;
}

// CI logs are public: print no part of a match, its key or an ignore entry,
// only positions. `jq '.responses | keys[N]'` names answer N locally.
export function describeFinding(finding: Finding): string {
  const { rule, match, answer, ignoreLine } = finding;
  if (answer !== undefined)
    return `${rule}: ${match.length} chars (answer ${answer})`;
  if (ignoreLine !== undefined)
    return `${rule} (.gitleaksignore line ${ignoreLine})`;
  return rule;
}

function report(findings: readonly Finding[]): void {
  for (const finding of findings) console.error(describeFinding(finding));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "string" },
      root: { type: "string" },
      "write-ignores": { type: "string" },
    },
  });
  if (!values.fixtures !== !values.root) {
    console.error("--fixtures and --root go together");
    process.exit(2);
  }
  const repo = resolve(
    values.root ?? new URL("../../../", import.meta.url).pathname,
  );
  const fixturesPath = resolve(values.fixtures ?? join(repo, FIXTURES_PATH));
  const name = relative(repo, fixturesPath);
  if (name.startsWith("..")) {
    console.error("--fixtures must sit under --root");
    process.exit(2);
  }
  const ignorePath = join(repo, ".gitleaksignore");
  const ignoreFile = Bun.file(ignorePath);
  const ignoreText = (await ignoreFile.exists()) ? await ignoreFile.text() : "";
  const fixturesText = await Bun.file(fixturesPath).text();
  // A parser's message quotes the text around the error.
  const parse = (text: string, name: string) => {
    try {
      return JSON.parse(text);
    } catch {
      console.error(`${name} is not valid JSON`);
      process.exit(1);
    }
  };
  const fixtures: { responses: Record<string, unknown> } = parse(
    fixturesText,
    name,
  );

  if (values["write-ignores"]) {
    // A gitleaks JSON report of the fixture file, run from --root.
    const found: { File: string; RuleID: string; StartLine: number }[] = parse(
      await Bun.file(values["write-ignores"]).text(),
      values["write-ignores"],
    );
    // A report naming the file another way (./x, an absolute path) would
    // match nothing here and wipe the existing entries.
    if (found.some((finding) => finding.File !== name)) {
      console.error(
        `not written: the report names files other than ${name}; run gitleaks from --root on ${name}`,
      );
      process.exit(1);
    }
    const entries = found.map(
      (finding) => `${finding.File}:${finding.RuleID}:${finding.StartLine}`,
    );
    const refused = checkIgnores(fixturesText, entries.join("\n"), name);
    if (refused.length > 0) {
      report(refused);
      console.error("not written: these findings need a look, not an ignore");
      process.exit(1);
    }
    await Bun.write(ignorePath, withFixtureIgnores(ignoreText, entries, name));
    console.log(`wrote ${entries.length} fixture entries to .gitleaksignore`);
    process.exit(0);
  }

  const findings = [
    ...checkComplete(fixtures),
    ...scanFixtures(fixtures),
    ...checkIgnores(fixturesText, ignoreText, name),
  ];
  report(findings);
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s) in ${name}`);
    process.exit(1);
  }
  const ignored = ignoreText
    .split("\n")
    .filter((line) => line.startsWith(`${name}:`)).length;
  console.log(
    `clean: ${name} (${Object.keys(fixtures.responses).length} answers; ${ignored} gitleaks ignores, each a recorded agent id in a usage breakdown, of ${agentIds(fixtures).size} agents)`,
  );
}
