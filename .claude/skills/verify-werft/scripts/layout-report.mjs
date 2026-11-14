#!/usr/bin/env node
// Compare `browser.mjs measure` output with the console v35 layout rules and
// write one Markdown and one CSV table per measured set.
//
//   layout-report.mjs <layout dir> <out dir> <prefix> [<prefix> ...]
//
// Files are <prefix>-<screen>-<width>-<theme>.json (browser.mjs measure
// <prefix>-<screen>-<width>-<theme>). With two prefixes (before, after) the
// Markdown also gets a side-by-side count per screen and width.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, outDir, ...prefixes] = process.argv.slice(2);
if (!dir || !outDir || prefixes.length === 0) {
  console.error(
    "usage: layout-report.mjs <layout dir> <out dir> <prefix> [<prefix> ...]",
  );
  process.exit(2);
}

// Console v35: 4/8/12/16/24/32 only; page top 32, page head 24, section 32,
// block 16, card padding 16, list row 12 16, top bar 52. At 390 the gutter
// and the page top are 16; the vertical rhythm below the head is the same.
const SCALE = new Set([0, 4, 8, 12, 16, 24, 32]);
const RULE = {
  1440: { top: 32, head: 24, section: 32, block: 16, gutter: 32 },
  390: { top: 16, head: 24, section: 32, block: 16, gutter: 16 },
};
const TOPBAR = 52;
// Lists, tables and details take the wide column; one form or one settings
// column the narrow one (packages/ui/README.md). The key lists sit under
// /settings/ but are lists.
const W_WIDE = 1200;
const W_NARROW = 840;
const KEY_LISTS = new Set([
  "/settings/api-keys",
  "/settings/api-keys/agents",
]);
// A row that wraps on a narrow screen puts its action under the text, where
// centring does not apply.
const wrapped = (row) =>
  row.firstLine !== null &&
  row.firstLine !== undefined &&
  row.button.y >= row.firstLine.bottom;
const near = (a, b, tol = 1) =>
  a !== null && b !== null && Math.abs(a - b) <= tol;

