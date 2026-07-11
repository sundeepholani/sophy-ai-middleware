ALTER TABLE "usage_events" ALTER COLUMN "api_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "source" text DEFAULT 'proxy' NOT NULL;