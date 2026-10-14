ALTER TABLE "organisations" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD COLUMN "cleared_reason" text;--> statement-breakpoint
ALTER TABLE "break_glass_requests" ADD COLUMN "denial_reason" text;