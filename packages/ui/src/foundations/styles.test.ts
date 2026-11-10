import { describe, expect, test } from "bun:test";

/*
 * jsdom and happy-dom have no layout engine, so "360px에서 가로 스크롤이 없다"
 * and "prefers-reduced-motion을 존중한다" cannot be observed by rendering. They
 * are enforced here as properties of the stylesheet itself, which is where the
 * regression would actually be introduced.
 */

const TOKENS = await Bun.file(`${import.meta.dir}/tokens.css`).text();
const STYLES = await Bun.file(`${import.meta.dir}/styles.css`).text();
const THEME = await Bun.file(`${import.meta.dir}/theme.css`).text();

const NARROWEST_VIEWPORT_PX = 360;
const ROOT_FONT_SIZE_PX = 16;
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

interface Declaration {
  readonly selector: string;
  readonly atRules: readonly string[];
  readonly property: string;
  readonly value: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Enough of a CSS parser for flat rules and one level of at-rule nesting. */
function parse(css: string): Declaration[] {
  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";

  for (const character of stripComments(css)) {
    if (character === "{") {
      // Drop the `@import`/`@layer` statements that precede the first block.
      stack.push(buffer.slice(buffer.lastIndexOf(";") + 1).trim());
      buffer = "";
      continue;
    }
    if (character === "}") {
      const selector = stack.pop() ?? "";
      // Every rule sits in the `werft` layer; only the at-rules inside it matter.
      const atRules = stack.filter(
        (entry) => entry.startsWith("@") && entry !== "@layer werft",
      );
      for (const entry of buffer.split(";")) {
        const [property, ...rest] = entry.split(":");
        if (!property?.trim() || rest.length === 0) continue;
        declarations.push({
          selector,
          atRules,
          property: property.trim(),
          value: rest.join(":").trim(),
        });
      }
      buffer = "";
      continue;
    }
    buffer += character;
  }

  return declarations;
}

const tokenDeclarations = parse(TOKENS);
const styleDeclarations = parse(STYLES);

/** `animation`/`transition` declarations, grouped by property → selectors. */
function motionDeclarations(
  predicate: (d: Declaration) => boolean,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const declaration of styleDeclarations) {
    const property = /^(animation|transition)(-|$)/.exec(declaration.property);
    if (!property || !predicate(declaration)) continue;
    const selectors = grouped.get(property[1] as string) ?? new Set<string>();
    for (const selector of declaration.selector.split(",")) {
      selectors.add(selector.trim().replace(/\s+/g, " "));
    }
    grouped.set(property[1] as string, selectors);
  }
  return grouped;
}

function customProperties(predicate: (d: Declaration) => boolean): string[] {
  return tokenDeclarations
    .filter((d) => d.property.startsWith("--werft-") && predicate(d))
    .map((d) => d.property);
}

/** WCAG relative luminance, then the 2.1 contrast ratio. */
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5]
      .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return (
      0.2126 * (channels[0] as number) +
      0.7152 * (channels[1] as number) +
      0.0722 * (channels[2] as number)
    );
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Token name → value, for one theme's block. */
function paletteOf(
  predicate: (d: Declaration) => boolean,
): Map<string, string> {
  const palette = new Map<string, string>();
  for (const declaration of tokenDeclarations) {
    if (
      !declaration.property.startsWith("--werft-color") &&
      !declaration.property.startsWith("--werft-tone")
    ) {
      continue;
    }
    if (!predicate(declaration)) continue;
    palette.set(declaration.property, declaration.value);
  }
  return palette;
}

/** The arguments of a leading `min(...)`, split at depth 1. Empty otherwise. */
function topLevelArguments(value: string): string[] {
  const match = /^\s*min\(([\s\S]*)\)\s*$/.exec(value);
  if (!match?.[1]) return [];
  const args: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const character of match[1]) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      args.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += character;
  }
  args.push(buffer.trim());
  return args;
}

/** What is left after the `@import`/`@layer` statements and the `werft` block. */
function outsideApLayer(css: string): string {
  const body = stripComments(css)
    .replace(/@(import|layer)[^{;]*;/g, "")
    .trim();
  if (!body.startsWith("@layer werft {")) return body;
  let depth = 0;
  for (const [index, character] of [...body].entries()) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (character === "}" && depth === 0) return body.slice(index + 1).trim();
  }
  return body;
}

