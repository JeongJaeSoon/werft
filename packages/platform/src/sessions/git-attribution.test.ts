import { describe, expect, test } from "bun:test";
import type { SessionAttributionRecord } from "../ports/session-attribution.ts";
import {
  appBotAuthor,
  attributionView,
  claimGitOf,
  coAuthorOf,
  PULL_REQUEST_TAIL_END_MARKER,
  PULL_REQUEST_TAIL_MARKER,
  pullRequestTail,
  sessionUrlOf,
  withPullRequestTail,
} from "./git-attribution.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function record(
  starter: SessionAttributionRecord["starter"],
  trigger: SessionAttributionRecord["trigger"] = "web",
): SessionAttributionRecord {
  return {
    ownerId: "owner-a",
    trigger,
    agentId: null,
    agentReleaseId: null,
    starter,
    authorApp: null,
    authorPinned: false,
  };
}

const OCTOCAT = { id: "583231", login: "octocat" };
const LINKED = record({ userId: "user-1", github: OCTOCAT });

describe("the co-author a commit names", () => {
  test("is the linked starter's login with GitHub's noreply address", () => {
    expect(coAuthorOf(LINKED)).toEqual({
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    });
  });

  test("is no one without a starter, a link, or with a value outside GitHub's rules", () => {
    for (const github of [
      null,
      { id: "0", login: "octocat" },
      { id: "12a", login: "octocat" },
      { id: "583231", login: "octo cat" },
      { id: "583231", login: "octocat>\nSigned-off-by: x" },
      { id: "583231", login: "a".repeat(40) },
    ]) {
      expect(coAuthorOf(record({ userId: "user-1", github }))).toBeNull();
    }
    expect(coAuthorOf(record(null))).toBeNull();
    expect(coAuthorOf(null)).toBeNull();
  });
});

test("the claim names the session's console page, or none without an origin", () => {
  expect(
    claimGitOf(record(null), "https://console.example.com", SESSION),
  ).toEqual({
    co_author: null,
    session_url: `https://console.example.com/sessions/${SESSION}`,
  });
  expect(sessionUrlOf(null, SESSION)).toBeNull();
});

test("the session detail says co_author, unlinked or app_only", () => {
  expect(attributionView(LINKED)).toEqual({
    trigger: "web",
    attribution: "co_author",
    login: "octocat",
  });
  expect(
    attributionView(record({ userId: "user-1", github: null }, "slack")),
  ).toEqual({ trigger: "slack", attribution: "unlinked", login: null });
  expect(attributionView(record(null, "agent_key"))).toEqual({
    trigger: "agent_key",
    attribution: "app_only",
    login: null,
  });
});

describe("the App bot a commit is written by", () => {
  test("is <slug>[bot] at its users-API id's noreply address", () => {
    expect(appBotAuthor("werft-dev", "41898282")).toEqual({
      name: "werft-dev[bot]",
      email: "41898282+werft-dev[bot]@users.noreply.github.com",
    });
  });

  test("is none for a slug or id outside GitHub's rules", () => {
    expect(appBotAuthor("Werft Dev", "1")).toBeNull();
    expect(appBotAuthor("werft-dev]", "1")).toBeNull();
    expect(appBotAuthor("werft-dev", "0")).toBeNull();
    expect(appBotAuthor("werft-dev", "12a")).toBeNull();
  });
});

