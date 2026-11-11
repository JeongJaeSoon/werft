import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import {
  type FieldErrors,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import type { z } from "zod";
import type { ModuleMessages } from "../messages/index.ts";
import { useWerft } from "../provider.tsx";
import { issueText } from "./issues.ts";

export type StepSchema = z.ZodType<FieldValues, FieldValues>;

export type StepForm<S extends StepSchema> = UseFormReturn<
  z.input<S>,
  unknown,
  z.output<S>
>;

/** Where `submitStep` puts a failed request; `formAlerts` lists it first. */
export const SERVER_ERROR = "root.server";

/** Calls `visit` on every error object in a nested FieldErrors tree. */
function walk(
  node: unknown,
  path: string,
  visit: (path: string, error: { message?: unknown; type?: unknown }) => void,
) {
  if (typeof node !== "object" || node === null) return;
  const error = node as Record<string, unknown>;
  if (typeof error.type === "string") visit(path, error);
  for (const [key, child] of Object.entries(error)) {
    if (key === "ref" || key === "types" || key === "message") continue;
    walk(child, path ? `${path}.${key}` : key, visit);
  }
}

/**
 * zodResolver with the console's wording on every issue. A check's own
 * message (the contract's `.regex(re, "must be lowercase kebab-case")`)
 * outranks a per-parse error map in zod, so instead the schema handed to
 * zodResolver words the final issues, each from its own code and limits.
 */
export function stepResolver<S extends StepSchema>(
  schema: S,
  messages: ModuleMessages,
): Resolver<z.input<S>, unknown, z.output<S>> {
  const word = (issue: z.core.$ZodIssue) => {
    // Final issues are plain objects; zodResolver reads `message` from them.
    (issue as { message: string }).message = issueText(issue, messages);
    if (issue.code === "invalid_union")
      for (const branch of issue.errors) branch.forEach(word);
  };
  const settle = (result: z.ZodSafeParseResult<z.output<S>>) => {
    if (result.success) return result.data;
    result.error.issues.forEach(word);
    throw result.error;
  };
  // `reportInput` keeps the input on each issue, which tells an empty field
  // from a wrong type.
  const worded = {
    _zod: schema._zod,
    parse: (values: unknown) =>
      settle(schema.safeParse(values, { reportInput: true })),
    parseAsync: async (values: unknown) =>
      settle(await schema.safeParseAsync(values, { reportInput: true })),
  };
  return zodResolver(
    // Not a whole schema: only the members zodResolver reads off one.
    worded as unknown as z.ZodType<z.output<S>, z.input<S>>,
  ) as Resolver<z.input<S>, unknown, z.output<S>>;
}

/**
 * A form over one step schema: the form holds the schema's input, a valid
 * submit hands over its output. Pass a schema that keeps its identity across
 * renders (a module constant, or `useMemo` for `agentCardStep(base)`).
 */
export function useStepForm<S extends StepSchema>(
  schema: S,
  props: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, "resolver"> = {},
): StepForm<S> {
  const { messages } = useWerft();
  const resolver = useMemo(
    () => stepResolver(schema, messages),
    [schema, messages],
  );
  return useForm<z.input<S>, unknown, z.output<S>>({ ...props, resolver });
}

/**
 * The submit handler. A valid form goes to `send`; whatever `send` throws
 * becomes one line in `root.server`, worded by the host (the server's 400
 * carries no field paths, so nothing is mapped back onto inputs).
 */
export function submitStep<TInput extends FieldValues, TOutput>(
  form: UseFormReturn<TInput, unknown, TOutput>,
  send: (values: TOutput) => unknown,
  serverMessage: (error: unknown) => string,
) {
  return form.handleSubmit(async (values) => {
    try {
      await send(values);
    } catch (error) {
      form.setError(SERVER_ERROR, {
        type: "server",
        message: serverMessage(error),
      });
    }
  });
}

/**
 * The messages a form shows above its fields: the server's line, then other
 * root errors, then any error whose path is not one of `fields`, the paths
 * whose own message the form renders in a FieldError. An error inside such a
 * path (`tools.0` under `tools`) is listed too, as the field shows only its own.
 */
export function formAlerts<T extends FieldValues>(
  errors: FieldErrors<T>,
  fields: readonly string[],
): string[] {
  const server: string[] = [];
  const root: string[] = [];
  const unmapped: string[] = [];
  walk(errors, "", (path, error) => {
    if (typeof error.message !== "string" || !error.message) return;
    if (path === SERVER_ERROR) server.push(error.message);
    else if (path === "root" || path.startsWith("root."))
      root.push(error.message);
    else if (!fields.includes(path)) unmapped.push(error.message);
  });
  return [...new Set([...server, ...root, ...unmapped])];
}
