-- Extend only the existing leave and correction review guard. No historical rows are rewritten.
CREATE OR REPLACE FUNCTION protect_review_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reviewer_allowed BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='attendance_corrections' THEN
  IF OLD.status<>'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED','WITHDRAWN') OR
   (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','review_comment','applied_session_id','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','review_comment','applied_session_id','updated_at']) THEN RAISE EXCEPTION 'Correction proposal and decisions are immutable'; END IF;
 ELSIF TG_TABLE_NAME='overtime_reviews' THEN
  IF NEW.employee_id<>OLD.employee_id OR NEW.week_start_date<>OLD.week_start_date OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Overtime identity/revision mismatch'; END IF;
  IF OLD.status IN ('APPROVED','REJECTED','NOT_REQUIRED') AND (NEW.status<>'STALE' OR
   (to_jsonb(NEW)-ARRAY['status','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','updated_at'])) THEN RAISE EXCEPTION 'Reviewed snapshots must be retained until marked stale'; END IF;
  IF OLD.status='STALE' AND NEW.status NOT IN ('PENDING','NOT_REQUIRED') THEN RAISE EXCEPTION 'Stale overtime must be recomputed before review'; END IF;
  IF NEW.status IN ('PENDING','NOT_REQUIRED') AND (NEW.approved_seconds<>0 OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL) THEN RAISE EXCEPTION 'New calculation requires a new decision'; END IF;
  IF OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED') AND
   (to_jsonb(NEW)-ARRAY['status','approved_seconds','reviewed_by','reviewed_at','review_comment','revision','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','approved_seconds','reviewed_by','reviewed_at','review_comment','revision','updated_at']) THEN RAISE EXCEPTION 'Decision must use retained calculation inputs'; END IF;
 ELSIF TG_TABLE_NAME='leave_requests' THEN
  IF NOT ((OLD.status='PENDING' AND NEW.status IN ('APPROVED','REJECTED','WITHDRAWN')) OR (OLD.status='APPROVED' AND NEW.status='CANCELLED')) OR NEW.revision<>OLD.revision+1 OR
   (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','review_comment','revision','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','review_comment','revision','updated_at']) THEN RAISE EXCEPTION 'Leave proposal/history is immutable'; END IF;
 ELSIF TG_TABLE_NAME='notifications' THEN
  IF (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN RAISE EXCEPTION 'Notification content is immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME IN ('attendance_corrections','leave_requests','overtime_reviews') THEN
  IF NEW.reviewed_by IS NOT NULL AND NEW.status IN ('APPROVED','REJECTED','CANCELLED') THEN
   SELECT EXISTS (
    SELECT 1 FROM users u WHERE u.id=NEW.reviewed_by AND u.is_active
     AND (u.role='ADMIN' OR (u.role='HR_MANAGER' AND NOT EXISTS(
       SELECT 1 FROM employees e WHERE e.id=NEW.employee_id AND e.user_id=u.id
     )))
   ) INTO reviewer_allowed;
   IF NOT reviewer_allowed AND TG_TABLE_NAME IN ('attendance_corrections','leave_requests') THEN
    WITH local_day AS (
     SELECT (statement_timestamp() AT TIME ZONE timezone)::date AS date
     FROM organization_settings WHERE id=1
    )
    SELECT EXISTS (
     SELECT 1 FROM users u
     JOIN employees manager ON manager.user_id=u.id
     JOIN employment_periods subject ON subject.manager_employee_id=manager.id
     CROSS JOIN local_day
     WHERE u.id=NEW.reviewed_by AND u.role='EMPLOYEE' AND u.is_active
      AND u.account_status='ACTIVE' AND NOT u.must_change_password
      AND current_setting('app.actor_user_id',true)=u.id::text
      AND manager.id<>NEW.employee_id
      AND NEW.status IN ('APPROVED','REJECTED') AND NEW.review_comment ~ '[^[:space:]]'
      AND subject.id=NEW.employment_period_id AND subject.employee_id=NEW.employee_id
      AND subject.start_date<=local_day.date AND (subject.end_date IS NULL OR subject.end_date>local_day.date)
      AND EXISTS (
       SELECT 1 FROM employment_periods p WHERE p.employee_id=manager.id
        AND p.start_date<=local_day.date AND (p.end_date IS NULL OR p.end_date>local_day.date)
      )
    ) INTO reviewer_allowed;
   END IF;
   IF NOT reviewer_allowed THEN RAISE EXCEPTION 'An authorized non-self reviewer is required'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
