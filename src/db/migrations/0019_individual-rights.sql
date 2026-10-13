CREATE TYPE "public"."rights_request_status" AS ENUM('received', 'in_progress', 'completed', 'refused', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."rights_request_type" AS ENUM('access', 'correction', 'complaint', 'withdrawal', 'erasure');--> statement-breakpoint
CREATE TYPE "public"."tenant_offboarding_status" AS ENUM('export_queued', 'exported', 'purge_queued', 'purged');--> statement-breakpoint
CREATE TABLE "associated_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"field" text,
	"statement" text NOT NULL,
	"recorded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rights_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"type" "rights_request_type" NOT NULL,
	"status" "rights_request_status" DEFAULT 'received' NOT NULL,
	"subject_client_id" uuid,
	"subject_user_id" uuid,
	"requester_name" text NOT NULL,
	"requester_contact" text,
	"details" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"extension_reason" text,
	"assigned_to_user_id" uuid,
	"logged_by_user_id" uuid,
	"outcome" text,
	"erased_at" timestamp with time zone,
	"erasure_report" jsonb,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_offboardings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"organisation_slug" text NOT NULL,
	"status" "tenant_offboarding_status" DEFAULT 'export_queued' NOT NULL,
	"requested_by_user_id" uuid,
	"export_object_key" text,
	"export_sha256" text,
	"export_row_count" bigint,
	"manifest" jsonb,
	"exported_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"purge_confirmed_by_user_id" uuid,
	"purge_confirmed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "associated_statements" ADD CONSTRAINT "associated_statements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "associated_statements" ADD CONSTRAINT "associated_statements_request_id_rights_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."rights_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "associated_statements" ADD CONSTRAINT "associated_statements_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_subject_client_id_clients_id_fk" FOREIGN KEY ("subject_client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_logged_by_user_id_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_offboardings" ADD CONSTRAINT "tenant_offboardings_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_offboardings" ADD CONSTRAINT "tenant_offboardings_purge_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("purge_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "associated_statements_org_resource_idx" ON "associated_statements" USING btree ("organisation_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "rights_requests_org_status_due_idx" ON "rights_requests" USING btree ("organisation_id","status","due_at");--> statement-breakpoint
CREATE INDEX "rights_requests_org_client_idx" ON "rights_requests" USING btree ("organisation_id","subject_client_id");--> statement-breakpoint
CREATE INDEX "rights_requests_org_user_idx" ON "rights_requests" USING btree ("organisation_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "tenant_offboardings_org_idx" ON "tenant_offboardings" USING btree ("organisation_id");