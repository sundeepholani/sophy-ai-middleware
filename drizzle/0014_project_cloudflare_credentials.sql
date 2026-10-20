CREATE TABLE "project_cloudflare_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"lifecycle" text DEFAULT 'available' NOT NULL,
	"health" text DEFAULT 'unchecked' NOT NULL,
	"encrypted_secret" text,
	"encryption_nonce" text,
	"encryption_tag" text,
	"encryption_key_version" text NOT NULL,
	"secret_fingerprint" text NOT NULL,
	"secret_last_four" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_failure_code" text,
	"created_by_user_id" uuid NOT NULL,
	"replaced_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_cloudflare_credentials_account_id_check" CHECK ("project_cloudflare_credentials"."account_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "project_cloudflare_credentials_lifecycle_check" CHECK ("project_cloudflare_credentials"."lifecycle" in ('available', 'replaced', 'disconnected')),
	CONSTRAINT "project_cloudflare_credentials_health_check" CHECK ("project_cloudflare_credentials"."health" in ('unchecked', 'healthy', 'invalid', 'billing_attention')),
	CONSTRAINT "project_cloudflare_credentials_envelope_check" CHECK ((
        "project_cloudflare_credentials"."lifecycle" = 'available'
        and "project_cloudflare_credentials"."encrypted_secret" is not null
        and "project_cloudflare_credentials"."encryption_nonce" is not null
        and "project_cloudflare_credentials"."encryption_tag" is not null
      ) or (
        "project_cloudflare_credentials"."lifecycle" in ('replaced', 'disconnected')
        and "project_cloudflare_credentials"."encrypted_secret" is null
        and "project_cloudflare_credentials"."encryption_nonce" is null
        and "project_cloudflare_credentials"."encryption_tag" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "current_cloudflare_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cloudflare_credential_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cloudflare_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "project_cloudflare_credentials" ADD CONSTRAINT "project_cloudflare_credentials_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cloudflare_credentials" ADD CONSTRAINT "project_cloudflare_credentials_creator_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_cloudflare_credentials_project_id_idx" ON "project_cloudflare_credentials" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_cloudflare_credentials_one_available_idx" ON "project_cloudflare_credentials" USING btree ("project_id") WHERE "project_cloudflare_credentials"."lifecycle" = 'available';--> statement-breakpoint
CREATE UNIQUE INDEX "project_cloudflare_credentials_fingerprint_idx" ON "project_cloudflare_credentials" USING btree ("secret_fingerprint") WHERE "project_cloudflare_credentials"."lifecycle" = 'available';--> statement-breakpoint
CREATE INDEX "project_cloudflare_credentials_project_created_idx" ON "project_cloudflare_credentials" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_cloudflare_credential_fk" FOREIGN KEY ("id","current_cloudflare_credential_id") REFERENCES "public"."project_cloudflare_credentials"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_cloudflare_credential_fk" FOREIGN KEY ("project_id","cloudflare_credential_id") REFERENCES "public"."project_cloudflare_credentials"("project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_id_current_cloudflare_idx" ON "projects" USING btree ("id","current_cloudflare_credential_id");--> statement-breakpoint
CREATE INDEX "usage_events_cloudflare_credential_idx" ON "usage_events" USING btree ("cloudflare_credential_id");--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_single_credential_check" CHECK ("usage_events"."gateway_credential_id" is null or "usage_events"."cloudflare_credential_id" is null);