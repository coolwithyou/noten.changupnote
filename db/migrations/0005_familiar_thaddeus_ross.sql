CREATE TABLE "grant_insight_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metrics" jsonb NOT NULL,
	"dimensions" jsonb NOT NULL,
	"insights" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "grant_insight_snapshots_kind_generated_idx" ON "grant_insight_snapshots" USING btree ("kind","generated_at");