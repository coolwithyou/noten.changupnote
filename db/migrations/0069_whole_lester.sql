CREATE TABLE "deep_analysis_runtime_control" (
	"control_key" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"mode" text DEFAULT 'paused' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"changed_by" text DEFAULT 'migration' NOT NULL,
	"change_reason" text,
	"local_owner_id" text,
	"local_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_analysis_runtime_control_singleton_check" CHECK (
    "deep_analysis_runtime_control"."control_key" = 'global'
  ),
	CONSTRAINT "deep_analysis_runtime_control_mode_check" CHECK (
    "deep_analysis_runtime_control"."mode" IN ('paused', 'production_api', 'local_subscription')
  ),
	CONSTRAINT "deep_analysis_runtime_control_generation_check" CHECK (
    "deep_analysis_runtime_control"."generation" > 0
  ),
	CONSTRAINT "deep_analysis_runtime_control_local_lease_check" CHECK (
    (
      "deep_analysis_runtime_control"."mode" = 'local_subscription'
      AND "deep_analysis_runtime_control"."local_owner_id" IS NOT NULL
      AND "deep_analysis_runtime_control"."local_lease_expires_at" IS NOT NULL
    )
    OR (
      "deep_analysis_runtime_control"."mode" <> 'local_subscription'
      AND "deep_analysis_runtime_control"."local_owner_id" IS NULL
      AND "deep_analysis_runtime_control"."local_lease_expires_at" IS NULL
    )
  )
);
--> statement-breakpoint
INSERT INTO "deep_analysis_runtime_control" (
	"control_key",
	"mode",
	"changed_by",
	"change_reason"
) VALUES (
	'global',
	'paused',
	'migration:0069',
	'안전 기본값으로 유료 분석 신규 착수 차단'
) ON CONFLICT ("control_key") DO NOTHING;
