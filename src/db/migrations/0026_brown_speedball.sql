ALTER TABLE "membership_invitations" ADD COLUMN "token_seal" jsonb;--> statement-breakpoint
ALTER TABLE "form_invitations" ADD COLUMN "token_seal" jsonb;