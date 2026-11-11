import {
  listSessionOutputsResponseSchema,
  sessionIdParamsSchema,
  sessionOutputParamsSchema,
} from "@werft-ai/contracts";
import type { SessionOutputService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../../app.ts";
import { mapped, requireParams } from "../errors.ts";

export function registerSessionOutputRoutes(
  router: ApiRouter,
  service: SessionOutputService,
) {
  apiRoute(router, "listSessionOutputs", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const listed = await mapped(() =>
      service.listOutputs(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listSessionOutputsResponseSchema, listed);
  });

  apiRoute(router, "downloadSessionOutput", async (context) => {
    const params = requireParams(context, sessionOutputParamsSchema);
    const { body, output } = await mapped(() =>
      service.openOutput(context.get("caller"), params.id, params.path),
    );
    return context.body(streamOf(body), 200, {
      "Cache-Control": "private, no-store",
      "Content-Disposition": attachmentDisposition(output.path),
      "Content-Length": String(output.bytes),
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
  });
}

// Bun has no ReadableStream.from. Pulled one chunk at a time; a client that
// goes away returns the iterator, which lets go of the store's connection.
function streamOf(body: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const chunks = body[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}

/**
 * RFC 6266: the name as UTF-8 in `filename*`, and an ASCII-only `filename`
 * for clients that ignore it. Nothing of the path reaches the header
 * unencoded, so no quote, CR or LF in a file name can shape it.
 */
export function attachmentDisposition(path: string): string {
  // A lone surrogate would make encodeURIComponent throw.
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\p{Cs}/gu, "�");
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
