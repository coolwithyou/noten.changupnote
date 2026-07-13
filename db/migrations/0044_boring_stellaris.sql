CREATE TYPE "public"."registry_import_status" AS ENUM('staged', 'validated', 'published', 'failed', 'superseded');--> statement-breakpoint
CREATE TABLE "registry_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"status" "registry_import_status" DEFAULT 'staged' NOT NULL,
	"filename" text NOT NULL,
	"file_size" bigint NOT NULL,
	"content_type" text,
	"encoding" text NOT NULL,
	"sha256" text NOT NULL,
	"raw_object_key" text,
	"source_published_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parser_version" text NOT NULL,
	"schema_signature" text NOT NULL,
	"raw_row_count" integer NOT NULL,
	"parsed_row_count" integer NOT NULL,
	"rejected_row_count" integer NOT NULL,
	"exact_key_count" integer NOT NULL,
	"active_row_count" integer NOT NULL,
	"error_summary" jsonb,
	"uploaded_by_admin_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registry_source_state" (
	"source" text PRIMARY KEY NOT NULL,
	"active_run_id" uuid NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registry_index" ADD COLUMN "import_run_id" uuid;--> statement-breakpoint
ALTER TABLE "registry_index" ADD COLUMN "source_record_key" text;--> statement-breakpoint
ALTER TABLE "registry_index" ADD COLUMN "source_year" integer;--> statement-breakpoint
ALTER TABLE "registry_import_runs" ADD CONSTRAINT "registry_import_runs_uploaded_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("uploaded_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_source_state" ADD CONSTRAINT "registry_source_state_active_run_id_registry_import_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."registry_import_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registry_import_runs_source_created_idx" ON "registry_import_runs" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "registry_import_runs_uploader_idx" ON "registry_import_runs" USING btree ("uploaded_by_admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_import_runs_source_sha_idx" ON "registry_import_runs" USING btree ("source","sha256");--> statement-breakpoint
CREATE INDEX "registry_source_state_active_run_idx" ON "registry_source_state" USING btree ("active_run_id");--> statement-breakpoint
ALTER TABLE "registry_index" ADD CONSTRAINT "registry_index_import_run_id_registry_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."registry_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registry_index_import_run_idx" ON "registry_index" USING btree ("import_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registry_index_run_record_idx" ON "registry_index" USING btree ("import_run_id","source_record_key");