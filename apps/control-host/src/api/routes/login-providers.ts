import {
  createLoginProviderRequestSchema,
  disableLoginProviderResponseSchema,
  discoverLoginProviderRequestSchema,
  discoverLoginProviderResponseSchema,
  listLoginProvidersResponseSchema,
  loginProviderParamsSchema,
  loginProviderResponseSchema,
  setLoginProviderSecretRequestSchema,
  startProviderLoginResponseSchema,
  updateLoginProviderRequestSchema,
} from "@werft-ai/contracts";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import type { ProviderAdmin } from "../provider-admin.ts";
import { setLoginFlowCookie } from "./auth.ts";
import { mapped, requireParams } from "./errors.ts";

/** The owner's sign-in provider settings (design 7.2). */
export function registerLoginProviderRoutes(
  router: ApiRouter,
  admin: ProviderAdmin,
) {
  apiRoute(router, "listLoginProviders", async (context) => {
    const listed = await mapped(() => admin.list(context.get("caller")));
    return jsonWithSchema(context, listLoginProvidersResponseSchema, listed);
  });

  apiRoute(router, "discoverLoginProvider", async (context) => {
    const body = await parseJsonBody(
      context,
      discoverLoginProviderRequestSchema,
    );
    const found = await mapped(() =>
      admin.discover(context.get("caller"), body.issuer),
    );
    return jsonWithSchema(context, discoverLoginProviderResponseSchema, found);
  });

  apiRoute(router, "createLoginProvider", async (context) => {
    const body = await parseJsonBody(context, createLoginProviderRequestSchema);
    const provider = await mapped(() =>
      admin.create(context.get("caller"), body),
    );
    return jsonWithSchema(
      context,
      loginProviderResponseSchema,
      { provider },
      201,
    );
  });

  apiRoute(router, "updateLoginProvider", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const body = await parseJsonBody(context, updateLoginProviderRequestSchema);
    const provider = await mapped(() =>
      admin.update(
        context.get("caller"),
        id,
        context.req.header("If-Match"),
        body,
      ),
    );
    return jsonWithSchema(context, loginProviderResponseSchema, { provider });
  });

  apiRoute(router, "refreshLoginProviderDiscovery", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const provider = await mapped(() =>
      admin.refreshDiscovery(context.get("caller"), id),
    );
    return jsonWithSchema(context, loginProviderResponseSchema, { provider });
  });

  apiRoute(router, "setLoginProviderSecret", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const body = await parseJsonBody(
      context,
      setLoginProviderSecretRequestSchema,
    );
    const provider = await mapped(() =>
      admin.setClientSecret(context.get("caller"), id, body.value),
    );
    return jsonWithSchema(context, loginProviderResponseSchema, { provider });
  });

  apiRoute(router, "startLoginProviderTest", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const flow = await mapped(() =>
      admin.startTest(
        context.get("caller"),
        id,
        context.get("webSession")?.sessionId,
      ),
    );
    setLoginFlowCookie(context, flow.cookieValue);
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(context, startProviderLoginResponseSchema, {
      authorization_url: flow.authorizationUrl,
    });
  });

  apiRoute(router, "enableLoginProvider", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const provider = await mapped(() =>
      admin.enable(context.get("caller"), id),
    );
    return jsonWithSchema(context, loginProviderResponseSchema, { provider });
  });

  apiRoute(router, "disableLoginProvider", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    const disabled = await mapped(() =>
      admin.disable(context.get("caller"), id),
    );
    return jsonWithSchema(
      context,
      disableLoginProviderResponseSchema,
      disabled,
    );
  });

  apiRoute(router, "deleteLoginProvider", async (context) => {
    const { id } = requireParams(context, loginProviderParamsSchema);
    await mapped(() => admin.remove(context.get("caller"), id));
    return context.body(null, 204);
  });
}
