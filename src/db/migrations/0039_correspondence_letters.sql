CREATE TYPE "public"."correspondence_channel" AS ENUM('email', 'letter');--> statement-breakpoint
CREATE TYPE "public"."correspondence_kind" AS ENUM('outcome', 'evidence_request', 'revocation', 'certificate', 'general');--> statement-breakpoint
CREATE TYPE "public"."correspondence_status" AS ENUM('draft', 'sent');--> statement-breakpoint
CREATE TABLE "correspondence_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"template_id" uuid,
	"kind" "correspondence_kind" NOT NULL,
	"channel" "correspondence_channel" NOT NULL,
	"status" "correspondence_status" DEFAULT 'draft' NOT NULL,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"rendered_subject" text,
	"rendered_body" text,
	"recipient_name" text,
	"recipient_email" text,
	"message_id" uuid,
	"decision_id" uuid,
	"evidence_request_id" uuid,
	"certificate_id" uuid,
	"due_at" timestamp with time zone,
	"portal_token_hash" text,
	"portal_expires_at" timestamp with time zone,
	"pdf_object_key" text,
	"sent_by_user_id" uuid,
	"sent_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "correspondence_kind" NOT NULL,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_template_id_correspondence_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."correspondence_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_message_id_correspondence_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."correspondence_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_evidence_request_id_evidence_requests_id_fk" FOREIGN KEY ("evidence_request_id") REFERENCES "public"."evidence_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_items" ADD CONSTRAINT "correspondence_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_templates" ADD CONSTRAINT "correspondence_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_templates" ADD CONSTRAINT "correspondence_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correspondence_items_org_app_idx" ON "correspondence_items" USING btree ("organisation_id","application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_items_token_hash_uidx" ON "correspondence_items" USING btree ("portal_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "correspondence_templates_org_name_uidx" ON "correspondence_templates" USING btree ("organisation_id","name");--> statement-breakpoint
CREATE INDEX "correspondence_templates_org_kind_idx" ON "correspondence_templates" USING btree ("organisation_id","kind");