describe("the folded pull request tail", () => {
  const COMMIT = "cacbb01f".padEnd(40, "0");
  const render = (
    overrides: Partial<Parameters<typeof pullRequestTail>[0]> = {},
  ) =>
    pullRequestTail({
      sessionId: SESSION,
      sessionUrl: `https://console.example.com/sessions/${SESSION}`,
      commit: COMMIT,
      pushRequestId: "p-1",
      record: { ...LINKED, agentId: "agent-1", agentReleaseId: "sha256:f5" },
      ...overrides,
    });

  test("folds the details and names the linked starter without a mention", () => {
    expect(render()).toBe(
      [
        "---",
        PULL_REQUEST_TAIL_MARKER,
        "<!-- agent-platform:push-request p-1 -->",
        `Opened in a Werft session · [session](<https://console.example.com/sessions/${SESSION}>) · commit \`cacbb01\``,
        "",
        "<details><summary>Details</summary>",
        "",
        `- Session: \`${SESSION}\``,
        "- Agent: `agent-1`, release `sha256:f5`",
        "- Push request: `p-1`",
        "- Trigger: web",
        "- Started by: GitHub account linked (octocat)",
        "</details>",
        "",
        "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
        PULL_REQUEST_TAIL_END_MARKER,
      ].join("\n"),
    );
    expect(render()).not.toContain("@octocat");
  });

  test("names the session by id alone when asked, or without a console", () => {
    for (const tail of [
      render({ sessionLink: "id" }),
      render({ sessionUrl: null }),
    ]) {
      expect(tail).toContain(
        `${PULL_REQUEST_TAIL_MARKER}\n<!-- agent-platform:push-request p-1 -->\nOpened in a Werft session · commit \`cacbb01\`\n`,
      );
      expect(tail).toContain(`- Session: \`${SESSION}\``);
      expect(tail).not.toContain("console.example.com");
    }
  });

  test("has a Requested by line only when given one", () => {
    expect(render()).not.toContain("Requested by");
    expect(render({ requester: null })).not.toContain("Requested by");
    const requested = render({
      requester: { kind: "person", github: OCTOCAT, surface: "Slack" },
    });
    expect(requested).toContain(
      "- Started by: GitHub account linked (octocat)\n- Requested by: octocat (Slack)\n</details>",
    );
    // Either way it is the platform's tail, replaced on the next write.
    const newer = render({ commit: "b".repeat(40) });
    for (const tail of [
      render(),
      requested,
      render({
        requester: { kind: "person", github: null, surface: "Slack" },
      }),
      render({ requester: { kind: "none" } }),
    ]) {
      expect(withPullRequestTail(`Intro\n\n${tail}`, newer)).toBe(
        `Intro\n\n${newer}`,
      );
    }
  });

  describe("the turn's requester (94S-1304)", () => {
    const HUBOT = { id: "42", login: "hubot" };
    const asked = (
      github: typeof OCTOCAT | null,
      surface: "Slack" | "web console" = "Slack",
    ) => render({ requester: { kind: "person", github, surface } });

    test("the requester is the co-author, not the linked starter", () => {
      const tail = asked(HUBOT, "web console");
      expect(tail).toContain("- Started by: GitHub account linked (octocat)");
      expect(tail).toContain("- Requested by: hubot (web console)");
      expect(tail).toContain(
        "Co-authored-by: hubot <42+hubot@users.noreply.github.com>",
      );
      expect(tail).not.toContain("Co-authored-by: octocat");
      expect(tail).not.toContain("@hubot");
    });

    test("a requester without a link adds no co-author and no name, though the starter is linked", () => {
      const tail = asked(null);
      expect(tail).toContain(
        "- Requested by: a person without a linked GitHub account (Slack)",
      );
      expect(tail).not.toContain("Co-authored-by");
      expect(tail).not.toContain("octocat\n");
      expect(render({ requester: { kind: "none" } })).not.toContain(
        "Co-authored-by",
      );
    });

    test("a login outside GitHub's rules is no requester login and no co-author", () => {
      const tail = asked({ id: "42", login: "hubot\n- Requested by: x" });
      expect(tail).toContain("a person without a linked GitHub account");
      expect(tail).not.toContain("hubot");
    });

    test("an old tail is replaced by one new tail, however often it is applied", () => {
      const old = render();
      const fresh = asked(HUBOT);
      const body = `Intro\n\n${old}`;
      const once = withPullRequestTail(body, fresh);
      expect(once).toBe(`Intro\n\n${fresh}`);
      expect(withPullRequestTail(once, fresh)).toBe(once);
      expect(once.match(/Co-authored-by/g)).toHaveLength(1);
      expect(once.match(/Requested by/g)).toHaveLength(1);
    });

    test("a Co-authored-by line that does not match the requester is a person's, not the tail's", () => {
      const forged = asked(HUBOT).replace(
        "Co-authored-by: hubot <42+hubot@users.noreply.github.com>",
        "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
      );
      const fresh = asked(HUBOT, "web console");
      const result = withPullRequestTail(`Intro\n\n${forged}`, fresh);
      expect(result).toContain(forged);
      expect(result.match(/Requested by/g)).toHaveLength(2);
    });
  });

  test("an unlinked or keyless starter gets no Co-authored-by", () => {
    const unlinked = render({
      record: record({ userId: "user-1", github: null }),
    });
    expect(unlinked).toContain(
      "- Started by: GitHub account not linked (App only)\n</details>\n<!--",
    );
    const keyless = render({ record: record(null, "agent_key") });
    expect(keyless).toContain("- Started by: none (App only)");
    for (const tail of [unlinked, keyless]) {
      expect(tail).not.toContain("Co-authored-by");
      expect(withPullRequestTail(tail, render())).toBe(render());
    }
  });

  test("a body ending inside an unclosed HTML comment gets it closed, so the tail shows", () => {
    for (const body of [
      "Summary\n\n<!-- reviewer notes, unfinished",
      "Summary\n<!--\nnotes\n\nmore notes",
      "Summary <!-- a --> then <!-- b",
    ]) {
      const once = withPullRequestTail(body, render());
      expect(once).toBe(`${body}\n-->\n\n${render()}`);
      const newer = render({ commit: "b".repeat(40) });
      expect(withPullRequestTail(once, newer)).toBe(`${body}\n-->\n\n${newer}`);
    }
    // Closed on the same or a later line, or named in code, a comment leaves
    // nothing open.
    for (const body of [
      "<!-- note -->",
      "<!--\nnote\n-->",
      "`<!--` is how",
      "Use `` <!-- ` `` here.",
    ]) {
      expect(withPullRequestTail(body, render())).toBe(
        `${body}\n\n${render()}`,
      );
    }
  });

  test("a tail inside a person's HTML comment is hidden text, not the tail", () => {
    const hidden = `<!--\n${render({ commit: "0".repeat(40) })}\n-->`;
    expect(withPullRequestTail(hidden, render())).toBe(
      `${hidden}\n\n${render()}`,
    );
  });

  test("comments and code spans are read in order, so an element around a tail still quotes", () => {
    const pasted = render({ commit: "0".repeat(40) });
    for (const example of [
      // An element after a comment's end on its line.
      `<!-- note\n--> <details>\n<summary>Example</summary>\n\n${pasted}\n</details>`,
      // A comment cut out of a tag does not close the element.
      `<details>\n<summary>Examples</summary>\n\n</det<!-- note -->ails>\n\n${pasted}\n</details>`,
      // A backtick inside a comment opens no code span.
      `<!-- \` --> <details>\`\n<!-- divider -->\n\n${pasted}\n</details>`,
    ]) {
      expect(withPullRequestTail(example, render())).toBe(
        `${example}\n\n${render()}`,
      );
    }
  });

  test("an old-shape tail is replaced by exactly one folded tail", () => {
    const old = [
      "---",
      PULL_REQUEST_TAIL_MARKER,
      `Opened by Werft from session \`${SESSION}\`, commit \`${"a".repeat(40)}\`.`,
      "",
      `- Session: https://console.example.com/sessions/${SESSION}`,
      "- Agent: `agent-1`, release `sha256:f5`",
      "- Push request: `p-1`",
      "- Trigger: web",
      "- Started by: GitHub account linked (@octocat)",
      "",
      "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
      PULL_REQUEST_TAIL_END_MARKER,
    ].join("\n");
    const once = withPullRequestTail(`Summary\n\n${old}\n\nAfter`, render());
    expect(once).toBe(`Summary\n\n${render()}\n\nAfter`);
    expect(once.split(PULL_REQUEST_TAIL_MARKER)).toHaveLength(2);
    expect(withPullRequestTail(once, render())).toBe(once);
  });

  test("a folded tail a person edited is theirs, kept whole", () => {
    const tail = render();
    for (const edited of [
      tail.replace("</details>", "- Reviewed: yes\n</details>"),
      tail.replace("Details</summary>", "More</summary>"),
      tail.replace("(octocat)", "(@octocat)"),
      tail.replace(
        "Co-authored-by: octocat <583231+",
        "Co-authored-by: pair <583231+",
      ),
      tail.replace("\n\nCo-authored-by", "\nCo-authored-by"),
      tail.replace("`cacbb01`", "`reviewed manually; do not overwrite`"),
      tail.replace(
        "</details>",
        "- Requested by: Alice; keep this approval note\n</details>",
      ),
    ]) {
      expect(edited).not.toBe(tail);
      expect(withPullRequestTail(edited, tail)).toBe(`${edited}\n\n${tail}`);
    }
  });
});

