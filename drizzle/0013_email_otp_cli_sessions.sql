CREATE TABLE "cli_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"invitation_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_challenges_attempts_check" CHECK ("login_challenges"."attempts" between 0 and 5),
	CONSTRAINT "login_challenges_email_check" CHECK ("login_challenges"."email" = lower(btrim("login_challenges"."email")))
);
--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_invitation_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."project_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_token_idx" ON "cli_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cli_sessions_user_idx" ON "cli_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cli_sessions_expiry_idx" ON "cli_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cli_sessions_revoked_idx" ON "cli_sessions" USING btree ("revoked_at") WHERE "cli_sessions"."revoked_at" is not null;--> statement-breakpoint
CREATE INDEX "login_challenges_email_created_idx" ON "login_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_retention_idx" ON "login_challenges" USING btree ("created_at");