CREATE TABLE "grant_document_revision_heads" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"origin" text NOT NULL,
	"format" text NOT NULL,
	"artifact_storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"page_count" integer NOT NULL,
	"field_answers_hash" text NOT NULL,
	"verification" jsonb NOT NULL,
	"studio_session_id" text NOT NULL,
	"document_epoch" integer,
	"change_seq" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grant_document_revision_heads" ADD CONSTRAINT "grant_document_revision_heads_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revision_heads" ADD CONSTRAINT "grant_document_revision_heads_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_parent_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revision_heads_revision_unique" ON "grant_document_revision_heads" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "grant_document_revisions_draft_created_idx" ON "grant_document_revisions" USING btree ("draft_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revisions_artifact_key_unique" ON "grant_document_revisions" USING btree ("artifact_storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revisions_snapshot_idempotency_unique" ON "grant_document_revisions" USING btree ("draft_id","studio_session_id","document_epoch","change_seq","sha256");