import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedRequest } from "@werft-ai/testkit/fake-anthropic";
import { bunTestRows, CAMPAIGNS } from "../../scripts/soak/campaigns.ts";
import { distribution, percentile } from "../../scripts/soak/lib.ts";
import {
  createMessages,
  specIds,
  validFaults,
} from "../../scripts/soak/messages.ts";
import {
  Api,
  type ControlSample,
  modelEvidence,
  turnPrompt,
} from "../../scripts/soak/probes.ts";
import {
  curlLoop,
  HOST_PROBE,
  type HostProbeSample,
  INTERRUPT_EXCLUSION,
  judgeInterrupts,
  judgeReadyz,
  READYZ_EXCLUSION,
  type ReadyzSample,
  readEngineStops,
  summarizeHostProbe,
  type TurnRecord,
  type VmStall,
  validConfig,
} from "../../scripts/soak/soak.ts";
import { StallRecorder } from "../../scripts/soak/vm-lag.ts";

const CONFIG_DIR = join(import.meta.dir, "../../scripts/soak/config");

function request(messages: unknown[]): RecordedRequest {
  return {
    body: { messages, tools: [{ name: "Write" }] },
    headers: {},
    path: "/v1/messages",
    signal: new AbortController().signal,
  };
}

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("soak tooling", () => {
  test("percentiles are nearest-rank over the samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
    expect(distribution([3, 1, 2])).toEqual({
      n: 3,
      min: 1,
      p50: 2,
      p95: 3,
      p99: 3,
      max: 3,
    });
  });

  test("every committed config is valid and fixes its measurements", async () => {
    const files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual([
      "interrupt-3h.json",
      "preflight-1h.json",
      "soak-24h.json",
    ]);
    for (const file of files) {
      const config = validConfig(await Bun.file(join(CONFIG_DIR, file)).json());
      expect(config.sessions).toBe(10);
      expect(config.targets).toMatchObject({
        acceptP95Ms: 500,
        interruptEffectMs: 5000,
        interruptTerminalMs: 50000,
        terminateEffectMs: 30000,
      });
      for (const key of [
        "acceptance",
        "interrupt",
        "terminate",
        "startup",
        "environment",
      ]) {
        expect(config.measurement[key]).toBeDefined();
      }
    }
    const soak = validConfig(
      await Bun.file(join(CONFIG_DIR, "soak-24h.json")).json(),
    );
    expect(soak.durationMin).toBe(24 * 60);
    // P-3 on at least 500 interrupts over at least 3 hours (rc.sh checks the count).
    const interrupts = validConfig(
      await Bun.file(join(CONFIG_DIR, "interrupt-3h.json")).json(),
    );
    expect(
      interrupts.durationMin - interrupts.warmupMin,
    ).toBeGreaterThanOrEqual(180);
    expect(interrupts).toMatchObject({
      ...soak,
      name: "interrupt-3h",
      purpose: interrupts.purpose,
      durationMin: interrupts.durationMin,
      probes: { ...soak.probes, interruptEveryTurns: 8 },
      measurement: interrupts.measurement,
    });
  });

  test("a config the run could not judge is refused before it starts", async () => {
    const good = await Bun.file(join(CONFIG_DIR, "preflight-1h.json")).json();
    expect(() => validConfig({ ...good, ramp: [1, 5] })).toThrow(/ramp/);
    expect(() =>
      validConfig({ ...good, probes: { ...good.probes, slowStepMs: 3000 } }),
    ).toThrow(/slowStepMs/);
    expect(() =>
      validConfig({
        ...good,
        messagesFaults: { ...good.messagesFaults, errorRate: 2 },
      }),
    ).toThrow(/errorRate/);
  });

  test("the spec ids a conversation carries are read in order, once each", () => {
    const first = turnPrompt({
      id: "s0g1t1",
      kind: "normal",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 1,
    });
    const second = turnPrompt({
      id: "s0g1t2",
      kind: "interrupt",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 2,
    });
    expect(specIds([user(first), user(first), user(second)])).toEqual([
      "s0g1t1",
      "s0g1t2",
    ]);
  });

  test("the Messages API injects the configured faults and still plays the spec", async () => {
    const failing = createMessages({ random: () => 0 });
    failing.setFaults({
      latencyMs: [0, 0],
      errorRate: 1,
      errorStatuses: [529],
    });
    const prompt = turnPrompt({
      id: "t",
      kind: "normal",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 0,
    });
    const refused = await failing.reply(request([user(prompt)]));
    expect(refused instanceof Response && refused.status).toBe(529);
    expect(failing.requests({})[0]).toMatchObject({
      fault: 529,
      specId: "t",
      step: 0,
    });

    const answering = createMessages({ random: () => 0.99 });
    answering.setFaults({
      latencyMs: [0, 0],
      errorRate: 0.5,
      errorStatuses: [500],
    });
    const reply = await answering.reply(request([user(prompt)]));
    expect(reply).toMatchObject({ stopReason: "tool_use" });
    expect(() => validFaults({ latencyMs: [5, 1] })).toThrow(/latencyMs/);
  });

  test("model evidence names a lost context and a turn started twice", () => {
    const entry = (step: number, specs: string[], fault: number | null) => ({
      at: new Date().toISOString(),
      fault,
      hasTools: true,
      index: 0,
      latencyMs: 0,
      specs,
      specId: specs.at(-1) ?? null,
      step,
    });
    expect(modelEvidence([entry(0, ["a", "b"], null)], "a")).toMatchObject({
      contextKept: true,
      startsAnswered: 1,
    });
    expect(
      modelEvidence(
        [entry(0, ["b"], 500), entry(0, ["b"], null), entry(0, ["b"], null)],
        "a",
      ),
    ).toEqual({ contextKept: false, startsAnswered: 2, faults: 1 });
  });

  test("campaign ids are unique and each has exactly one way to run", () => {
    const ids = CAMPAIGNS.map((campaign) => campaign.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const campaign of CAMPAIGNS) {
      expect(Boolean(campaign.run) !== Boolean(campaign.standalone)).toBe(true);
    }
    expect(
      CAMPAIGNS.filter((campaign) => campaign.standalone).map(
        (campaign) => campaign.id,
      ),
    ).toEqual(["fault-backup-restore-resume"]);
  });

  test("a bun test report passes only cases that ran and asserted", () => {
    const junit = join(mkdtempSync(join(tmpdir(), "soak-junit-")), "r.xml");
    const report = (cases: string) => {
      writeFileSync(
        junit,
        `<testsuites><testsuite>${cases}</testsuite></testsuites>`,
      );
      return bunTestRows("c", "input", junit, 0, 2).map((row) => [
        row.id,
        row.status,
      ]);
    };
    expect(
      report(
        '<testcase name="H1: a &amp; b" line="1" assertions="3" />' +
          '<testcase name="H2: b" line="2" assertions="1">\n<failure type="x" />\n</testcase>' +
          '<testcase name="H3: c" line="3" assertions="0">\n<skipped />\n</testcase>' +
          '<testcase name="H4: d" line="4" assertions="0" />',
      ),
    ).toEqual([
      ["c/H1", "pass"],
      ["c/H2", "fail"],
      ["c/H3", "fail"],
      ["c/H4", "fail"],
    ]);
    // Fewer cases than required, or none at all, fails the run.
    expect(report('<testcase name="H1" line="1" assertions="1" />')).toEqual([
      ["c/H1", "pass"],
      ["c/exit", "fail"],
    ]);
    expect(
      bunTestRows("c", "input", join(tmpdir(), "no-such.xml"), 1, 1).map(
        (row) => row.status,
      ),
    ).toEqual(["fail"]);
  });
});

