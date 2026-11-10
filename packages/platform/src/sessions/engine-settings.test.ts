import { describe, expect, test } from "bun:test";

import {
  type AgentEngineSettingsView,
  effectiveEngineSettings,
} from "./engine-settings.ts";

const row = (
  permissions: AgentEngineSettingsView["permissions"],
  auto_mode: AgentEngineSettingsView["auto_mode"] = {},
  revision = 1,
): AgentEngineSettingsView => ({ permissions, auto_mode, revision });

const start = (
  permissions: AgentEngineSettingsView["permissions"],
  auto_mode: AgentEngineSettingsView["auto_mode"] = {},
  revision = 1,
) => ({ permissions, auto_mode, revision });

const NONE = { allow: [], ask: [], deny: [] };
const NO_AUTO = { allow: [], soft_deny: [], hard_deny: [], environment: [] };

describe("effectiveEngineSettings", () => {
  test("no snapshot and no row adds nothing: rules with every list empty", () => {
    expect(effectiveEngineSettings({ start: null, row: null })).toEqual({
      kind: "rules",
      permissions: NONE,
      autoMode: NO_AUTO,
    });
  });

  test("an empty row is the same as no row", () => {
    expect(effectiveEngineSettings({ start: null, row: row({}) })).toEqual(
      effectiveEngineSettings({ start: null, row: null }),
    );
  });

  test("a session with no snapshot is restricted by a row saved later and never granted by it", () => {
    expect(
      effectiveEngineSettings({
        start: null,
        row: row(
          {
            allow: ["WebSearch"],
            ask: ["Bash(git push:*)"],
            deny: ["WebFetch"],
          },
          { allow: ["ok"], hard_deny: ["never"] },
        ),
      }),
    ).toEqual({
      kind: "rules",
      permissions: {
        allow: [],
        ask: ["Bash(git push:*)"],
        deny: ["WebFetch"],
      },
      autoMode: { ...NO_AUTO, hard_deny: ["never"] },
    });
  });

  test("a snapshot equal to the row passes it through", () => {
    const same = { allow: ["Read"], ask: ["Edit"], deny: ["WebFetch"] };
    expect(
      effectiveEngineSettings({ start: start(same), row: row(same) }),
    ).toEqual({ kind: "rules", permissions: same, autoMode: NO_AUTO });
  });

  test("a grant the agent has since lost narrows the session at once", () => {
    const result = effectiveEngineSettings({
      start: start({ allow: ["Read", "Edit"] }),
      row: row({ allow: ["Read"] }, {}, 2),
    });
    expect(result).toMatchObject({
      permissions: { allow: ["Read"] },
    });
  });

  test("a grant the agent gained since reaches only the next session", () => {
    const result = effectiveEngineSettings({
      start: start({ allow: ["Read"] }),
      row: row({ allow: ["Read", "Edit", "WebSearch"] }, {}, 2),
    });
    expect(result).toMatchObject({ permissions: { allow: ["Read"] } });
    // The next session starts from the row as it is now.
    expect(
      effectiveEngineSettings({
        start: start({ allow: ["Read", "Edit", "WebSearch"] }, {}, 2),
        row: row({ allow: ["Read", "Edit", "WebSearch"] }, {}, 2),
      }),
    ).toMatchObject({
      permissions: { allow: ["Edit", "Read", "WebSearch"] },
    });
  });

  test("a deny or ask is kept after the row drops it, and a new one applies at once", () => {
    const result = effectiveEngineSettings({
      start: start({ deny: ["WebFetch"], ask: ["Edit"] }),
      row: row({ deny: ["WebSearch"] }, {}, 2),
    });
    expect(result).toMatchObject({
      permissions: { deny: ["WebFetch", "WebSearch"], ask: ["Edit"] },
    });
  });

  test("auto mode sentences: the ones that restrict are kept, the ones that relax need both sides", () => {
    const result = effectiveEngineSettings({
      start: start(
        {},
        {
          allow: ["a", "b"],
          environment: ["e1"],
          soft_deny: ["s1"],
          hard_deny: ["h1"],
        },
      ),
      row: row(
        {},
        {
          allow: ["b", "c"],
          environment: ["e2"],
          soft_deny: ["s2"],
          hard_deny: [],
        },
        2,
      ),
    });
    expect(result).toEqual({
      kind: "rules",
      permissions: NONE,
      autoMode: {
        allow: ["b"],
        environment: [],
        soft_deny: ["s1", "s2"],
        hard_deny: ["h1"],
      },
    });
  });

  test("a sentence both sides keep stays, in the lists that relax the classifier", () => {
    expect(
      effectiveEngineSettings({
        start: start({}, { allow: ["a", "keep"], environment: ["e1", "keep"] }),
        row: row({}, { allow: ["keep", "c"], environment: ["keep", "e2"] }, 2),
      }),
    ).toMatchObject({
      autoMode: { allow: ["keep"], environment: ["keep"] },
    });
  });

  test("a snapshot that does not parse closes the session's agent rules, not opens them", () => {
    for (const bad of [
      {},
      "nope",
      { permissions: {}, auto_mode: {}, revision: 0 },
      { permissions: { deny: "Bash" }, auto_mode: {}, revision: 1 },
      { permissions: { other: [] }, auto_mode: {}, revision: 1 },
    ]) {
      expect(
        effectiveEngineSettings({ start: bad, row: row({ deny: ["Bash"] }) }),
      ).toEqual({ kind: "closed", reason: "invalid_start" });
    }
  });

  test("a snapshot whose row is gone or older than it closes the session's agent rules", () => {
    expect(
      effectiveEngineSettings({ start: start({}, {}, 2), row: null }),
    ).toEqual({ kind: "closed", reason: "row_missing" });
    expect(
      effectiveEngineSettings({ start: start({}, {}, 3), row: row({}, {}, 2) }),
    ).toEqual({ kind: "closed", reason: "revision_regressed" });
  });

  test("closed is not neutral: the two results are told apart", () => {
    const neutral = effectiveEngineSettings({ start: null, row: null });
    const closed = effectiveEngineSettings({
      start: { revision: 0 },
      row: null,
    });
    expect(neutral.kind).toBe("rules");
    expect(closed.kind).toBe("closed");
    expect(closed).not.toEqual(neutral);
  });

  test("a later field in the snapshot does not close it", () => {
    expect(
      effectiveEngineSettings({
        start: { ...start({ deny: ["WebFetch"] }), later: true },
        row: row({ deny: ["WebFetch"] }),
      }),
    ).toMatchObject({ kind: "rules", permissions: { deny: ["WebFetch"] } });
  });
});
