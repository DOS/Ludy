-- SPDX-License-Identifier: AGPL-3.0-only
-- Notes v2 (T3, #3557): recurring personal to-dos on crove_notes.todo.
-- Adds recurrence (jsonb rule validated by crove_notes.todo_recurrence_valid) and series_id (uuid linking
-- occurrences of the same recurring series). Keeps all ADR-0037 author-only isolation and column grants intact.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION crove_notes.todo_recurrence_valid(p_rule jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_freq text;
  v_interval_txt text;
  v_interval integer;
  v_weekday_txt text;
  v_month_day_txt text;
  v_month_day integer;
BEGIN
  IF p_rule IS NULL THEN
    RETURN true;
  END IF;
  IF pg_catalog.jsonb_typeof(p_rule) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF NOT (p_rule ? 'freq') OR NOT (p_rule ? 'interval') THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_rule) AS k(key)
    WHERE k.key NOT IN ('freq', 'interval', 'byWeekday', 'byMonthDay')
  ) THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_rule -> 'freq') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  v_freq := p_rule ->> 'freq';
  IF v_freq IS NULL OR v_freq NOT IN ('daily', 'weekly', 'monthly') THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_rule -> 'interval') IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  v_interval_txt := p_rule ->> 'interval';
  IF v_interval_txt IS NULL OR v_interval_txt !~ '^[1-9][0-9]{0,2}$' THEN
    RETURN false;
  END IF;
  v_interval := v_interval_txt::integer;
  IF v_interval IS NULL OR v_interval < 1 OR v_interval > 365 THEN
    RETURN false;
  END IF;

  IF p_rule ? 'byWeekday' AND pg_catalog.jsonb_typeof(p_rule -> 'byWeekday') IS DISTINCT FROM 'null' THEN
    IF v_freq IS DISTINCT FROM 'weekly' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(p_rule -> 'byWeekday') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    v_weekday_txt := p_rule ->> 'byWeekday';
    IF v_weekday_txt IS NULL OR v_weekday_txt !~ '^[0-6]$' THEN
      RETURN false;
    END IF;
  END IF;

  IF p_rule ? 'byMonthDay' AND pg_catalog.jsonb_typeof(p_rule -> 'byMonthDay') IS DISTINCT FROM 'null' THEN
    IF v_freq IS DISTINCT FROM 'monthly' THEN
      RETURN false;
    END IF;
    IF pg_catalog.jsonb_typeof(p_rule -> 'byMonthDay') IS DISTINCT FROM 'number' THEN
      RETURN false;
    END IF;
    v_month_day_txt := p_rule ->> 'byMonthDay';
    IF v_month_day_txt IS NULL OR v_month_day_txt !~ '^(-1|[1-9][0-9]?)$' THEN
      RETURN false;
    END IF;
    v_month_day := v_month_day_txt::integer;
    IF v_month_day IS NULL OR NOT (v_month_day = -1 OR (v_month_day >= 1 AND v_month_day <= 31)) THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION crove_notes.todo_recurrence_valid(jsonb)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_notes.todo_recurrence_valid(jsonb) TO crove_tenant, crove_worker;

ALTER TABLE crove_notes.todo
  ADD COLUMN IF NOT EXISTS recurrence jsonb,
  ADD COLUMN IF NOT EXISTS series_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_notes.todo'::pg_catalog.regclass
      AND conname = 'todo_recurrence_shape'
  ) THEN
    ALTER TABLE crove_notes.todo
      ADD CONSTRAINT todo_recurrence_shape
      CHECK (crove_notes.todo_recurrence_valid(recurrence));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS todo_series_idx
  ON crove_notes.todo (org_id, owner_user_id, series_id)
  WHERE series_id IS NOT NULL;

GRANT UPDATE (recurrence, series_id) ON crove_notes.todo TO crove_tenant;
