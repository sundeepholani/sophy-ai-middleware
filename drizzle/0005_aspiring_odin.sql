ALTER TABLE "api_keys" ADD COLUMN "monthly_cost_cap_usd" numeric(12, 4) DEFAULT 100;--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "monthly_token_cap";