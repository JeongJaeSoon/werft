import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  InstallationProfileOptionsResponse,
  ToolBoundaryValue,
} from "@werft-ai/contracts";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import {
  addMcpBlock,
  blockedOf,
  mcpBlockedOf,
  needsAccepting,
  setMcpBlock,
  type ToolChoiceModel,
  type ToolPicks,
} from "./profile-tools-model.ts";

/** GET /v1/installation-profiles/options, which only an owner may read. */
export const installationOptionsQuery = (client: ApiClient) => ({
  queryKey: scopedKey(client, "installation-profile-options"),
  queryFn: () =>
    unwrap(
      client.GET("/v1/installation-profiles/options"),
    ) as Promise<InstallationProfileOptionsResponse>,
  retry: false,
});

const TOOL_REFUSALS: Readonly<Record<string, MessageKey>> = {
  mcp_tool: "profiles.tools.error.mcpTool",
  mcp_tool_name: "profiles.tools.error.mcpToolName",
  github_server: "profiles.tools.error.githubServer",
  unknown_mcp_server: "profiles.tools.error.unknownMcpServer",
  base_mcp_deny_dropped: "profiles.tools.error.baseMcpDenyDropped",
  mcp_unblock_unknown: "profiles.tools.error.mcpUnblockUnknown",
  mcp_unblock_conflict: "profiles.tools.error.mcpUnblockConflict",
  mcp_unblock_no_previous: "profiles.tools.error.mcpUnblockNoPrevious",
  tool_pattern: "profiles.tools.error.toolPattern",
  unknown_tool: "profiles.tools.error.unknownTool",
  no_tool_catalog: "profiles.tools.error.noToolCatalog",
  base_denies: "profiles.tools.error.baseDenies",
  added_tool_not_accepted: "profiles.tools.asked",
};

/** What a save refused over its deny or accepted tools says, by reason code. */
export function toolRefusalKey(reason: unknown): MessageKey | undefined {
  return typeof reason === "string" && Object.hasOwn(TOOL_REFUSALS, reason)
    ? TOOL_REFUSALS[reason]
    : undefined;
}

export const toolField = (path: string | undefined): string | undefined =>
  path === "tools" ||
  path === "accept_added_tools" ||
  path === "unblock_mcp_tools"
    ? "deny"
    : path;

export const reasonOf = (failure: ApiError): unknown =>
  (failure.details as { readonly reason_code?: unknown } | undefined)
    ?.reason_code;

function McpBlocks({
  model,
  picks,
  onPicks,
  disabled,
}: {
  readonly model: ToolChoiceModel;
  readonly picks: ToolPicks;
  readonly onPicks: (picks: ToolPicks) => void;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState("");
  const [problem, setProblem] = useState<"invalid" | "duplicate" | null>(null);
  const fixed = new Set(model.mcp.fixed);
  const held = new Set(model.mcp.start);
  const blocked = new Set(mcpBlockedOf(model, picks));
  const names = [
    ...new Set([...model.mcp.fixed, ...model.mcp.start, ...picks.mcpAdded]),
  ].sort();
  const add = () => {
    const added = addMcpBlock(model, picks, raw);
    if ("picks" in added) {
      onPicks(added.picks);
      setRaw("");
      setProblem(null);
    } else {
      setProblem(added.error);
    }
  };

  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label" className="mb-2">
        {t("profiles.tools.mcp.legend")}
      </FieldLegend>
      <FieldDescription>{t("profiles.tools.mcp.hint")}</FieldDescription>
      {names.length === 0 ? (
        <FieldDescription>{t("profiles.tools.mcp.none")}</FieldDescription>
      ) : null}
      {names.map((name) => (
        <Field key={name} orientation="horizontal">
          <Checkbox
            checked={blocked.has(name)}
            disabled={disabled || fixed.has(name)}
            onCheckedChange={(checked) =>
              onPicks(setMcpBlock(model, picks, name, checked === true))
            }
          />
          <FieldContent>
            <FieldLabel className="font-mono">{name}</FieldLabel>
            <FieldDescription className="flex flex-wrap items-center gap-1">
              {fixed.has(name) ? (
                t("profiles.tools.fixed")
              ) : held.has(name) ? (
                t("profiles.tools.mcp.carried")
              ) : (
                <Badge variant="blue">{t("profiles.tools.mcp.new")}</Badge>
              )}
            </FieldDescription>
          </FieldContent>
        </Field>
      ))}
      {/* Not a form: this checklist sits inside the page's own. */}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field>
          <FieldLabel>{t("profiles.tools.mcp.input")}</FieldLabel>
          <Input
            value={raw}
            placeholder={t("profiles.tools.mcp.placeholder")}
            className="font-mono"
            autoComplete="off"
            disabled={disabled}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              add();
            }}
          />
          {problem ? (
            <FieldError>{t(`profiles.tools.mcp.${problem}`)}</FieldError>
          ) : null}
        </Field>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={add}
        >
          {t("profiles.tools.mcp.add")}
        </Button>
      </div>
    </FieldSet>
  );
}

