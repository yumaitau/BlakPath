CREATE TABLE "signing_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"key_spec" text NOT NULL,
	"public_key_spki" text NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_fingerprint_unique" ON "signing_keys" USING btree ("fingerprint_sha256");