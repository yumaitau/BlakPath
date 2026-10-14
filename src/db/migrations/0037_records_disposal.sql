ALTER TYPE "public"."retention_action" ADD VALUE 'retain';--> statement-breakpoint
CREATE TABLE "destruction_register" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"disposal_class" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"authority_reference" text NOT NULL,
	"policy_id" uuid NOT NULL,
	"destroyed_at" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposal_authority_signoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"disposal_class" text NOT NULL,
	"catalogue_version" text NOT NULL,
	"authority_reference" text NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"minimum_retention_days" integer,
	"notes" text,
	"signed_off_by_user_id" uuid NOT NULL,
	"signed_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "retention_days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "retention_policies" ALTER COLUMN "active" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "disposal_class" text;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "approved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "destruction_register" ADD CONSTRAINT "destruction_register_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_register" ADD CONSTRAINT "destruction_register_policy_id_retention_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retention_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authority_signoffs" ADD CONSTRAINT "disposal_authority_signoffs_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposal_authority_signoffs" ADD CONSTRAINT "disposal_authority_signoffs_signed_off_by_user_id_users_id_fk" FOREIGN KEY ("signed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "destruction_register_org_destroyed_idx" ON "destruction_register" USING btree ("organisation_id","destroyed_at");--> statement-breakpoint
CREATE INDEX "disposal_authority_signoffs_org_class_idx" ON "disposal_authority_signoffs" USING btree ("organisation_id","jurisdiction","disposal_class");--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;