function checks(m, width) {
  const rule = RULE[width] ?? RULE[1440];
  const out = [];
  const add = (check, where, measured, expected, ok, note = "") =>
    out.push({
      check,
      where,
      measured,
      expected,
      ok,
      delta:
        typeof measured === "number" && typeof expected === "number"
          ? Math.abs(measured - expected)
          : 0,
      note,
    });
  const auth = !m.shell;
  add(
    "page.overflow",
    "document scrollWidth vs viewport",
    m.scrollWidth,
    m.w,
    m.scrollWidth <= m.w,
  );

  if (m.shell) {
    const { topbar, brand, trail } = m.shell;
    add(
      "shell.topbar-height",
      "topbar",
      topbar.h,
      TOPBAR,
      near(topbar.h, TOPBAR),
    );
    if (brand) {
      add(
        "shell.edge-y",
        "sidebar brand vs topbar bottom edge",
        brand.bottom,
        topbar.bottom,
        near(brand.bottom, topbar.bottom),
        `brand line ${brand.borderBottom}px, topbar line ${topbar.borderBottom}px`,
      );
      if (trail?.ink && brand.ink) {
        const bc = (brand.ink.y + brand.ink.bottom) / 2;
        const tc = (topbar.y + topbar.bottom) / 2;
        add(
          "shell.center-y",
          "brand text centre vs topbar centre",
          bc,
          tc,
          near(bc, tc, 2),
        );
      }
    }
  }
  if (!auth) {
    add(
      "page.gutter",
      "main padding-left",
      m.main.padding[3],
      rule.gutter,
      near(m.main.padding[3], rule.gutter),
    );
    const first = m.head.header ?? m.head.h1;
    if (first && m.shell) {
      const top = first.y - m.shell.topbar.bottom;
      add(
        "page.top",
        `${m.head.header ? "page head" : "h1"} top − topbar`,
        top,
        rule.top,
        near(top, rule.top),
      );
    }
    if (!m.head.pageHeader)
      add(
        "page.header",
        "PageHeader",
        "own head",
        "PageHeader",
        false,
        "screen builds its own head",
      );
    if (m.head.action && m.head.h1) {
      // Against the title's first line: a long title wraps, the action stays on line one.
      const ac = m.head.action.y + m.head.action.h / 2;
      const hc =
        m.head.h1.y + Number.parseFloat(m.head.h1.font.split("/")[1]) / 2;
      add(
        "head.action-y",
        `${m.head.action.label} centre vs h1 centre`,
        ac - hc,
        0,
        near(ac, hc, 2),
      );
      const right = m.main.contentLeft + m.main.contentWidth;
      add(
        "head.action-x",
        "action right vs content right",
        m.head.action.right,
        right,
        near(m.head.action.right, right),
      );
    }
  }
  for (const g of m.gaps) {
    const where = `${g.a} → ${g.b}`;
    // One field rhythm on every form: 16, a checkbox or radio list 12.
    if (/\[field\]/.test(g.a) && /\[field\]/.test(g.b)) {
      const list = /field-set|checkbox|radio/.test(g.parent);
      add(
        "gap.field",
        where,
        g.layout,
        list ? 12 : 16,
        near(g.layout, 16) || (list && near(g.layout, 12)),
      );
    } else if (g.level === "head")
      add(
        "gap.page-head",
        where,
        g.layout,
        rule.head,
        near(g.layout, rule.head),
        `ink ${g.ink}`,
      );
    else if (
      (g.level === "section" || (g.sections && g.level === "block")) &&
      !auth
    )
      add(
        "gap.section",
        where,
        g.layout,
        rule.section,
        near(g.layout, rule.section),
        `ink ${g.ink}`,
      );
    // Inside a card the card's own rhythm holds (title → body 12); only the scale is checked.
    else if (g.level === "block" && !auth && !g.inCard)
      add(
        "gap.block",
        where,
        g.layout,
        rule.block,
        near(g.layout, rule.block) || g.layout === 0,
        `ink ${g.ink}`,
      );
    else if (!SCALE.has(Math.round(g.layout)) && g.layout >= 0)
      add(
        "gap.scale",
        where,
        g.layout,
        "4·8·12·16·24·32",
        false,
        `${g.level}, ink ${g.ink}`,
      );
  }
  if (!auth) {
    // Measurements taken before `column` existed fall back to the old cut-off.
    const lefts = m.lines.filter(
      (l) => l.dx !== null && (l.column === undefined ? l.dx < 40 : !l.column),
    );
    for (const l of lefts)
      if (Math.abs(l.dx) > 1)
        add("align.left", l.el, l.dx, 0, false, `box ${l.box}, ink ${l.ink}`);
  }
  for (const c of m.cards) {
    if (c.rows) {
      for (const row of c.rows.filter((x) => !x.headerRow)) {
        const [t, rt, b, l] = row.padding;
        const rowOk = t === 12 && b === 12 && rt === 16 && l === 16;
        if (!rowOk)
          add(
            "card.row-padding",
            `${c.el} / ${row.el}`,
            row.padding.join(" "),
            "12 16 12 16",
            false,
          );
        // Centred in the row's box: an icon button inside a text line keeps the ink centre off by its own padding.
        const rowCenter = row.y + row.h / 2;
        if (row.button && !wrapped(row)) {
          const y = row.button.groupCenterY ?? row.button.centerY;
          add(
            "card.row-button-y",
            `${row.el} ${row.button.label}`,
            y - rowCenter,
            0,
            near(y, rowCenter, 1),
          );
        }
      }
    } else if (/^li\b/.test(c.el)) {
      // A row bordered on its own is still a list row.
      const pad = c.padding.join(" ");
      if (pad !== "12 16 12 16")
        add("card.row-padding", c.el, pad, "12 16 12 16", false);
      if (c.button && !wrapped(c)) {
        const y = c.button.groupCenterY ?? c.button.centerY;
        const rowCenter = c.y + c.h / 2;
        add(
          "card.row-button-y",
          `${c.el} ${c.button.label}`,
          y - rowCenter,
          0,
          near(y, rowCenter, 1),
        );
      }
    } else {
      // No padding: a frame around rows (a table).
      const pad = c.padding.join(" ");
      if (pad !== "16 16 16 16" && pad !== "0 0 0 0")
        add("card.padding", c.el, pad, "16", false);
    }
  }
  if (m.shell && m.path) {
    const narrow =
      m.path === "/agents/new" ||
      (m.path.startsWith("/settings/") && !KEY_LISTS.has(m.path));
    const expected = (narrow ? W_NARROW : W_WIDE) + 2 * RULE[1440].gutter;
    add(
      "width.main",
      `${m.path} (${narrow ? "narrow" : "wide"})`,
      parseFloat(m.main.maxWidth),
      expected,
      parseFloat(m.main.maxWidth) === expected,
    );
    // A list, table or panel fills the column; an inner max-width shows here.
    for (const b of m.widths ?? [])
      if (/^(ul|ol|table|section|nav|div\[card\])/.test(b.el))
        add(
          "width.block",
          b.el,
          b.w,
          m.main.contentWidth,
          near(b.w, m.main.contentWidth),
        );
  }
  return out;
}

function load(prefix) {
  const re = new RegExp(`^${prefix}-(.+)-(1440|390)-(light|dark)\\.json$`);
  const sets = [];
  for (const f of readdirSync(dir).sort()) {
    const hit = f.match(re);
    if (!hit) continue;
    const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const [, screen, width, theme] = hit;
    sets.push({
      screen,
      width: Number(width),
      theme,
      m,
      rows: checks(m, Number(width)),
    });
  }
  return sets;
}

