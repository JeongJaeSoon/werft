import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "./fake-anthropic.ts";
import { createRequestLog } from "./request-log.ts";

const call = (id: string, history: string[] = []) => ({
  body: {
    system: "SYSTEM PROMPT",
    messages: [...history, id].map((spec) => ({
      role: "user",
      content: `BODY TEXT GATE-SPEC {"id":"${spec}","steps":[],"final":"done"}`,
    })),
    tools: [{ name: "Bash" }],
  },
  headers: {},
  path: "/v1/messages",
  signal: new AbortController().signal,
});

describe("the scripted fake's request log", () => {
  test("holds the latest calls, oldest out first", () => {
    const log = createRequestLog(3);
    for (const id of ["a", "b", "c", "d", "e"]) log.reply(call(id));
    expect(log.entries().map((entry) => entry.spec_id)).toEqual([
      "c",
      "d",
      "e",
    ]);
    expect(log.entries("a")).toEqual([]);
    expect(log.entries("d")).toHaveLength(1);
  });

  test("keeps what the control port reports and no request text", () => {
    const log = createRequestLog(3);
    log.reply(call("second", ["first"]));
    expect(log.entries()).toEqual([
      {
        at: expect.any(String),
        spec_id: "second",
        step: 0,
        history: ["first", "second"],
        tools: ["Bash"],
        found: [],
      },
    ]);
    expect(JSON.stringify(log.entries())).not.toMatch(/BODY TEXT|SYSTEM/);
  });
});

describe("startFakeAnthropicServer's keepRequests", () => {
  let server: FakeAnthropicServer | undefined;
  afterEach(() => server?.stop());

  const send = async (keepRequests?: number) => {
    const indexes: number[] = [];
    server = startFakeAnthropicServer(
      (_request, index) => {
        indexes.push(index);
        return textReply("ok");
      },
      keepRequests === undefined ? {} : { keepRequests },
    );
    for (const n of [0, 1, 2, 3]) {
      await fetch(`${server.url}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: `m${n}` }),
      });
      await fetch(`${server.url}/v1/models?limit=${n + 1}`);
    }
    return {
      indexes,
      kept: server.requests.map((request) => request.body.model),
      models: server.modelRequests.length,
    };
  };

  test("bounds what is held without restarting the call index", async () => {
    expect(await send(2)).toEqual({
      indexes: [0, 1, 2, 3],
      kept: ["m2", "m3"],
      models: 2,
    });
  });

  test("holds nothing at zero", async () => {
    expect(await send(0)).toMatchObject({ kept: [], models: 0 });
  });

  test("holds every request by default", async () => {
    expect(await send()).toMatchObject({ models: 4 });
    expect(server?.requests).toHaveLength(4);
  });
});
