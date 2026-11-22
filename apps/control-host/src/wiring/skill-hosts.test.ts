import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CanonicalBundleFile,
  checkSkillVersion,
  UNREADABLE,
} from "@werft-ai/platform";
import { RENDER_LIMIT, renderedHostExtractor } from "./skill-hosts.ts";

const file = (
  path: string,
  text: string,
  mode: 0o644 | 0o755 = 0o644,
): CanonicalBundleFile => {
  const bytes = new TextEncoder().encode(text);
  return {
    path: `skills/s/${path}`,
    mode,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const skillMd = (body: string, description = "Use for s") =>
  file(
    "SKILL.md",
    `---\nname: "s"\ndescription: "${description}"\n---\n${body}`,
  );
const check = (
  before: CanonicalBundleFile[] | null,
  after: CanonicalBundleFile[],
) => checkSkillVersion(before, after, renderedHostExtractor);
const rules = (
  before: CanonicalBundleFile[] | null,
  after: CanonicalBundleFile[],
) => check(before, after).map((finding) => finding.rule);

const base = [
  skillMd("See https://docs.example.com/a.\n"),
  file("notes.md", "n\n"),
];

describe("new_url through the rendered reading", () => {
  test("the host is the one a client reaches: userinfo with parentheses, escapes and IDN spellings do not hide it", () => {
    const known = [
      ...base,
      file(
        "more.md",
        "https://known.example/ and https://xn--bcher-kva.example/",
      ),
    ];
    const hostOf = (text: string) =>
      check(known, [...base, file("more.md", text)]).find(
        (one) => one.rule === "new_url",
      )?.samples;
    expect(hostOf("https://known.example(user)@evil.example/x")).toEqual([
      "evil.example",
    ]);
    expect(hostOf("https://ev%69l.example/")).toEqual(["evil.example"]);
    // Plain text ends a URL at whitespace, as Markdown does: what follows a
    // space or tab is not the URL's (a known limit, written in the docs).
    expect(hostOf("https://known.example @evil.example/")).toBeUndefined();
    expect(hostOf("https://known.example\t@evil.example/")).toBeUndefined();
    // Extra slashes before the host are skipped as the parser skips them.
    for (const [text, host] of [
      ["https:////evil.example/", "evil.example"],
      ["https://\\evil.example/", "evil.example"],
    ] as const) {
      expect(hostOf(text)).toContain(host);
    }
    // A line end ends a URL, as in Markdown: a link and the next line's
    // text are not one URL, and nothing is read across.
    expect(
      hostOf("[API](https://evil.example)\n\nContact support@known.example/"),
    ).toEqual(["evil.example"]);
    expect(hostOf("[Docs](https://known.example)")).toBeUndefined();
    expect(hostOf("https://known.example\n\nNotes")).toBeUndefined();
    expect(hostOf("https://known.example\n@evil.example/")).toBeUndefined();
    // Read as CommonMark renders it: a backslash escape or a character
    // reference does not hide the host.
    for (const text of [
      "[x](https://known.example\\@evil.example/)",
      "[x](https://known.example&#64;evil.example/)",
      "[x](https://known.example&#x40;evil.example/)",
      "[x](https://known.example&commat;evil.example/)",
    ]) {
      expect(hostOf(text)).toContain("evil.example");
    }
    // An HTML attribute value is read as a browser reads it: tabs and line
    // ends dropped, references resolved.
    for (const [text, host] of [
      [
        '<a href="https://known.example\n.evil.example/">Docs</a>',
        "known.example.evil.example",
      ],
      ['<a href="ht\ttps://evil.example/">Docs</a>', "evil.example"],
      [
        "<a href='https://known.example&#64;evil.example/'>Docs</a>",
        "evil.example",
      ],
      ['<img src=" //evil.example/x.png">', "evil.example"],
    ] as const) {
      expect(hostOf(text)).toContain(host);
    }
    expect(
      hostOf('<a href="https://known.example/docs">Docs</a> and <b class="x">'),
    ).toBeUndefined();
    // A link destination ends where CommonMark ends it, whatever follows;
    // an attribute may start on the next line; numeric references need no
    // ";" and may carry leading zeros.
    for (const text of [
      "[x](https://evil.example)@known.example/",
      "[x]: https://evil.example\n",
      '<a href=\n"ht\ttps://evil.example/">x</a>',
      '<a href="h&#116tps://evil.example/">x</a>',
      '<a href="&#000000000104;ttps://evil.example/">x</a>',
    ]) {
      expect(hostOf(text)).toContain("evil.example");
    }
    // CommonMark allows a line end before a destination; an autolink keeps
    // what is inside its brackets.
    expect(hostOf("[x](\nhttps://evil.example)@known.example/")).toContain(
      "evil.example",
    );
    expect(hostOf("[x](\r\nhttps://evil.example)@known.example/")).toContain(
      "evil.example",
    );
    expect(hostOf("<https://known.example!>")).toEqual(["known.example!"]);
    // A placeholder no URL parser takes names no host.
    expect(hostOf("Use https://example.com:PORT/api")).toBeUndefined();
    expect(hostOf("Use https://<host>/api")).toBeUndefined();
    // A contact after a link is not a host.
    expect(
      hostOf("[x](https://known.example) Contact support@support.example/"),
    ).toBeUndefined();
    // A quote or punctuation the parser keeps in the host is a new host.
    for (const text of [
      "https://known.example'evil.example/",
      "https://known.example!/",
    ]) {
      expect(hostOf(text)).toBeDefined();
    }
    // A quote or a backtick inside userinfo does not end the URL.
    expect(hostOf("https://known.example'@evil.example/x")).toEqual([
      "evil.example",
    ]);
    expect(hostOf("https://known.example`@evil.example/x")).toEqual([
      "evil.example",
    ]);
    // URLs packed in quotes are each read: the second is not swallowed.
    expect(
      hostOf('["https://known.example","https://evil.example"]'),
    ).toContain("evil.example");
    // Known hosts in other spellings, and markdown around them, are not new.
    expect(
      hostOf(
        "[a](https://Known.Example./a). https://known.example:443/b, (https://bücher.example/c)",
      ),
    ).toBeUndefined();
  });

  test("Markdown or HTML past RENDER_LIMIT fails new_url as unreadable", () => {
    const at = "x".repeat(RENDER_LIMIT);
    expect(rules(base, [...base, file("big.md", at)])).not.toContain("new_url");
    for (const path of ["big.md", "big.html"]) {
      expect(
        check(base, [...base, file(path, `${at}x`)]).find(
          (one) => one.rule === "new_url",
        )?.samples,
      ).toEqual([UNREADABLE]);
    }
    // The limit counts bytes, not UTF-16 units.
    const wide = "한".repeat(Math.ceil(RENDER_LIMIT / 3) + 1);
    expect(
      check(base, [...base, file("wide.md", wide)]).find(
        (one) => one.rule === "new_url",
      )?.samples,
    ).toEqual([UNREADABLE]);
    // An approved file too large to read names no host as approved.
    const had = [...base, file("big.md", `https://known.example/ ${at}`)];
    expect(
      rules(had, [...base, file("more.txt", "https://known.example/")]),
    ).toContain("new_url");
  });

  test("Codex round 12: one rendered reading for both versions, so no false host is approved and none is missed", () => {
    const newUrl = (before: string, after: string) =>
      check(
        [...base, file("more.md", before)],
        [...base, file("more.md", after)],
      ).find((one) => one.rule === "new_url")?.samples;
    // Text after a link's ")" is not its destination: it approves nothing.
    expect(
      newUrl(
        "[x](https://known.example)@evil.example/",
        "[x](https://evil.example/)",
      ),
    ).toEqual(["evil.example"]);
    expect(
      newUrl(
        "[x](https://known.example)",
        "[x](https://known.example)and more",
      ),
    ).toBeUndefined();
    // A quote in an HTML comment does not swallow the attribute after it.
    expect(
      newUrl(
        "https://known.example/",
        '<!-- =" -->\n<a href="ht\ttps://evil.example/">x</a>',
      ),
    ).toEqual(["evil.example"]);
    // Every named character reference resolves as CommonMark resolves it.
    expect(
      newUrl(
        "https://%26escr%3Bvil.example/",
        "[x](https://&escr;vil.example/)",
      ),
    ).toEqual(["evil.example"]);
    // Raw HTML keeps its backslash: the escape is Markdown's only.
    expect(
      newUrl(
        '<a href="https://known.example\\@evil.example/">x</a>',
        "[x](https://evil.example/)",
      ),
    ).toEqual(["evil.example"]);
    // A definition nothing uses is still a link a reader of the source sees.
    expect(newUrl("", "[x]: https://evil.example\n")).toEqual(["evil.example"]);
  });

  test("a long authority is read whole, so a shared start hides no host", () => {
    const long = `https://${"a".repeat(2000)}.example/`;
    expect(rules(base, [...base, file("more.md", long)])).toContain("new_url");
    const userinfo = "a".repeat(1100);
    const had = [
      ...base,
      file("more.md", `https://${userinfo}@known.example/`),
    ];
    expect(
      rules(had, [
        ...base,
        file(
          "more.md",
          `https://${userinfo}@known.example/\nhttps://${userinfo}@new.example/`,
        ),
      ]),
    ).toContain("new_url");
  });

  test("an IPv6 host, with userinfo or a port, is a host like any other", () => {
    for (const url of [
      "https://[2606:4700:4700::1111]/",
      "http://user@[2606:4700:4700::1111]:8443/x",
      "https://[2606:4700:4700::1111]",
      "(see https://[2606:4700:4700::1111])",
    ]) {
      expect(
        check(base, [...base, file("more.md", url)]).find(
          (one) => one.rule === "new_url",
        )?.samples,
      ).toEqual(["[2606:4700:4700::1111]"]);
    }
    const had = [...base, file("more.md", "https://[2606:4700:4700::1111]/a")];
    expect(
      rules(had, [
        ...base,
        file("more.md", "https://[2606:4700:4700::1111]:443/b"),
      ]),
    ).toEqual([]);
  });
});
