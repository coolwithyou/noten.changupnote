CREATE TABLE "grant_attachment_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"filename" text NOT NULL,
	"source_uri" text DEFAULT '' NOT NULL,
	"archive_url" text,
	"storage_key" text,
	"content_type" text,
	"bytes" integer,
	"sha256" text,
	"fetched_at" timestamp with time zone,
	"conversion_status" text,
	"markdown_url" text,
	"markdown_storage_key" text,
	"markdown_sha256" text,
	"markdown_bytes" integer,
	"converter" text,
	"converted_at" timestamp with time zone,
	"conversion_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "grant_attachment_archives_source_attachment_idx" ON "grant_attachment_archives" USING btree ("source","source_id","filename","source_uri");--> statement-breakpoint
CREATE INDEX "grant_attachment_archives_source_id_idx" ON "grant_attachment_archives" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "grant_attachment_archives_sha_idx" ON "grant_attachment_archives" USING btree ("sha256");