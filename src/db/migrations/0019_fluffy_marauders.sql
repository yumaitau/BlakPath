ALTER TABLE "organisation_settings" ADD COLUMN "agreement_reference" text;--> statement-breakpoint
ALTER TABLE "organisation_settings" ADD COLUMN "agreement_signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "staff_mfa_required" boolean DEFAULT false NOT NULL;