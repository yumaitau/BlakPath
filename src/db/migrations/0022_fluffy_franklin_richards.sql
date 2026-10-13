ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_prev_hash_unique" UNIQUE NULLS NOT DISTINCT("organisation_id","prev_hash");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $audit_guard$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$audit_guard$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_events_append_only_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_only_update;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_events_append_only_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_only_delete;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_events_append_only_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_append_only_truncate;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_integrity_checkpoints_append_only_update
  BEFORE UPDATE ON audit_integrity_checkpoints
  FOR EACH ROW
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_integrity_checkpoints ENABLE ALWAYS TRIGGER audit_integrity_checkpoints_append_only_update;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_integrity_checkpoints_append_only_delete
  BEFORE DELETE ON audit_integrity_checkpoints
  FOR EACH ROW
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_integrity_checkpoints ENABLE ALWAYS TRIGGER audit_integrity_checkpoints_append_only_delete;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER audit_integrity_checkpoints_append_only_truncate
  BEFORE TRUNCATE ON audit_integrity_checkpoints
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_append_only_guard();
--> statement-breakpoint
ALTER TABLE audit_integrity_checkpoints ENABLE ALWAYS TRIGGER audit_integrity_checkpoints_append_only_truncate;
