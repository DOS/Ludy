-- SPDX-License-Identifier: AGPL-3.0-only
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Project templates on crove_projects.project
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.template_tasks_valid(p_tasks jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_item jsonb;
  v_title text;
  v_desc text;
  v_offset text;
BEGIN
  IF p_tasks IS NULL OR pg_catalog.jsonb_typeof(p_tasks) <> 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_tasks) > 50 THEN
    RETURN false;
  END IF;

  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_tasks) LOOP
    IF pg_catalog.jsonb_typeof(v_item) <> 'object' THEN
      RETURN false;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(v_item) AS k(key)
      WHERE k.key NOT IN ('title', 'description', 'dueOffsetDays', 'tainted')
    ) THEN
      RETURN false;
    END IF;

    IF pg_catalog.jsonb_typeof(v_item -> 'title') <> 'string' THEN
      RETURN false;
    END IF;
    v_title := v_item ->> 'title';
    IF pg_catalog.char_length(pg_catalog.btrim(v_title)) < 1
       OR pg_catalog.char_length(v_title) > 300 THEN
      RETURN false;
    END IF;

    IF v_item ? 'description' AND pg_catalog.jsonb_typeof(v_item -> 'description') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'description') <> 'string' THEN
        RETURN false;
      END IF;
      v_desc := v_item ->> 'description';
      IF pg_catalog.char_length(v_desc) > 2000 THEN
        RETURN false;
      END IF;
    END IF;

    IF v_item ? 'dueOffsetDays' AND pg_catalog.jsonb_typeof(v_item -> 'dueOffsetDays') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'dueOffsetDays') <> 'number' THEN
        RETURN false;
      END IF;
      v_offset := v_item ->> 'dueOffsetDays';
      IF v_offset !~ '^[0-9]+$' OR v_offset::integer < 0 OR v_offset::integer > 365 THEN
        RETURN false;
      END IF;
    END IF;

    IF v_item ? 'tainted' AND pg_catalog.jsonb_typeof(v_item -> 'tainted') <> 'null' THEN
      IF pg_catalog.jsonb_typeof(v_item -> 'tainted') <> 'boolean' THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION crove_projects.template_tasks_valid(jsonb)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.template_tasks_valid(jsonb) TO crove_tenant, crove_worker;

ALTER TABLE crove_projects.project
  ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_tasks jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project'::pg_catalog.regclass
      AND conname = 'project_template_tasks_shape'
  ) THEN
    ALTER TABLE crove_projects.project
      ADD CONSTRAINT project_template_tasks_shape
      CHECK (crove_projects.template_tasks_valid(template_tasks));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project'::pg_catalog.regclass
      AND conname = 'project_template_tasks_only_when_template'
  ) THEN
    ALTER TABLE crove_projects.project
      ADD CONSTRAINT project_template_tasks_only_when_template
      CHECK (is_template OR template_tasks = '[]'::jsonb);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_template_idx
  ON crove_projects.project (org_id)
  WHERE is_template;

CREATE OR REPLACE FUNCTION crove_projects.project_template_no_tasks()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.is_template THEN
    PERFORM 1 FROM crove_projects.project_task pt
    WHERE pt.org_id = NEW.org_id AND pt.project_id = NEW.id;
    IF FOUND THEN
      RAISE EXCEPTION 'PROJECT_TEMPLATE_HAS_TASKS' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.project_template_no_tasks()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS project_template_no_tasks ON crove_projects.project;
CREATE TRIGGER project_template_no_tasks
  BEFORE INSERT OR UPDATE OF is_template ON crove_projects.project
  FOR EACH ROW EXECUTE FUNCTION crove_projects.project_template_no_tasks();

CREATE OR REPLACE FUNCTION crove_projects.project_task_not_on_template()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_is_template boolean;
BEGIN
  SELECT p.is_template INTO v_is_template
  FROM crove_projects.project p
  WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id
  FOR SHARE;
  IF COALESCE(v_is_template, false) THEN
    RAISE EXCEPTION 'PROJECT_TASK_ON_TEMPLATE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION crove_projects.project_task_not_on_template()
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

