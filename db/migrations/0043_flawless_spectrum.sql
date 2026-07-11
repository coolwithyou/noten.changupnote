CREATE TYPE "public"."registry_polarity" AS ENUM('known_on_absence', 'present_only');--> statement-breakpoint
CREATE TYPE "public"."registry_type" AS ENUM('certification', 'sanction', 'investment');--> statement-breakpoint
CREATE TABLE "registry_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registry_type" "registry_type" NOT NULL,
	"flag_or_cert" text NOT NULL,
	"polarity" "registry_polarity" NOT NULL,
	"biz_no" text,
	"corp_no" text,
	"name_normalized" text NOT NULL,
	"representative" text,
	"region_sido" text,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"detail" jsonb,
	"source" text NOT NULL,
	"source_fetched_at" timestamp with time zone NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "registry_index_biz_no_idx" ON "registry_index" USING btree ("biz_no");--> statement-breakpoint
CREATE INDEX "registry_index_name_normalized_idx" ON "registry_index" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "registry_index_type_flag_idx" ON "registry_index" USING btree ("registry_type","flag_or_cert");--> statement-breakpoint
CREATE INDEX "registry_index_source_idx" ON "registry_index" USING btree ("source");