describe("O-1 readyz exclusions", () => {
  const T0 = Date.parse("2026-09-25T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const ok = (i: number): ReadyzSample => ({
    t: at(i * 5000),
    error: null,
    ms: 3,
    ok: true,
    status: 200,
    wallMs: 20,
  });
  const timeout = (i: number): ReadyzSample => ({
    t: at(i * 5000),
    error: "curl exit 28",
    ms: 2000,
    ok: false,
    status: 0,
    wallMs: 2010,
  });
  // 200 samples: one exclusion is 0.5%, three are 1.5%.
  const samples = (replace: Record<number, ReadyzSample>) =>
    Array.from({ length: 200 }, (_, i) => replace[i] ?? ok(i));
  const stall = (from: number, gapMs: number, offsetMs = 0): VmStall => ({
    index: 0,
    bootId: "b",
    from: T0 + from,
    to: T0 + from + gapMs,
    gapMs,
    offsetMs,
    offsetErrorMs: 5,
  });
  const judge = (list: ReadyzSample[], stalls: VmStall[] = []) =>
    judgeReadyz(list, stalls, 1);

  test("the probe records a gap between ticks as a stall, from tick to tick", () => {
    const recorder = new StallRecorder(500);
    for (const mono of [0, 100, 200, 1500, 1600, 2300]) {
      recorder.tick(mono, 10_000 + mono);
    }
    expect(recorder.stalls).toEqual([
      { index: 0, from: 10_200, to: 11_500, gapMs: 1300 },
      { index: 1, from: 11_600, to: 12_300, gapMs: 700 },
    ]);
    expect(recorder.since(1)).toEqual([recorder.stalls[1]]);
  });

  test("a timeout a VM stall of 1s or more overlapped is excluded; O-1 passes on the rest", () => {
    // Sample 10 is sent at 50s; the VM stood still from 49.2s to 52.6s.
    const result = judge(samples({ 10: timeout(10) }), [stall(49_200, 3400)]);
    expect(result).toMatchObject({
      pass: true,
      availability: 1,
      judged: 199,
      hostExcluded: 1,
      hostExcludedRatio: 0.005,
      productFailures: [],
    });
    expect(result.stalls).toMatchObject({ count: 1, maxGapMs: 3400 });
  });

  test("the probe's clock offset places the stall on the host clock", () => {
    // In the VM's clock the stall is a minute early; the poll measured that.
    expect(
      judge(samples({ 10: timeout(10) }), [stall(-10_800, 3400, 60_000)]),
    ).toMatchObject({ pass: true, hostExcluded: 1 });
    expect(
      judge(samples({ 10: timeout(10) }), [stall(49_200, 3400, 60_000)]),
    ).toMatchObject({ pass: false, hostExcluded: 0 });
  });

  test("a failure no long stall overlapped stays a product failure", () => {
    for (const stalls of [
      [],
      // Over before the request was sent.
      [stall(47_000, 2900)],
      // Overlapping, but shorter than a stall O-1 excuses.
      [stall(50_500, READYZ_EXCLUSION.stallMinMs - 1)],
    ]) {
      const result = judge(samples({ 10: timeout(10) }), stalls);
      expect(result).toMatchObject({ pass: false, hostExcluded: 0 });
      expect(result.productFailures).toEqual([
        { t: at(50_000), error: "curl exit 28", status: 0 },
      ]);
    }
  });

  test("an answer that was not 200 is the product's even inside a stall", () => {
    const refused = { ...ok(10), ok: false, status: 503 };
    // Headers of a 503, then the body timed out.
    const refusedSlowly = { ...timeout(10), status: 503 };
    for (const sample of [refused, refusedSlowly]) {
      expect(
        judge(samples({ 10: sample }), [stall(49_200, 3400)]),
      ).toMatchObject({
        pass: false,
        hostExcluded: 0,
        availability: 199 / 200,
      });
    }
  });

  test("a runner slow to see curl end leaves only what curl surely ran", () => {
    // curl ran 2s and the runner saw it end at 3.6s: curl may have started
    // as late as 1.6s, however soon its spawn returned.
    const slowRunner = { ...timeout(10), wallMs: 3600, spawnMs: 5 };
    expect(
      judge(samples({ 10: slowRunner }), [stall(50_100, 1200)]),
    ).toMatchObject({ pass: false, hostExcluded: 0 });
    expect(
      judge(samples({ 10: slowRunner }), [stall(51_000, 1200)]),
    ).toMatchObject({ pass: true, hostExcluded: 1 });
  });

  test("only a stall surely inside the request excuses it", () => {
    // curl gave up after 2s, the runner noticed at 3.6s; a stall from 2.2s
    // came after the request.
    const late = { ...timeout(10), wallMs: 3600 };
    expect(judge(samples({ 10: late }), [stall(52_200, 3000)])).toMatchObject({
      pass: false,
      hostExcluded: 0,
    });
    // Ended 150ms before the request on the probe's clock, placed within
    // ±350ms: it may not have overlapped at all.
    const loose = { ...stall(46_850, 3000), offsetErrorMs: 350 };
    expect(judge(samples({ 10: timeout(10) }), [loose])).toMatchObject({
      pass: false,
      hostExcluded: 0,
    });
  });

  test("host exclusions past 1% of the samples fail O-1", () => {
    const list = samples({
      10: timeout(10),
      70: timeout(70),
      130: timeout(130),
    });
    const stalls = [10, 70, 130].map((i) => stall(i * 5000 - 800, 3000));
    expect(judge(list, stalls)).toMatchObject({
      pass: false,
      availability: 1,
      hostExcluded: 3,
      hostExcludedRatio: 0.015,
    });
    // Exactly 1% is still within the cap.
    const onePercent = samples({ 10: timeout(10) }).slice(0, 100);
    expect(judge(onePercent, stalls.slice(0, 1))).toMatchObject({
      pass: true,
      hostExcludedRatio: 0.01,
    });
  });

  test("a slot the runner missed is counted apart, and too many void the measurement", () => {
    const missed = (i: number): ReadyzSample => ({
      ...ok(i),
      error: "slot missed: the runner did not get to it",
      ok: false,
      status: 0,
      ms: 0,
      wallMs: 0,
    });
    expect(judge(samples({ 10: missed(10) }))).toMatchObject({
      pass: true,
      availability: 1,
      judged: 199,
      runnerMissed: 1,
      hostExcluded: 0,
      productFailures: [],
    });
    expect(
      judge(samples({ 10: missed(10), 70: missed(70), 130: missed(130) })),
    ).toMatchObject({ pass: false, availability: 1, runnerMissedRatio: 0.015 });
  });
});