DROP TRIGGER IF EXISTS project_task_not_on_template ON crove_projects.project_task;
CREATE TRIGGER project_task_not_on_template
  BEFORE INSERT OR UPDATE OF org_id, project_id ON crove_projects.project_task
  FOR EACH ROW EXECUTE FUNCTION crove_projects.project_task_not_on_template();

-- ---------------------------------------------------------------------------
-- 2. Recurring tasks on crove_projects.project_task
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.recurrence_valid(r jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_cadence text;
  v_interval integer;
  v_weekday integer;
  v_month_day text;
  v_month_day_int integer;
  v_tz text;
  v_until text;
  v_parts text[];
  v_times integer;
BEGIN
  IF r IS NULL THEN
    RETURN true;
  END IF;
  IF pg_catalog.jsonb_typeof(r) <> 'object' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(r) AS k(key)
    WHERE k.key NOT IN ('cadence', 'interval', 'weekday', 'monthDay', 'timeZone', 'until', 'times')
  ) THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(r -> 'cadence') <> 'string' THEN
    RETURN false;
  END IF;
  v_cadence := r ->> 'cadence';
  IF v_cadence NOT IN ('weekly', 'monthly') THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(r -> 'interval') <> 'number'
     OR (r ->> 'interval') !~ '^[1-9][0-9]*$' THEN
    RETURN false;
  END IF;
  v_interval := (r ->> 'interval')::integer;
  IF v_interval < 1 OR v_interval > 12 THEN
    RETURN false;
  END IF;

  IF v_cadence = 'weekly' THEN
    IF pg_catalog.jsonb_typeof(r -> 'weekday') <> 'number'
       OR (r ->> 'weekday') !~ '^[0-6]$' THEN
      RETURN false;
    END IF;
    v_weekday := (r ->> 'weekday')::integer;
    IF v_weekday < 0 OR v_weekday > 6 THEN
      RETURN false;
    END IF;
    IF r ? 'monthDay' AND pg_catalog.jsonb_typeof(r -> 'monthDay') <> 'null' THEN
      RETURN false;
    END IF;
  ELSE
    IF pg_catalog.jsonb_typeof(r -> 'monthDay') <> 'number' THEN
      RETURN false;
    END IF;
    v_month_day := r ->> 'monthDay';
    IF v_month_day !~ '^(-1|[1-9][0-9]*)$' THEN
      RETURN false;
    END IF;
    v_month_day_int := v_month_day::integer;
    IF NOT (v_month_day_int = -1 OR (v_month_day_int >= 1 AND v_month_day_int <= 28)) THEN
      RETURN false;
    END IF;
    IF r ? 'weekday' AND pg_catalog.jsonb_typeof(r -> 'weekday') <> 'null' THEN
      RETURN false;
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(r -> 'timeZone') <> 'string' THEN
    RETURN false;
  END IF;
  v_tz := r ->> 'timeZone';
  IF pg_catalog.char_length(pg_catalog.btrim(v_tz)) < 1 OR pg_catalog.char_length(v_tz) > 64 THEN
    RETURN false;
  END IF;

  IF r ? 'until' AND pg_catalog.jsonb_typeof(r -> 'until') <> 'null' THEN
    IF pg_catalog.jsonb_typeof(r -> 'until') <> 'string' THEN
      RETURN false;
    END IF;
    v_until := r ->> 'until';
    IF v_until !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN false;
    END IF;
    v_parts := pg_catalog.string_to_array(v_until, '-');
    PERFORM pg_catalog.make_date(v_parts[1]::integer, v_parts[2]::integer, v_parts[3]::integer);
  END IF;

  IF r ? 'times' AND pg_catalog.jsonb_typeof(r -> 'times') <> 'null' THEN
    IF pg_catalog.jsonb_typeof(r -> 'times') <> 'number'
       OR (r ->> 'times') !~ '^[1-9][0-9]*$' THEN
      RETURN false;
    END IF;
    v_times := (r ->> 'times')::integer;
    IF v_times < 1 OR v_times > 500 THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION crove_projects.recurrence_valid(jsonb)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.recurrence_valid(jsonb) TO crove_tenant, crove_worker;

