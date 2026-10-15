CREATE TABLE "certificate_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"wording" text NOT NULL,
	"signatory_name" text NOT NULL,
	"signatory_role" text NOT NULL,
	"logo_object_key" text,
	"logo_content_type" text,
	"logo_sha256" text,
	"content_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "supersedes_certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "superseded_by_certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_templates" ADD CONSTRAINT "certificate_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_templates_org_version_unique" ON "certificate_templates" USING btree ("organisation_id","template_version");--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_template_id_certificate_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."certificate_templates"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_supersedes_certificate_id_certificates_id_fk" FOREIGN KEY ("supersedes_certificate_id") REFERENCES "public"."certificates"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_superseded_by_certificate_id_certificates_id_fk" FOREIGN KEY ("superseded_by_certificate_id") REFERENCES "public"."certificates"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "certificates" VALIDATE CONSTRAINT "certificates_template_id_certificate_templates_id_fk";--> statement-breakpoint
ALTER TABLE "certificates" VALIDATE CONSTRAINT "certificates_supersedes_certificate_id_certificates_id_fk";--> statement-breakpoint
ALTER TABLE "certificates" VALIDATE CONSTRAINT "certificates_superseded_by_certificate_id_certificates_id_fk";