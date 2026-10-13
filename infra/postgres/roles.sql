-- BlakPath database roles. Apply once as the RDS master user, in database
-- `blakpath`, before the first production migrate Job. This file has no
-- passwords. Set them out of band and store only the migrator URL in
-- Secrets Manager key /blakpath/production/migrator.
--
--   CREATE ROLE blakpath_migrator LOGIN PASSWORD '…';
--   CREATE ROLE blakpath_app LOGIN PASSWORD '…';
--
-- blakpath_migrator owns the schema and runs migrations.
-- blakpath_app is the runtime role: DML only, no CREATE.

GRANT blakpath_migrator TO CURRENT_USER;

ALTER DATABASE blakpath OWNER TO blakpath_migrator;

REVOKE ALL ON DATABASE blakpath FROM PUBLIC;
GRANT CONNECT ON DATABASE blakpath TO blakpath_migrator;
GRANT CONNECT ON DATABASE blakpath TO blakpath_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO blakpath_migrator;
GRANT USAGE ON SCHEMA public TO blakpath_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO blakpath_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO blakpath_app;

ALTER DEFAULT PRIVILEGES FOR ROLE blakpath_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO blakpath_app;
ALTER DEFAULT PRIVILEGES FOR ROLE blakpath_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO blakpath_app;

-- Existing objects created by the master user follow the migrator so later
-- default privileges apply. RDS master must already be a member of the role.
DO $$
DECLARE
  object record;
BEGIN
  FOR object IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
  LOOP
    EXECUTE format(
      'ALTER %s %I.%I OWNER TO blakpath_migrator',
      CASE object.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      object.schema_name,
      object.object_name
    );
  END LOOP;
END
$$;

-- The application role must not inherit the owner.
REVOKE blakpath_migrator FROM blakpath_app;
