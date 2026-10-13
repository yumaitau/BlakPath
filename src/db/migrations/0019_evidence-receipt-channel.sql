CREATE TYPE "public"."evidence_receipt_channel" AS ENUM('post', 'in_person', 'email', 'other');--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "receipt_channel" "evidence_receipt_channel";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "received_on" date;--> statement-breakpoint
-- intake-officer and case-officer only. organisation-admin is not granted this.
INSERT INTO "permissions" ("key", "description", "category")
VALUES (
  'evidence:upload-on-behalf',
  'Record evidence received on behalf of an applicant (post, email, in person or other), on an application the actor can read.',
  'evidence'
)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_key")
SELECT gen_random_uuid(), "roles"."id", 'evidence:upload-on-behalf'
FROM "roles"
WHERE "roles"."slug" IN ('intake-officer', 'case-officer')
ON CONFLICT ("role_id", "permission_key") DO NOTHING;