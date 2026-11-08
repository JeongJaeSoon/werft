/// <reference lib="dom" />
import { describe, expect, mock, test } from "bun:test";
import { type ApiClient, ApiError } from "@werft-ai/client";
import { type AgentCard, createAgentRequestSchema } from "@werft-ai/contracts";
import {
  type AgentCardDraft,
  agentCardStep,
  agentIdentityStep,
} from "@werft-ai/core/forms";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";
import type { DefaultValues } from "react-hook-form";
import { z } from "zod";
import { defaultMessages } from "../messages/index.ts";
import { WerftProvider } from "../provider.tsx";
import {
  formAlerts,
  type StepForm,
  type StepSchema,
  stepResolver,
  submitStep,
  useStepForm,
} from "./step-form.ts";

// Queries come from each render's result, not `screen`: Testing Library is
// cached across files and its `screen` keeps the first file's document.
const { render, waitFor } = await setupDom();
// After setupDom: the ui entry loads Radix, which decides at import time
// whether a DOM exists, for every later file in the run too.
const { Field, FieldError, FieldLabel, Input } = await import("@werft-ai/ui");
type View = ReturnType<typeof render>;
const ko = defaultMessages.ko;

function Wrap({ children }: { readonly children: ReactNode }) {
  return (
    <WerftProvider
      client={{} as ApiClient}
      locale="ko"
      renderLink={({ children: label }) => label}
    >
      {children}
    </WerftProvider>
  );
}

// The host's wording for a failed request; the console's comes from errorKey.
const serverMessage = (error: unknown) =>
  error instanceof ApiError ? `server:${error.code}` : "server:UNKNOWN";

/** The convention as a step screen writes it: alerts on top, a Field each. */
function StepFormView<S extends StepSchema>({
  schema,
  fields,
  defaultValues,
  send,
}: {
  readonly schema: S;
  readonly fields: readonly (keyof z.input<S> & string)[];
  readonly defaultValues: DefaultValues<z.input<S>>;
  readonly send: (values: z.output<S>) => unknown;
}) {
  const form: StepForm<S> = useStepForm(schema, { defaultValues });
  const { errors } = form.formState;
  return (
    <form noValidate onSubmit={submitStep(form, send, serverMessage)}>
      {formAlerts(errors, fields).map((message) => (
        <p key={message} role="alert" data-testid="form-alert">
          {message}
        </p>
      ))}
      {fields.map((name) => (
        <Field key={name}>
          <FieldLabel>{name}</FieldLabel>
          <Input {...form.register(name as never)} />
          <FieldError>
            {(errors as Record<string, { message?: string }>)[name]?.message}
          </FieldError>
        </Field>
      ))}
      <button type="submit">submit</button>
    </form>
  );
}

const identity = (send: (values: { slug: string; name: string }) => unknown) =>
  render(
    <Wrap>
      <StepFormView
        schema={agentIdentityStep}
        fields={["slug", "name"]}
        defaultValues={{ slug: "", name: "", description: "" }}
        send={send}
      />
    </Wrap>,
  );

const fill = async (view: View, values: Record<string, string>) => {
  const user = await setupUser();
  for (const [name, value] of Object.entries(values)) {
    const input = view.getByLabelText(name);
    await user.clear(input);
    if (value) await user.type(input, value);
  }
  await user.click(view.getByRole("button", { name: "submit" }));
};

const fieldError = (view: View, name: string) =>
  view
    .getByLabelText(name)
    .closest("[data-slot=field]")
    ?.querySelector("[data-slot=field-error]")?.textContent ?? null;

const alerts = (view: View) =>
  view.queryAllByTestId("form-alert").map((line) => line.textContent);

