CREATE TYPE "public"."import_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"requested_session_id" uuid NOT NULL,
	"kind" text DEFAULT 'applications' NOT NULL,
	"file_name" text,
	"file_sha256" text NOT NULL,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"total_rows" integer NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"includes_outcomes" boolean DEFAULT false NOT NULL,
	"includes_certificates" boolean DEFAULT false NOT NULL,
	"staged_rows" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "import_job_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "recorded_before_blakpath" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "legacy_recorded_by" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "issued_before_blakpath" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_org_created_idx" ON "import_jobs" USING btree ("organisation_id","created_at");--> statement-breakpoint
CREATE INDEX "import_jobs_org_status_idx" ON "import_jobs" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_org_external_reference_unique" ON "applications" USING btree ("organisation_id","external_reference");