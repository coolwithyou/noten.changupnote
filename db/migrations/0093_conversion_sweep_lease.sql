CREATE TABLE "conversion_sweep_leases" (
  "scope" text PRIMARY KEY,
  "owner" uuid NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversion_sweep_leases_scope_check" CHECK ("scope" = 'current_inventory')
);
--> statement-breakpoint
ALTER TABLE "conversion_sweep_leases" ENABLE ROW LEVEL SECURITY;
