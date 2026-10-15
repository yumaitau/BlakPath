ALTER TABLE "passkeys" ADD COLUMN "aaguid" text;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factors" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Accounts that already have a factor row are enrolled.
UPDATE "users" AS u
SET "two_factor_enabled" = true
WHERE EXISTS (
  SELECT 1 FROM "two_factors" AS tf WHERE tf."user_id" = u."id"
);