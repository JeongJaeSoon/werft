import { sql } from "drizzle-orm";

const CARD_REFS_TEXT = `v.card -> 'capabilities' -> 'credential_refs'`;
const CARD_SERVER_TEXT = `v.card #>> '{capabilities,mcp,0,server}'`;
const START_REFS_TEXT = `s.mcp_start -> 'credential_refs'`;
// A selection could pick another catalog server than the card's.
const START_SERVER_TEXT = `s.mcp_start ->> 'server'`;

// `refs` as a jsonb array less the credential name of the retired catalog
// server `server` names (`retired_catalog_mcp`).
const withoutRetiredRef = (refs: string, server: string) =>
  `(SELECT COALESCE(jsonb_agg(e.ref ORDER BY e.at), '[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${refs}) = 'array' THEN ${refs} ELSE '[]'::jsonb END) WITH ORDINALITY AS e(ref, at)
    WHERE (e.ref #>> '{}') IS DISTINCT FROM (
      SELECT rc.credential_ref FROM retired_catalog_mcp rc
      WHERE rc.name = ${server}
    ))`;

/**
 * The credential names a release needs, as a jsonb array: its card's, less
 * the one the retired catalog server the card names used. `v` is the
 * release's version. Written out with aliases: inside a select list drizzle
 * renders a column without its table, which is ambiguous once the subquery
 * joins.
 */
export const RELEASE_CARD_REFS = sql.raw(
  withoutRetiredRef(CARD_REFS_TEXT, CARD_SERVER_TEXT),
);

/**
 * The names a session needs: the snapshot it started with when it has one
 * (a catalog selection could narrow the card's), less the retired server
 * that snapshot names; else its release's card, less the card's. `s` is the
 * session, `v` its release's version.
 */
export const SESSION_REFS = sql.raw(
  `CASE WHEN jsonb_typeof(${START_REFS_TEXT}) = 'array' THEN ${withoutRetiredRef(START_REFS_TEXT, START_SERVER_TEXT)} ELSE ${withoutRetiredRef(CARD_REFS_TEXT, CARD_SERVER_TEXT)} END`,
);
