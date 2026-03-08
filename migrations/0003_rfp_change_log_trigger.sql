-- RFP Change Log Trigger
-- ======================
-- Fires on every UPDATE to rfp_approval_requests and inserts a row into
-- rfp_change_log for each changed column. Works for API and direct DB edits.

CREATE OR REPLACE FUNCTION rfp_log_changes()
RETURNS TRIGGER AS $$
DECLARE
  col_name TEXT;
  old_val TEXT;
  new_val TEXT;
  changed_by_val VARCHAR(255);
BEGIN
  -- Use session variable or current_user for changed_by when not set by app
  changed_by_val := COALESCE(
    current_setting('app.rfp_changed_by', true),
    current_user
  );

  -- Compare each column (excluding id)
  IF OLD.hubspot_deal_id IS DISTINCT FROM NEW.hubspot_deal_id THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'hubspot_deal_id', OLD.hubspot_deal_id, COALESCE(NEW.hubspot_deal_id::text, ''), changed_by_val);
  END IF;

  IF OLD.token IS DISTINCT FROM NEW.token THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'token', OLD.token, COALESCE(NEW.token, ''), changed_by_val);
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'status', OLD.status, COALESCE(NEW.status, ''), changed_by_val);
  END IF;

  IF OLD.deal_data::text IS DISTINCT FROM NEW.deal_data::text THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'deal_data', OLD.deal_data::text, COALESCE(NEW.deal_data::text, ''), changed_by_val);
  END IF;

  IF OLD.edited_fields::text IS DISTINCT FROM NEW.edited_fields::text THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'edited_fields', OLD.edited_fields::text, COALESCE(NEW.edited_fields::text, ''), changed_by_val);
  END IF;

  IF OLD.approved_attachments::text IS DISTINCT FROM NEW.approved_attachments::text THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'approved_attachments', OLD.approved_attachments::text, COALESCE(NEW.approved_attachments::text, ''), changed_by_val);
  END IF;

  IF OLD.approved_by IS DISTINCT FROM NEW.approved_by THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'approved_by', OLD.approved_by, COALESCE(NEW.approved_by, ''), changed_by_val);
  END IF;

  IF OLD.approved_at IS DISTINCT FROM NEW.approved_at THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'approved_at', OLD.approved_at::text, COALESCE(NEW.approved_at::text, ''), changed_by_val);
  END IF;

  IF OLD.declined_by IS DISTINCT FROM NEW.declined_by THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'declined_by', OLD.declined_by, COALESCE(NEW.declined_by, ''), changed_by_val);
  END IF;

  IF OLD.declined_at IS DISTINCT FROM NEW.declined_at THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'declined_at', OLD.declined_at::text, COALESCE(NEW.declined_at::text, ''), changed_by_val);
  END IF;

  IF OLD.bidboard_project_id IS DISTINCT FROM NEW.bidboard_project_id THEN
    INSERT INTO rfp_change_log (rfp_id, field_changed, old_value, new_value, changed_by)
    VALUES (NEW.id, 'bidboard_project_id', OLD.bidboard_project_id, COALESCE(NEW.bidboard_project_id, ''), changed_by_val);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rfp_change_log ON rfp_approval_requests;
CREATE TRIGGER trg_rfp_change_log
  AFTER UPDATE ON rfp_approval_requests
  FOR EACH ROW
  EXECUTE PROCEDURE rfp_log_changes();
