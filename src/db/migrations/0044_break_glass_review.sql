ALTER TABLE "break_glass_requests" ADD COLUMN "review_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "break_glass_requests" ADD COLUMN "reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "break_glass_requests" ADD COLUMN "review_notes" text;--> statement-breakpoint
ALTER TABLE "break_glass_requests" ADD CONSTRAINT "break_glass_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "break_glass_requests" VALIDATE CONSTRAINT "break_glass_requests_reviewed_by_user_id_users_id_fk";
