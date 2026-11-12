-- The login method a web session was signed in with, so that turning a
-- provider off can end exactly the sessions it made. Nullable with no
-- default and no foreign key: web_sessions grows, so the column must not
-- rewrite or scan it. Rows are not backfilled; a session without a method is
-- judged by the session lookup (resolveWebSession) instead.
ALTER TABLE "web_sessions" ADD COLUMN "login_method_id" uuid;--> statement-breakpoint
-- A user holds one subject per issuer. External rows have only ever been
-- made together with their user, so none should break this; if one does,
-- stop with a message that says what to look at rather than a bare
-- duplicate-key error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "login_methods"
    WHERE "kind" <> 'password'
    GROUP BY "user_id", "issuer"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'login_methods has a user with two external login methods of one issuer; remove the extra row (SELECT user_id, issuer, count(*) FROM login_methods WHERE kind <> ''password'' GROUP BY 1, 2 HAVING count(*) > 1) and run the migration again';
  END IF;
END
$$;--> statement-breakpoint
-- Also what the session lookup reads to learn whether a user has any
-- external method. login_methods is small and not on the growing-table list.
CREATE UNIQUE INDEX "login_methods_user_issuer_uniq" ON "login_methods" USING btree ("user_id","issuer") WHERE "login_methods"."kind" <> 'password';
