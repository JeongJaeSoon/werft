import {
  createSettingsConnectionRequestSchema,
  createSettingsMcpServerRequestSchema,
  exportSettingsResponseSchema,
  importSettingsQuerySchema,
  importSettingsResponseSchema,
  listSettingsConnectionsResponseSchema,
  listSettingsMcpServersResponseSchema,
  setConnectionAutoModeRequestSchema,
  setConnectionModelsRequestSchema,
  setSettingsCredentialRequestSchema,
  setSettingsMcpServerRequestSchema,
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

const KINDS = [
  ["Connection", "connection"],
  ["McpServer", "mcp"],
] as const;

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
  apiRoute(router, "listSettingsMcpServers", async (context) => {
    const listed = await mapped(() =>
      settings.listMcpServers(context.get("caller")),
    );
    return jsonWithSchema(
      context,
      listSettingsMcpServersResponseSchema,
      listed,
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
  apiRoute(router, "createSettingsMcpServer", async (context) => {
    const body = await parseJsonBody(
      context,
      createSettingsMcpServerRequestSchema,
    );
    const made = await mapped(() =>
      settings.createMcpServer(context.get("caller"), body),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, made, 201);
  });

  for (const [name, kind] of KINDS) {
    apiRoute(router, `setSettings${name}Credential`, async (context) => {
      const { id } = requireParams(context, settingsIdParamsSchema);
      const body = await parseJsonBody(
        context,
        setSettingsCredentialRequestSchema,
      );
      const changed = await mapped(() =>
        settings.setCredential(context.get("caller"), kind, id, body.value),
      );
      return jsonWithSchema(context, settingsChangeResponseSchema, changed);
    });
    apiRoute(router, `disableSettings${name}`, async (context) => {
      const { id } = requireParams(context, settingsIdParamsSchema);
      const changed = await mapped(() =>
        settings.disable(context.get("caller"), kind, id),
      );
      return jsonWithSchema(context, settingsChangeResponseSchema, changed);
    });
  }

  apiRoute(router, "enableSettingsConnection", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const changed = await mapped(() =>
      settings.enableConnection(context.get("caller"), id),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "convertSettingsConnection", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setSettingsCredentialRequestSchema,
    );
    const changed = await mapped(() =>
      settings.convertConnection(context.get("caller"), id, body.value),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });

  apiRoute(router, "setSettingsConnectionAutoMode", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setConnectionAutoModeRequestSchema,
    );
    const changed = await mapped(() =>
      settings.setConnectionAutoMode(context.get("caller"), id, body.auto_mode),
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

  apiRoute(router, "setSettingsMcpServer", async (context) => {
    const { id } = requireParams(context, settingsIdParamsSchema);
    const body = await parseJsonBody(
      context,
      setSettingsMcpServerRequestSchema,
    );
    const changed = await mapped(() =>
      settings.setMcpWorkspaces(context.get("caller"), id, body.workspaces),
    );
    return jsonWithSchema(context, settingsChangeResponseSchema, changed);
  });
}
