CREATE TYPE "public"."support_ticket_author" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_message_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" "support_ticket_author" NOT NULL,
	"author_user_id" uuid,
	"author_email" text,
	"body" text NOT NULL,
	"visibility" "support_ticket_message_visibility" DEFAULT 'public' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_created_idx" ON "support_ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_ticket_messages_ticket_visibility_idx" ON "support_ticket_messages" USING btree ("ticket_id","visibility");