// Values every screen should share at one width; a screen that differs is a defect too.
function consistency(sets) {
  const rows = [];
  for (const width of [1440, 390]) {
    const at = sets.filter(
      (s) => s.width === width && s.theme === "light" && s.m.shell,
    );
    const metric = {
      "h1 y": (s) => s.m.head.h1?.y,
      "content left": (s) => s.m.main.contentLeft,
      "page-head gap": (s) => s.m.gaps.find((g) => g.level === "head")?.layout,
      "section gap": (s) => s.m.gaps.find((g) => g.level === "section")?.layout,
    };
    for (const [name, get] of Object.entries(metric)) {
      const values = new Map();
      for (const s of at) {
        const v = get(s);
        if (v === undefined || v === null) continue;
        values.set(v, [...(values.get(v) ?? []), s.screen]);
      }
      if (values.size > 1) {
        const common = [...values.entries()].sort(
          (a, b) => b[1].length - a[1].length,
        )[0][0];
        for (const [v, screens] of values)
          if (v !== common)
            rows.push({ width, metric: name, value: v, common, screens });
      }
    }
  }
  return rows;
}

const csvCell = (v) => `"${String(v).replaceAll('"', '""')}"`;
const md = [];
const counts = {};
mkdirSync(outDir, { recursive: true });
for (const prefix of prefixes) {
  const sets = load(prefix);
  const csv = ["screen,width,theme,check,where,measured,expected,ok,note"];
  for (const s of sets)
    for (const r of s.rows)
      csv.push(
        [
          s.screen,
          s.width,
          s.theme,
          r.check,
          r.where,
          r.measured,
          r.expected,
          r.ok,
          r.note,
        ]
          .map(csvCell)
          .join(","),
      );
  writeFileSync(join(outDir, `${prefix}.csv`), `${csv.join("\n")}\n`);

  const cross = consistency(sets);
  counts[prefix] = {};
  md.push(
    `## ${prefix}`,
    "",
    "| 화면 | 폭 | 어긋남 | 점검 | light·dark 차이 |",
    "|---|---|---|---|---|",
  );
  for (const s of sets.filter((x) => x.theme === "light")) {
    const dark = sets.find(
      (x) => x.screen === s.screen && x.width === s.width && x.theme === "dark",
    );
    const bad = s.rows.filter((r) => !r.ok);
    const crossBad = cross.filter(
      (c) => c.width === s.width && c.screens.includes(s.screen),
    );
    const n = bad.length + crossBad.length;
    counts[prefix][`${s.screen} ${s.width}`] = n;
    const darkDiff = dark
      ? JSON.stringify(dark.rows.map((r) => [r.check, r.measured])) ===
        JSON.stringify(s.rows.map((r) => [r.check, r.measured]))
        ? "같음"
        : "다름"
      : "없음";
    md.push(
      `| ${s.screen} | ${s.width} | ${n} | ${s.rows.length + crossBad.length} | ${darkDiff} |`,
    );
  }
  md.push(
    "",
    "### 화면끼리 다른 값",
    "",
    "| 폭 | 값 | 이 값 | 대부분 | 화면 |",
    "|---|---|---|---|---|",
  );
  for (const c of cross)
    md.push(
      `| ${c.width} | ${c.metric} | ${c.value} | ${c.common} | ${c.screens.join(", ")} |`,
    );
  md.push(
    "",
    "### 어긋남 (light, 큰 순)",
    "",
    "| 화면 | 폭 | 점검 | 위치 | 실측 | 기대 | 메모 |",
    "|---|---|---|---|---|---|---|",
  );
  const all = sets
    .filter((x) => x.theme === "light")
    .flatMap((s) =>
      s.rows
        .filter((r) => !r.ok)
        .map((r) => ({ ...r, screen: s.screen, width: s.width })),
    );
  all.sort((a, b) => b.delta - a.delta);
  for (const r of all)
    md.push(
      `| ${r.screen} | ${r.width} | ${r.check} | ${r.where.replaceAll("|", "/")} | ${r.measured} | ${r.expected} | ${r.note} |`,
    );
  md.push("");
}
if (prefixes.length === 2) {
  const [a, b] = prefixes;
  const keys = [
    ...new Set([...Object.keys(counts[a]), ...Object.keys(counts[b])]),
  ];
  const total = (p) => Object.values(counts[p]).reduce((x, y) => x + y, 0);
  md.unshift(
    `합계: ${a} ${total(a)} → ${b} ${total(b)}`,
    "",
    `| 화면 폭 | ${a} | ${b} |`,
    "|---|---|---|",
    ...keys.map(
      (k) => `| ${k} | ${counts[a][k] ?? "-"} | ${counts[b][k] ?? "-"} |`,
    ),
    "",
  );
}
md.unshift(
  "# 콘솔 간격·폭·정렬 실측 (v35 규칙 대비)",
  "",
  "규칙: page-top 32(390은 16) · page-head 24 · section 32 · block 16 · 척도 4·8·12·16·24·32 · 카드 padding 16 · 목록 행 12 16 · topbar 52, 사이드바 머리와 같은 경계선 · 좌측 정렬선 하나.",
  "",
);
writeFileSync(
  join(outDir, `${prefixes.join("-vs-")}.md`),
  `${md.join("\n")}\n`,
);
for (const p of prefixes)
  console.log(
    `${p}: ${Object.values(counts[p]).reduce((x, y) => x + y, 0)} deviations over ${Object.keys(counts[p]).length} screen×width`,
  );
console.log(join(outDir, `${prefixes.join("-vs-")}.md`));
