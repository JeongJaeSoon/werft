import { describe, expect, test } from "bun:test";
import {
  type AffectedSession,
  assessNothingReplaced,
  assessUpgrade,
  type UpgradeSession,
} from "./upgrade-check.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };
const older = { ...current, cliVersion: "2.1.260", sdkVersion: "0.3.260" };

const on = (
  sessionId: string,
  image: typeof current | null,
): UpgradeSession => ({
  sessionId,
  pointer:
    image === null
      ? { kind: "unrecorded" }
      : { kind: "recorded", runtime: image },
});

type Assessed = Parameters<typeof assessUpgrade>[0];

const n = "worker@sha256:n";
const n1 = "worker@sha256:n1";
const other = "worker@sha256:other";

// The usual release: n1 is new, and n, deployed now, stays as its previous.
const upgrade: Omit<Assessed, "sessions" | "approved"> = {
  deployed: [{ image: n, runtime: previous }],
  target: [
    { image: n1, runtime: current },
    { image: n, runtime: previous },
  ],
  writers: [],
};

describe("assessUpgrade", () => {
  test("sessions on either target image, or with no pointer, need no approval", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        sessions: [
          on("s-current", current),
          on("s-previous", previous),
          { sessionId: "s-fresh", pointer: { kind: "none" } },
        ],
        approved: [],
      }),
    ).toEqual({ verdict: "proceed", affected: [], approved: [] });
  });

  test("a session on neither image, or with an unrecorded pointer, stops the upgrade until approved exactly", () => {
    const sessions = [
      on("s-current", current),
      on("s-unrecorded", null),
      on("s-older", older),
    ];
    const affected: AffectedSession[] = [
      { sessionId: "s-older", reason: "no_image" },
      { sessionId: "s-unrecorded", reason: "unrecorded" },
    ];

    const unapproved = assessUpgrade({ ...upgrade, sessions, approved: [] });
    expect(unapproved.verdict).toBe("refused");
    expect(unapproved.affected).toEqual(affected);
    expect(unapproved.reason).toContain(
      "not approved: s-older s-unrecorded; no longer affected: none",
    );

    const short = assessUpgrade({
      ...upgrade,
      sessions,
      approved: ["s-older"],
    });
    expect(short.verdict).toBe("refused");
    expect(short.reason).toContain("not approved: s-unrecorded");

    const extra = assessUpgrade({
      ...upgrade,
      sessions,
      approved: ["s-older", "s-unrecorded", "s-gone"],
    });
    expect(extra.verdict).toBe("refused");
    expect(extra.reason).toContain("no longer affected: s-gone");

    expect(
      assessUpgrade({
        ...upgrade,
        sessions,
        approved: ["s-unrecorded", "s-older", "s-older"],
      }),
    ).toEqual({
      verdict: "proceed",
      affected,
      approved: ["s-older", "s-unrecorded"],
    });
  });

  test("the same engine build under another profile digest scheme runs on neither image", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        sessions: [on("s-scheme", { ...previous, profileDigestScheme: 2 })],
        approved: [],
      }).affected,
    ).toEqual([{ sessionId: "s-scheme", reason: "no_image" }]);
  });

  test("a target that restores nothing the deployed newest image seals is refused, approved or not, still listing what would break", () => {
    for (const target of [
      [
        { image: n1, runtime: current },
        { image: other, runtime: older },
      ],
      [{ image: n1, runtime: current }],
    ] as Assessed["target"][]) {
      const assessment = assessUpgrade({
        ...upgrade,
        target,
        sessions: [on("s-previous", previous)],
        approved: ["s-previous"],
      });
      expect(assessment.verdict).toBe("refused");
      expect(assessment.reason).toContain(
        `workers on ${n}, the deployed newest image, keep sealing checkpoints`,
      );
      expect(assessment.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);
    }
  });

  test("a rebuild of the deployed image under another digest stands in for it", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        target: [
          { image: n1, runtime: current },
          { image: other, runtime: previous },
        ],
        sessions: [on("s-previous", previous)],
        approved: [],
      }),
    ).toEqual({ verdict: "proceed", affected: [], approved: [] });
  });

  test("a deployed image nothing declared a runtime for counts as kept only under its own digest", () => {
    const undeclared: typeof upgrade = {
      ...upgrade,
      deployed: [{ image: n, runtime: null }],
    };
    expect(
      assessUpgrade({ ...undeclared, sessions: [], approved: [] }).verdict,
    ).toBe("proceed");
    const dropped = assessUpgrade({
      ...undeclared,
      target: [
        { image: n1, runtime: current },
        { image: other, runtime: previous },
      ],
      sessions: [],
      approved: [],
    });
    expect(dropped.verdict).toBe("refused");
    expect(dropped.reason).toContain(`workers on ${n}, the deployed newest`);
  });

  describe("a launch still holding a slot", () => {
    const deployed: Assessed["deployed"] = [
      { image: n, runtime: previous },
      { image: other, runtime: older },
    ];

    test("refuses, approved or not, when its image's checkpoints would lose every image that restores them", () => {
      for (const writer of [
        { image: other, runtime: older },
        { image: other, runtime: null },
      ]) {
        const assessment = assessUpgrade({
          ...upgrade,
          deployed,
          writers: [writer],
          sessions: [on("s-older", older)],
          approved: ["s-older"],
        });
        expect(assessment.verdict).toBe("refused");
        expect(assessment.reason).toContain(
          `workers on ${other} still hold a slot`,
        );
      }
    });

    test("passes when the target still restores what it seals", () => {
      expect(
        assessUpgrade({
          ...upgrade,
          deployed,
          writers: [{ image: "worker@sha256:rebuilt", runtime: previous }],
          sessions: [],
          approved: [],
        }).verdict,
      ).toBe("proceed");
    });

    test("is not this release's to refuse when no deployed image restores it either", () => {
      for (const writer of [
        {
          image: "worker@sha256:ancient",
          runtime: { ...older, cliVersion: "1" },
        },
        { image: "worker@sha256:ancient", runtime: null },
      ]) {
        expect(
          assessUpgrade({
            ...upgrade,
            deployed,
            writers: [writer],
            sessions: [],
            approved: [],
          }).verdict,
        ).toBe("proceed");
      }
    });
  });

  describe("a retracted image restores nothing", () => {
    const fix = "worker@sha256:fix";

    test("retracting the deployed newest image needs a fixed build beside it; waiting does not help", () => {
      for (const target of [
        [{ image: n, runtime: previous, retracted: true }],
        [
          { image: n1, runtime: current },
          { image: n, runtime: previous, retracted: true },
        ],
      ] as Assessed["target"][]) {
        const refused = assessUpgrade({
          ...upgrade,
          target,
          sessions: [on("s-previous", previous)],
          approved: ["s-previous"],
        });
        expect(refused.verdict).toBe("refused");
        expect(refused.reason).toContain(
          `workers on ${n}, the deployed newest image`,
        );
        expect(refused.reason).toContain(
          "keep that image unretracted in the target release, or list beside it one that restores its checkpoints (a fixed build of the same engine, SDK and CLI)",
        );
      }
      expect(
        assessUpgrade({
          ...upgrade,
          target: [
            { image: n1, runtime: current },
            { image: fix, runtime: previous },
            { image: n, runtime: previous, retracted: true },
          ],
          sessions: [on("s-previous", previous)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });

    test("an older image retracted while a launch on it holds a slot names both ways out", () => {
      const deployed: Assessed["deployed"] = [
        { image: n1, runtime: current },
        { image: n, runtime: previous },
      ];
      const target: Assessed["target"] = [
        { image: n1, runtime: current },
        { image: n, runtime: previous, retracted: true },
      ];
      const held = assessUpgrade({
        deployed,
        target,
        writers: [{ image: n, runtime: previous }],
        sessions: [on("s-previous", previous)],
        approved: ["s-previous"],
      });
      expect(held.verdict).toBe("refused");
      expect(held.reason).toContain(
        `workers on ${n} still hold a slot and keep sealing checkpoints no unretracted target image restores`,
      );
      expect(held.reason).toContain(
        "list an unretracted image that restores them in the target release (the image itself, or a fixed build of the same engine, SDK and CLI), or run the upgrade once no launch on it holds a slot",
      );
      // Once its slots are free, what it sealed is approved like a dropped image.
      const drained = { deployed, target, writers: [] };
      expect(
        assessUpgrade({
          ...drained,
          sessions: [on("s-previous", previous)],
          approved: [],
        }).affected,
      ).toEqual([{ sessionId: "s-previous", reason: "no_image" }]);
      expect(
        assessUpgrade({
          ...drained,
          sessions: [on("s-previous", previous)],
          approved: ["s-previous"],
        }).verdict,
      ).toBe("proceed");
    });

    test("a fully retracted list kept as it is changes nothing", () => {
      const images: Assessed["target"] = [
        { image: n, runtime: previous, retracted: true },
      ];
      expect(
        assessUpgrade({
          deployed: images,
          target: images,
          writers: [],
          sessions: [on("s-previous", previous)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });

    test("the flag alone is a change, both ways", () => {
      const retract = assessUpgrade({
        deployed: [
          { image: n1, runtime: current },
          { image: n, runtime: previous },
        ],
        target: [
          { image: n1, runtime: current },
          { image: n, runtime: previous, retracted: true },
        ],
        writers: [],
        sessions: [on("s-previous", previous)],
        approved: [],
      });
      expect(retract.verdict).toBe("refused");
      expect(retract.reason).toContain(`retracted: ${n};`);
      // Lifting a retraction moves sessions back onto the image: compared, and
      // here nothing is stranded.
      expect(
        assessUpgrade({
          deployed: [
            { image: n1, runtime: current },
            { image: n, runtime: previous, retracted: true },
          ],
          target: [
            { image: n1, runtime: current },
            { image: n, runtime: previous },
          ],
          writers: [],
          sessions: [on("s-previous", previous), on("s-unrecorded", null)],
          approved: ["s-unrecorded"],
        }),
      ).toEqual({
        verdict: "proceed",
        affected: [{ sessionId: "s-unrecorded", reason: "unrecorded" }],
        approved: ["s-unrecorded"],
      });
    });

    test("with every deployed image retracted, no new session seals anything until the target", () => {
      expect(
        assessUpgrade({
          deployed: [{ image: n, runtime: previous, retracted: true }],
          target: [{ image: fix, runtime: previous }],
          writers: [],
          sessions: [on("s-previous", previous)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });
  });

  test("unchanged worker images go ahead without looking at sessions or launches", () => {
    for (const target of [
      [{ image: n, runtime: previous }],
      // An older image added beside the newest moves no session off it.
      [
        { image: n, runtime: previous },
        { image: other, runtime: older },
      ],
    ] as Assessed["target"][]) {
      expect(
        assessUpgrade({
          ...upgrade,
          target,
          writers: [{ image: "worker@sha256:ancient", runtime: null }],
          sessions: [on("s-older", older), on("s-unrecorded", null)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    }
  });

  describe("the newest image stays and the deployed previous image goes", () => {
    const kept: Omit<Assessed, "sessions" | "approved"> = {
      deployed: [
        { image: n1, runtime: current },
        { image: n, runtime: previous },
      ],
      target: [{ image: n1, runtime: current }],
      writers: [],
    };

    test("lists a session sealed on the dropped image and refuses until it is approved", () => {
      const sessions = [on("s-previous", previous), on("s-current", current)];
      const refused = assessUpgrade({ ...kept, sessions, approved: [] });
      expect(refused.verdict).toBe("refused");
      expect(refused.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);
      expect(refused.reason).toContain(
        `dropped, redeclared or retracted: ${n};`,
      );

      expect(
        assessUpgrade({ ...kept, sessions, approved: ["s-previous"] }).verdict,
      ).toBe("proceed");
    });

    test("a live launch on the dropped image refuses, approved or not", () => {
      for (const runtime of [previous, null]) {
        const assessment = assessUpgrade({
          ...kept,
          writers: [{ image: n, runtime }],
          sessions: [on("s-previous", previous)],
          approved: ["s-previous"],
        });
        expect(assessment.verdict).toBe("refused");
        expect(assessment.reason).toContain(
          `workers on ${n} still hold a slot`,
        );
      }
    });

    test("a replaced previous image refuses sessions its runtime does not cover, and keeps those it does", () => {
      const sessions = [on("s-previous", previous)];
      const incompatible = assessUpgrade({
        ...kept,
        target: [
          { image: n1, runtime: current },
          { image: other, runtime: older },
        ],
        sessions,
        approved: [],
      });
      expect(incompatible.verdict).toBe("refused");
      expect(incompatible.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);
      expect(
        assessUpgrade({
          ...kept,
          target: [
            { image: n1, runtime: current },
            { image: other, runtime: previous },
          ],
          sessions,
          approved: [],
        }).verdict,
      ).toBe("proceed");
    });

    test("the same digest declared under another runtime is compared like a dropped one", () => {
      const assessment = assessUpgrade({
        ...kept,
        target: [
          { image: n1, runtime: current },
          { image: n, runtime: older },
        ],
        sessions: [on("s-previous", previous)],
        approved: [],
      });
      expect(assessment.verdict).toBe("refused");
      expect(assessment.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);
      expect(assessment.reason).toContain(
        `dropped, redeclared or retracted: ${n};`,
      );
      // Restorable schemes are what image choice reads too.
      const widened = assessUpgrade({
        ...kept,
        target: [
          { image: n1, runtime: current },
          { image: n, runtime: { ...previous, restorableSchemes: [1, 2] } },
        ],
        sessions: [on("s-unrecorded", null)],
        approved: [],
      });
      expect(widened.verdict).toBe("refused");
      expect(widened.reason).toContain(
        `dropped, redeclared or retracted: ${n};`,
      );
    });

    test("restorable schemes listed in another order are the same declaration", () => {
      const schemes = (restorableSchemes: number[]) => ({
        ...previous,
        profileDigestScheme: 2,
        restorableSchemes,
      });
      expect(
        assessUpgrade({
          deployed: [{ image: n, runtime: schemes([1, 2]) }],
          target: [{ image: n, runtime: schemes([2, 1]) }],
          writers: [],
          sessions: [on("s-unrecorded", null)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });

    test("a session with no recorded combination is listed too, as for a replaced image", () => {
      const assessment = assessUpgrade({
        ...kept,
        sessions: [on("s-unrecorded", null)],
        approved: [],
      });
      expect(assessment.verdict).toBe("refused");
      expect(assessment.affected).toEqual([
        { sessionId: "s-unrecorded", reason: "unrecorded" },
      ]);
    });

    test("proceeds when no session was sealed on it", () => {
      expect(
        assessUpgrade({
          ...kept,
          sessions: [on("s-current", current)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });

    test("a previous image that is kept, or that the deployed release never had, compares nothing", () => {
      for (const overrides of [
        {
          target: [
            { image: n1, runtime: current },
            { image: n, runtime: previous },
          ],
        },
        { deployed: [{ image: n1, runtime: current }] },
      ] as Partial<Assessed>[]) {
        expect(
          assessUpgrade({
            ...kept,
            ...overrides,
            sessions: [on("s-older", older)],
            approved: [],
          }),
        ).toEqual({ verdict: "proceed", affected: [], approved: [] });
      }
    });
  });

  test("a stale approval left in the values is refused even when nothing is affected", () => {
    const changed = assessUpgrade({
      ...upgrade,
      sessions: [on("s-current", current)],
      approved: ["s-gone"],
    });
    expect(changed.verdict).toBe("refused");
    expect(changed.reason).toContain("no longer affected: s-gone");

    const unchanged = assessUpgrade({
      ...upgrade,
      target: [{ image: n, runtime: previous }],
      sessions: [],
      approved: ["s-gone"],
    });
    expect(unchanged.verdict).toBe("refused");
    expect(unchanged.reason).toContain("must be empty");
  });
});

describe("assessNothingReplaced", () => {
  test("proceeds with no approvals, saying nothing about any session", () => {
    expect(assessNothingReplaced([], "nothing was deployed")).toEqual({
      verdict: "proceed",
      affected: [],
      approved: [],
    });
  });

  test("refuses a stale approval and says why it does not apply", () => {
    const stale = assessNothingReplaced(
      ["s-2", "s-1", "s-1"],
      "nothing was deployed",
    );
    expect(stale.verdict).toBe("refused");
    expect(stale.approved).toEqual(["s-1", "s-2"]);
    expect(stale.reason).toStartWith("nothing was deployed, so");
    expect(stale.reason).toContain("no longer affected: s-1 s-2");
  });
});
