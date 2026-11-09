-- A release is insert-only apart from its first approval (0139). The spec
-- backfill needs one more write: the four spec columns, once, from NULL. Any
-- other change, or a change to a spec already stored, is still refused.
CREATE OR REPLACE FUNCTION "agent_releases_approve_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."approved_by" IS NULL
     AND (to_jsonb(NEW) - 'approved_by' - 'approved_at')
       = (to_jsonb(OLD) - 'approved_by' - 'approved_at') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."runtime_spec" IS NULL
     AND (to_jsonb(NEW) - 'runtime_spec' - 'spec_source' - 'spec_source_digest' - 'spec_digest')
       = (to_jsonb(OLD) - 'runtime_spec' - 'spec_source' - 'spec_source_digest' - 'spec_digest') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_releases rows are insert-only apart from their first approval and their first spec'
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
