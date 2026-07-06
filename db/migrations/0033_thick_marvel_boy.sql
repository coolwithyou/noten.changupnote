CREATE TABLE "lesson_exposure_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"anchor_label" text,
	"company_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_exposure_events" ADD CONSTRAINT "lesson_exposure_events_lesson_id_review_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."review_lessons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lesson_exposure_events_lesson_created_idx" ON "lesson_exposure_events" USING btree ("lesson_id","created_at");--> statement-breakpoint
CREATE INDEX "lesson_exposure_events_grant_idx" ON "lesson_exposure_events" USING btree ("grant_id");