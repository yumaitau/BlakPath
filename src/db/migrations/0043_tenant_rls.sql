-- Tenant isolation (issue #72). Hand-written parts: the policy function, and
-- FORCE so a table owner is also subject to the policy. See
-- docs/tenant-isolation.md and src/db/rls.ts.
--
-- blakpath_rls_allows reads transaction-local settings applied by
-- src/db/bound-db.ts:
--   app.bypass_rls = 'on'  platform handle (src/db/platform-db.ts): every row
--   app.org_id = <uuid>    tenant handle: only that organisation's rows
--   neither                allowed for now, because release N-1 sets neither
--                          and must keep running on this schema. A later
--                          release replaces the THEN true below with false.
-- STABLE sql with one SELECT, so the planner inlines it into each policy.
CREATE OR REPLACE FUNCTION blakpath_rls_allows(row_org uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $rls$
  SELECT CASE
    WHEN pg_catalog.current_setting('app.bypass_rls', true) = 'on' THEN true
    WHEN COALESCE(pg_catalog.current_setting('app.org_id', true), '') = '' THEN true
    ELSE row_org = pg_catalog.current_setting('app.org_id', true)::uuid
  END
$rls$;--> statement-breakpoint
ALTER TABLE "ai_governance_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destruction_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_key_rewraps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_encrypted_fields" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "representative_authorisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "group_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "family_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_declarations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_votes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destruction_register" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "disposal_authority_signoffs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_backfill_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_sso_providers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_dashboard_layouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_integrity_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_governance_approvals" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "feature_flags" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_shared_read" ON "feature_flags" AS PERMISSIVE FOR SELECT TO public USING (organisation_id is null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organisation_domains" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organisation_settings" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "destruction_certificates" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organisation_key_rewraps" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organisation_keys" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_encrypted_fields" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership_invitations" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "representative_authorisations" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "roles" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_shared_read" ON "roles" AS PERMISSIVE FOR SELECT TO public USING (organisation_id is null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "clients" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "group_memberships" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "groups" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "team_memberships" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "teams" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_event_attendees" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_event_reminders" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_events" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_assignments" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_notes" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "application_status_history" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "applications" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "evidence" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "evidence_requests" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_comments" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reviews" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "family_links" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conflict_declarations" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "meeting_agenda_items" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "meeting_attendance" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "meetings" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decision_votes" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "decisions" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "certificates" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "correspondence_items" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "correspondence_messages" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "correspondence_templates" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tasks" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_invitations" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "form_responses" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "forms" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "export_requests" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "destruction_register" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "disposal_authority_signoffs" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "legal_holds" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retention_policies" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "encryption_backfill_runs" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organisation_sso_providers" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "scim_credentials" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "consent_records" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_dashboard_layouts" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_events" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_integrity_checkpoints" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "break_glass_requests" AS PERMISSIVE FOR ALL TO public USING (blakpath_rls_allows(organisation_id)) WITH CHECK (blakpath_rls_allows(organisation_id));--> statement-breakpoint
ALTER TABLE "ai_governance_approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feature_flags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destruction_certificates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_key_rewraps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_encrypted_fields" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "representative_authorisations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "group_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "groups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_status_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "applications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evidence_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "family_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conflict_declarations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_attendance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meetings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_votes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "certificates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "correspondence_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_responses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destruction_register" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "disposal_authority_signoffs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encryption_backfill_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_sso_providers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scim_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_dashboard_layouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_integrity_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_requests" FORCE ROW LEVEL SECURITY;
