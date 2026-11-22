// In-page layout measurement for `browser.mjs <run> measure <name>`: one
// expression whose value is the geometry of the current console screen.
// Page coordinates (scroll included), px rounded to 0.5. "ink" is what the
// eye sees: text line boxes plus anything painted (border, fill, shadow,
// image), so a gap in ink is the empty space a person reads between blocks.
(() => {
  const r = (n) => Math.round(n * 2) / 2;
  const main = document.getElementById("main");
  const sidebar = document.querySelector("[data-slot=app-sidebar]");
  const topbar = sidebar
    ? sidebar.parentElement.querySelector(":scope > header")
    : null;
  const pageBg = main
    ? getComputedStyle(main).backgroundColor
    : "rgb(255, 255, 255)";
  const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  const LEAF = new Set([
    "P",
    "SPAN",
    "A",
    "BUTTON",
    "LABEL",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "H1",
    "H2",
    "H3",
    "H4",
    "SVG",
    "IMG",
    "TABLE",
    "CODE",
    "PRE",
    "DT",
    "DD",
    "TIME",
    "STRONG",
    "SMALL",
  ]);
  const painted = new Set([
    "IMG",
    "SVG",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "CANVAS",
    "VIDEO",
    "HR",
  ]);
  const hidden = (el) => {
    const s = getComputedStyle(el);
    if (
      s.display === "none" ||
      s.visibility === "hidden" ||
      Number(s.opacity) === 0
    )
      return true;
    // A closed <details> keeps a box for its body; it is not drawn.
    const d = el.parentElement?.closest("details");
    if (d && !d.open && !el.closest("summary")) return true;
    const b = el.getBoundingClientRect();
    if (b.width <= 1 || b.height <= 1)
      return s.position === "absolute" || b.width === 0 || b.height === 0;
    return false;
  };
  const box = (b) => ({
    x: r(b.left + scrollX),
    y: r(b.top + scrollY),
    w: r(b.width),
    h: r(b.height),
    right: r(b.right + scrollX),
    bottom: r(b.bottom + scrollY),
  });
  const rect = (el) => box(el.getBoundingClientRect());
  const name = (el) => {
    if (!el) return null;
    const slot = el.getAttribute("data-slot");
    const role = el.getAttribute("role");
    const text = (el.getAttribute("aria-label") || el.innerText || "")
      .trim()
      .split("\n")[0]
      .slice(0, 28);
    return `${el.tagName.toLowerCase()}${slot ? `[${slot}]` : ""}${role ? `(${role})` : ""}${text ? ` "${text}"` : ""}`;
  };
  const transparent = (c) => c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
  const paints = (el, s) =>
    painted.has(el.tagName.toUpperCase()) ||
    ["Top", "Right", "Bottom", "Left"].some(
      (side) =>
        parseFloat(s[`border${side}Width`]) > 0 &&
        !transparent(s[`border${side}Color`]),
    ) ||
    (!transparent(s.backgroundColor) && s.backgroundColor !== pageBg) ||
    s.backgroundImage !== "none" ||
    s.boxShadow !== "none";
  // Union of what is painted inside el, or null when nothing is.
  // textOnly: leave out what paints only a bottom line (a tab's underline).
  function ink(el, self = true, textOnly = false) {
    let u = null;
    const add = (b) => {
      if (b.width <= 0 || b.height <= 0) return;
      u = u
        ? {
            left: Math.min(u.left, b.left),
            top: Math.min(u.top, b.top),
            right: Math.max(u.right, b.right),
            bottom: Math.max(u.bottom, b.bottom),
          }
        : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    };
    const visit = (node, isRoot) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent.trim()) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const b of range.getClientRects()) add(b);
        return;
      }
      if (
        node.nodeType !== Node.ELEMENT_NODE ||
        SKIP.has(node.tagName) ||
        hidden(node)
      )
        return;
      const s = getComputedStyle(node);
      const underline =
        ["Top", "Right", "Left"].every(
          (side) => parseFloat(s[`border${side}Width`]) === 0,
        ) &&
        transparent(s.backgroundColor) &&
        s.boxShadow === "none";
      if ((!isRoot || self) && paints(node, s) && !(textOnly && underline)) {
        add(node.getBoundingClientRect());
        if (painted.has(node.tagName.toUpperCase())) return;
      }
      for (const child of node.childNodes) visit(child, false);
    };
    visit(el, true);
    return u
      ? {
          x: r(u.left + scrollX),
          y: r(u.top + scrollY),
          right: r(u.right + scrollX),
          bottom: r(u.bottom + scrollY),
        }
      : null;
  }
  const flowChildren = (el) =>
    [...el.children].filter((c) => {
      if (SKIP.has(c.tagName) || hidden(c)) return false;
      const p = getComputedStyle(c).position;
      return p !== "absolute" && p !== "fixed";
    });

  const out = {
    path: location.pathname,
    w: innerWidth,
    theme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    scrollWidth: document.documentElement.scrollWidth,
  };

  // (f) shell: sidebar brand block and top bar, their lower edges.
  if (sidebar && topbar) {
    const head = sidebar.firstElementChild;
    const ts = getComputedStyle(topbar);
    const hs = head ? getComputedStyle(head) : null;
    const firstNav = sidebar.querySelector("nav a");
    out.shell = {
      sidebar: rect(sidebar),
      topbar: {
        ...rect(topbar),
        borderBottom: parseFloat(ts.borderBottomWidth),
      },
      brand:
        head && !hidden(head)
          ? {
              ...rect(head),
              borderBottom: parseFloat(hs.borderBottomWidth),
              // Without the block's own border, so the centre is the brand's.
              ink: ink(head, false),
              lines: [...head.children].map((c) => ({
                text: c.innerText.trim().slice(0, 28),
                ...rect(c),
                font: getComputedStyle(c).fontSize,
              })),
            }
          : null,
      firstNav: firstNav ? rect(firstNav) : null,
      trail: topbar.querySelector("p")
        ? {
            ...rect(topbar.querySelector("p")),
            ink: ink(topbar.querySelector("p")),
          }
        : null,
      topbarButton:
        topbar.querySelector("a,button:not(.md\\:hidden)") &&
        !hidden(topbar.querySelector("a,button:not(.md\\:hidden)"))
          ? rect(topbar.querySelector("a,button:not(.md\\:hidden)"))
          : null,
    };
  }

  // The content root: <main> in the console, else the first form's card (login family).
  const root =
    main ??
    document.querySelector("form")?.closest("[data-slot=card], section, div") ??
    document.body;
  const ms = getComputedStyle(root);
  const contentLeft =
    root.getBoundingClientRect().left +
    scrollX +
    parseFloat(ms.paddingLeft) +
    parseFloat(ms.borderLeftWidth);
  out.main = {
    ...rect(root),
    padding: [
      ms.paddingTop,
      ms.paddingRight,
      ms.paddingBottom,
      ms.paddingLeft,
    ].map(parseFloat),
    contentLeft: r(contentLeft),
    contentWidth: r(
      root.clientWidth -
        parseFloat(ms.paddingLeft) -
        parseFloat(ms.paddingRight),
    ),
    maxWidth: ms.maxWidth,
  };

  // (e) page head: title, description, actions.
  // A screen that builds its own head still has one: the first <header> in main.
  const header =
    root.querySelector("[data-slot=page-header]") ??
    (main ? main.querySelector("header") : null);
  const h1 = root.querySelector("h1") ?? document.querySelector("h1");
  const desc = header?.querySelector("p") ?? null;
  const action = header
    ? [...header.querySelectorAll("a,button")].find((b) => !hidden(b))
    : null;
  out.head = {
    pageHeader: !!root.querySelector("[data-slot=page-header]"),
    header: header ? rect(header) : null,
    headerMarginBottom: header
      ? parseFloat(getComputedStyle(header).marginBottom)
      : null,
    h1: h1
      ? {
          ...rect(h1),
          ink: ink(h1),
          font: `${getComputedStyle(h1).fontSize}/${getComputedStyle(h1).lineHeight}`,
        }
      : null,
    desc: desc
      ? {
          ...rect(desc),
          ink: ink(desc),
          font: `${getComputedStyle(desc).fontSize}/${getComputedStyle(desc).lineHeight}`,
        }
      : null,
    action: action ? { label: name(action), ...rect(action) } : null,
  };

  // (c) vertical rhythm: every stacked pair of in-flow siblings, by level.
  const sections = header
    ? header.nextElementSibling &&
      flowChildren(header.parentElement).length === 2
      ? header.nextElementSibling
      : header.parentElement
    : root;
  out.sectionContainer = name(sections);
  const gaps = [];
  if (header?.nextElementSibling) {
    const next = header.nextElementSibling;
    const first =
      next === sections ? (flowChildren(sections)[0] ?? next) : next;
    const hi = ink(header);
    const fi = ink(first);
    gaps.push({
      level: "head",
      parent: name(header.parentElement),
      a: "page-header",
      b: name(first),
      layout: r(
        first.getBoundingClientRect().top -
          header.getBoundingClientRect().bottom,
      ),
      ink: hi && fi ? r(fi.y - hi.bottom) : null,
    });
  }
  const levelOf = (depth) =>
    depth === 0 ? "section" : depth === 1 ? "block" : "inner";
  // An open (not carded) group led by an h2 with content under it: a section
  // by what the reader sees, whatever its depth in the DOM.
  function sectionish(el) {
    // A detail page's side panel is a region of its own, card or not.
    if (el.tagName === "ASIDE") return true;
    if (isCard(el)) return false;
    const h = el.querySelector("h2");
    if (!h || hidden(h)) return false;
    const eb = el.getBoundingClientRect();
    const hb = h.getBoundingClientRect();
    return (
      hb.top - eb.top <= 8 &&
      eb.height > hb.height + 24 &&
      ![...cards0()].some((c) => c !== el && c.contains(h) && el.contains(c))
    );
  }
  const inCard = (el) => {
    for (let p = el; p && p !== root; p = p.parentElement)
      if (isCard(p)) return true;
    return false;
  };
  const cards0 = () =>
    [...root.querySelectorAll("*")].filter((x) => !hidden(x) && isCard(x));
  function walk(el, depth) {
    if (depth > 7) return;
    // An inline box's top is its line's half-leading, not where its block starts.
    const kids = flowChildren(el).filter(
      (c) =>
        !(header && c === header) && getComputedStyle(c).display !== "inline",
    );
    const stacked =
      kids.length >= 2 &&
      kids.every(
        (c, i) =>
          i === 0 ||
          c.getBoundingClientRect().top >=
            kids[i - 1].getBoundingClientRect().bottom - 0.5,
      );
    if (stacked) {
      kids.slice(1, 5).forEach((b, i) => {
        const a = kids[i];
        const ai = ink(a);
        const bi = ink(b);
        gaps.push({
          level: levelOf(depth),
          depth,
          sections: sectionish(a) || sectionish(b),
          inCard: inCard(el),
          parent: name(el),
          a: name(a),
          b: name(b),
          layout: r(
            b.getBoundingClientRect().top - a.getBoundingClientRect().bottom,
          ),
          ink: ai && bi ? r(bi.y - ai.bottom) : null,
        });
      });
    }
    for (const c of kids) {
      if (
        LEAF.has(c.tagName.toUpperCase()) ||
        c.getAttribute("role") === "tablist"
      )
        continue;
      // Rows of one list repeat one shape; the first two say it all.
      if (kids.length > 6 && kids.indexOf(c) > 1) continue;
      // Whatever sits in the section container is a section, even alone.
      walk(c, stacked || depth === 0 ? depth + 1 : depth);
    }
  }
  walk(sections, 0);
  out.gaps = gaps;

  // (a) left lines: where the outer blocks start, box and ink, outside cards.
  // A block with a sibling to its left on the same row (an icon, a first
  // column) starts its own line; every other block, an indented first column
  // too, owes the content line.
  function sideColumn(el) {
    for (let n = el; n && n !== root; n = n.parentElement) {
      const p = n.parentElement;
      if (!p) break;
      const b = n.getBoundingClientRect();
      const besideLeft = [...p.children].some((s) => {
        if (s === n || hidden(s)) return false;
        const sb = s.getBoundingClientRect();
        return (
          sb.width > 0 &&
          sb.right <= b.left + 1 &&
          sb.top < b.bottom &&
          sb.bottom > b.top
        );
      });
      if (besideLeft) return true;
    }
    return false;
  }
  const lines = [];
  const cards = [];
  function isCard(el) {
    if (el.getAttribute("data-slot") === "card") return true;
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    // A dashed frame is an empty-state placeholder, not a card.
    return (
      s.borderTopStyle === "solid" &&
      ["Top", "Right", "Bottom", "Left"].every(
        (side) => parseFloat(s[`border${side}Width`]) > 0,
      ) &&
      parseFloat(s.borderTopLeftRadius) >= 6 &&
      b.width >= 160 &&
      b.height >= 40 &&
      !["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(el.tagName) &&
      /block|flex|grid/.test(s.display)
    );
  }
  // An empty-state frame centres its words on purpose; its border owes the line.
  const placeholders = [];
  for (const el of root.querySelectorAll("*")) {
    if (hidden(el) || el.closest("[data-slot=page-header] [data-slot]"))
      continue;
    const covered = [...cards.map((c) => c.el), ...placeholders].some((c) =>
      c.contains(el),
    );
    if (isCard(el) && !covered) {
      cards.push({ el });
      continue;
    }
    if (covered) continue;
    if (getComputedStyle(el).borderTopStyle === "dashed") {
      placeholders.push(el);
      const b = rect(el);
      lines.push({
        el: name(el),
        box: b.x,
        ink: b.x,
        dx: r(b.x - contentLeft),
        column: sideColumn(el),
      });
      continue;
    }
    const tag = el.tagName;
    const role = el.getAttribute("role");
    if (
      /^H[1-4]$/.test(tag) ||
      tag === "P" ||
      tag === "TABLE" ||
      tag === "UL" ||
      tag === "OL" ||
      tag === "FORM" ||
      tag === "NAV" ||
      role === "tablist" ||
      tag === "LABEL" ||
      tag === "DL"
    ) {
      const b = el.getBoundingClientRect();
      if (b.left + scrollX > contentLeft + 0.45 * out.main.contentWidth)
        continue;
      // A tab strip lines up by its first label, not by its underline.
      const strip = tag === "NAV" || role === "tablist";
      const i = ink(el, !strip, strip);
      lines.push({
        el: name(el),
        box: r(b.left + scrollX),
        ink: i ? i.x : null,
        dx: i ? r(i.x - contentLeft) : null,
        column: sideColumn(el),
      });
    }
  }
  for (const c of cards) {
    const b = rect(c.el);
    lines.push({
      el: name(c.el),
      box: b.x,
      ink: b.x,
      dx: r(b.x - contentLeft),
      card: true,
      column: sideColumn(c.el),
    });
  }
  out.lines = lines;

  const structuralFrames = [
    ...root.querySelectorAll(
      "section,form,fieldset,ul,ol,table,[role=table],[data-slot=card],[data-slot=alert],div",
    ),
  ].filter((el) => {
    if (
      hidden(el) ||
      el.closest(
        "button,a,[role=combobox],[role=radio],[role=checkbox],[role=switch],[data-slot=input-group],[data-slot=combobox]",
      )
    )
      return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return (
      box.width >= 120 &&
      box.height >= 24 &&
      ["Top", "Right", "Bottom", "Left"].every(
        (side) =>
          parseFloat(style[`border${side}Width`]) > 0 &&
          !transparent(style[`border${side}Color`]),
      )
    );
  });
  out.structuralFrames = structuralFrames.map((el) => {
    const ancestor = structuralFrames.find(
      (parent) => parent !== el && parent.contains(el),
    );
    return {
      el: name(el),
      ...rect(el),
      framedAncestor: ancestor ? name(ancestor) : null,
    };
  });
  out.structuralFrameCount = structuralFrames.length;
  out.nestedStructuralFrameCount = out.structuralFrames.filter(
    (frame) => frame.framedAncestor !== null,
  ).length;

  // (d) card insides: padding, what the eye sees as the inset, the right button.
  // A list card (no padding of its own, rows stacked) is read row by row.
  const inside = (el) => {
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const inner = ink(el, false);
    // A worded button on the right half: an icon button (copy) is part of its line.
    const btns = [...el.querySelectorAll("button, a[data-slot=button]")].filter(
      (x) =>
        !hidden(x) &&
        x.innerText.trim() &&
        x.getBoundingClientRect().left > b.left + b.width / 2,
    );
    const btn = btns[btns.length - 1];
    const firstText = [...el.querySelectorAll("h2,h3,h4,p,strong,a,span")].find(
      (x) => !hidden(x) && x.innerText.trim() && !x.closest("button"),
    );
    return {
      el: name(el),
      ...rect(el),
      headerRow: !!el.querySelector("[role=columnheader], th"),
      padding: [
        s.paddingTop,
        s.paddingRight,
        s.paddingBottom,
        s.paddingLeft,
      ].map(parseFloat),
      inset: inner
        ? {
            top: r(inner.y - (b.top + scrollY)),
            right: r(b.right + scrollX - inner.right),
            bottom: r(b.bottom + scrollY - inner.bottom),
            left: r(inner.x - (b.left + scrollX)),
          }
        : null,
      button: btn
        ? {
            label: name(btn),
            ...rect(btn),
            centerY: r(
              btn.getBoundingClientRect().top +
                scrollY +
                btn.getBoundingClientRect().height / 2,
            ),
            // A button with a hint under it is centred as that group; the
            // row itself or a wrapper holding the row's title is no group.
            groupCenterY:
              btn.parentElement !== el &&
              !btn.parentElement.contains(firstText ?? null) &&
              [...btn.parentElement.childNodes].some(
                (n) => n !== btn && n.textContent.trim(),
              )
                ? r(
                    btn.parentElement.getBoundingClientRect().top +
                      scrollY +
                      btn.parentElement.getBoundingClientRect().height / 2,
                  )
                : null,
          }
        : null,
      firstLine: firstText ? { el: name(firstText), ...rect(firstText) } : null,
      contentCenterY: inner ? r((inner.y + inner.bottom) / 2) : null,
    };
  };
  out.cards = cards.slice(0, 8).map(({ el }) => {
    const card = inside(el);
    const kids = flowChildren(el);
    const listLike = card.padding.every((p) => p === 0) && kids.length >= 2;
    // A row that only wraps one padded box (a row with sub-rows) is read by that box.
    const rowBox = (k) => {
      const only = flowChildren(k);
      return parseFloat(getComputedStyle(k).paddingTop) === 0 &&
        only.length === 1
        ? only[0]
        : k;
    };
    // A table frame pads its cells, not its rows: a row's padding is its
    // first cell's top, bottom and left with its last cell's right.
    const table =
      card.padding.every((p) => p === 0) && kids.length === 1
        ? (kids[0].closest("table") ?? kids[0].querySelector("table"))
        : null;
    if (table) {
      const rows = [...table.querySelectorAll("tbody tr")]
        .filter((tr) => !hidden(tr) && tr.cells.length > 0)
        .slice(0, 2)
        .map((tr) => {
          const first = getComputedStyle(tr.cells[0]);
          const last = getComputedStyle(tr.cells[tr.cells.length - 1]);
          return {
            ...inside(tr),
            padding: [
              first.paddingTop,
              last.paddingRight,
              first.paddingBottom,
              first.paddingLeft,
            ].map(parseFloat),
          };
        });
      return { ...card, rows };
    }
    return listLike
      ? { ...card, rows: kids.slice(0, 2).map((k) => inside(rowBox(k))) }
      : card;
  });

  // (b) widths of the blocks directly under each section.
  out.widths = flowChildren(sections).map((c) => ({
    el: name(c),
    w: rect(c).w,
    x: rect(c).x,
  }));
  return out;
})();
