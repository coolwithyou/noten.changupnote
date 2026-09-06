CREATE TABLE "profile_source_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"baseline" jsonb NOT NULL,
	"statement" text NOT NULL,
	"observation" jsonb,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_source_corrections" ADD CONSTRAINT "profile_source_corrections_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_source_corrections" ADD CONSTRAINT "profile_source_corrections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_source_corrections" ADD CONSTRAINT "profile_source_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_source_corrections_company_idx" ON "profile_source_corrections" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "profile_source_corrections_queue_idx" ON "profile_source_corrections" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_source_corrections_active_idx" ON "profile_source_corrections" USING btree ("company_id","user_id","dimension") WHERE "profile_source_corrections"."status" in ('open', 'reviewing', 'waiting_source');
--> statement-breakpoint
ALTER TABLE profile_source_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_source_corrections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY profile_source_corrections_own_read ON profile_source_corrections FOR SELECT
USING (user_id = app_private.current_user_id() AND app_private.is_current_company_member(company_id));
--> statement-breakpoint
ALTER TABLE profile_source_corrections ADD CONSTRAINT profile_source_corrections_status_check
CHECK (status IN ('open','reviewing','waiting_source','resolved','rejected','withdrawn'));
--> statement-breakpoint
CREATE FUNCTION app_private.protect_source_correction_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.baseline IS DISTINCT FROM OLD.baseline OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
    OR NEW.dimension IS DISTINCT FROM OLD.dimension OR NEW.statement IS DISTINCT FROM OLD.statement
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'source correction baseline is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR jsonb_typeof(NEW.events) <> 'array'
    OR jsonb_array_length(NEW.events) <> jsonb_array_length(OLD.events) + 1
    OR NEW.events - (jsonb_array_length(NEW.events) - 1) IS DISTINCT FROM OLD.events THEN
    RAISE EXCEPTION 'source correction history must be appended with an exact revision';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_source_correction_history BEFORE UPDATE ON profile_source_corrections
FOR EACH ROW EXECUTE FUNCTION app_private.protect_source_correction_history();
