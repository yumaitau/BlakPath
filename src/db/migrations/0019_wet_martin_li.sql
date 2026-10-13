CREATE TABLE "application_search_tokens" (
	"organisation_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"field" text NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "application_search_tokens_organisation_id_token_application_id_pk" PRIMARY KEY("organisation_id","token","application_id")
);
--> statement-breakpoint
ALTER TABLE "application_search_tokens" ADD CONSTRAINT "application_search_tokens_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_search_tokens" ADD CONSTRAINT "application_search_tokens_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_search_tokens_application_idx" ON "application_search_tokens" USING btree ("organisation_id","application_id");--> statement-breakpoint
CREATE INDEX "applications_org_created_id_idx" ON "applications" USING btree ("organisation_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_org_status_created_id_idx" ON "applications" USING btree ("organisation_id","status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "applications_org_assignee_created_id_idx" ON "applications" USING btree ("organisation_id","current_assignee_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);