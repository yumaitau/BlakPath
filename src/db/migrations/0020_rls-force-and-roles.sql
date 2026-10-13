-- Roles themselves are created by src/db/rls-roles.ts before drizzle migrate.
-- CREATE ROLE cannot run inside the transaction this file executes in.
-- FORCE makes table owners subject to tenant_isolation. Superusers still bypass,
-- which is why tenant work SET LOCAL ROLE blakpath_app.
GRANT USAGE ON SCHEMA public TO blakpath_app, blakpath_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO blakpath_app, blakpath_platform;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO blakpath_app, blakpath_platform;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blakpath_app, blakpath_platform;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO blakpath_app, blakpath_platform;--> statement-breakpoint
GRANT blakpath_app TO CURRENT_USER;--> statement-breakpoint
GRANT blakpath_platform TO CURRENT_USER;--> statement-breakpoint
ALTER TABLE "feature_flags" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
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
ALTER TABLE "meetings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decision_votes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "certificates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "form_responses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forms" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "export_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organisation_sso_providers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consent_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_dashboard_layouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_integrity_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_requests" FORCE ROW LEVEL SECURITY;
