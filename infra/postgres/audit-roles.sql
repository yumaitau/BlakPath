-- Human-applied once by the RDS master. The application does not run this file.
-- Passwords are set out of band (Secrets Manager). Do not commit them.
--
-- Pre-check before the unique predecessor migration. Duplicate predecessors
-- must be resolved by an operator before migrate; do not edit rows in place
-- after the append-only triggers are installed.
--
--   SELECT organisation_id, prev_hash, count(*)
--   FROM audit_events
--   GROUP BY organisation_id, prev_hash
--   HAVING count(*) > 1;

CREATE ROLE blakpath_migrator LOGIN;
CREATE ROLE blakpath_app LOGIN;

GRANT CONNECT ON DATABASE blakpath TO blakpath_migrator;
GRANT CONNECT ON DATABASE blakpath TO blakpath_app;

-- Replace `current_app_owner` with the role that owns the tables today
-- (often the historical DATABASE_URL user). The master must be a member of
-- that role to reassign its objects.
-- GRANT current_app_owner TO CURRENT_USER;
-- REASSIGN OWNED BY current_app_owner TO blakpath_migrator;

-- Confirm, then store the two URLs in different secrets:
--   /blakpath/production/runtime    DATABASE_URL            user blakpath_app
--   /blakpath/production/migrator   DATABASE_MIGRATION_URL  user blakpath_migrator