const BOUNDARY_BADGE: Record<ToolBoundaryValue, "gray" | "blue" | "amber"> = {
  local: "gray",
  egress: "blue",
  provider: "amber",
};

/**
 * A profile form's "built-in tools to block" checklist: a ticked box blocks
 * that tool. On a next version it also lists how the catalog changed and
 * asks for each tool the previous version never had before it may run.
 */
export function DenyChecklist({
  model,
  picks,
  onPicks,
  disabled,
  previousId,
  error,
}: {
  readonly model: ToolChoiceModel;
  readonly picks: ToolPicks;
  readonly onPicks: (picks: ToolPicks) => void;
  readonly disabled: boolean;
  /** The version the catalog change is read against. */
  readonly previousId: string | undefined;
  readonly error: string | undefined;
}) {
  const { t } = useI18n();
  // A FieldSet's error reaches no checkbox by itself: each Field links only its own parts.
  const errorId = useId();
  const describedBy = error ? errorId : undefined;
  const blocked = new Set(blockedOf(model, picks));
  const fixed = new Set(model.fixed);
  const accepting = needsAccepting(model, picks);
  const fresh = new Set(accepting);
  const accepted = new Set(picks.accepted);
  const hasProvider = model.catalog.tools.some(
    (tool) => model.boundaries?.get(tool.name) === "provider",
  );

  return (
    <>
      <FieldSet className="gap-3">
        <FieldLegend variant="label" className="mb-2">
          {t("profiles.tools.legend")}
        </FieldLegend>
        <FieldDescription>{t("profiles.tools.hint")}</FieldDescription>
        <FieldDescription>
          {model.boundaries === null
            ? t("profiles.tools.unlimitedBase", { base: model.catalog.id })
            : t("profiles.tools.unlimited", { catalog: model.catalog.id })}
        </FieldDescription>
        {hasProvider ? (
          <FieldDescription className="nth-last-2:mt-0">
            {t("profiles.tools.providerNote")}
          </FieldDescription>
        ) : null}
        {model.catalog.tools.map(({ name }) => {
          const boundary = model.boundaries?.get(name);
          const locked = fixed.has(name);
          return (
            <Field key={name} orientation="horizontal">
              <Checkbox
                checked={blocked.has(name)}
                disabled={disabled || locked}
                aria-describedby={describedBy}
                aria-invalid={error && !locked ? true : undefined}
                onCheckedChange={(checked) =>
                  onPicks({
                    ...picks,
                    blocked: { ...picks.blocked, [name]: checked === true },
                  })
                }
              />
              <FieldContent>
                <FieldLabel className="font-mono">{name}</FieldLabel>
                {boundary || locked || fresh.has(name) ? (
                  <FieldDescription className="flex flex-wrap items-center gap-1">
                    {boundary ? (
                      <Badge variant={BOUNDARY_BADGE[boundary]}>
                        {t(`profiles.tools.boundary.${boundary}`)}
                      </Badge>
                    ) : null}
                    {fresh.has(name) ? (
                      <Badge variant="blue">{t("profiles.tools.new")}</Badge>
                    ) : null}
                    {locked ? t("profiles.tools.fixed") : null}
                  </FieldDescription>
                ) : null}
              </FieldContent>
            </Field>
          );
        })}
        <FieldError id={errorId}>{error}</FieldError>
      </FieldSet>

      <McpBlocks
        model={model}
        picks={picks}
        onPicks={onPicks}
        disabled={disabled}
      />

      {model.versioned && (accepting.length > 0 || model.removed.length > 0) ? (
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0">
            {t("profiles.tools.diff.legend")}
          </FieldLegend>
          <FieldDescription>
            {t("profiles.tools.diff.text", { id: previousId ?? "" })}
          </FieldDescription>
          {accepting.map((name) => (
            <Field key={name} orientation="horizontal">
              <Checkbox
                checked={accepted.has(name)}
                disabled={disabled}
                aria-describedby={describedBy}
                aria-invalid={
                  error && !blocked.has(name) && !accepted.has(name)
                    ? true
                    : undefined
                }
                onCheckedChange={(checked) =>
                  onPicks({
                    ...picks,
                    accepted:
                      checked === true
                        ? [...picks.accepted, name]
                        : picks.accepted.filter((other) => other !== name),
                  })
                }
              />
              <FieldContent>
                <FieldLabel>
                  {t("profiles.tools.diff.accept", { tool: name })}
                </FieldLabel>
                <FieldDescription>
                  {t(
                    blocked.has(name)
                      ? "profiles.tools.diff.stillBlocked"
                      : "profiles.tools.diff.opens",
                  )}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
          {model.removed.length > 0 ? (
            <FieldDescription className="flex flex-wrap items-center gap-1">
              {t("profiles.tools.diff.removed")}
              {model.removed.map((name) => (
                <Badge key={name} variant="mono">
                  {name}
                </Badge>
              ))}
            </FieldDescription>
          ) : null}
        </FieldSet>
      ) : null}
    </>
  );
}
