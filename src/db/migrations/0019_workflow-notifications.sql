ALTER TABLE "memberships" ADD COLUMN "email_notifications" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_requests" ADD COLUMN "overdue_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "evidence_requests_org_status_due_idx" ON "evidence_requests" USING btree ("organisation_id","status","due_at");