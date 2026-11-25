import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LocalToolServer } from "@werft-ai/runtime-core";
import { localToolNames, localToolRelay } from "./local-tools.ts";

async function connected(server: LocalToolServer) {
  const relay = localToolRelay(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await relay.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return { relay, client };
}

const ran: string[] = [];
const server: LocalToolServer = {
  name: "conversation",
  binding: "conversation-read-tools-1",
  tools: [
    {
      name: "read_turns",
      description: "Lists turns.",
      call: async () => {
        ran.push("read_turns");
        return { text: '{"turns":[]}', isError: false };
      },
    },
    {
      name: "read_thread",
      description: "Reads the thread.",
      call: async () => {
        throw new Error("a failure that quotes the thread");
      },
    },
  ],
};

describe("localToolRelay", () => {
  test("lists the server's tools alone, each taking no argument", async () => {
    const { relay, client } = await connected(server);
    expect(relay).toMatchObject({ type: "sdk", name: "conversation" });
    expect((await client.listTools()).tools).toEqual([
      {
        name: "read_turns",
        description: "Lists turns.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "read_thread",
        description: "Reads the thread.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ]);
    expect(localToolNames(server)).toEqual([
      "mcp__conversation__read_turns",
      "mcp__conversation__read_thread",
    ]);
  });

  test("runs a listed tool's own handler; one not listed, or a call with arguments, runs nothing", async () => {
    ran.length = 0;
    const { client } = await connected(server);
    expect(
      await client.callTool({ name: "read_turns", arguments: {} }),
    ).toEqual({
      content: [{ type: "text", text: '{"turns":[]}' }],
    });
    expect(await client.callTool({ name: "read_file", arguments: {} })).toEqual(
      {
        isError: true,
        content: [{ type: "text", text: "Tool read_file is not allowed" }],
      },
    );
    expect(
      await client.callTool({
        name: "read_turns",
        arguments: { channel: "C0OTHER" },
      }),
    ).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool read_turns takes no arguments" }],
    });
    expect(ran).toEqual(["read_turns"]);
  });

  test("a tool with a schema lists it and is handed its call's input, to judge itself", async () => {
    const taken: unknown[] = [];
    const schema = {
      type: "object",
      properties: { reason: { type: "string", minLength: 1 } },
      required: ["reason"],
      additionalProperties: false,
    };
    const { client } = await connected({
      name: "conversation",
      binding: "conversation-tools-2",
      tools: [
        {
          name: "no_reply",
          description: "Stays quiet.",
          inputSchema: schema,
          call: async (_signal, input) => {
            taken.push(input);
            return { text: "taken", isError: false };
          },
        },
      ],
    });
    expect((await client.listTools()).tools as unknown[]).toEqual([
      { name: "no_reply", description: "Stays quiet.", inputSchema: schema },
    ]);
    expect(
      await client.callTool({ name: "no_reply", arguments: { reason: "r" } }),
    ).toEqual({ content: [{ type: "text", text: "taken" }] });
    expect(taken).toEqual([{ reason: "r" }]);
  });

  test("a handler that throws is an error result that says nothing of why", async () => {
    const { client } = await connected(server);
    expect(
      await client.callTool({ name: "read_thread", arguments: {} }),
    ).toEqual({
      isError: true,
      content: [
        { type: "text", text: "Tool read_thread could not be answered" },
      ],
    });
  });
});
