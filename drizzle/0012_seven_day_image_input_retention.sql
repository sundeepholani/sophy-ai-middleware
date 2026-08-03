ALTER TABLE "blob_uploads" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "blob_uploads" SET "expires_at" = "created_at" + interval '24 hours';--> statement-breakpoint
ALTER TABLE "blob_uploads" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '24 hours';--> statement-breakpoint
ALTER TABLE "blob_uploads" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "request_after_image_expiry" jsonb;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "image_inputs_expires_at" timestamp with time zone;--> statement-breakpoint

-- Existing canonical message arrays may contain complete image data URLs or
-- external/signed URLs. They have no precomputed seven-day copy, so discard the
-- image value during rollout while preserving every non-image message part.
WITH "redacted_requests" AS (
  SELECT
    "request_logs"."id",
    jsonb_agg(
      CASE
        WHEN jsonb_typeof("message"."item"->'content') = 'array' THEN
          jsonb_set(
            "message"."item",
            '{content}',
            (
              SELECT coalesce(
                jsonb_agg(
                  CASE
                    WHEN "part"."item"->>'type' = 'image' THEN
                      ("part"."item" - 'image') || jsonb_build_object(
                        'image',
                        jsonb_build_object('legacyImageInputDiscarded', true)
                      )
                    ELSE "part"."item"
                  END
                  ORDER BY "part"."ordinality"
                ),
                '[]'::jsonb
              )
              FROM jsonb_array_elements("message"."item"->'content')
                WITH ORDINALITY AS "part"("item", "ordinality")
            )
          )
        ELSE "message"."item"
      END
      ORDER BY "message"."ordinality"
    ) AS "request"
  FROM "request_logs"
  CROSS JOIN LATERAL jsonb_array_elements("request_logs"."request")
    WITH ORDINALITY AS "message"("item", "ordinality")
  WHERE jsonb_typeof("request_logs"."request") = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements("request_logs"."request") AS "existing_message"("item")
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof("existing_message"."item"->'content') = 'array'
            THEN "existing_message"."item"->'content'
          ELSE '[]'::jsonb
        END
      ) AS "existing_part"("item")
      WHERE "existing_part"."item"->>'type' = 'image'
    )
  GROUP BY "request_logs"."id"
)
UPDATE "request_logs"
SET "request" = "redacted_requests"."request"
FROM "redacted_requests"
WHERE "request_logs"."id" = "redacted_requests"."id";--> statement-breakpoint

-- A capped legacy preview cannot be parsed losslessly. If it contains evidence
-- of an image part, replace the entire preview rather than retaining partial
-- Base64 or a signed URL for the remainder of the 30-day text-log window.
UPDATE "request_logs"
SET "request" = jsonb_build_object(
  'truncated', true,
  'preview', '[legacy multimodal request discarded during seven-day image-input retention rollout]'
)
WHERE jsonb_typeof("request") = 'object'
  AND "request"->>'truncated' = 'true'
  AND (
    "request"->>'preview' ILIKE '%data:image/%'
    OR "request"->>'preview' ~ '"type"[[:space:]]*:[[:space:]]*"image"'
  );--> statement-breakpoint

CREATE INDEX "blob_uploads_expiry_idx" ON "blob_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "request_logs_image_inputs_expiry_idx" ON "request_logs" USING btree ("image_inputs_expires_at");--> statement-breakpoint
ALTER TABLE "blob_uploads" ADD CONSTRAINT "blob_uploads_expiry_check" CHECK ("blob_uploads"."expires_at" >= "blob_uploads"."created_at");--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_image_retention_pair_check" CHECK (("request_logs"."image_inputs_expires_at" is null and "request_logs"."request_after_image_expiry" is null)
          or ("request_logs"."image_inputs_expires_at" is not null and "request_logs"."request_after_image_expiry" is not null));--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_image_retention_max_check" CHECK ("request_logs"."image_inputs_expires_at" is null
          or "request_logs"."image_inputs_expires_at" <= "request_logs"."created_at" + interval '7 days');
