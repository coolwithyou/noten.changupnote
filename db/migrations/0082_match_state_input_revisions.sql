ALTER TABLE "match_state" ADD COLUMN "input_binding" jsonb;--> statement-breakpoint
ALTER TABLE "match_state" ADD COLUMN "calculation_as_of" timestamp with time zone;--> statement-breakpoint

CREATE TABLE "match_company_input_revisions" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
  "revision" bigint DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "match_grant_input_revisions" (
  "grant_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."grants"("id") ON DELETE cascade,
  "revision" bigint DEFAULT 1 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE match_company_input_revisions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE match_company_input_revisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY match_company_input_revisions_member_read ON match_company_input_revisions FOR SELECT
USING (app_private.is_current_company_member(company_id));--> statement-breakpoint
ALTER TABLE match_grant_input_revisions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE match_grant_input_revisions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY match_grant_input_revisions_authenticated_read ON match_grant_input_revisions FOR SELECT
USING (app_private.current_user_id() IS NOT NULL);--> statement-breakpoint

INSERT INTO match_company_input_revisions(company_id)
SELECT id FROM companies ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO match_grant_input_revisions(grant_id)
SELECT id FROM grants ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_company_input_revision(target_company_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.match_company_input_revisions(company_id, revision, updated_at)
  SELECT target_company_id, 1, now()
  WHERE EXISTS (SELECT 1 FROM public.companies WHERE id = target_company_id)
  ON CONFLICT (company_id) DO UPDATE
  SET revision = public.match_company_input_revisions.revision + 1,
      updated_at = now();
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_company_input_revision(uuid) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_grant_input_revision(target_grant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.match_grant_input_revisions(grant_id, revision, updated_at)
  SELECT target_grant_id, 1, now()
  WHERE EXISTS (SELECT 1 FROM public.grants WHERE id = target_grant_id)
  ON CONFLICT (grant_id) DO UPDATE
  SET revision = public.match_grant_input_revisions.revision + 1,
      updated_at = now();
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_grant_input_revision(uuid) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION app_private.initialize_match_company_input_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.match_company_input_revisions(company_id) VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.initialize_match_company_input_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER initialize_match_company_input_revision AFTER INSERT ON companies
FOR EACH ROW EXECUTE FUNCTION app_private.initialize_match_company_input_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_company_row_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_private.bump_match_company_input_revision(NEW.id);
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_company_row_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_company_row_revision AFTER UPDATE ON companies
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_company_row_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_company_child_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_company_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'company_profiles' THEN
    IF (TG_OP = 'INSERT' AND NEW.user_id IS NOT NULL)
      OR (TG_OP = 'DELETE' AND OLD.user_id IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND OLD.user_id IS NOT NULL AND NEW.user_id IS NOT NULL) THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM app_private.bump_match_company_input_revision(NEW.company_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM app_private.bump_match_company_input_revision(OLD.company_id);
  ELSE
    FOR target_company_id IN
      SELECT DISTINCT id FROM unnest(ARRAY[OLD.company_id, NEW.company_id]) AS ids(id) ORDER BY id
    LOOP
      PERFORM app_private.bump_match_company_input_revision(target_company_id);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_company_child_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_company_profile_revision
AFTER INSERT OR UPDATE OR DELETE ON company_profiles
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_company_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_confirmation_answer_revision
AFTER INSERT OR UPDATE OR DELETE ON company_grant_confirmations
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_company_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_source_correction_revision
AFTER INSERT OR UPDATE OR DELETE ON profile_source_corrections
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_company_child_revision();--> statement-breakpoint

CREATE FUNCTION app_private.initialize_match_grant_input_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.match_grant_input_revisions(grant_id) VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.initialize_match_grant_input_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER initialize_match_grant_input_revision AFTER INSERT ON grants
FOR EACH ROW EXECUTE FUNCTION app_private.initialize_match_grant_input_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_grant_row_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_private.bump_match_grant_input_revision(NEW.id);
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_grant_row_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_grant_row_revision AFTER UPDATE ON grants
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_row_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_grant_child_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_grant_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.grant_id IS NOT NULL THEN
      PERFORM app_private.bump_match_grant_input_revision(NEW.grant_id);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.grant_id IS NOT NULL THEN
      PERFORM app_private.bump_match_grant_input_revision(OLD.grant_id);
    END IF;
  ELSE
    FOR target_grant_id IN
      SELECT DISTINCT id FROM unnest(ARRAY[OLD.grant_id, NEW.grant_id]) AS ids(id)
      WHERE id IS NOT NULL ORDER BY id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_grant_child_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_grant_criterion_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_criteria
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_confirmation_question_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_confirmation_questions
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_extraction_log_revision
AFTER INSERT OR UPDATE OR DELETE ON extraction_log
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_application_surface_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_application_surfaces
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_markdown_artifact_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_grant_id uuid;
BEGIN
  FOR target_grant_id IN
    SELECT DISTINCT surface.grant_id
    FROM public.grant_application_surfaces surface
    JOIN unnest(CASE
      WHEN TG_OP = 'INSERT' AND NEW.kind = 'markdown' THEN ARRAY[NEW.surface_id]
      WHEN TG_OP = 'DELETE' AND OLD.kind = 'markdown' THEN ARRAY[OLD.surface_id]
      WHEN TG_OP = 'UPDATE' THEN ARRAY[
        CASE WHEN OLD.kind = 'markdown' THEN OLD.surface_id END,
        CASE WHEN NEW.kind = 'markdown' THEN NEW.surface_id END
      ]
      ELSE ARRAY[]::uuid[]
    END) AS surface_ids(id) ON surface.id = surface_ids.id
    ORDER BY surface.grant_id
  LOOP
    PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_markdown_artifact_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_markdown_artifact_revision
AFTER INSERT OR UPDATE OR DELETE ON document_artifacts
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_markdown_artifact_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_deep_run_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_deep_analysis_runs
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_promotion_item_revision
AFTER INSERT OR UPDATE OR DELETE ON analysis_lab_promotion_items
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_child_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_grant_source_child_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE source_name text; source_key text; target_grant_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'grant_raw' THEN
    IF TG_OP = 'UPDATE'
       AND OLD.payload IS NOT DISTINCT FROM NEW.payload
       AND OLD.attachments IS NOT DISTINCT FROM NEW.attachments
       AND OLD.raw_hash IS NOT DISTINCT FROM NEW.raw_hash
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.source IS NOT DISTINCT FROM NEW.source
       AND OLD.source_id IS NOT DISTINCT FROM NEW.source_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    FOR target_grant_id IN
      SELECT id FROM public.grants WHERE source::text = NEW.source::text AND source_id = NEW.source_id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR target_grant_id IN
      SELECT id FROM public.grants WHERE source::text = OLD.source::text AND source_id = OLD.source_id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
  ELSE
    FOR target_grant_id IN
      SELECT DISTINCT grant_row.id
      FROM public.grants grant_row
      JOIN (VALUES (OLD.source::text, OLD.source_id), (NEW.source::text, NEW.source_id)) source_key(source, source_id)
        ON grant_row.source::text = source_key.source AND grant_row.source_id = source_key.source_id
      ORDER BY grant_row.id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_grant_source_child_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_grant_raw_revision
AFTER INSERT OR DELETE OR UPDATE ON grant_raw
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_source_child_revision();--> statement-breakpoint
CREATE TRIGGER bump_match_attachment_archive_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_attachment_archives
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_grant_source_child_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_deep_stage_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_grant_id uuid;
BEGIN
  FOR target_grant_id IN
    SELECT DISTINCT run.grant_id
    FROM public.grant_deep_analysis_runs run
    JOIN unnest(CASE WHEN TG_OP = 'INSERT' THEN ARRAY[NEW.run_id]
                     WHEN TG_OP = 'DELETE' THEN ARRAY[OLD.run_id]
                     ELSE ARRAY[OLD.run_id, NEW.run_id] END) AS run_ids(id)
      ON run.id = run_ids.id
    ORDER BY run.grant_id
  LOOP
    PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_deep_stage_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_deep_stage_revision
AFTER INSERT OR UPDATE OR DELETE ON grant_deep_analysis_stage_receipts
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_deep_stage_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_promotion_release_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_release_id uuid; target_grant_id uuid;
BEGIN
  target_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  FOR target_grant_id IN
    SELECT DISTINCT grant_id FROM public.analysis_lab_promotion_items
    WHERE release_db_id = target_release_id ORDER BY grant_id
  LOOP
    PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_promotion_release_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_promotion_release_revision
AFTER UPDATE OR DELETE ON analysis_lab_promotion_releases
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_promotion_release_revision();--> statement-breakpoint

CREATE FUNCTION app_private.bump_match_dedup_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_grant_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOR target_grant_id IN
      SELECT DISTINCT id FROM unnest(ARRAY[OLD.canonical_grant_id, OLD.member_grant_id]) AS ids(id) ORDER BY id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    FOR target_grant_id IN
      SELECT DISTINCT id FROM unnest(ARRAY[NEW.canonical_grant_id, NEW.member_grant_id]) AS ids(id) ORDER BY id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
    RETURN NEW;
  ELSIF OLD.canonical_grant_id IS DISTINCT FROM NEW.canonical_grant_id
    OR OLD.member_grant_id IS DISTINCT FROM NEW.member_grant_id
    OR OLD.confirmed IS DISTINCT FROM NEW.confirmed THEN
    FOR target_grant_id IN
      SELECT DISTINCT id FROM unnest(ARRAY[
        OLD.canonical_grant_id, OLD.member_grant_id, NEW.canonical_grant_id, NEW.member_grant_id
      ]) AS ids(id) ORDER BY id
    LOOP
      PERFORM app_private.bump_match_grant_input_revision(target_grant_id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.bump_match_dedup_revision() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER bump_match_dedup_revision
AFTER INSERT OR UPDATE OR DELETE ON dedup_links
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_dedup_revision();
