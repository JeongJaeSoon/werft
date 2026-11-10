import { afterEach, expect, spyOn, test } from "bun:test";
import { isApiError, unwrap } from "@werft-ai/client";
import { fakeClient, json } from "../.storybook/fake-client.ts";

const network = spyOn(globalThis, "fetch");
afterEach(() => network.mockClear());

test("answers a named request from the story's routes", async () => {
  const client = fakeClient({
    "GET /v1/connections": () => json(200, { items: [] }),
  });
  expect(await unwrap(client.GET("/v1/connections"))).toEqual({ items: [] });
  expect(network).not.toHaveBeenCalled();
});

test("anything the story did not name is a 404, still off the network", async () => {
  const error = await unwrap(fakeClient().GET("/v1/sessions")).catch(
    (caught: unknown) => caught,
  );
  expect(isApiError(error, "NOT_FOUND")).toBe(true);
  expect(network).not.toHaveBeenCalled();
});
