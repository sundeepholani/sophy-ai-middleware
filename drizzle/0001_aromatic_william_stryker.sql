CREATE TABLE "request_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"surface" text,
	"system_prompt" text,
	"request" jsonb,
	"response" text,
	"streamed" boolean DEFAULT false NOT NULL,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "log_content" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "request_logs_key_time_idx" ON "request_logs" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "request_logs_time_idx" ON "request_logs" USING btree ("created_at");