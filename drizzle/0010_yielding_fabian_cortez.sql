-- Convert the original single-tenant installation into a deterministic
-- legacy project without changing any existing Sophy key secret material.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: duplicate normalized user emails';
  END IF;

  IF EXISTS (SELECT 1 FROM users WHERE role NOT IN ('admin', 'editor')) THEN
    RAISE EXCEPTION 'multi-tenant preflight: invalid user role';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE status NOT IN ('active', 'inactive')) THEN
    RAISE EXCEPTION 'multi-tenant preflight: invalid user status';
  END IF;
  IF (
    EXISTS (SELECT 1 FROM users)
    OR EXISTS (SELECT 1 FROM login_tokens)
    OR EXISTS (SELECT 1 FROM api_keys)
    OR EXISTS (SELECT 1 FROM usage_events)
    OR EXISTS (SELECT 1 FROM usage_rollups)
    OR EXISTS (SELECT 1 FROM request_logs)
    OR EXISTS (SELECT 1 FROM blob_uploads)
    OR EXISTS (SELECT 1 FROM eval_runs)
    OR EXISTS (SELECT 1 FROM eval_samples)
    OR EXISTS (SELECT 1 FROM knowledgebases)
    OR EXISTS (SELECT 1 FROM kb_documents)
    OR EXISTS (SELECT 1 FROM kb_chunks)
    OR EXISTS (SELECT 1 FROM audit_log)
  ) AND NOT EXISTS (
    SELECT 1 FROM users WHERE role = 'admin' AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: at least one active admin is required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM login_tokens t
    LEFT JOIN users u ON u.id = t.user_id
    WHERE u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan login token';
  END IF;
  IF EXISTS (
    SELECT 1 FROM api_keys k
    LEFT JOIN users u ON u.id = k.owner_user_id
    WHERE k.owner_user_id IS NOT NULL AND u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan API key owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM api_keys k
    LEFT JOIN knowledgebases kb ON kb.id = k.knowledgebase_id
    WHERE k.knowledgebase_id IS NOT NULL AND kb.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan API key knowledgebase';
  END IF;
  IF EXISTS (
    SELECT 1 FROM usage_events e
    LEFT JOIN api_keys k ON k.id = e.api_key_id
    WHERE e.api_key_id IS NOT NULL AND k.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan usage event API key';
  END IF;
  IF EXISTS (
    SELECT 1 FROM usage_rollups r
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    WHERE k.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan usage rollup API key';
  END IF;
  IF EXISTS (
    SELECT 1 FROM request_logs l
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    LEFT JOIN usage_events e ON e.id = l.id
    WHERE k.id IS NULL OR e.id IS NULL OR e.api_key_id IS DISTINCT FROM l.api_key_id
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan or mismatched request log';
  END IF;
  IF EXISTS (
    SELECT 1 FROM blob_uploads b
    LEFT JOIN api_keys k ON k.id = b.api_key_id
    WHERE k.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan blob upload API key';
  END IF;
  IF EXISTS (
    SELECT 1 FROM eval_runs r
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    WHERE k.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan eval run API key';
  END IF;
  IF EXISTS (
    SELECT 1 FROM eval_samples s
    LEFT JOIN eval_runs r ON r.id = s.run_id
    LEFT JOIN usage_events e ON e.id = s.usage_event_id
    WHERE r.id IS NULL OR (s.usage_event_id IS NOT NULL AND e.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan eval sample';
  END IF;
  IF EXISTS (
    SELECT 1 FROM knowledgebases kb
    LEFT JOIN users u ON u.id = kb.owner_user_id
    WHERE kb.owner_user_id IS NOT NULL AND u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan knowledgebase owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kb_documents d
    LEFT JOIN knowledgebases kb ON kb.id = d.kb_id
    WHERE kb.id IS NULL
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan knowledgebase document';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kb_chunks c
    LEFT JOIN kb_documents d ON d.id = c.document_id
    LEFT JOIN knowledgebases kb ON kb.id = c.kb_id
    WHERE d.id IS NULL OR kb.id IS NULL OR d.kb_id IS DISTINCT FROM c.kb_id
  ) THEN
    RAISE EXCEPTION 'multi-tenant preflight: orphan or mismatched knowledgebase chunk';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_by_user_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "current_gateway_credential_id" uuid,
  "gateway_credential_revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "suspended_at" timestamp with time zone,
  "archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
  "project_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_gateway_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "source" text NOT NULL,
  "lifecycle" text DEFAULT 'available' NOT NULL,
  "health" text DEFAULT 'unchecked' NOT NULL,
  "encrypted_secret" text,
  "encryption_nonce" text,
  "encryption_tag" text,
  "encryption_key_version" text,
  "secret_fingerprint" text,
  "secret_last_four" text,
  "verified_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "last_failure_code" text,
  "created_by_user_id" uuid,
  "replaced_at" timestamp with time zone,
  "disconnected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_settings" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "judge_model" text DEFAULT 'anthropic/claude-opus-4.8' NOT NULL,
  "notify_email" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "invited_by_user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "purpose" text DEFAULT 'signup' NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "eval_samples" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "knowledgebases" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "gateway_credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "project_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_project_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;
--> statement-breakpoint
INSERT INTO projects (
  id, name, slug, status, gateway_credential_revision
) SELECT
  '57c16e84-0317-4db5-9282-d25f1d25fb0a',
  'Legacy',
  'legacy',
  'active',
  1
WHERE EXISTS (SELECT 1 FROM users);
--> statement-breakpoint
INSERT INTO project_gateway_credentials (
  id,
  project_id,
  source,
  lifecycle,
  health,
  verified_at,
  last_checked_at
) SELECT
  '57c16e84-0317-4db5-9282-d25f1d25fb0b',
  '57c16e84-0317-4db5-9282-d25f1d25fb0a',
  'platform_env',
  'available',
  'healthy',
  now(),
  now()
WHERE EXISTS (SELECT 1 FROM users);
--> statement-breakpoint
UPDATE projects
SET current_gateway_credential_id = '57c16e84-0317-4db5-9282-d25f1d25fb0b'
WHERE id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
INSERT INTO project_memberships (project_id, user_id, role, status, joined_at)
SELECT
  '57c16e84-0317-4db5-9282-d25f1d25fb0a',
  id,
  CASE WHEN role = 'admin' THEN 'admin' ELSE 'editor' END,
  'active',
  created_at
FROM users;
--> statement-breakpoint
INSERT INTO project_settings (project_id, judge_model, notify_email, updated_at)
SELECT
  '57c16e84-0317-4db5-9282-d25f1d25fb0a',
  coalesce(
    (SELECT judge_model FROM app_settings WHERE id = 'global'),
    'anthropic/claude-opus-4.8'
  ),
  (SELECT notify_email FROM app_settings WHERE id = 'global'),
  coalesce(
    (SELECT updated_at FROM app_settings WHERE id = 'global'),
    now()
  )
WHERE EXISTS (SELECT 1 FROM users);
--> statement-breakpoint
UPDATE users
SET
  email = lower(btrim(email)),
  default_project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a',
  onboarded_at = coalesce(onboarded_at, created_at, now());
--> statement-breakpoint
UPDATE knowledgebases
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE api_keys
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE usage_events
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE usage_rollups
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE request_logs
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE blob_uploads
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE eval_runs
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
UPDATE eval_samples s
SET project_id = r.project_id
FROM eval_runs r
WHERE r.id = s.run_id;
--> statement-breakpoint
UPDATE kb_documents d
SET project_id = kb.project_id
FROM knowledgebases kb
WHERE kb.id = d.kb_id;
--> statement-breakpoint
UPDATE kb_chunks c
SET project_id = d.project_id
FROM kb_documents d
WHERE d.id = c.document_id;
--> statement-breakpoint
UPDATE audit_log
SET project_id = '57c16e84-0317-4db5-9282-d25f1d25fb0a';
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "blob_uploads" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_runs" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "eval_samples" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_chunks" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_documents" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledgebases" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "request_logs" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_rollups" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "usage_rollups" DROP CONSTRAINT "usage_rollups_api_key_id_period_start_pk";
--> statement-breakpoint
ALTER TABLE "usage_rollups"
  ADD CONSTRAINT "usage_rollups_project_id_api_key_id_period_start_pk"
  PRIMARY KEY("project_id","api_key_id","period_start");
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_idx" ON "projects" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_id_current_gateway_idx"
  ON "projects" USING btree ("id","current_gateway_credential_id");
--> statement-breakpoint
CREATE INDEX "project_memberships_user_status_idx"
  ON "project_memberships" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX "project_memberships_project_role_idx"
  ON "project_memberships" USING btree ("project_id","role","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_gateway_credentials_project_id_idx"
  ON "project_gateway_credentials" USING btree ("project_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_gateway_credentials_one_available_idx"
  ON "project_gateway_credentials" USING btree ("project_id")
  WHERE "lifecycle" = 'available';
--> statement-breakpoint
CREATE UNIQUE INDEX "project_gateway_credentials_fingerprint_idx"
  ON "project_gateway_credentials" USING btree ("secret_fingerprint")
  WHERE "lifecycle" = 'available' AND "secret_fingerprint" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "project_gateway_credentials_project_created_idx"
  ON "project_gateway_credentials" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_token_idx"
  ON "project_invitations" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_one_live_idx"
  ON "project_invitations" USING btree ("project_id","email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "project_invitations_project_idx"
  ON "project_invitations" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_intents_token_idx"
  ON "auth_intents" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "auth_intents_email_idx"
  ON "auth_intents" USING btree ("email","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_project_id_idx"
  ON "api_keys" USING btree ("project_id","id");
--> statement-breakpoint
CREATE INDEX "api_keys_project_status_idx"
  ON "api_keys" USING btree ("project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_project_id_idx"
  ON "usage_events" USING btree ("project_id","id");
--> statement-breakpoint
CREATE INDEX "usage_events_project_time_idx"
  ON "usage_events" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX "usage_events_gateway_credential_idx"
  ON "usage_events" USING btree ("gateway_credential_id");
--> statement-breakpoint
CREATE INDEX "request_logs_project_time_idx"
  ON "request_logs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX "blob_uploads_project_idx"
  ON "blob_uploads" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "eval_runs_project_id_idx"
  ON "eval_runs" USING btree ("project_id","id");
--> statement-breakpoint
CREATE INDEX "eval_runs_project_status_idx"
  ON "eval_runs" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX "eval_samples_project_status_idx"
  ON "eval_samples" USING btree ("project_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledgebases_project_id_idx"
  ON "knowledgebases" USING btree ("project_id","id");
--> statement-breakpoint
CREATE INDEX "knowledgebases_project_idx"
  ON "knowledgebases" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_project_id_idx"
  ON "kb_documents" USING btree ("project_id","id");
--> statement-breakpoint
CREATE INDEX "kb_documents_project_status_idx"
  ON "kb_documents" USING btree ("project_id","status");
--> statement-breakpoint
CREATE INDEX "kb_chunks_project_idx"
  ON "kb_chunks" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "audit_log_project_time_idx"
  ON "audit_log" USING btree ("project_id","created_at");
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_created_by_user_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_current_gateway_credential_fk"
  FOREIGN KEY ("id","current_gateway_credential_id")
  REFERENCES "public"."project_gateway_credentials"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_memberships"
  ADD CONSTRAINT "project_memberships_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_memberships"
  ADD CONSTRAINT "project_memberships_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_gateway_credentials"
  ADD CONSTRAINT "project_gateway_credentials_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_gateway_credentials"
  ADD CONSTRAINT "project_gateway_credentials_creator_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_settings"
  ADD CONSTRAINT "project_settings_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_inviter_fk"
  FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_acceptor_fk"
  FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_default_project_membership_fk"
  FOREIGN KEY ("default_project_id","id")
  REFERENCES "public"."project_memberships"("project_id","user_id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "login_tokens"
  ADD CONSTRAINT "login_tokens_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_owner_membership_fk"
  FOREIGN KEY ("project_id","owner_user_id")
  REFERENCES "public"."project_memberships"("project_id","user_id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_knowledgebase_fk"
  FOREIGN KEY ("project_id","knowledgebase_id")
  REFERENCES "public"."knowledgebases"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ADD CONSTRAINT "usage_events_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ADD CONSTRAINT "usage_events_api_key_fk"
  FOREIGN KEY ("project_id","api_key_id")
  REFERENCES "public"."api_keys"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_events"
  ADD CONSTRAINT "usage_events_gateway_credential_fk"
  FOREIGN KEY ("project_id","gateway_credential_id")
  REFERENCES "public"."project_gateway_credentials"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "usage_rollups"
  ADD CONSTRAINT "usage_rollups_api_key_fk"
  FOREIGN KEY ("project_id","api_key_id")
  REFERENCES "public"."api_keys"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "request_logs"
  ADD CONSTRAINT "request_logs_usage_event_fk"
  FOREIGN KEY ("project_id","id")
  REFERENCES "public"."usage_events"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "request_logs"
  ADD CONSTRAINT "request_logs_api_key_fk"
  FOREIGN KEY ("project_id","api_key_id")
  REFERENCES "public"."api_keys"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "blob_uploads"
  ADD CONSTRAINT "blob_uploads_api_key_fk"
  FOREIGN KEY ("project_id","api_key_id")
  REFERENCES "public"."api_keys"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_runs"
  ADD CONSTRAINT "eval_runs_api_key_fk"
  FOREIGN KEY ("project_id","api_key_id")
  REFERENCES "public"."api_keys"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_samples"
  ADD CONSTRAINT "eval_samples_run_fk"
  FOREIGN KEY ("project_id","run_id")
  REFERENCES "public"."eval_runs"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledgebases"
  ADD CONSTRAINT "knowledgebases_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledgebases"
  ADD CONSTRAINT "knowledgebases_owner_membership_fk"
  FOREIGN KEY ("project_id","owner_user_id")
  REFERENCES "public"."project_memberships"("project_id","user_id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_documents"
  ADD CONSTRAINT "kb_documents_knowledgebase_fk"
  FOREIGN KEY ("project_id","kb_id")
  REFERENCES "public"."knowledgebases"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_chunks"
  ADD CONSTRAINT "kb_chunks_document_fk"
  FOREIGN KEY ("project_id","document_id")
  REFERENCES "public"."kb_documents"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_chunks"
  ADD CONSTRAINT "kb_chunks_knowledgebase_fk"
  FOREIGN KEY ("project_id","kb_id")
  REFERENCES "public"."knowledgebases"("project_id","id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_project_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eval_samples"
  ADD CONSTRAINT "eval_samples_usage_event_fk"
  FOREIGN KEY ("project_id","usage_event_id")
  REFERENCES "public"."usage_events"("project_id","id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_intents"
  ADD CONSTRAINT "auth_intents_purpose_check"
    CHECK ("purpose" = 'signup'),
  ADD CONSTRAINT "auth_intents_email_normalized_check"
    CHECK ("email" = lower(btrim("email")));
--> statement-breakpoint
ALTER TABLE "project_gateway_credentials"
  ADD CONSTRAINT "project_gateway_credentials_source_check"
    CHECK ("source" in ('encrypted_api_key', 'platform_env')),
  ADD CONSTRAINT "project_gateway_credentials_lifecycle_check"
    CHECK ("lifecycle" in ('available', 'replaced', 'disconnected')),
  ADD CONSTRAINT "project_gateway_credentials_health_check"
    CHECK ("health" in ('unchecked', 'healthy', 'invalid', 'billing_attention')),
  ADD CONSTRAINT "project_gateway_credentials_platform_scope_check"
    CHECK (
      "source" <> 'platform_env'
      or "project_id" = '57c16e84-0317-4db5-9282-d25f1d25fb0a'::uuid
    ),
  ADD CONSTRAINT "project_gateway_credentials_envelope_check" CHECK (
    (
      "source" = 'platform_env'
      and "encrypted_secret" is null
      and "encryption_nonce" is null
      and "encryption_tag" is null
      and "encryption_key_version" is null
      and "secret_fingerprint" is null
      and "created_by_user_id" is null
    ) or (
      "source" = 'encrypted_api_key'
      and "encryption_key_version" is not null
      and "secret_fingerprint" is not null
      and "created_by_user_id" is not null
      and (
        (
          "lifecycle" = 'available'
          and "encrypted_secret" is not null
          and "encryption_nonce" is not null
          and "encryption_tag" is not null
        ) or (
          "lifecycle" in ('replaced', 'disconnected')
          and "encrypted_secret" is null
          and "encryption_nonce" is null
          and "encryption_tag" is null
        )
      )
    )
  );
--> statement-breakpoint
ALTER TABLE "project_invitations"
  ADD CONSTRAINT "project_invitations_role_check"
    CHECK ("role" in ('admin', 'editor')),
  ADD CONSTRAINT "project_invitations_email_normalized_check"
    CHECK ("email" = lower(btrim("email")));
--> statement-breakpoint
ALTER TABLE "project_memberships"
  ADD CONSTRAINT "project_memberships_role_check"
    CHECK ("role" in ('admin', 'editor')),
  ADD CONSTRAINT "project_memberships_status_check"
    CHECK ("status" in ('active', 'suspended'));
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_status_check"
  CHECK ("status" in ('active', 'suspended', 'archived'));
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_normalized_check"
  CHECK ("email" = lower(btrim("email")));
