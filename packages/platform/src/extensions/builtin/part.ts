import { z } from "zod";

/** The one exchange a call belongs to: the session and attempt its grant names. */
export type WerftMcpCall = {
  sessionId: string;
  attemptId: string;
  requestId: string;
};

export type WerftMcpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * A tool of the built-in `werft` server. Every one reads only, and answers
 * with no secret value: a token, a key or a credential is never part of a
 * result, only whether one is set. The server masks what looks like one on
 * the way out, as a second line and not as the way to keep it out.
 */
export type WerftMcpTool = {
  name: string;
  /** When to use it, what it returns and what it never returns, with example questions. */
  description: string;
  /** JSON Schema of the arguments; an object at its root. */
  inputSchema: Record<string, unknown>;
  call(args: unknown, call: WerftMcpCall): Promise<WerftMcpToolResult>;
};

export type WerftMcpResource = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type WerftMcpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type WerftMcpResourceContents = {
  uri: string;
  mimeType?: string;
  text: string;
};

export type WerftMcpResources = {
  list(call: WerftMcpCall): Promise<readonly WerftMcpResource[]>;
  templates?: readonly WerftMcpResourceTemplate[];
  /** The contents of `uri`, or null when the URI is not one of this part's. */
  read(
    uri: string,
    call: WerftMcpCall,
  ): Promise<readonly WerftMcpResourceContents[] | null>;
};

export type WerftMcpPromptMessage = {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};

export type WerftMcpPrompt = {
  name: string;
  title?: string;
  description: string;
  arguments?: readonly {
    name: string;
    description?: string;
    required?: boolean;
  }[];
  get(
    args: Readonly<Record<string, string>>,
    call: WerftMcpCall,
  ): Promise<{ description?: string; messages: WerftMcpPromptMessage[] }>;
};

/**
 * What one area adds to the built-in `werft` server. The server's
 * capabilities, lists and the tool names a claim trusts all follow from the
 * parts it is made with, so an area adds to its own part and nothing else.
 */
export type WerftMcpPart = {
  tools?: readonly WerftMcpTool[];
  resources?: WerftMcpResources;
  prompts?: readonly WerftMcpPrompt[];
};

/** What every part is made with. */
export type WerftMcpPartContext = {
  /** The Werft version this image was built as (`werftVersionOf`). */
  version: string;
};

/** A tool whose arguments are parsed with `input` before `call` sees them. */
export function werftTool<Input extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: Input;
  call(args: z.infer<Input>, call: WerftMcpCall): Promise<WerftMcpToolResult>;
}): WerftMcpTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      ...z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
    },
    async call(args, call) {
      const parsed = tool.input.safeParse(args ?? {});
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid arguments: ${z.prettifyError(parsed.error)}`,
            },
          ],
        };
      }
      return tool.call(parsed.data, call);
    },
  };
}
