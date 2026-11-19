-- admin_audit_logs is append-only at the database level. Any UPDATE or DELETE
-- raises, with ONE narrow exception: the users FK is ON DELETE SET NULL, so when
-- a user row is removed Postgres updates actor_user_id to NULL. That single
-- column change (to NULL, nothing else changed) is allowed so user cleanup keeps working.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.actor_user_id IS NULL
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.target_type = OLD.target_type
     AND NEW.target_id = OLD.target_id
     AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'admin_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER admin_audit_logs_append_only
BEFORE UPDATE OR DELETE ON admin_audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
