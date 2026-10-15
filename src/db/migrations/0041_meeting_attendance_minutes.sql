CREATE TABLE "meeting_attendance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"present" boolean NOT NULL,
	"note" text,
	"attested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_recorded_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "minutes_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "quorum_present" boolean;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "quorum_note" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "quorum_attested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "quorum_attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_attendance_org_meeting_idx" ON "meeting_attendance" USING btree ("organisation_id","meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_meeting_user_unique" ON "meeting_attendance" USING btree ("meeting_id","user_id");--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_minutes_recorded_by_user_id_users_id_fk" FOREIGN KEY ("minutes_recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_quorum_attested_by_user_id_users_id_fk" FOREIGN KEY ("quorum_attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "meetings" VALIDATE CONSTRAINT "meetings_minutes_recorded_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "meetings" VALIDATE CONSTRAINT "meetings_quorum_attested_by_user_id_users_id_fk";