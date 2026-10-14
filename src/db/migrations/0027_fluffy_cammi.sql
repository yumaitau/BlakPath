CREATE TYPE "public"."key_custody_mode" AS ENUM('blakpath_managed', 'client_owned', 'client_owned_escrow');--> statement-breakpoint
CREATE TYPE "public"."organisation_key_status" AS ENUM('active', 'disabled', 'pending_deletion', 'unavailable');--> statement-breakpoint
CREATE TABLE "organisation_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"custody_mode" "key_custody_mode" NOT NULL,
	"kms_key_arn" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"status" "organisation_key_status" DEFAULT 'active' NOT NULL,
	"escrow" boolean DEFAULT false NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD CONSTRAINT "organisation_keys_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_keys_org_unique" ON "organisation_keys" USING btree ("organisation_id");