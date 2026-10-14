CREATE TABLE "ai_governance_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"statement" text NOT NULL,
	"approved_by_user_id" uuid,
	"step_up_verified" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "destination" text;--> statement-breakpoint
ALTER TABLE "ai_governance_approvals" ADD CONSTRAINT "ai_governance_approvals_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_governance_approvals" ADD CONSTRAINT "ai_governance_approvals_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_governance_approvals_org_idx" ON "ai_governance_approvals" USING btree ("organisation_id");