describe("a step form", () => {
  test("whitespace alone is an empty field, and nothing is sent", async () => {
    const send = mock();
    const view = identity(send);
    await fill(view, { slug: "   ", name: " " });
    await waitFor(() =>
      expect(fieldError(view, "name")).toBe(ko["form.error.required"]),
    );
    expect(fieldError(view, "slug")).toBe(ko["form.error.required"]);
    expect(view.getByLabelText("slug").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(send).not.toHaveBeenCalled();
    view.unmount();
  });

  test("a contract check's own English message is replaced by ours", async () => {
    const view = identity(mock());
    await fill(view, { slug: "Not Kebab", name: "Refunds" });
    await waitFor(() =>
      expect(fieldError(view, "slug")).toBe(ko["form.error.format"]),
    );
    expect(view.queryByText(/kebab-case/)).toBeNull();
    view.unmount();
  });

  test("every field valid goes to the request, trimmed", async () => {
    const post = mock(async (_path: string, init: { body: unknown }) => {
      createAgentRequestSchema.parse(init.body);
      return { data: {} };
    });
    const card = agentCardStep().parse({
      language: "ko",
      model: "claude-sonnet-5",
      toolsMode: "all",
      tools: [],
      forbidden: [],
    });
    // The wizard's team picker supplies the managing team beside the step.
    const managing_team_id = "019a0000-0000-7000-8000-0000000000c9";
    const view = identity((values) =>
      post("/v1/agents", { body: { ...values, managing_team_id, card } }),
    );
    await fill(view, { slug: "  refunds ", name: " Refunds " });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1].body).toEqual({
      slug: "refunds",
      name: "Refunds",
      description: "",
      managing_team_id,
      card,
    });
    expect(alerts(view)).toEqual([]);
    view.unmount();
  });

  test("a server 400 is one line above the form, no field marked", async () => {
    const send = mock(async () => {
      throw new ApiError(400, "BAD_REQUEST", "Request body is invalid", {
        details: null,
      });
    });
    const view = identity(send);
    await fill(view, { slug: "refunds", name: "Refunds" });
    await waitFor(() => expect(alerts(view)).toEqual(["server:BAD_REQUEST"]));
    const form = view.getByRole("button", { name: "submit" }).closest("form");
    expect(form?.firstElementChild?.textContent).toBe("server:BAD_REQUEST");
    expect(fieldError(view, "slug")).toBeNull();
    expect(fieldError(view, "name")).toBeNull();
    view.unmount();
  });

  test("an error on a path no field shows is listed above the form", async () => {
    const base: AgentCard = {
      role: "Support",
      instructions: "Answer.",
      language: "ko",
      model: "claude-sonnet-5",
      capabilities: {
        mcp: null,
        forbidden: [`mcp__${"x".repeat(125)}`],
      },
      rules: [],
    };
    const send = mock();
    const draft: AgentCardDraft = {
      language: "ko",
      model: "claude-sonnet-5",
    };
    const view = render(
      <Wrap>
        <StepFormView
          schema={agentCardStep(base)}
          fields={["model"]}
          defaultValues={draft}
          send={send}
        />
      </Wrap>,
    );
    await fill(view, {});
    await waitFor(() =>
      expect(alerts(view)).toEqual([
        ko["form.error.tooLong"].replace("{max}", "128"),
      ]),
    );
    expect(send).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("formAlerts", () => {
  test("the server's line first, then root errors, then unmapped paths", () => {
    expect(
      formAlerts(
        {
          name: { type: "too_small", message: "name" },
          capabilities: {
            tools: [{ type: "too_big", message: "tool" }],
          },
          root: {
            type: "custom",
            message: "root",
            server: { type: "server", message: "server" },
            other: { type: "custom", message: "other" },
          },
        } as never,
        ["name"],
      ),
    ).toEqual(["server", "root", "other", "tool"]);
  });

  test("an error inside a field's path is listed, as the field shows only its own", () => {
    expect(
      formAlerts(
        {
          tools: Object.assign([{ type: "too_big", message: "tool" }], {
            type: "too_small",
            message: "list",
          }),
        } as never,
        ["tools"],
      ),
    ).toEqual(["tool"]);
  });
});

describe("stepResolver words every issue from its own facts", () => {
  const resolve = async (
    schema: StepSchema,
    values: object,
    criteriaMode?: "all",
  ) =>
    (
      await stepResolver(schema, ko)(values, undefined, {
        fields: {},
        shouldUseNativeValidation: false,
        ...(criteriaMode ? { criteriaMode } : {}),
      } as never)
    ).errors as Record<
      string,
      { message?: string; types?: Record<string, unknown> }
    >;

  test("a check with its own message keeps its limit", async () => {
    const errors = await resolve(
      z.object({ x: z.string().min(5, "custom limit") }),
      { x: "a" },
    );
    expect(errors.x?.message).toBe("5자 이상 입력하세요.");
  });

  test("an own message equal to another issue's wording is still reworded", async () => {
    const errors = await resolve(
      z.object({
        a: z.string().min(1),
        b: z.email(ko["form.error.required"]),
      }),
      { a: "", b: "nope" },
    );
    expect(errors.a?.message).toBe(ko["form.error.required"]);
    expect(errors.b?.message).toBe(ko["form.error.email"]);
  });

  test("criteriaMode all words every listed check", async () => {
    const errors = await resolve(
      z.object({ x: z.string().min(5).regex(/^A/, "must start A") }),
      { x: "b" },
      "all",
    );
    expect(errors.x?.types).toEqual({
      too_small: "5자 이상 입력하세요.",
      invalid_format: ko["form.error.format"],
    });
  });

  test("a missing value reads as required, a wrong type as invalid", async () => {
    const schema = z.object({ n: z.number() });
    expect((await resolve(schema, {})).n?.message).toBe(
      ko["form.error.required"],
    );
    expect((await resolve(schema, { n: "1" })).n?.message).toBe(
      ko["form.error.invalid"],
    );
  });
});
