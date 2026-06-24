-- pgvector: required by the kb_chunks.embedding column + HNSW index below.
-- Installed into the current schema (public) so the unqualified `vector(1536)`
-- type resolves regardless of the migration connection's search_path.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kb_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"pathname" text NOT NULL,
	"url" text NOT NULL,
	"content_type" text,
	"bytes" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledgebases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"embedding_model" text DEFAULT 'openai/text-embedding-3-small' NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "knowledgebase_id" uuid;--> statement-breakpoint
CREATE INDEX "kb_chunks_kb_idx" ON "kb_chunks" USING btree ("kb_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_embedding_hnsw" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "kb_documents_kb_status_idx" ON "kb_documents" USING btree ("kb_id","status");--> statement-breakpoint
CREATE INDEX "knowledgebases_owner_idx" ON "knowledgebases" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "api_keys_kb_idx" ON "api_keys" USING btree ("knowledgebase_id");