CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"address_hash" text NOT NULL,
	"kind" text DEFAULT 'bounce' NOT NULL,
	"source_message_id" text,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisation_sso_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"recorded_by_user_id" uuid,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'granted' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "organisation_sso_providers" ADD CONSTRAINT "organisation_sso_providers_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_suppressions_hash_idx" ON "email_suppressions" USING btree ("address_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "org_sso_org_provider_unique" ON "organisation_sso_providers" USING btree ("organisation_id","provider_key");--> statement-breakpoint
CREATE INDEX "org_sso_org_domain_idx" ON "organisation_sso_providers" USING btree ("organisation_id","domain");--> statement-breakpoint
CREATE INDEX "consent_org_subject_idx" ON "consent_records" USING btree ("organisation_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "consent_org_purpose_idx" ON "consent_records" USING btree ("organisation_id","purpose");--> statement-breakpoint
ALTER TABLE "representative_authorisations" ADD CONSTRAINT "representative_authorisations_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;