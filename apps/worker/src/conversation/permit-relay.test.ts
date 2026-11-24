import { afterEach, describe, expect, test } from "bun:test";
import { PermitRelay, type RelayFetch } from "./permit-relay.ts";

const relays: PermitRelay[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop();
});

function setup() {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetch: RelayFetch = async (url, init) => {
    calls.push({
      url,
      headers: new Headers(init.headers),
      body: await new Response(init.body).text(),
    });
    return new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const relay = new PermitRelay("http://egress-proxy:3129/provider/", {
    fetch,
  });
  relays.push(relay);
  const send = (key: string) =>
    globalThis.fetch(`${relay.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: '{"model":"m"}',
    });
  return { relay, calls, send };
}

describe("PermitRelay", () => {
  test("passes a request on with the permit its turn holds in place of the session key", async () => {
    const { relay, calls, send } = setup();
    const key = relay.open();
    relay.hold(key, "permit-1");
    const response = await send(key);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://egress-proxy:3129/provider/v1/messages?beta=true",
    );
    expect(calls[0]?.headers.get("x-api-key")).toBe("permit-1");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]?.body).toBe('{"model":"m"}');
    expect(relay.requestBytes(key)).toBe(13);
    relay.close(key);
    expect(relay.requestBytes(key)).toBe(0);
  });

  test("a later turn's requests carry that turn's permit", async () => {
    const { relay, calls, send } = setup();
    const key = relay.open();
    relay.hold(key, "permit-1");
    await send(key);
    relay.release(key);
    relay.hold(key, "permit-2");
    await send(key);
    expect(calls.map((c) => c.headers.get("x-api-key"))).toEqual([
      "permit-1",
      "permit-2",
    ]);
  });

  test("refuses, without passing on, a key no turn holds, a closed key and an unknown one", async () => {
    const { relay, calls, send } = setup();
    const idle = relay.open();
    const held = relay.open();
    relay.hold(held, "permit-1");
    relay.release(held);
    const closed = relay.open();
    relay.hold(closed, "permit-2");
    relay.close(closed);
    for (const key of [idle, held, closed, "unknown"]) {
      const response = await send(key);
      expect(response.status).toBe(401);
      expect(
        ((await response.json()) as { error: { type: string } }).error.type,
      ).toBe("authentication_error");
    }
    expect(calls).toHaveLength(0);
    expect(() => relay.hold(closed, "permit-3")).toThrow();
  });

  test("one session's permit is not another's", async () => {
    const { relay, calls, send } = setup();
    const a = relay.open();
    const b = relay.open();
    relay.hold(a, "permit-a");
    expect((await send(b)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
