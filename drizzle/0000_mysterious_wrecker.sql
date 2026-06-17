CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_last4" text NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rotated_from" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_prefix_unique" UNIQUE("key_prefix")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text DEFAULT 'admin' NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_uploads" (
	"pathname" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"content_type" text,
	"size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "quota_policies" (
	"api_key_id" uuid PRIMARY KEY NOT NULL,
	"monthly_token_cap" bigint,
	"monthly_cost_cap" numeric(14, 6),
	"rpm_limit" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_config_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"route_id" uuid NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"param_bounds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_id" uuid,
	"output_schema" jsonb,
	"fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" text DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'locked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"route_id" uuid,
	"route_name" text,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"status" text DEFAULT 'ok' NOT NULL,
	"response_kind" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"gateway_request_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_rollups" (
	"api_key_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_rollups_api_key_id_period_start_pk" PRIMARY KEY("api_key_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_config_versions" ADD CONSTRAINT "route_config_versions_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_config_versions" ADD CONSTRAINT "route_config_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_client_idx" ON "api_keys" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "blob_uploads_key_idx" ON "blob_uploads" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "prompt_versions_prompt_idx" ON "prompt_versions" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "route_config_route_idx" ON "route_config_versions" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "routes_client_name_idx" ON "routes" USING btree ("client_id","name");--> statement-breakpoint
CREATE INDEX "usage_events_key_time_idx" ON "usage_events" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_time_idx" ON "usage_events" USING btree ("created_at");