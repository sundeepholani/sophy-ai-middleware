CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"judge_model" text DEFAULT 'anthropic/claude-opus-4.8' NOT NULL,
	"notify_email" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"champion_model" text NOT NULL,
	"challenger_model" text NOT NULL,
	"judge_model" text NOT NULL,
	"target_n" integer DEFAULT 100 NOT NULL,
	"captured_n" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"usage_event_id" uuid,
	"surface" text,
	"system_prompt" text,
	"request" jsonb,
	"params" jsonb,
	"structured" boolean DEFAULT false NOT NULL,
	"output_schema" jsonb,
	"champion_output" text,
	"champion_cost_usd" numeric(12, 6),
	"champion_latency_ms" integer,
	"challenger_output" text,
	"challenger_cost_usd" numeric(12, 6),
	"challenger_latency_ms" integer,
	"judge_cost_usd" numeric(12, 6),
	"winner" text,
	"confidence" numeric(4, 3),
	"judge_reason" text,
	"order_swapped" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "eval_runs_key_status_idx" ON "eval_runs" USING btree ("api_key_id","status");--> statement-breakpoint
CREATE INDEX "eval_samples_run_status_idx" ON "eval_samples" USING btree ("run_id","status");