CREATE FUNCTION app_private.enforce_match_state_writer_contract() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_setting('app.match_state_writer_contract', true) IS DISTINCT FROM 'match-state-input-v1' THEN
    RAISE EXCEPTION 'match_state write requires match-state-input-v1 writer contract'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.calculation_as_of IS NULL
     OR NEW.input_binding IS NULL
     OR jsonb_typeof(NEW.input_binding) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'match_state write requires a valid v1 input binding and calculation_as_of'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.input_binding - ARRAY[
       'version', 'companyId', 'companyRevision', 'grantId', 'grantComponentRevisions'
     ]::text[] <> '{}'::jsonb
     OR jsonb_typeof(NEW.input_binding -> 'version') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.input_binding -> 'companyId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.input_binding -> 'companyRevision') IS DISTINCT FROM 'string'
     OR jsonb_typeof(NEW.input_binding -> 'grantId') IS DISTINCT FROM 'string'
     OR NEW.input_binding ->> 'version' IS DISTINCT FROM 'match-state-input-v1'
     OR NEW.input_binding ->> 'companyId' IS DISTINCT FROM NEW.company_id::text
     OR NEW.input_binding ->> 'grantId' IS DISTINCT FROM NEW.grant_id::text
     OR coalesce(NEW.input_binding ->> 'companyRevision', '') !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'match_state write requires a valid v1 input binding and calculation_as_of'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(NEW.input_binding -> 'grantComponentRevisions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'match_state write requires a valid v1 input binding and calculation_as_of'
      USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(NEW.input_binding -> 'grantComponentRevisions') = 0
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(NEW.input_binding -> 'grantComponentRevisions') component
       WHERE jsonb_typeof(component) IS DISTINCT FROM 'object'
          OR CASE WHEN jsonb_typeof(component) = 'object' THEN
            component - ARRAY['grantId', 'revision']::text[] <> '{}'::jsonb
            ELSE false
          END
          OR jsonb_typeof(component -> 'grantId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(component -> 'revision') IS DISTINCT FROM 'string'
          OR coalesce(component ->> 'grantId', '') !~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          OR coalesce(component ->> 'revision', '') !~ '^[1-9][0-9]*$'
     )
     OR jsonb_array_length(NEW.input_binding -> 'grantComponentRevisions') <> (
       SELECT count(DISTINCT component ->> 'grantId')
       FROM jsonb_array_elements(NEW.input_binding -> 'grantComponentRevisions') component
     )
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(NEW.input_binding -> 'grantComponentRevisions') component
       WHERE component ->> 'grantId' = NEW.grant_id::text
     ) THEN
    RAISE EXCEPTION 'match_state write requires a valid v1 input binding and calculation_as_of'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.enforce_match_state_writer_contract() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER enforce_match_state_writer_contract
BEFORE INSERT OR UPDATE ON match_state
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_match_state_writer_contract();