describe("P-3 host exclusions", () => {
  const T0 = Date.parse("2026-09-25T13:00:00.000Z");
  const targets = { interruptEffectMs: 5000, interruptTerminalMs: 50_000 };
  const sentAt = (i: number) => T0 + i * 60_000;
  // RC4 13:52: accepted after 3.6s, engine_stopped at 7.6s, settled at 18s.
  const interrupt = (i: number, effectMs = 1500): ControlSample => ({
    op: "interrupt",
    sessionId: `session-${i}`,
    turnId: "8",
    acceptStatus: 202,
    acceptedMs: 50,
    effectMs,
    effect: "interrupted",
    receiptId: `receipt-${i}`,
    receiptMs: 18_058,
    receiptStatus: "succeeded",
    extra: {
      sentAt: new Date(sentAt(i)).toISOString(),
      terminalMs: 18_055,
      continuedAfterInterrupt: 0,
      receiptResult: { no_op: false },
      valid: true,
    },
  });
  const samples = (count: number, replace: Record<number, ControlSample>) =>
    Array.from({ length: count }, (_, i) => replace[i] ?? interrupt(i));
  const turnsOf = (list: ControlSample[]): TurnRecord[] =>
    list.flatMap((sample, i) => [
      {
        sessionId: sample.sessionId,
        turnId: "8",
        sentAt: sentAt(i) - 3000,
        acceptStatus: 202,
        status: "interrupted",
        contextKept: true,
      },
      {
        sessionId: sample.sessionId,
        turnId: "9",
        sentAt: sentAt(i) + 40_000,
        kind: "normal",
        acceptStatus: 202,
        status: "completed",
        contextKept: true,
      },
    ]) as TurnRecord[];
  // A stall that ended `endedBeforeMs` before interrupt i was sent.
  const stallBefore = (i: number, endedBeforeMs: number, gapMs = 1600) => ({
    index: 0,
    bootId: "b",
    from: sentAt(i) - endedBeforeMs - gapMs,
    to: sentAt(i) - endedBeforeMs,
    gapMs,
    offsetMs: 0,
    offsetErrorMs: 5,
  });
  const judge = (
    list: ControlSample[],
    stalls: VmStall[],
    turns = turnsOf(list),
  ) => judgeInterrupts(list, turns, stalls, targets);

  test("a late interrupt within 20s after a stall is excluded; P-3 passes on the rest", () => {
    const list = samples(200, { 10: interrupt(10, 7637) });
    const result = judge(list, [stallBefore(10, 16_000)]);
    expect(result).toMatchObject({
      pass: true,
      samples: 200,
      judged: 199,
      hostExcluded: 1,
      hostExcludedRatio: 0.005,
      late: [],
    });
    expect(result.hostExcludedSamples).toEqual([
      {
        sessionId: "session-10",
        turnId: "8",
        sentAt: new Date(sentAt(10)).toISOString(),
        effectMs: 7637,
        sseEffectMs: 7637,
        terminalMs: 18_055,
        stall: new Date(sentAt(10) - 17_600).toISOString().concat(" +1600ms"),
        nextTurn: "9 completed",
        broken: [],
      },
    ]);
    // An interrupt on time inside the window is judged, not excluded.
    expect(judge(samples(200, {}), [stallBefore(10, 16_000)])).toMatchObject({
      pass: true,
      hostExcluded: 0,
      judged: 200,
    });
  });

  test("a late interrupt outside every window stays a P-3 failure", () => {
    for (const stalls of [
      [],
      // Its 20s tail, narrowed by the clock error, ended before the POST.
      [stallBefore(10, INTERRUPT_EXCLUSION.afterStallMs - 5)],
      // Began after engine_stopped was read.
      [stallBefore(10, -10_000)],
      // Shorter than a stall anything is excused for.
      [stallBefore(10, 1000, READYZ_EXCLUSION.stallMinMs - 1)],
    ]) {
      expect(
        judge(samples(200, { 10: interrupt(10, 7637) }), stalls),
      ).toMatchObject({
        pass: false,
        hostExcluded: 0,
        late: [{ sessionId: "session-10", turnId: "8", effectMs: 7637 }],
      });
    }
    // A sample from before the probe recorded when its POST went out.
    const unplaced = interrupt(10, 7637);
    unplaced.extra = { ...unplaced.extra, sentAt: undefined };
    expect(
      judge(samples(200, { 10: unplaced }), [stallBefore(10, 16_000)]),
    ).toMatchObject({ pass: false, hostExcluded: 0 });
  });

  test("an excluded interrupt still has to settle, be receipted and let its session go on", () => {
    const stalls = [stallBefore(10, 16_000)];
    const settledLate = interrupt(10, 7637);
    settledLate.extra = { ...settledLate.extra, terminalMs: 50_001 };
    const unreceipted = { ...interrupt(10, 7637), receiptStatus: null };
    const cases: Array<[ControlSample, string, TurnRecord[]?]> = [
      [settledLate, "terminal late"],
      [unreceipted, "receipt null"],
      [{ ...interrupt(10, 7637), effect: "failed" }, "effect failed"],
    ];
    const list = samples(200, { 10: interrupt(10, 7637) });
    const stuck = turnsOf(list).map((turn) =>
      turn.sessionId === "session-10" && turn.turnId === "9"
        ? { ...turn, status: "timeout" }
        : turn,
    );
    cases.push([interrupt(10, 7637), "next turn not completed", stuck]);
    // Completed, but nothing showed it kept the session's context.
    const unchecked = turnsOf(list).map((turn) =>
      turn.sessionId === "session-10" && turn.turnId === "9"
        ? { ...turn, contextKept: null }
        : turn,
    );
    cases.push([interrupt(10, 7637), "next turn not completed", unchecked]);
    const ended = turnsOf(list).filter(
      (turn) => !(turn.sessionId === "session-10" && turn.turnId === "9"),
    );
    cases.push([interrupt(10, 7637), "next turn not completed", ended]);
    for (const [sample, reason, turns] of cases) {
      const result = judge(samples(200, { 10: sample }), stalls, turns);
      expect(result.pass).toBe(false);
      expect(result.hostExcludedSamples[0]?.broken).toContain(reason);
    }
  });

  test("host exclusions past 1% of the interrupts fail P-3", () => {
    const late = { 10: interrupt(10, 7637), 70: interrupt(70, 6000) };
    const list = samples(200, { ...late, 130: interrupt(130, 5100) });
    const stalls = [10, 70, 130].map((i) => stallBefore(i, 10_000));
    expect(judge(list, stalls)).toMatchObject({
      pass: false,
      hostExcluded: 3,
      hostExcludedRatio: 0.015,
      late: [],
    });
    // Exactly 1% is still within the cap.
    expect(
      judge(samples(100, { 10: interrupt(10, 7637) }), stalls.slice(0, 1)),
    ).toMatchObject({ pass: true, hostExcluded: 1, hostExcludedRatio: 0.01 });
  });
});
describe("host probe and the P-3 split", () => {
  const T0 = Date.parse("2026-09-26T07:00:00.000Z");
  const iso = (ms: number) => new Date(T0 + ms).toISOString();
  // A host probe request to `target`, sent `at` after T0, that took `ms` in curl.
  const host = (
    target: string,
    at: number,
    ms: number,
    extra: Partial<ReadyzSample> = {},
  ): HostProbeSample => ({
    target,
    t: iso(at),
    error: null,
    ms,
    ok: true,
    status: 200,
    wallMs: ms + 5,
    spawnMs: 2,
    ...extra,
  });
  // The shared port forward held both targets over the same stretch.
  const heldBoth = (at: number, ms: number): HostProbeSample[] => [
    host("vm-lag", at, ms),
    host("host-echo", at + 200, ms),
  ];
  const hostTimeout = { ok: false, error: "curl exit 28", status: 0 };

  test("the probe lists near misses from 500ms and counts a stall only where both targets were held", () => {
    expect(HOST_PROBE.intervalMs).toBeLessThanOrEqual(1000);
    expect(HOST_PROBE.nearMissMs).toBe(500);
    const summary = summarizeHostProbe([
      host("vm-lag", 0, 3),
      host("host-echo", 0, 4),
      host("vm-lag", 500, 600),
      ...heldBoth(1000, 1800),
      // Only one target held: that container, not the path.
      host("vm-lag", 10_000, 2000, hostTimeout),
      host("host-echo", 20_000, 0, {
        ok: false,
        error: "curl exit 7",
        status: 0,
      }),
    ]);
    expect(summary).toMatchObject({
      samples: 7,
      targets: {
        "vm-lag": { samples: 4, ok: 3, timeouts: 1, otherFailures: 0, held: 2 },
        "host-echo": {
          samples: 3,
          ok: 2,
          timeouts: 0,
          otherFailures: 1,
          held: 1,
        },
      },
      stalls: { count: 1 },
    });
    // vm-lag surely held 1105–2700, host-echo 1305–2900.
    expect(summary.stalls.list).toEqual([`host ${iso(1305)} +1395ms`]);
    expect(summary.nearMisses.map((entry) => entry.t)).toEqual(
      [500, 1000, 1200, 10_000, 20_000].map(iso),
    );
  });

  test("slots do not wait on a held request", async () => {
    let first = true;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        if (first) {
          first = false;
          await Bun.sleep(1200);
        }
        return new Response("ok");
      },
    });
    try {
      const clock = { stopping: false };
      const samples: ReadyzSample[] = [];
      const loop = curlLoop(
        clock,
        `http://127.0.0.1:${server.port}/healthz`,
        200,
        3000,
        (sample) => samples.push(sample),
      );
      await Bun.sleep(1000);
      clock.stopping = true;
      await loop;
      const held = samples.find((sample) => sample.ms >= 1000);
      expect(held?.ok).toBe(true);
      // Slots kept going out while the first request was held.
      const during = samples.filter(
        (sample) =>
          held !== undefined &&
          Date.parse(sample.t) > Date.parse(held.t) + 150 &&
          Date.parse(sample.t) < Date.parse(held.t) + 1000,
      );
      expect(
        during.filter((sample) => sample.ok && sample.ms < 1000).length,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      server.stop(true);
    }
  });

  describe("O-1", () => {
    // RC4 06:05:52Z: readyz timed out at 2s, the VM probe ticked on.
    const timedOut: ReadyzSample = {
      t: iso(50_000),
      error: "curl exit 28",
      ms: 2000,
      ok: false,
      status: 0,
      wallMs: 2010,
    };
    const readyz = Array.from({ length: 200 }, (_, i) =>
      i === 10
        ? timedOut
        : {
            t: iso(i * 5000),
            error: null,
            ms: 3,
            ok: true,
            status: 200,
            wallMs: 20,
          },
    );
    const judge = (probe: HostProbeSample[]) =>
      judgeReadyz(readyz, [], 1, probe);

    test("a timeout both host targets saw held is excluded though the VM ticked on", () => {
      for (const probe of [
        heldBoth(50_300, 1500),
        [
          host("vm-lag", 50_300, 2000, hostTimeout),
          host("host-echo", 50_400, 2000, hostTimeout),
        ],
      ]) {
        const result = judge([host("vm-lag", 49_500, 3), ...probe]);
        expect(result).toMatchObject({
          pass: true,
          hostExcluded: 1,
          productFailures: [],
        });
        expect(result.hostExcludedSamples[0]?.stall).toStartWith("host ");
      }
    });

    test("only both targets held for 1s, surely inside the request, excuse it", () => {
      for (const probe of [
        [],
        // One target alone.
        [host("vm-lag", 50_300, 1800)],
        [host("host-echo", 50_300, 1800)],
        // Held at different times.
        [host("vm-lag", 50_000, 1200), host("host-echo", 51_000, 1000)],
        // Held together, but for 945ms: less than a stall.
        [host("vm-lag", 50_000, 1300), host("host-echo", 50_150, 1300)],
        [
          host("vm-lag", 50_300, READYZ_EXCLUSION.stallMinMs - 1),
          host("host-echo", 50_300, 1800),
        ],
        // Refused or answered by something other than 200: not the path.
        [
          host("vm-lag", 50_300, 1800, {
            ok: false,
            error: "curl exit 7",
            status: 0,
          }),
          host("host-echo", 50_300, 1800),
        ],
        [
          host("vm-lag", 50_300, 1800, { ok: false, status: 503 }),
          host("host-echo", 50_300, 1800),
        ],
        // Sent 50ms before readyz gave up: less the slack, it ran after.
        heldBoth(51_950, 1500),
      ]) {
        expect(judge(probe)).toMatchObject({
          pass: false,
          hostExcluded: 0,
          productFailures: [{ t: timedOut.t }],
        });
      }
    });

    test("a target held by back-to-back requests counts as one hold", () => {
      // Each vm-lag request overlaps host-echo's for 895ms; together 1495ms.
      const probe = [
        host("vm-lag", 50_000, 1100),
        host("vm-lag", 50_600, 1100),
        host("host-echo", 50_000, 1900),
      ];
      expect(judge(probe)).toMatchObject({ pass: true, hostExcluded: 1 });
      expect(judge(probe.slice(1))).toMatchObject({ hostExcluded: 0 });
      expect(summarizeHostProbe(probe).stalls.list).toEqual([
        `host ${iso(50_105)} +1495ms`,
      ]);
    });

    test("curl may start after its spawn returned: only its last `ms` before the runner saw it end count", () => {
      // curl said 1.8s, the runner saw it end 3s after sending: it surely
      // ran only from 1.2s to 1.8s, after this readyz request ended at 1.2s.
      const early: ReadyzSample = { ...timedOut, ms: 1200, wallMs: 1210 };
      const late = [
        host("vm-lag", 50_000, 1800, { wallMs: 3000 }),
        host("host-echo", 50_000, 1800, { wallMs: 3000 }),
      ];
      expect(
        judgeReadyz(
          readyz.map((sample, i) => (i === 10 ? early : sample)),
          [],
          1,
          late,
        ),
      ).toMatchObject({ pass: false, hostExcluded: 0 });
    });
  });

  describe("P-3", () => {
    const targets = { interruptEffectMs: 5000, interruptTerminalMs: 50_000 };
    const sentAt = (i: number) => T0 + i * 60_000;
    // Container 1ms behind, read over 2ms before the POST and after the read.
    const steady = {
      clockOffsetMs: 1,
      clockRttMs: 2,
      clockAfterOffsetMs: 1,
      clockAfterRttMs: 2,
    };
    const interrupt = (
      i: number,
      sseMs: number | null = 1500,
      clock: Record<string, unknown> = steady,
    ): ControlSample => ({
      op: "interrupt",
      sessionId: `session-${i}`,
      turnId: "456",
      acceptStatus: 202,
      acceptedMs: 12,
      effectMs: sseMs,
      effect: "interrupted",
      receiptId: `receipt-${i}`,
      receiptMs: 6416,
      receiptStatus: "succeeded",
      extra: {
        sentAt: new Date(sentAt(i)).toISOString(),
        ...clock,
        terminalMs: 6415,
        continuedAfterInterrupt: 0,
        receiptResult: { no_op: false },
        valid: true,
      },
    });
    // engine_stopped logged at `afterMs` past the POST on the container's clock.
    const stop = (i: number, afterMs: number, sessionId = `session-${i}`) => ({
      sessionId,
      turnId: "456",
      at: sentAt(i) + afterMs,
    });
    const samples = (replace: Record<number, ControlSample>) =>
      Array.from({ length: 200 }, (_, i) => replace[i] ?? interrupt(i));
    const effectOf = (
      sample: ControlSample,
      engineStops: ReturnType<typeof stop>[],
    ) =>
      judgeInterrupts([sample], [], [], targets, { engineStops }).effectMs[0];

    test("RC4 07:00:48Z: stopped at 2.2s, read at 5.1s — P-3 judges the stop and reports the read", () => {
      const result = judgeInterrupts(
        samples({ 10: interrupt(10, 5106) }),
        [],
        [],
        targets,
        { engineStops: [stop(10, 2210)] },
      );
      // 2210 + offset 1 + half the 2ms round trip.
      expect(result).toMatchObject({
        pass: true,
        late: [],
        hostExcluded: 0,
        effectFromWorkerLog: 1,
        sseLate: [
          {
            sessionId: "session-10",
            turnId: "456",
            sseEffectMs: 5106,
            effectMs: 2212,
          },
        ],
      });
      expect(Math.max(...result.effectMs)).toBe(2212);
      expect(Math.max(...result.sseEffectMs)).toBe(5106);
    });

    test("a late stop fails P-3 unless a host stall overlapped it", () => {
      const list = samples({ 10: interrupt(10, 7000) });
      const engineStops = [stop(10, 6000)];
      expect(
        judgeInterrupts(list, [], [], targets, { engineStops }),
      ).toMatchObject({
        pass: false,
        late: [
          {
            sessionId: "session-10",
            turnId: "456",
            effectMs: 6002,
            sseEffectMs: 7000,
          },
        ],
      });
      const turns = [
        {
          sessionId: "session-10",
          turnId: "456",
          sentAt: sentAt(10) - 3000,
          acceptStatus: 202,
          status: "interrupted",
          contextKept: true,
        },
        {
          sessionId: "session-10",
          turnId: "457",
          sentAt: sentAt(10) + 40_000,
          kind: "normal",
          acceptStatus: 202,
          status: "completed",
          contextKept: true,
        },
      ] as TurnRecord[];
      const held = heldBoth(sentAt(10) - T0 + 100, 1500);
      const result = judgeInterrupts(list, turns, [], targets, {
        engineStops,
        host: held,
      });
      expect(result).toMatchObject({ pass: true, late: [], hostExcluded: 1 });
      expect(result.hostExcludedSamples[0]).toMatchObject({
        effectMs: 6002,
        sseEffectMs: 7000,
        broken: [],
      });
      // One target alone excuses nothing.
      expect(
        judgeInterrupts(list, turns, [], targets, {
          engineStops,
          host: held.slice(0, 1),
        }),
      ).toMatchObject({ pass: false, hostExcluded: 0 });
    });

    test("the stop is placed at the later of the two clock bounds, and never beats the SSE read", () => {
      // The container clock stepped 400ms back between the readings: the
      // later bound holds either way.
      expect(
        effectOf(
          interrupt(10, 5500, {
            clockOffsetMs: -400,
            clockRttMs: 20,
            clockAfterOffsetMs: 0,
            clockAfterRttMs: 20,
          }),
          [stop(10, 5200)],
        ),
      ).toBe(5210);
      for (const clock of [
        // A sample with a reading missing cannot place the line.
        { clockOffsetMs: 1, clockRttMs: 2 },
        { ...steady, clockAfterOffsetMs: null },
        {},
      ]) {
        expect(effectOf(interrupt(10, 5106, clock), [stop(10, 2500)])).toBe(
          5106,
        );
      }
      for (const engineStops of [
        // Later than the runner's read, or before the POST: the clock is off.
        [stop(10, 6000)],
        [stop(10, -10)],
        // Two lines for the turn: which one the event came from is unknown.
        [stop(10, 2000), stop(10, 5000)],
        // Another session's turn of the same number.
        [stop(11, 2500, "session-10-other")],
        [],
      ]) {
        expect(effectOf(interrupt(10, 5106), engineStops)).toBe(5106);
      }
    });

    test("an interrupt the runner never read stays unobserved, whatever the log says", () => {
      const result = judgeInterrupts(
        samples({ 10: interrupt(10, null) }),
        [],
        [],
        targets,
        { engineStops: [stop(10, 2000)] },
      );
      expect(result).toMatchObject({
        pass: false,
        unobserved: 1,
        effectFromWorkerLog: 0,
      });
    });

    test("engine stops are read per worker log, under the session it claimed", () => {
      const dir = mkdtempSync(join(tmpdir(), "soak-workers-"));
      const line = (record: Record<string, unknown>) =>
        `${JSON.stringify({ timestamp: iso(0), level: "info", ...record })}\n`;
      const stopped = (turn: string, at: number) =>
        line({
          timestamp: iso(at),
          event: "worker.turn.engine_stopped",
          turn_id: turn,
          control_id: "c",
        });
      const claimed = (session: string) =>
        line({ event: "worker.claimed", session_id: session });
      writeFileSync(
        join(dir, "ap-worker-a-g1.log"),
        `${stopped("1", 100)}${claimed("s1")}not json\n${stopped("7", 2000)}`,
      );
      writeFileSync(
        join(dir, "ap-worker-a-g1.log.stderr"),
        claimed("s3") + stopped("7", 3000),
      );
      writeFileSync(
        join(dir, "ap-worker-b-g1.log"),
        claimed("s2") + stopped("7", 2500),
      );
      expect(readEngineStops(dir).sort((a, b) => a.at - b.at)).toEqual([
        { sessionId: "s1", turnId: "7", at: T0 + 2000 },
        { sessionId: "s2", turnId: "7", at: T0 + 2500 },
      ]);
      expect(readEngineStops(join(dir, "missing"))).toEqual([]);
    });
  });
});

