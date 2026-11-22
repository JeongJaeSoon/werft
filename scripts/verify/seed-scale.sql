-- Large-list fixture for P-LIST-SCALE: clones rows that the API created
-- (one session, one agent, one team, one personal key) so every constraint
-- the API relies on already holds, then adds members as plain rows.
-- Run inside the run's own postgres only:
--   ap_compose exec -T postgres psql -U postgres -d sessions -v ON_ERROR_STOP=1 \
--     -v sessions=50000 -v agents=2000 -v members=2000 -v teams=300 \
--     -v team_members=500 -v keys=1000 < scripts/seed-scale.sql
-- Rows carry a "scale-" prefix; a second run adds nothing.
\set ON_ERROR_STOP 1
BEGIN;

CREATE TEMP TABLE scale_ctx ON COMMIT DROP AS
SELECT
  (SELECT id FROM sessions WHERE title NOT LIKE 'scale-%' ORDER BY created_at LIMIT 1) AS session_id,
  (SELECT id FROM agents WHERE slug NOT LIKE 'scale-%' ORDER BY created_at LIMIT 1) AS agent_id,
  (SELECT id FROM member_teams WHERE name NOT LIKE 'scale-%' ORDER BY created_at LIMIT 1) AS team_id,
  (SELECT id FROM api_keys WHERE kind = 'personal' AND coalesce(name, '') NOT LIKE 'scale-%' ORDER BY created_at LIMIT 1) AS key_id,
  (SELECT workspace_id FROM agents WHERE slug NOT LIKE 'scale-%' ORDER BY created_at LIMIT 1) AS workspace_id,
  NOT EXISTS (SELECT 1 FROM users WHERE email LIKE 'scale-%') AS fresh;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM scale_ctx WHERE session_id IS NULL OR agent_id IS NULL OR team_id IS NULL OR key_id IS NULL) THEN
    RAISE EXCEPTION 'seed-scale: create one session, agent, team and personal key through the API first';
  END IF;
END $$;

-- Members: users and their memberships, joined a minute apart.
INSERT INTO users (id, email, display_name, created_at)
SELECT gen_random_uuid(), format('scale-%s@example.test', g),
       format('scale-%s %s', g, (ARRAY['Kim','Lee','Park','Choi','Jung','Tanaka','Smith'])[1 + g % 7]),
       now() - g * interval '1 minute'
FROM generate_series(1, :members) g, scale_ctx WHERE scale_ctx.fresh;

INSERT INTO memberships (workspace_id, user_id, role, created_at)
SELECT c.workspace_id, u.id, 'member', u.created_at
FROM users u, scale_ctx c WHERE c.fresh AND u.email LIKE 'scale-%';

-- Teams, then one of them grown to :team_members members.
INSERT INTO member_teams
SELECT (jsonb_populate_record(NULL::member_teams, to_jsonb(t) || jsonb_build_object(
  'id', gen_random_uuid(), 'name', format('scale-team-%s', g),
  'created_at', now() - g * interval '1 minute'))).*
FROM member_teams t, scale_ctx c, generate_series(1, :teams) g
WHERE c.fresh AND t.id = c.team_id;

INSERT INTO member_team_members (id, workspace_id, team_id, user_id, added_at)
SELECT gen_random_uuid(), c.workspace_id, c.team_id, u.id, now()
FROM scale_ctx c,
     LATERAL (SELECT id FROM users WHERE email LIKE 'scale-%' ORDER BY email LIMIT :team_members) u
WHERE c.fresh;

-- Agents with no release, as a draft is.
INSERT INTO agents
SELECT (jsonb_populate_record(NULL::agents, to_jsonb(a) || jsonb_build_object(
  'id', gen_random_uuid(), 'slug', format('scale-agent-%s', g),
  'name', format('scale-%s %s', g, (ARRAY['reviewer','triage','deploy','writer','analyst'])[1 + g % 5]),
  'active_release_id', NULL, 'activation_revision', -1,
  'created_at', now() - g * interval '1 minute', 'updated_at', now()))).*
FROM agents a, scale_ctx c, generate_series(1, :agents) g
WHERE c.fresh AND a.id = c.agent_id;

-- Sessions of the template's agent release and owner; every tenth started
-- by a seeded member, so a member's list is a slice of the whole.
INSERT INTO sessions
SELECT (jsonb_populate_record(NULL::sessions, to_jsonb(s) || jsonb_build_object(
  'id', gen_random_uuid(),
  'title', format('scale-%s %s', g, (ARRAY['fix login bug','deploy api','write docs','triage alerts','refactor queue'])[1 + g % 5]),
  'pod_id', NULL,
  'created_by_user_id', CASE WHEN g % 10 = 0
    THEN (SELECT id FROM users WHERE email = format('scale-%s@example.test', 1 + g % :members))
    ELSE s.created_by_user_id END,
  'created_at', now() - g * interval '30 seconds', 'updated_at', now() - g * interval '30 seconds'))).*
FROM sessions s, scale_ctx c, generate_series(1, :sessions) g
WHERE c.fresh AND s.id = c.session_id;

INSERT INTO api_keys
SELECT (jsonb_populate_record(NULL::api_keys, to_jsonb(k) || jsonb_build_object(
  'id', gen_random_uuid(), 'name', format('scale-key-%s', g),
  'key_hash', '\x' || encode(sha256(convert_to(format('scale-key-%s-%s', g, random()), 'UTF8')), 'hex'),
  'created_at', now() - g * interval '1 minute'))).*
FROM api_keys k, scale_ctx c, generate_series(1, :keys) g
WHERE c.fresh AND k.id = c.key_id;

COMMIT;
ANALYZE;

SELECT 'sessions' AS rows, count(*) FROM sessions
UNION ALL SELECT 'agents', count(*) FROM agents
UNION ALL SELECT 'memberships', count(*) FROM memberships
UNION ALL SELECT 'member_teams', count(*) FROM member_teams
UNION ALL SELECT 'member_team_members', count(*) FROM member_team_members
UNION ALL SELECT 'api_keys', count(*) FROM api_keys;