describe("replacing the pull request tail", () => {
  const block = (text: string) =>
    `---\n${PULL_REQUEST_TAIL_MARKER}\n${text}\n${PULL_REQUEST_TAIL_END_MARKER}`;
  const tailOf = (sessionId: string) =>
    block(
      `Opened by Werft from session \`${sessionId}\`, commit \`abc\`.\n\n- Agent: none, release none\n- Push request: \`p\`\n- Trigger: web\n- Started by: none (App only)`,
    );
  const tail = tailOf("new");
  const OLD = tailOf("old");
  const EXAMPLE = tailOf("example");

  test("an empty body becomes the tail", () => {
    expect(withPullRequestTail("", tail)).toBe(tail);
  });

  test("only the tail between the markers is replaced", () => {
    expect(
      withPullRequestTail(
        `Intro\n\n---\nA rule of the author's\n\n${OLD}\n\nAdded below`,
        tail,
      ),
    ).toBe(`Intro\n\n---\nA rule of the author's\n\n${tail}\n\nAdded below`);
  });

  test("a body that is only an old tail becomes the new one", () => {
    expect(withPullRequestTail(OLD, tail)).toBe(tail);
  });

  test("a marker a person quotes is text: only the real tail changes", () => {
    const quoted = `Use \`${PULL_REQUEST_TAIL_MARKER}\` to find it.\n\nMore notes`;
    expect(withPullRequestTail(`${quoted}\n\n${OLD}`, tail)).toBe(
      `${quoted}\n\n${tail}`,
    );
    expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
      `${tail}\n\n${quoted}`,
    );
  });

  test("both markers quoted in a line or a code block are text too", () => {
    const inline = `Example: \`${PULL_REQUEST_TAIL_MARKER}\` HUMAN NOTES \`${PULL_REQUEST_TAIL_END_MARKER}\``;
    expect(withPullRequestTail(`${OLD}\n\n${inline}`, tail)).toBe(
      `${tail}\n\n${inline}`,
    );
    const fence = `\`\`\`\n${EXAMPLE}\n\`\`\``;
    expect(withPullRequestTail(`${OLD}\n\n${fence}`, tail)).toBe(
      `${tail}\n\n${fence}`,
    );
    expect(withPullRequestTail(fence, tail)).toBe(`${fence}\n\n${tail}`);
  });

  test("a fence closes only on its own character, at least as long", () => {
    for (const quoted of [
      `\`\`\`\`\n\`\`\`\n${EXAMPLE}\n\`\`\`\n\`\`\`\``,
      `~~~\n\`\`\`\n${EXAMPLE}\n\`\`\`\n~~~`,
      `\`\`\`\n~~~\n${EXAMPLE}\n~~~\n\`\`\``,
    ]) {
      expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
        `${tail}\n\n${quoted}`,
      );
    }
    const indented = EXAMPLE.split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    expect(withPullRequestTail(`${OLD}\n\nUsage:\n\n${indented}`, tail)).toBe(
      `${tail}\n\nUsage:\n\n${indented}`,
    );
    // A longer closing run still closes; the real tail after it is found.
    const closed = `\`\`\`\ncode\n\`\`\`\`\n\n${OLD}`;
    expect(withPullRequestTail(closed, tail)).toBe(
      `\`\`\`\ncode\n\`\`\`\`\n\n${tail}`,
    );
  });

  test("a start marker with no end after it cuts nothing", () => {
    const cut = `Intro\n\n---\n${PULL_REQUEST_TAIL_MARKER}\nold, end removed`;
    expect(withPullRequestTail(cut, tail)).toBe(`${cut}\n\n${tail}`);
  });

  test("markers around a person's own text are not a tail", () => {
    const details = `<details>\n<summary>PR body example</summary>\n\n${block("HUMAN NOTES")}\n</details>`;
    expect(withPullRequestTail(`${OLD}\n\n${details}`, tail)).toBe(
      `${tail}\n\n${details}`,
    );
    const edited = block(
      "Opened by Werft from session `old`, commit `abc`.\n\nReviewed by hand",
    );
    expect(withPullRequestTail(edited, tail)).toBe(`${edited}\n\n${tail}`);
  });

  test("a tail written before the rename is still replaced", () => {
    const legacy = OLD.replace("Opened by Werft", "Opened by agent-platform");
    expect(legacy).not.toBe(OLD);
    expect(withPullRequestTail(`Intro\n\n${legacy}`, tail)).toBe(
      `Intro\n\n${tail}`,
    );
  });

  test("the public markers carry the Werft name", () => {
    expect(PULL_REQUEST_TAIL_MARKER).toBe("<!-- werft:pr-tail -->");
    expect(PULL_REQUEST_TAIL_END_MARKER).toBe("<!-- /werft:pr-tail -->");
    expect(tail).not.toContain("agent-platform");
  });

  test("a tail under the pre-rename marker is text: kept, and a new tail added", () => {
    // No customer body carries it before the first tag, so there is no
    // legacy reader; nothing a person wrote is lost.
    const prior = OLD.replaceAll("<!-- werft:", "<!-- agent-platform:").replace(
      "<!-- /werft:",
      "<!-- /agent-platform:",
    );
    expect(prior).toContain("agent-platform:pr-tail");
    const once = withPullRequestTail(`Intro\n\n${prior}`, tail);
    expect(once).toBe(`Intro\n\n${prior}\n\n${tail}`);
    expect(withPullRequestTail(once, tail)).toBe(once);
  });

  test("the text after the tail is kept as written", () => {
    const code = "    const example = 1;\n      indented more";
    expect(withPullRequestTail(`${OLD}\n\n${code}`, tail)).toBe(
      `${tail}\n\n${code}`,
    );
  });

  test("a whole tail pasted inside an HTML element is quoted", () => {
    for (const quoted of [
      `<details>\n<summary>Earlier output</summary>\n\n${EXAMPLE}\n\n</details>`,
      `<pre>\n${EXAMPLE}\n</pre>`,
      `<div><details>\n\n${EXAMPLE}\n\n</details></div>`,
    ]) {
      expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
        `${tail}\n\n${quoted}`,
      );
    }
    // Named in inline code, an element opens nothing.
    const named = "Wrap it in `<details>` to fold it.";
    expect(withPullRequestTail(`${named}\n\n${OLD}`, tail)).toBe(
      `${named}\n\n${tail}`,
    );
  });

  test("a block left open is closed before the tail, so refreshes do not pile up", () => {
    for (const [body, closing] of [
      ["Build log:\n\n```\nerror: failed", "```"],
      ["~~~~\nlog", "~~~~"],
      ["<details>\n<summary>Log</summary>\n\nlines", "</details>"],
    ]) {
      const once = withPullRequestTail(body ?? "", tail);
      expect(once).toBe(`${body}\n${closing}\n\n${tail}`);
      const again = withPullRequestTail(once, tailOf("newer"));
      expect(again).toBe(`${body}\n${closing}\n\n${tailOf("newer")}`);
    }
  });

  test("a line a person adds inside the tail makes it theirs, kept whole", () => {
    const opening = "Opened by Werft from session `old`, commit `abc`.";
    const agent = "- Agent: none, release none\n- Push request: `p`";
    const own = `${agent}\n- Trigger: web\n- Started by: none (App only)`;
    for (const added of [
      block(`${opening}\n\n${own}\nCo-authored-by: pair <1+pair@example.com>`),
      block(
        `${opening}\n\n${own}\n\nCo-authored-by: pair <2+pair@users.noreply.github.com>`,
      ),
      block(
        `${opening}\n\n${agent}\n- Trigger: web\n- Started by: GitHub account linked (@octo)\n\nCo-authored-by: pair <2+pair@users.noreply.github.com>`,
      ),
      block(
        `${opening}\n\n${agent}\n- Trigger: web\n- Started by: GitHub account linked (@octo)`,
      ),
      block(`${opening}\n\n${own}\n- Trigger: slack`),
      block(
        `${opening}\n\n${agent}\n- Trigger: web\n- Trigger: web\n- Started by: none (App only)`,
      ),
    ]) {
      expect(withPullRequestTail(added, tail)).toBe(`${added}\n\n${tail}`);
    }
    const linked = block(
      `${opening}\n\n- Session: http://console.test/sessions/old\n- Agent: \`a\`, release none\n- Push request: \`p\`\n- Trigger: web\n- Started by: GitHub account linked (@octo)\n\nCo-authored-by: octo <1+octo@users.noreply.github.com>`,
    );
    expect(withPullRequestTail(linked, tail)).toBe(tail);
  });

  test("the person's line endings are kept, and a refresh equals one write", () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    expect(
      withPullRequestTail(crlf(`Intro\nline\n\n${OLD}\n\nAfter\nmore\n`), tail),
    ).toBe(`${crlf("Intro\nline")}\n\n${tail}\n\n${crlf("After\nmore\n")}`);
    for (const body of ["Summary\n", crlf("Summary\nline\n\n"), "Summary"]) {
      const newer = tailOf("newer");
      expect(withPullRequestTail(withPullRequestTail(body, tail), newer)).toBe(
        withPullRequestTail(body, newer),
      );
    }
  });
});
