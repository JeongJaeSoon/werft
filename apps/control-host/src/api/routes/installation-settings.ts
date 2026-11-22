import {
  createSettingsConnectionRequestSchema,
  discoverConnectionModelsResponseSchema,
  exportSettingsResponseSchema,
  importSettingsQuerySchema,
  importSettingsResponseSchema,
  listSettingsConnectionsResponseSchema,
  setConnectionModelsRequestSchema,
  setSettingsCredentialRequestSchema,
  settingsChangeResponseSchema,
  settingsConnectionImpactResponseSchema,
  settingsDocumentSchema,
  settingsIdParamsSchema,
} from "@werft-ai/contracts";
import type {
  SettingsConsoleService,
  SettingsDocumentService,
} from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerInstallationSettingsRoutes(
  router: ApiRouter,
  settings: Pick<SettingsDocumentService, "export" | "import">,
) {
  apiRoute(router, "exportInstallationSettings", async (context) => {
    const exported = await mapped(() => settings.export(context.get("caller")));
    return jsonWithSchema(context, exportSettingsResponseSchema, exported);
  });

  apiRoute(router, "importInstallationSettings", async (context) => {
    const query = requireQuery(context, importSettingsQuerySchema);
    const document = await parseJsonBody(context, settingsDocumentSchema);
    const imported = await mapped(() =>
      settings.import(context.get("caller"), document, {
        dryRun: query.dry_run === "true",
      }),
    );
    return jsonWithSchema(context, importSettingsResponseSchema, imported);
  });
}

export function registerSettingsConsoleRoutes(
  router: ApiRouter,
  settings: SettingsConsoleService,
) {
  apiRoute(router, "listSettingsConnections", async (context) => {
    const listed = await mapped(() =>
      settings.listConnections(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      listSettingsConnectionsResponseSchema,
      listed,
    );
  });
  apiRoute(router, "getSettingsConnectionImpact", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const impact = await mapped(() =>
      settings.connectionImpact(context.get("caller"), id),
    );
    return jsonWithSchema(
      context,
      settingsConnectionImpactResponseSchema,
      impact,
    );
  });

  apiRoute(router, "createSettingsConnection", async (context) => {
    const body = await parseJsonBody(
      context,
      createSettingsConnectionRequestSchema,
    );
    const made = await mapped(() =>
      settings.createConnection(context.get("caller"), body),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, made, 201);
  });
  apiRoute(router, "setSettingsConnectionCredential", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setSettingsCredentialRequestSchema,
    );
    const changed = await mapped(() =>
      settings.setCredential(
        context.get("caller"),
        "connection",
        id,
        body.value,
      ),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });
  apiRoute(router, "disableSettingsConnection", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const changed = await mapped(() =>
      settings.disable(context.get("caller"), "connection", id),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "setSettingsRepositoryCredential", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setSettingsCredentialRequestSchema,
    );
    const changed = await mapped(() =>
      settings.setCredential(
        context.get("caller"),
        "repository",
        id,
        body.value,
      ),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "enableSettingsConnection", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const changed = await mapped(() =>
      settings.enableConnection(context.get("caller"), id),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "setSettingsConnectionModels", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(context, setConnectionModelsRequestSchema);
    const changed = await mapped(() =>
      settings.setConnectionModels(context.get("caller"), id, body),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "discoverSettingsConnectionModels", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const listed = await mapped(() =>
      settings.discoverConnectionModels(context.get("caller"), id),
    );
    return jsonWithSchema(
      context,
      discoverConnectionModelsResponseSchema,
      listed,
    );
  });
}
