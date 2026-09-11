CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"linked_user_id" uuid,
	"assigned_team_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"team_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event_attendees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text,
	"display_name" text,
	"response_status" text DEFAULT 'needs-action' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"minutes_before" integer DEFAULT 30 NOT NULL,
	"channel" text DEFAULT 'in-app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"resource" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"rrule" text,
	"timezone" text DEFAULT 'Australia/Sydney' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"meeting_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_assigned_team_id_teams_id_fk" FOREIGN KEY ("assigned_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_org_team_idx" ON "clients" USING btree ("organisation_id","assigned_team_id");--> statement-breakpoint
CREATE INDEX "clients_org_user_idx" ON "clients" USING btree ("organisation_id","linked_user_id");--> statement-breakpoint
CREATE INDEX "clients_org_name_idx" ON "clients" USING btree ("organisation_id","display_name");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_group_user_unique" ON "group_memberships" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_org_group_idx" ON "group_memberships" USING btree ("organisation_id","group_id");--> statement-breakpoint
CREATE INDEX "group_memberships_org_user_idx" ON "group_memberships" USING btree ("organisation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_org_slug_unique" ON "groups" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "groups_org_team_idx" ON "groups" USING btree ("organisation_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_team_user_unique" ON "team_memberships" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_memberships_org_team_idx" ON "team_memberships" USING btree ("organisation_id","team_id");--> statement-breakpoint
CREATE INDEX "team_memberships_org_user_idx" ON "team_memberships" USING btree ("organisation_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_slug_unique" ON "teams" USING btree ("organisation_id","slug");--> statement-breakpoint
CREATE INDEX "teams_org_name_idx" ON "teams" USING btree ("organisation_id","name");--> statement-breakpoint
CREATE INDEX "calendar_attendees_org_event_idx" ON "calendar_event_attendees" USING btree ("organisation_id","event_id");--> statement-breakpoint
CREATE INDEX "calendar_attendees_org_user_idx" ON "calendar_event_attendees" USING btree ("organisation_id","user_id");--> statement-breakpoint
CREATE INDEX "calendar_attendees_org_email_idx" ON "calendar_event_attendees" USING btree ("organisation_id","email");--> statement-breakpoint
CREATE INDEX "calendar_reminders_org_event_idx" ON "calendar_event_reminders" USING btree ("organisation_id","event_id");--> statement-breakpoint
CREATE INDEX "calendar_events_org_start_idx" ON "calendar_events" USING btree ("organisation_id","start_at");--> statement-breakpoint
CREATE INDEX "calendar_events_org_status_idx" ON "calendar_events" USING btree ("organisation_id","status");--> statement-breakpoint
CREATE INDEX "calendar_events_org_resource_idx" ON "calendar_events" USING btree ("organisation_id","resource");--> statement-breakpoint
CREATE INDEX "calendar_events_org_meeting_idx" ON "calendar_events" USING btree ("organisation_id","meeting_id");