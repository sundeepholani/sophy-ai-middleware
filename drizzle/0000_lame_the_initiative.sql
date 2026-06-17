CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_last4" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb,
	"monthly_token_cap" bigint,
	"rpm_limit" integer,
	"status" text DEFAULT 'active' NOT NULL,
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
	"content_type" text,
	"size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"name" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"bucket" text PRIMARY KEY NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
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
CREATE INDEX "api_keys_status_idx" ON "api_keys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "blob_uploads_key_idx" ON "blob_uploads" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "usage_events_key_time_idx" ON "usage_events" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_time_idx" ON "usage_events" USING btree ("created_at");