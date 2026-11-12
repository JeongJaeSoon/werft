-- The OIDC providers people sign in with, one per issuer for the whole
-- installation. The client secret is a secret_values row owned by
-- login_provider:<id>, not a column here.
CREATE TABLE "login_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"issuer" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"jwks_uri" text NOT NULL,
	"userinfo_endpoint" text,
	"signing_algs" text[] NOT NULL,
	"iss_parameter_required" boolean NOT NULL,
	"pkce_advertised" boolean NOT NULL,
	"discovery_checked_at" timestamp with time zone NOT NULL,
	"client_id" text,
	"token_auth_method" text NOT NULL,
	"allowed_domains" text[] DEFAULT '{}' NOT NULL,
	"jit_role" text,
	"require_verified_email" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config_revision" integer DEFAULT 1 NOT NULL,
	"tested_config_revision" integer,
	"tested_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "login_providers_display_name_check" CHECK (length("login_providers"."display_name") BETWEEN 1 AND 64),
	CONSTRAINT "login_providers_token_auth_method_check" CHECK ("login_providers"."token_auth_method" IN ('client_secret_basic', 'client_secret_post')),
	CONSTRAINT "login_providers_jit_role_check" CHECK ("login_providers"."jit_role" IS NULL OR "login_providers"."jit_role" = 'member'),
	CONSTRAINT "login_providers_enabled_client_check" CHECK (NOT "login_providers"."enabled" OR "login_providers"."client_id" IS NOT NULL)
);
--> statement-breakpoint
-- Every external login method is an OIDC one, whichever provider issued it;
-- the row keeps its issuer and subject, so the person signs in as the same
-- user once a provider with that issuer is turned on. login_methods has a
-- row per user per method and is not on the growing-table list, so the
-- UPDATE and the new check run inside the migration.
--
-- Not readable by the release before this one: its Google sign-in looks for
-- kind = 'google' and finds nothing. To go back to it, put the kind back
-- first (CHANGELOG).
ALTER TABLE "login_methods" DROP CONSTRAINT "login_methods_kind_check";--> statement-breakpoint
UPDATE "login_methods" SET "kind" = 'oidc' WHERE "kind" = 'google';--> statement-breakpoint
ALTER TABLE "login_providers" ADD CONSTRAINT "login_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_providers_issuer_uniq" ON "login_providers" USING btree ("issuer");--> statement-breakpoint
ALTER TABLE "login_methods" ADD CONSTRAINT "login_methods_kind_check" CHECK ("login_methods"."kind" IN ('password', 'oidc'));