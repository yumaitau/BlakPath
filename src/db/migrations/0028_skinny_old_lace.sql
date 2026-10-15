CREATE TABLE "correspondence_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encryption_backfill_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cursor" text,
	"rows_encrypted" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "applications_org_reference_unique";--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD COLUMN "blind_index_wrapped_dek" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "reference_bidx" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "applicant_name_bidx" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "applicant_name_token_bidx" text[];--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "wording_snapshot" text;--> statement-breakpoint
ALTER TABLE "correspondence_messages" ADD CONSTRAINT "correspondence_messages_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encryption_backfill_runs" ADD CONSTRAINT "encryption_backfill_runs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correspondence_messages_org_idx" ON "correspondence_messages" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "encryption_backfill_runs_org_idx" ON "encryption_backfill_runs" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_org_reference_bidx_unique" ON "applications" USING btree ("organisation_id","reference_bidx");--> statement-breakpoint
CREATE INDEX "applications_org_name_bidx_idx" ON "applications" USING btree ("organisation_id","applicant_name_bidx");--> statement-breakpoint
CREATE INDEX "applications_name_token_bidx_gin" ON "applications" USING gin ("applicant_name_token_bidx");