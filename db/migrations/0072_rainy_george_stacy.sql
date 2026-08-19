CREATE INDEX "generative_usage_events_user_idx" ON "generative_usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generative_usage_events_grant_idx" ON "generative_usage_events" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "grant_document_agent_runs_created_by_idx" ON "grant_document_agent_runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "grant_document_agent_suggestions_created_by_idx" ON "grant_document_agent_suggestions" USING btree ("created_by");