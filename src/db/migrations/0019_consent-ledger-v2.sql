CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"grant_event_id" uuid,
	"subject_user_id" uuid,
	"subject_client_id" uuid,
	"purpose" text NOT NULL,
	"wording_version_id" uuid,
	"sharing_recipient" text,
	"method" text NOT NULL,
	"evidence_reference" text,
	"witness_name" text,
	"given_by" text DEFAULT 'subject' NOT NULL,
	"representative_name" text,
	"representative_relationship" text,
	"representative_user_id" uuid,
	"channel" text NOT NULL,
	"actor_user_id" uuid,
	"expires_at" timestamp with time zone,
	"notes" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_events_subject_present" CHECK ("consent_events"."subject_user_id" IS NOT NULL OR "consent_events"."subject_client_id" IS NOT NULL),
	CONSTRAINT "consent_events_shape" CHECK (("consent_events"."kind" = 'granted' AND "consent_events"."wording_version_id" IS NOT NULL AND "consent_events"."grant_event_id" IS NULL)
        OR ("consent_events"."kind" = 'withdrawn' AND "consent_events"."grant_event_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_wording_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"locale" text DEFAULT 'en-AU' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"published_by_user_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "representative_authorisations" ADD COLUMN "consent_event_id" uuid;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_grant_event_id_consent_events_id_fk" FOREIGN KEY ("grant_event_id") REFERENCES "public"."consent_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_subject_client_id_clients_id_fk" FOREIGN KEY ("subject_client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_wording_version_id_consent_wording_versions_id_fk" FOREIGN KEY ("wording_version_id") REFERENCES "public"."consent_wording_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_wording_versions" ADD CONSTRAINT "consent_wording_versions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_events_org_subject_user_idx" ON "consent_events" USING btree ("organisation_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "consent_events_org_subject_client_idx" ON "consent_events" USING btree ("organisation_id","subject_client_id");--> statement-breakpoint
CREATE INDEX "consent_events_org_purpose_idx" ON "consent_events" USING btree ("organisation_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_events_grant_event_unique" ON "consent_events" USING btree ("grant_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_wording_org_purpose_version_unique" ON "consent_wording_versions" USING btree ("organisation_id","purpose","version");--> statement-breakpoint
ALTER TABLE "representative_authorisations" ADD CONSTRAINT "representative_authorisations_consent_event_id_consent_events_id_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."consent_events"("id") ON DELETE restrict ON UPDATE no action;