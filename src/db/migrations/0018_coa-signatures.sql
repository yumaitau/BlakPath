ALTER TABLE "certificates" ADD COLUMN "payload_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "signing_algorithm" text;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "signing_key_id" text;