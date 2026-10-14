CREATE TYPE "public"."organisation_key_rewrap_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "destruction_certificates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kms_key_arn" text NOT NULL,
	"key_version" integer NOT NULL,
	"certificate" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_key_rewraps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"from_kms_key_arn" text NOT NULL,
	"from_key_version" integer NOT NULL,
	"to_kms_key_arn" text NOT NULL,
	"to_key_version" integer NOT NULL,
	"status" "organisation_key_rewrap_status" DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'fields' NOT NULL,
	"fields_done" integer DEFAULT 0 NOT NULL,
	"fields_total" integer,
	"objects_done" integer DEFAULT 0 NOT NULL,
	"objects_total" integer,
	"field_cursor" text,
	"object_cursor" text,
	"last_error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_encrypted_fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"row_id" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "previous_kms_key_arn" text;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "previous_key_version" integer;--> statement-breakpoint
ALTER TABLE "organisation_key_rewraps" ADD CONSTRAINT "organisation_key_rewraps_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_encrypted_fields" ADD CONSTRAINT "tenant_encrypted_fields_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "destruction_certificates_org_idx" ON "destruction_certificates" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "organisation_key_rewraps_org_status_idx" ON "organisation_key_rewraps" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_encrypted_fields_binding_unique" ON "tenant_encrypted_fields" USING btree ("organisation_id","table_name","column_name","row_id");--> statement-breakpoint
CREATE INDEX "tenant_encrypted_fields_org_id_idx" ON "tenant_encrypted_fields" USING btree ("organisation_id","id");