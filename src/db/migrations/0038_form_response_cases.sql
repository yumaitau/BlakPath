ALTER TABLE "evidence" ALTER COLUMN "application_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "form_invitation_id" uuid;--> statement-breakpoint
ALTER TABLE "form_invitations" ADD COLUMN "draft_answers" jsonb;--> statement-breakpoint
ALTER TABLE "form_invitations" ADD COLUMN "draft_saved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "form_invitations" ADD COLUMN "draft_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "form_responses" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_form_invitation_id_form_invitations_id_fk" FOREIGN KEY ("form_invitation_id") REFERENCES "public"."form_invitations"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "evidence" VALIDATE CONSTRAINT "evidence_form_invitation_id_form_invitations_id_fk";--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "form_responses" VALIDATE CONSTRAINT "form_responses_application_id_applications_id_fk";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "evidence_org_form_invitation_idx" ON "evidence" USING btree ("organisation_id","form_invitation_id");--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "form_responses_org_application_idx" ON "form_responses" USING btree ("organisation_id","application_id");
