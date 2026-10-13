-- Consent ledger is append-only at the database layer (issue #41).
-- consent_events and consent_wording_versions accept INSERT and SELECT only;
-- any UPDATE, DELETE or TRUNCATE is rejected regardless of the caller's role,
-- so a grant, its wording and its withdrawal can never be rewritten.
CREATE OR REPLACE FUNCTION "reject_append_only_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "consent_events_append_only"
  BEFORE UPDATE OR DELETE ON "consent_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "consent_events_no_truncate"
  BEFORE TRUNCATE ON "consent_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "consent_wording_versions_append_only"
  BEFORE UPDATE OR DELETE ON "consent_wording_versions"
  FOR EACH ROW EXECUTE FUNCTION "reject_append_only_mutation"();
--> statement-breakpoint
CREATE TRIGGER "consent_wording_versions_no_truncate"
  BEFORE TRUNCATE ON "consent_wording_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_append_only_mutation"();
