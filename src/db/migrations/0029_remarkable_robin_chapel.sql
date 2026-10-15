CREATE TYPE "public"."organisation_key_validation_status" AS ENUM('pending', 'passed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."organisation_key_status" ADD VALUE 'pending_validation';--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "validation_status" "organisation_key_validation_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "validation_failure" text;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "canary_ciphertext" text;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "last_health_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "last_health_state" text;