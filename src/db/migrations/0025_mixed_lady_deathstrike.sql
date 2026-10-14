ALTER TABLE "certificates" ADD COLUMN "holder_binding_salt" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "holder_name_hash" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "holder_dob_hash" text;