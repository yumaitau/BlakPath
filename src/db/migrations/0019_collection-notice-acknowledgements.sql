CREATE TABLE "collection_notice_acknowledgements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"context" text NOT NULL,
	"method" text NOT NULL,
	"notice_version" text NOT NULL,
	"notice_hash" text NOT NULL,
	"acknowledged_by_user_id" uuid,
	"subject_user_id" uuid,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_notice_acknowledgements" ADD CONSTRAINT "collection_notice_acknowledgements_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_notice_acknowledgements" ADD CONSTRAINT "collection_notice_acknowledgements_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_notice_acknowledgements" ADD CONSTRAINT "collection_notice_acknowledgements_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_ack_org_resource_idx" ON "collection_notice_acknowledgements" USING btree ("organisation_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "notice_ack_org_hash_idx" ON "collection_notice_acknowledgements" USING btree ("organisation_id","notice_hash");