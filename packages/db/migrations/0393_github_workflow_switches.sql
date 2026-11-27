-- Two switches over the stored keys (94S-2406): `workflows` (with `checks`
-- beside it) edits workflow files and reads CI, on by default; `actions` runs
-- workflows directly, off by default. Every ceiling and agent row takes the
-- defaults: the old `actions` mixed reading CI into running, so carrying it
-- over would turn on a run nobody chose. An allow-list only applies with
-- `actions` on, and a save refuses one without it, so it is emptied too.
-- Release pins are not touched: a session on its release keeps that release's.
-- A ceiling never saved keeps revision 0; a saved one moves, so a console
-- holding the old revision gets a conflict rather than writing the old values.
UPDATE "github_workspace_settings"
SET
  "ceiling" = "ceiling" || '{"workflows": true, "checks": true, "actions": false}'::jsonb,
  "revision" = CASE WHEN "revision" > 0 THEN "revision" + 1 ELSE 0 END,
  "updated_at" = now()
WHERE jsonb_typeof("ceiling") = 'object'
  AND NOT ("ceiling" @> '{"workflows": true, "checks": true, "actions": false}'::jsonb);
--> statement-breakpoint
UPDATE "agent_github_settings"
SET
  "features" = "features" || '{"workflows": true, "checks": true, "actions": false}'::jsonb,
  "actions_allow" = '[]'::jsonb,
  "revision" = "revision" + 1,
  "updated_at" = now()
WHERE jsonb_typeof("features") = 'object'
  AND (
    NOT ("features" @> '{"workflows": true, "checks": true, "actions": false}'::jsonb)
    OR "actions_allow" <> '[]'::jsonb
  );
