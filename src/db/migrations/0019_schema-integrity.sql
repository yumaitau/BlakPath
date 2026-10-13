ALTER TABLE "membership_invitations" DROP CONSTRAINT "membership_invitations_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "membership_roles" DROP CONSTRAINT "membership_roles_membership_id_memberships_id_fk";
--> statement-breakpoint
ALTER TABLE "representative_authorisations" DROP CONSTRAINT "representative_authorisations_consent_record_id_consent_records_id_fk";
--> statement-breakpoint
ALTER TABLE "clients" DROP CONSTRAINT "clients_assigned_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "group_memberships" DROP CONSTRAINT "group_memberships_group_id_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT "groups_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "team_memberships" DROP CONSTRAINT "team_memberships_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" DROP CONSTRAINT "calendar_event_attendees_event_id_calendar_events_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" DROP CONSTRAINT "calendar_event_reminders_event_id_calendar_events_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "application_assignments" DROP CONSTRAINT "application_assignments_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "application_notes" DROP CONSTRAINT "application_notes_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "application_status_history" DROP CONSTRAINT "application_status_history_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_client_id_clients_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_fulfils_request_id_evidence_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence_requests" DROP CONSTRAINT "evidence_requests_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "review_comments" DROP CONSTRAINT "review_comments_review_id_reviews_id_fk";
--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "family_links" DROP CONSTRAINT "family_links_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "conflict_declarations" DROP CONSTRAINT "conflict_declarations_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "conflict_declarations" DROP CONSTRAINT "conflict_declarations_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "conflict_declarations" DROP CONSTRAINT "conflict_declarations_declared_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" DROP CONSTRAINT "meeting_agenda_items_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" DROP CONSTRAINT "meeting_agenda_items_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "decision_votes" DROP CONSTRAINT "decision_votes_decision_id_decisions_id_fk";
--> statement-breakpoint
ALTER TABLE "decision_votes" DROP CONSTRAINT "decision_votes_voter_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_meeting_id_meetings_id_fk";
--> statement-breakpoint
ALTER TABLE "certificates" DROP CONSTRAINT "certificates_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "certificates" DROP CONSTRAINT "certificates_decision_id_decisions_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "form_invitations" DROP CONSTRAINT "form_invitations_form_id_forms_id_fk";
--> statement-breakpoint
ALTER TABLE "form_responses" DROP CONSTRAINT "form_responses_form_id_forms_id_fk";
--> statement-breakpoint
ALTER TABLE "form_responses" DROP CONSTRAINT "form_responses_invitation_id_form_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE "forms" DROP CONSTRAINT "forms_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk";
--> statement-breakpoint
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_subject_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "feature_flags_org_key_unique";
--> statement-breakpoint
DROP INDEX "roles_org_slug_unique";
--> statement-breakpoint
-- Composite (organisation_id, id) keys must exist before the same-tenant FKs
-- that reference them (drizzle-kit emits them last; reordered by hand).
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_org_key_unique" UNIQUE NULLS NOT DISTINCT("organisation_id","key");
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_slug_unique" UNIQUE NULLS NOT DISTINCT("organisation_id","slug");
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "evidence_requests" ADD CONSTRAINT "evidence_requests_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "form_invitations" ADD CONSTRAINT "form_invitations_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_org_id_unique" UNIQUE("organisation_id","id");
--> statement-breakpoint
-- membership_roles gains its membership's organisation. Add nullable, backfill,
-- then require it (drizzle-kit emits a bare NOT NULL add, which fails on a
-- populated table).
ALTER TABLE "membership_roles" ADD COLUMN "organisation_id" uuid;
--> statement-breakpoint
UPDATE "membership_roles" SET "organisation_id" = "memberships"."organisation_id" FROM "memberships" WHERE "memberships"."id" = "membership_roles"."membership_id";
--> statement-breakpoint
ALTER TABLE "membership_roles" ALTER COLUMN "organisation_id" SET NOT NULL;
--> statement-breakpoint
-- Same-tenant composite FKs. Nullable ones clear only the reference column:
-- ON DELETE SET NULL ("<col>") (PostgreSQL 15+) is amended by hand because a
-- plain SET NULL would also null the NOT NULL organisation_id.
ALTER TABLE "membership_invitations" ADD CONSTRAINT "membership_invitations_team_same_org_fk" FOREIGN KEY ("organisation_id","team_id") REFERENCES "public"."teams"("organisation_id","id") ON DELETE SET NULL ("team_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_same_org_fk" FOREIGN KEY ("organisation_id","membership_id") REFERENCES "public"."memberships"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "representative_authorisations" ADD CONSTRAINT "representative_authorisations_consent_same_org_fk" FOREIGN KEY ("organisation_id","consent_record_id") REFERENCES "public"."consent_records"("organisation_id","id") ON DELETE SET NULL ("consent_record_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_assigned_team_same_org_fk" FOREIGN KEY ("organisation_id","assigned_team_id") REFERENCES "public"."teams"("organisation_id","id") ON DELETE SET NULL ("assigned_team_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_same_org_fk" FOREIGN KEY ("organisation_id","group_id") REFERENCES "public"."groups"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_team_same_org_fk" FOREIGN KEY ("organisation_id","team_id") REFERENCES "public"."teams"("organisation_id","id") ON DELETE SET NULL ("team_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_same_org_fk" FOREIGN KEY ("organisation_id","team_id") REFERENCES "public"."teams"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_same_org_fk" FOREIGN KEY ("organisation_id","event_id") REFERENCES "public"."calendar_events"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_same_org_fk" FOREIGN KEY ("organisation_id","event_id") REFERENCES "public"."calendar_events"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_meeting_same_org_fk" FOREIGN KEY ("organisation_id","meeting_id") REFERENCES "public"."meetings"("organisation_id","id") ON DELETE SET NULL ("meeting_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_assignments" ADD CONSTRAINT "application_assignments_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_notes" ADD CONSTRAINT "application_notes_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "application_status_history" ADD CONSTRAINT "application_status_history_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_client_same_org_fk" FOREIGN KEY ("organisation_id","client_id") REFERENCES "public"."clients"("organisation_id","id") ON DELETE SET NULL ("client_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_fulfils_request_same_org_fk" FOREIGN KEY ("organisation_id","fulfils_request_id") REFERENCES "public"."evidence_requests"("organisation_id","id") ON DELETE SET NULL ("fulfils_request_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_requests" ADD CONSTRAINT "evidence_requests_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_same_org_fk" FOREIGN KEY ("organisation_id","review_id") REFERENCES "public"."reviews"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "family_links" ADD CONSTRAINT "family_links_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conflict_declarations" ADD CONSTRAINT "conflict_declarations_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conflict_declarations" ADD CONSTRAINT "conflict_declarations_meeting_same_org_fk" FOREIGN KEY ("organisation_id","meeting_id") REFERENCES "public"."meetings"("organisation_id","id") ON DELETE SET NULL ("meeting_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conflict_declarations" ADD CONSTRAINT "conflict_declarations_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_meeting_same_org_fk" FOREIGN KEY ("organisation_id","meeting_id") REFERENCES "public"."meetings"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_votes" ADD CONSTRAINT "decision_votes_decision_same_org_fk" FOREIGN KEY ("organisation_id","decision_id") REFERENCES "public"."decisions"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_votes" ADD CONSTRAINT "decision_votes_voter_user_id_users_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_meeting_same_org_fk" FOREIGN KEY ("organisation_id","meeting_id") REFERENCES "public"."meetings"("organisation_id","id") ON DELETE SET NULL ("meeting_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_decision_same_org_fk" FOREIGN KEY ("organisation_id","decision_id") REFERENCES "public"."decisions"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE SET NULL ("application_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_invitations" ADD CONSTRAINT "form_invitations_form_same_org_fk" FOREIGN KEY ("organisation_id","form_id") REFERENCES "public"."forms"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_form_same_org_fk" FOREIGN KEY ("organisation_id","form_id") REFERENCES "public"."forms"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_invitation_same_org_fk" FOREIGN KEY ("organisation_id","invitation_id") REFERENCES "public"."form_invitations"("organisation_id","id") ON DELETE SET NULL ("invitation_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_application_same_org_fk" FOREIGN KEY ("organisation_id","application_id") REFERENCES "public"."applications"("organisation_id","id") ON DELETE SET NULL ("application_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_same_org_fk" FOREIGN KEY ("organisation_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("organisation_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "two_factors" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");
--> statement-breakpoint
CREATE INDEX "organisation_domains_org_idx" ON "organisation_domains" USING btree ("organisation_id");
--> statement-breakpoint
CREATE INDEX "membership_invitations_org_team_idx" ON "membership_invitations" USING btree ("organisation_id","team_id");
--> statement-breakpoint
CREATE INDEX "membership_invitations_role_idx" ON "membership_invitations" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "membership_invitations_invited_by_idx" ON "membership_invitations" USING btree ("invited_by_user_id");
--> statement-breakpoint
CREATE INDEX "membership_invitations_accepted_by_idx" ON "membership_invitations" USING btree ("accepted_by_user_id");
--> statement-breakpoint
CREATE INDEX "membership_roles_org_membership_idx" ON "membership_roles" USING btree ("organisation_id","membership_id");
--> statement-breakpoint
CREATE INDEX "membership_roles_role_idx" ON "membership_roles" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "memberships_invited_by_idx" ON "memberships" USING btree ("invited_by_user_id");
--> statement-breakpoint
CREATE INDEX "representative_authorisations_org_consent_idx" ON "representative_authorisations" USING btree ("organisation_id","consent_record_id");
--> statement-breakpoint
CREATE INDEX "representative_authorisations_subject_idx" ON "representative_authorisations" USING btree ("subject_user_id");
--> statement-breakpoint
CREATE INDEX "representative_authorisations_representative_idx" ON "representative_authorisations" USING btree ("representative_user_id");
--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission_key");
--> statement-breakpoint
CREATE INDEX "clients_linked_user_idx" ON "clients" USING btree ("linked_user_id");
--> statement-breakpoint
CREATE INDEX "group_memberships_user_idx" ON "group_memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "team_memberships_user_idx" ON "team_memberships" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "calendar_attendees_user_idx" ON "calendar_event_attendees" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "calendar_events_created_by_idx" ON "calendar_events" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "application_assignments_assignee_idx" ON "application_assignments" USING btree ("assignee_user_id");
--> statement-breakpoint
CREATE INDEX "application_assignments_assigned_by_idx" ON "application_assignments" USING btree ("assigned_by_user_id");
--> statement-breakpoint
CREATE INDEX "application_notes_author_idx" ON "application_notes" USING btree ("author_user_id");
--> statement-breakpoint
CREATE INDEX "application_status_history_actor_idx" ON "application_status_history" USING btree ("actor_user_id");
--> statement-breakpoint
CREATE INDEX "applications_org_client_idx" ON "applications" USING btree ("organisation_id","client_id");
--> statement-breakpoint
CREATE INDEX "applications_applicant_idx" ON "applications" USING btree ("applicant_user_id");
--> statement-breakpoint
CREATE INDEX "applications_current_assignee_idx" ON "applications" USING btree ("current_assignee_user_id");
--> statement-breakpoint
CREATE INDEX "applications_created_by_idx" ON "applications" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "evidence_org_request_idx" ON "evidence" USING btree ("organisation_id","fulfils_request_id");
--> statement-breakpoint
CREATE INDEX "evidence_uploaded_by_idx" ON "evidence" USING btree ("uploaded_by_user_id");
--> statement-breakpoint
CREATE INDEX "evidence_classified_by_idx" ON "evidence" USING btree ("classified_by_user_id");
--> statement-breakpoint
CREATE INDEX "evidence_requests_requested_by_idx" ON "evidence_requests" USING btree ("requested_by_user_id");
--> statement-breakpoint
CREATE INDEX "review_comments_author_idx" ON "review_comments" USING btree ("author_user_id");
--> statement-breakpoint
CREATE INDEX "reviews_reviewer_idx" ON "reviews" USING btree ("reviewer_user_id");
--> statement-breakpoint
CREATE INDEX "reviews_finalised_by_idx" ON "reviews" USING btree ("finalised_by_user_id");
--> statement-breakpoint
CREATE INDEX "family_links_requested_by_idx" ON "family_links" USING btree ("requested_by_user_id");
--> statement-breakpoint
CREATE INDEX "family_links_decided_by_idx" ON "family_links" USING btree ("decided_by_user_id");
--> statement-breakpoint
CREATE INDEX "conflict_declarations_declared_by_idx" ON "conflict_declarations" USING btree ("declared_by_user_id");
--> statement-breakpoint
CREATE INDEX "conflict_declarations_cleared_by_idx" ON "conflict_declarations" USING btree ("cleared_by_user_id");
--> statement-breakpoint
CREATE INDEX "meeting_agenda_items_org_application_idx" ON "meeting_agenda_items" USING btree ("organisation_id","application_id");
--> statement-breakpoint
CREATE INDEX "meetings_created_by_idx" ON "meetings" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "decision_votes_voter_idx" ON "decision_votes" USING btree ("voter_user_id");
--> statement-breakpoint
CREATE INDEX "decisions_proposed_by_idx" ON "decisions" USING btree ("proposed_by_user_id");
--> statement-breakpoint
CREATE INDEX "decisions_finalised_by_idx" ON "decisions" USING btree ("finalised_by_user_id");
--> statement-breakpoint
CREATE INDEX "certificates_org_decision_idx" ON "certificates" USING btree ("organisation_id","decision_id");
--> statement-breakpoint
CREATE INDEX "certificates_signed_by_idx" ON "certificates" USING btree ("signed_by_user_id");
--> statement-breakpoint
CREATE INDEX "certificates_revoked_by_idx" ON "certificates" USING btree ("revoked_by_user_id");
--> statement-breakpoint
CREATE INDEX "tasks_org_application_idx" ON "tasks" USING btree ("organisation_id","application_id");
--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_user_id");
--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "form_invitations_sent_by_idx" ON "form_invitations" USING btree ("sent_by_user_id");
--> statement-breakpoint
CREATE INDEX "form_responses_org_invitation_idx" ON "form_responses" USING btree ("organisation_id","invitation_id");
--> statement-breakpoint
CREATE INDEX "forms_org_application_idx" ON "forms" USING btree ("organisation_id","application_id");
--> statement-breakpoint
CREATE INDEX "forms_created_by_idx" ON "forms" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "webhook_endpoints_created_by_idx" ON "webhook_endpoints" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "export_requests_requested_by_idx" ON "export_requests" USING btree ("requested_by_user_id");
--> statement-breakpoint
CREATE INDEX "legal_holds_placed_by_idx" ON "legal_holds" USING btree ("placed_by_user_id");
--> statement-breakpoint
CREATE INDEX "legal_holds_released_by_idx" ON "legal_holds" USING btree ("released_by_user_id");
--> statement-breakpoint
CREATE INDEX "retention_policies_created_by_idx" ON "retention_policies" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "consent_subject_idx" ON "consent_records" USING btree ("subject_user_id");
--> statement-breakpoint
CREATE INDEX "consent_recorded_by_idx" ON "consent_records" USING btree ("recorded_by_user_id");
--> statement-breakpoint
CREATE INDEX "user_dashboard_layouts_user_idx" ON "user_dashboard_layouts" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "break_glass_requests_requested_by_idx" ON "break_glass_requests" USING btree ("requested_by_user_id");
--> statement-breakpoint
CREATE INDEX "break_glass_requests_approved_by_idx" ON "break_glass_requests" USING btree ("approved_by_user_id");
--> statement-breakpoint
-- A role assigned to a membership or offered by an invitation must be a system
-- template (organisation_id IS NULL) or belong to the same organisation. A FK
-- cannot express that OR, so a trigger enforces it.
CREATE FUNCTION "enforce_role_same_tenant"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  role_organisation_id uuid;
BEGIN
  SELECT "organisation_id" INTO role_organisation_id FROM "roles" WHERE "id" = NEW."role_id";
  -- A missing role is left to the role_id foreign key to reject.
  IF FOUND AND role_organisation_id IS NOT NULL
     AND role_organisation_id <> NEW."organisation_id" THEN
    RAISE EXCEPTION 'role % belongs to another organisation', NEW."role_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "membership_roles_role_same_tenant" BEFORE INSERT OR UPDATE OF "organisation_id", "role_id" ON "membership_roles" FOR EACH ROW EXECUTE FUNCTION "enforce_role_same_tenant"();
--> statement-breakpoint
CREATE TRIGGER "membership_invitations_role_same_tenant" BEFORE INSERT OR UPDATE OF "organisation_id", "role_id" ON "membership_invitations" FOR EACH ROW EXECUTE FUNCTION "enforce_role_same_tenant"();
--> statement-breakpoint
-- Triggers do not check existing rows; fail the migration if any already cross.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "membership_roles" mr JOIN "roles" r ON r."id" = mr."role_id"
    WHERE r."organisation_id" IS NOT NULL AND r."organisation_id" <> mr."organisation_id"
  ) OR EXISTS (
    SELECT 1 FROM "membership_invitations" mi JOIN "roles" r ON r."id" = mi."role_id"
    WHERE r."organisation_id" IS NOT NULL AND r."organisation_id" <> mi."organisation_id"
  ) THEN
    RAISE EXCEPTION 'cross-organisation role assignments exist; resolve before migrating';
  END IF;
END;
$$;