describe("이름공간", () => {
  test("키트 규칙은 모두 werft layer 안에 있다", () => {
    expect(outsideApLayer(TOKENS)).toBe("");
    expect(outsideApLayer(STYLES)).toBe("");
  });

  test("theme.css의 Tailwind 키는 모두 --werft- 토큰을 가리킨다", () => {
    const keys = parse(THEME).filter((d) => d.selector === "@theme inline");
    expect(keys.length).toBeGreaterThan(40);
    const loose = keys.filter(
      (d) =>
        d.property.startsWith("--werft-") ||
        !/^(var\(--werft-[\w-]+\)|-?[\d.]+rem)$/.test(d.value),
    );
    expect(loose.map((d) => `${d.property}: ${d.value}`)).toEqual([]);
  });

  test("theme.css는 --werft- 밖의 변수를 읽지 않는다", () => {
    // A rule reading a Tailwind theme key makes Tailwind emit that key on
    // `:root`, outside the namespace.
    const reads = parse(THEME).flatMap((d) =>
      [...d.value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name]) => name),
    );
    expect(reads.length).toBeGreaterThan(40);
    expect(reads.filter((name) => !name?.startsWith("--werft-"))).toEqual([]);
  });

  test("werft layer가 Tailwind layer 뒤에 온다", () => {
    expect(stripComments(TOKENS)).toContain(
      "@layer theme, base, components, utilities, werft;",
    );
  });

  test("키트가 선언하는 커스텀 프로퍼티는 모두 --werft- 접두사를 단다", () => {
    const unprefixed = [...tokenDeclarations, ...styleDeclarations]
      .filter((d) => d.property.startsWith("--"))
      .filter((d) => !d.property.startsWith("--werft-"))
      .map((d) => `${d.selector} { ${d.property} }`);
    expect(unprefixed).toEqual([]);
  });
});

describe("theme.css", () => {
  test("눌리는 부품은 손가락 커서, 비활성은 not-allowed 커서다", () => {
    // Tailwind 4's preflight leaves <button> on the UA's arrow cursor.
    const base = parse(THEME).filter(
      (d) => d.atRules.includes("@layer base") && d.property === "cursor",
    );
    const cursorOf = (part: string, enabled: boolean) =>
      base.find(
        (d) =>
          d.selector.includes(part) &&
          d.selector.includes(":disabled") &&
          d.selector.includes(":not(") === enabled,
      )?.value;
    for (const part of [
      "button",
      '[role="tab"]',
      '[role="switch"]',
      '[role="radio"]',
      "summary",
      "select",
    ]) {
      expect([part, cursorOf(part, true)]).toEqual([part, "pointer"]);
      expect([part, cursorOf(part, false)]).toEqual([part, "not-allowed"]);
    }
  });
});

