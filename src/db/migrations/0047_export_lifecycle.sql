ALTER TYPE "public"."export_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TABLE "export_requests" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "export_requests" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;