describe("Api.statusPhase", () => {
  test("reads the turn's phase off the stream, resumes from the last id, and waits out the stream limit", async () => {
    const seen: Array<string | null> = [];
    let refusals = 1;
    const frame = (id: string, turn: string, phase: string) =>
      `id: ${id}\nevent: status\ndata: ${JSON.stringify({ turn_id: turn, data: { phase } })}\n\n`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("last-event-id"));
        if (refusals > 0) {
          refusals -= 1;
          return new Response("busy", { status: 429 });
        }
        const body =
          seen.length <= 2
            ? `: keepalive\n\n${frame("ev_1", "11", "engine_stopped")}${frame("ev_2", "12", "interrupting")}event: result\nid: ev_3\ndata: {}\n\n${frame("ev_4", "12", "engine_stopped")}`
            : frame("ev_9", "24", "engine_stopped");
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      const signal = new AbortController().signal;
      const at = await api.statusPhase("s", "12", "engine_stopped", signal);
      expect(typeof at).toBe("number");
      await api.statusPhase("s", "24", "engine_stopped", signal);
      // One refusal, the first read from the start, the next from ev_4.
      expect(seen).toEqual([null, null, "ev_4"]);
    } finally {
      server.stop(true);
    }
  });

  test("reopens a stream the API closed from the last id it read", async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("last-event-id"));
        const body =
          seen.length === 1
            ? "event: status\nid: ev_1\ndata: {}\n\n"
            : `id: ev_2\nevent: status\ndata: ${JSON.stringify({ turn_id: "1", data: { phase: "engine_stopped" } })}\n\n`;
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      const at = await api.statusPhase(
        "s",
        "1",
        "engine_stopped",
        new AbortController().signal,
      );
      expect(typeof at).toBe("number");
      expect(seen).toEqual([null, "ev_1"]);
    } finally {
      server.stop(true);
    }
  });

  test("answers null once aborted, and at once for a stream refused for good", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname.includes("gone")
          ? new Response("no", { status: 404 })
          : new Response(": keepalive\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      expect(
        await api.statusPhase(
          "gone",
          "1",
          "engine_stopped",
          new AbortController().signal,
        ),
      ).toBeNull();
      expect(
        await api.statusPhase(
          "s",
          "1",
          "engine_stopped",
          AbortSignal.timeout(300),
        ),
      ).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