describe("tokens.css", () => {
  test("본문 색이 앉을 수 있는 모든 바탕에서 AA를 넘는다", () => {
    // 12px 상태 문구까지 포함하므로 large-text 예외(3:1)는 쓰지 않는다.
    const AA = 4.5;
    const TONES = [
      "neutral",
      "progress",
      "attention",
      "caution",
      "danger",
      "unknown",
      "positive",
      "success",
    ];
    const SURFACES = [
      "--werft-color-sidebar",
      "--werft-color-surface",
      "--werft-color-surface-sunken",
      ...TONES.map((tone) => `--werft-tone-${tone}-bg`),
    ];
    const light = paletteOf(
      (d) => d.selector === ":root" && d.atRules.length === 0,
    );
    const themes: [string, Map<string, string>][] = [
      ["light", light],
      [
        "dark(수동)",
        paletteOf((d) => d.selector === ':root[data-theme="dark"]'),
      ],
      [
        // The OS-preference block is a third theme, not a copy: a regression
        // that only lands there would otherwise go unmeasured.
        "dark(시스템)",
        paletteOf((d) =>
          d.atRules.includes("@media (prefers-color-scheme: dark)"),
        ),
      ],
    ];
    const TEXT = [
      "--werft-color-foreground",
      "--werft-color-muted-foreground",
      "--werft-color-subtle-foreground",
    ];

    const failures: string[] = [];
    // A token this test cannot read is a hole in it, not a pass. Every pair
    // below must resolve to a hex value in every theme.
    const colourOf = (
      theme: string,
      palette: Map<string, string>,
      name: string,
    ): string | null => {
      const value = palette.get(name);
      if (value && /^#[0-9a-f]{6}$/i.test(value)) return value;
      failures.push(`${theme}: ${name} = ${value ?? "없음"} (읽을 수 없다)`);
      return null;
    };

    for (const [theme, palette] of themes) {
      expect(palette.size).toBeGreaterThan(0);
      const pairs: [string[], string[]][] = [
        [TEXT, SURFACES],
        [TEXT, ["--werft-color-sidebar-hover", "--werft-color-sidebar-accent"]],
        [
          ["--werft-color-sidebar-selected-text"],
          ["--werft-color-sidebar-selected"],
        ],
        // A status label draws its own tone on its own background — the pair
        // the whole StatusLabel vocabulary rests on.
        ...TONES.map(
          (tone) =>
            [[`--werft-tone-${tone}-fg`], [`--werft-tone-${tone}-bg`]] as [
              string[],
              string[],
            ],
        ),
      ];
      for (const [texts, surfaces] of pairs) {
        for (const text of texts) {
          const fg = colourOf(theme, palette, text);
          for (const surface of surfaces) {
            const bg = colourOf(theme, palette, surface);
            if (!fg || !bg) continue;
            const ratio = contrast(fg, bg);
            if (ratio < AA) {
              failures.push(
                `${theme}: ${text} on ${surface} = ${ratio.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("입력 칸 테두리가 표·카드 선보다 옅지 않고 hover에 3:1을 넘는다", () => {
    const themes: [string, Map<string, string>][] = [
      [
        "light",
        paletteOf((d) => d.selector === ":root" && d.atRules.length === 0),
      ],
      [
        "dark(수동)",
        paletteOf((d) => d.selector === ':root[data-theme="dark"]'),
      ],
      [
        "dark(시스템)",
        paletteOf((d) =>
          d.atRules.includes("@media (prefers-color-scheme: dark)"),
        ),
      ],
    ];
    // Matched by suffix: Tailwind scans this file, and the full theme key
    // written out here would be emitted into apps/web's CSS.
    expect(parse(THEME).find((d) => d.property.endsWith("-input"))?.value).toBe(
      "var(--werft-color-border-input)",
    );
    const ratios = themes.flatMap(([theme, palette]) =>
      // surface-sunken: the default Tabs track the active tab's edge sits on.
      [
        "--werft-color-surface",
        "--werft-color-sidebar",
        "--werft-color-surface-sunken",
      ].map((surface) => {
        const bg = palette.get(surface) ?? "";
        const ratio = contrast(
          palette.get("--werft-color-border-input") ?? "",
          bg,
        );
        const line = contrast(palette.get("--werft-color-border") ?? "", bg);
        return `${theme} ${surface} ${ratio > line ? "ok" : `${ratio.toFixed(2)} <= ${line.toFixed(2)}`}`;
      }),
    );
    expect(ratios.filter((line) => !line.endsWith("ok"))).toEqual([]);
    // The resting edge is under 3:1 by choice (tokens.css); hover makes up
    // the 3:1 under the pointer and never stands out less than the rest.
    const hover = themes.map(([theme, palette]) => {
      const surface = palette.get("--werft-color-surface") ?? "";
      const rest = contrast(
        palette.get("--werft-color-border-input") ?? "",
        surface,
      );
      const over = contrast(
        palette.get("--werft-color-subtle-foreground") ?? "",
        surface,
      );
      return `${theme} ${over >= rest && over >= 3 ? "ok" : `${over.toFixed(2)} vs ${rest.toFixed(2)}`}`;
    });
    expect(hover.filter((line) => !line.endsWith("ok"))).toEqual([]);
  });

  test("링크·상태 점·주 버튼·아이콘 타일·채운 위험 버튼·켜진 Switch가 바탕에서 AA를 넘는다", () => {
    // Link text 4.5:1; a dot is a graphic, 3:1 (WCAG 1.4.11).
    const DOTS = ["wait", "run", "idle", "done", "failed"].map(
      (state) => `--werft-color-status-dot-${state}`,
    );
    const pairs: [string, string, number][] = [
      ...[
        "--werft-color-surface",
        "--werft-color-sidebar",
        "--werft-color-surface-sunken",
      ].flatMap((surface): [string, string, number][] => [
        ["--werft-color-link", surface, 4.5],
        ...DOTS.map((dot): [string, string, number] => [dot, surface, 3]),
      ]),
      [
        "--werft-color-destructive-foreground",
        "--werft-color-destructive-solid",
        4.5,
      ],
      ["--werft-color-focus-ring", "--werft-color-surface", 3],
      // The primary button's label, at rest and under the pointer.
      ["--werft-color-accent-foreground", "--werft-color-accent", 4.5],
      ["--werft-color-accent-foreground", "--werft-color-accent-hover", 4.5],
      // A chart's bars, in the accent, on the cards they sit on.
      ["--werft-color-accent", "--werft-color-surface", 3],
      ["--werft-color-accent", "--werft-color-surface-sunken", 3],
      // An icon tile's glyph on its hue.
      ...[
        "blue",
        "violet",
        "orange",
        "green",
        "pink",
        "teal",
        "sky",
        "slate",
      ].map((hue): [string, string, number] => [
        "--werft-color-tile-foreground",
        `--werft-color-tile-${hue}`,
        3,
      ]),
      // A switch's track, on or off, on the page.
      ...[
        "--werft-color-surface",
        "--werft-color-sidebar",
        "--werft-color-surface-sunken",
      ].flatMap((surface): [string, string, number][] => [
        ["--werft-color-control-checked", surface, 3],
        ["--werft-color-control-unchecked", surface, 3],
      ]),
    ];
    const themes: [string, Map<string, string>][] = [
      [
        "light",
        paletteOf((d) => d.selector === ":root" && d.atRules.length === 0),
      ],
      [
        "dark(수동)",
        paletteOf((d) => d.selector === ':root[data-theme="dark"]'),
      ],
      [
        "dark(시스템)",
        paletteOf((d) =>
          d.atRules.includes("@media (prefers-color-scheme: dark)"),
        ),
      ],
    ];
    // Suffix match for the same reason as the input border test above.
    for (const name of ["control-checked", "control-unchecked"]) {
      expect(
        parse(THEME).find((d) => d.property.endsWith(`-${name}`))?.value,
      ).toBe(`var(--werft-color-${name})`);
    }
    const failures = themes.flatMap(([theme, palette]) =>
      pairs.flatMap(([fg, bg, floor]) => {
        const a = palette.get(fg) ?? "";
        const b = palette.get(bg) ?? "";
        if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) {
          return [`${theme}: ${fg} on ${bg} 읽을 수 없다`];
        }
        const ratio = contrast(a, b);
        return ratio < floor ? [`${theme}: ${fg} on ${bg} = ${ratio}`] : [];
      }),
    );
    expect(failures).toEqual([]);
  });

  test("테마마다 color-scheme을 선언해 native 컨트롤도 따라간다", () => {
    const schemes = tokenDeclarations
      .filter((d) => d.property === "color-scheme")
      .map((d) => `${d.selector} ${d.value}`);
    expect(schemes).toEqual([
      ":root light dark",
      ':root[data-theme="light"] light',
      ':root[data-theme="dark"] dark',
    ]);
  });

  test("색 토큰이 라이트·다크 양쪽에 모두 있다", () => {
    const light = new Set(
      customProperties((d) => d.selector === ":root" && d.atRules.length === 0),
    );
    const systemDark = new Set(
      customProperties((d) =>
        d.atRules.includes("@media (prefers-color-scheme: dark)"),
      ),
    );
    const manualDark = new Set(
      customProperties((d) => d.selector === ':root[data-theme="dark"]'),
    );

    // An alias (`var(--werft-…)`) follows its target, which is checked itself.
    const aliases = new Set(
      tokenDeclarations
        .filter((d) => d.selector === ":root" && d.value.startsWith("var("))
        .map((d) => d.property),
    );
    const themed = [...light].filter(
      (name) =>
        /^--werft-(color|tone|shadow|avatar)-/.test(name) && !aliases.has(name),
    );
    expect(themed.length).toBeGreaterThan(0);
    for (const name of themed) {
      expect(systemDark.has(name)).toBe(true);
      expect(manualDark.has(name)).toBe(true);
    }
  });

  test("시스템 설정과 수동 전환을 모두 받는다", () => {
    // `data-theme="light"` must win over the OS preference, or the toggle lies.
    expect(TOKENS).toContain(':root:not([data-theme="light"])');
    expect(TOKENS).toContain(':root[data-theme="dark"]');
  });

  test("모션 토큰이 reduced-motion에서 0이 된다", () => {
    const reduced = tokenDeclarations.filter((d) =>
      d.atRules.includes(REDUCED_MOTION),
    );
    expect(reduced.map((d) => d.property).sort()).toEqual([
      "--werft-motion-fast",
      "--werft-motion-normal",
    ]);
    for (const declaration of reduced) {
      expect(declaration.value).toBe("0ms");
    }
  });
});

describe("styles.css", () => {
  test("색은 tokens.css 한 곳에서만 나온다", () => {
    const literals = styleDeclarations.filter(
      (d) =>
        !d.property.startsWith("--") &&
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value),
    );
    expect(literals.map((d) => `${d.selector} { ${d.property} }`)).toEqual([]);
  });

  test("비활성 행은 행동 셀을 뺀 셀을 흐린 글자와 무채색 tone으로 그린다", () => {
    const inactive = styleDeclarations.filter((d) =>
      d.selector.includes("[data-inactive]"),
    );
    expect(inactive.length).toBeGreaterThan(0);
    for (const d of inactive) {
      // The actions cell keeps its contrast. A Button under `TooltipTrigger
      // asChild` takes the trigger's slot, so it is found by its own mark.
      expect(
        d.selector
          .replace(/\s+/g, " ")
          .replace(/\( | (?=\))/g, (m) => m.trim()),
      ).toContain(
        ':not([data-raised], [data-variant="actions"], :has([data-werft-button]))',
      );
    }
    const value = (property: string) =>
      inactive.find((d) => d.property === property)?.value;
    // subtle-foreground is the faintest text that holds AA on every
    // surface and tone bg (tokens.css test above).
    expect(value("color")).toBe("var(--werft-color-subtle-foreground)");
    expect(value("--werft-color-foreground")).toBe(
      "var(--werft-color-subtle-foreground)",
    );
    // Every tone a badge or status label can take turns neutral.
    for (const tone of [
      "progress",
      "attention",
      "caution",
      "danger",
      "unknown",
      "positive",
      "success",
    ]) {
      expect(value(`--werft-tone-${tone}-fg`)).toBe(
        "var(--werft-color-subtle-foreground)",
      );
      expect(value(`--werft-tone-${tone}-bg`)).toBe(
        "var(--werft-tone-neutral-bg)",
      );
    }
  });

  test("한글 마이크로라벨을 uppercase로 바꾸지 않는다", () => {
    const uppercased = styleDeclarations.filter(
      (d) => d.property === "text-transform" && d.value !== "none",
    );
    expect(uppercased).toEqual([]);
  });

  test("360px 폭에서 가로로 넘치는 고정 너비가 없다", () => {
    const tooWide = styleDeclarations.filter((d) => {
      if (!["width", "min-width", "max-width"].includes(d.property))
        return false;
      // A big intrinsic width is fine when `min()` caps it against the
      // container. `clamp(a, b, c)` does not: its floor is `a`, so only the
      // first argument is read below.
      // `100%` is the container; `vw` includes the scrollbar and is what
      // pushed the dialog sideways once already. A `+` inside the cap means
      // it grows past the container, so it is not a cap.
      // A real cap: one argument of `min()` is the container itself, `100%`
      // or `calc(100% - x)`. `100vw` includes the scrollbar — the value that
      // scrolled this package sideways once — and `1100%` merely contains the
      // same characters.
      const cappedToContainer = topLevelArguments(d.value).some(
        (argument) =>
          argument === "100%" || /^calc\(\s*100%\s*-/.test(argument),
      );
      const value = cappedToContainer
        ? ""
        : (/^\s*clamp\((.*)$/.exec(d.value)?.[1]?.split(",")[0] ?? d.value);
      // rem as well as px: `width: 40rem` is 640px at the default root size,
      // and this package states its widths in rem.
      const match = /(\d+(?:\.\d+)?)(px|rem)\b/.exec(value);
      if (!match) return false;
      const px =
        Number(match[1]) * (match[2] === "rem" ? ROOT_FONT_SIZE_PX : 1);
      return px > NARROWEST_VIEWPORT_PX;
    });
    expect(
      tooWide.map((d) => `${d.selector} { ${d.property}: ${d.value} }`),
    ).toEqual([]);
  });

  test("서버가 준 글자를 그리는 자리는 모두 끊어서 감싼다", () => {
    /*
     * 360px에서 넘치는지는 레이아웃 엔진 없이는 볼 수 없지만, 원인은 볼 수
     * 있다 — 서버 문자열(식별자·URL·트레이스 토큰)에는 공백이 없을 수 있고,
     * flex 항목의 최소 폭은 가장 긴 단어다.
     */
    const SERVER_TEXT = [
      ".werft-status__text",
      ".werft-status__detail",
      ".werft-receipt__operation",
      ".werft-receipt__id",
      ".werft-receipt__detail",
      ".werft-receipt-link__text",
      ".werft-receipt-link__id",
      ".werft-state__description",
      ".werft-state__code",
    ];
    const wrapping = new Map<string, string>();
    for (const declaration of styleDeclarations) {
      if (declaration.atRules.length > 0) continue;
      if (declaration.property !== "overflow-wrap") continue;
      for (const selector of declaration.selector.split(",")) {
        wrapping.set(selector.trim(), declaration.value);
      }
    }
    // The value, not just the property: `overflow-wrap: normal` declares
    // nothing and would otherwise pass.
    const missing = SERVER_TEXT.filter(
      (selector) =>
        !["anywhere", "break-word"].includes(wrapping.get(selector) ?? ""),
    );
    expect(missing).toEqual([]);
  });

  test("모션을 쓰는 선택자마다 reduced-motion 짝이 있다", () => {
    const animated = motionDeclarations(
      (d) => !d.atRules.includes(REDUCED_MOTION),
    );
    const stilled = motionDeclarations((d) =>
      d.atRules.includes(REDUCED_MOTION),
    );

    expect(animated.size).toBeGreaterThan(0);
    for (const [property, selectors] of animated) {
      for (const selector of selectors) {
        // Same selector, same specificity, later in the file — so `none` wins
        // without `!important`. A near-miss selector would silently lose.
        expect(stilled.get(property)?.has(selector)).toBe(true);
      }
    }
  });

  test("reduced-motion 짝이 모션을 실제로 끈다", () => {
    // The pairing test above only proves the selector is repeated. Without
    // this one, `animation: werft-spin 900ms linear infinite` in the reduced
    // block would still pass while nothing at all was stilled.
    const stilled = styleDeclarations.filter(
      (d) =>
        d.atRules.includes(REDUCED_MOTION) &&
        /^(animation|transition)(-|$)/.test(d.property),
    );
    expect(stilled.length).toBeGreaterThan(0);
    for (const declaration of stilled) {
      expect(declaration.value).toBe("none");
    }
  });

  test("reduced-motion 블록이 파일 맨 뒤에 온다", () => {
    const last = styleDeclarations.at(-1);
    expect(last?.atRules).toContain(REDUCED_MOTION);
  });

  test("한쪽 면만 굵게 그은 강조선이 없다", () => {
    // Spinner arcs (`border-top-color: transparent`) are a shape, not an accent.
    const KEYWORD_PX: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
    const widthsPx = (value: string): number[] =>
      [
        ...value.matchAll(
          /(?<![\w.-])(\d*\.?\d+)(px|rem|em)?(?![\w.%-])|\b(thin|medium|thick)\b/g,
        ),
      ].map(([, n, unit, keyword]) =>
        keyword
          ? (KEYWORD_PX[keyword] ?? 0)
          : Number(n) * (unit === "px" || !unit ? 1 : ROOT_FONT_SIZE_PX),
      );
    const accents = styleDeclarations.filter((d) => {
      if (d.property === "border-width") {
        return new Set(widthsPx(d.value)).size > 1;
      }
      if (
        !/^border-(top|right|bottom|left|inline|block)(-(start|end))?(-width)?$/.test(
          d.property,
        )
      ) {
        return false;
      }
      if (/^(0|none|hidden)$/.test(d.value)) return false;
      const widths = widthsPx(d.value);
      // A side drawn without a width falls back to `medium`.
      return (widths.length === 0 ? [3] : widths).some((px) => px > 1);
    });
    expect(
      accents.map((d) => `${d.selector} { ${d.property}: ${d.value} }`),
    ).toEqual([]);
  });

  test("!important로 캐스케이드를 뒤집지 않는다", () => {
    const shouting = styleDeclarations.filter((d) =>
      d.value.includes("!important"),
    );
    expect(shouting.map((d) => `${d.selector} { ${d.property} }`)).toEqual([]);
  });
});