ALTER TABLE crove_projects.project_task
  ADD COLUMN IF NOT EXISTS recurrence jsonb,
  ADD COLUMN IF NOT EXISTS recurrence_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recurrence_last_due date,
  ADD COLUMN IF NOT EXISTS recurrence_next_at timestamptz,
  ADD COLUMN IF NOT EXISTS recurrence_source_task_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project_task'::pg_catalog.regclass
      AND conname = 'project_task_recurrence_shape'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_recurrence_shape
      CHECK (crove_projects.recurrence_valid(recurrence));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project_task'::pg_catalog.regclass
      AND conname = 'project_task_recurrence_count_nonneg'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_recurrence_count_nonneg
      CHECK (recurrence_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project_task'::pg_catalog.regclass
      AND conname = 'project_task_recurrence_not_copy'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_recurrence_not_copy
      CHECK (recurrence IS NULL OR recurrence_source_task_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'crove_projects.project_task'::pg_catalog.regclass
      AND conname = 'project_task_recurrence_source_fk'
  ) THEN
    ALTER TABLE crove_projects.project_task
      ADD CONSTRAINT project_task_recurrence_source_fk
      FOREIGN KEY (org_id, recurrence_source_task_id)
      REFERENCES crove_kernel.task (org_id, id)
      ON DELETE SET NULL (recurrence_source_task_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS project_task_recurrence_source_idx
  ON crove_projects.project_task (org_id, recurrence_source_task_id)
  WHERE recurrence_source_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS project_task_recurrence_next_idx
  ON crove_projects.project_task (org_id, recurrence_next_at)
  WHERE recurrence IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Worker scan definer for due recurring project tasks
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crove_projects.recurring_tasks_due(p_limit integer DEFAULT 100)
RETURNS TABLE (org_id uuid, project_id uuid, task_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_now timestamptz := pg_catalog.now();
BEGIN
  RETURN QUERY
  SELECT pt.org_id, pt.project_id, pt.task_id
  FROM crove_projects.project_task pt
  JOIN crove_projects.project p
    ON p.org_id = pt.org_id
   AND p.id = pt.project_id
  JOIN crove_kernel.tenant t
    ON t.org_id = pt.org_id
  JOIN crove_kernel.task src_t
    ON src_t.org_id = pt.org_id
   AND src_t.id = pt.task_id
  WHERE t.status = 'active'
    AND crove_kernel.org_app_on(t.org_id, 'projects')
    AND NOT p.is_template
    AND p.status = 'active'
    AND pt.recurrence IS NOT NULL
    AND pt.recurrence_source_task_id IS NULL
    AND pt.recurrence_next_at IS NOT NULL
    AND pt.recurrence_next_at <= v_now
    AND src_t.status IN ('done', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM crove_projects.project_task cpt
      JOIN crove_kernel.task ct
        ON ct.org_id = cpt.org_id
       AND ct.id = cpt.task_id
      WHERE cpt.org_id = pt.org_id
        AND cpt.recurrence_source_task_id = pt.task_id
        AND ct.status NOT IN ('done', 'cancelled')
    )
  ORDER BY pt.recurrence_next_at ASC, pt.org_id ASC, pt.task_id ASC
  LIMIT v_limit;
END $$;

REVOKE ALL ON FUNCTION crove_projects.recurring_tasks_due(integer)
  FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
GRANT EXECUTE ON FUNCTION crove_projects.recurring_tasks_due(integer) TO crove_worker;
