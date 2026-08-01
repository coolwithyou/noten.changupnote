CREATE TABLE "grant_collection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"raw_hash" text NOT NULL,
	"revision_kind" text NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_collection_events_revision_kind_check" CHECK (
    "grant_collection_events"."revision_kind" IN ('new', 'changed', 'observed')
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "grant_collection_events_revision_idx" ON "grant_collection_events" USING btree ("source","source_id","raw_hash");--> statement-breakpoint
CREATE INDEX "grant_collection_events_collected_at_idx" ON "grant_collection_events" USING btree ("collected_at");--> statement-breakpoint
INSERT INTO "grant_collection_events" (
	"source",
	"source_id",
	"raw_hash",
	"revision_kind",
	"collected_at"
)
SELECT
	"source",
	"source_id",
	"raw_hash",
	'observed',
	"collected_at"
FROM "grant_raw"
WHERE "raw_hash" IS NOT NULL
ON CONFLICT ("source", "source_id", "raw_hash") DO NOTHING;
