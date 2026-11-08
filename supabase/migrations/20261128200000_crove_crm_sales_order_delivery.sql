-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove CRM (issue #2697, ADR-0050 point 4, plan docs/plan/crm-quotes.md sections 4.8 and 6.5, step Q4b): the delivery of a sales order line. Idempotent; applied files stay untouched.
--
-- crove_crm.sales_order_delivery  append-only: a row says a goods line of a confirmed order was delivered on a day (kind 'delivery') or that such a delivery was a mistake (kind
--                                 'reversal', naming the delivery row it reverses). Owners, admins and members insert it through the deliver and undeliver commands; nobody updates or
--                                 deletes it. One delivery per line (a whole line, no partial quantity) and one reversal per delivery, so a line is not delivered again after a return
--                                 in this slice (ADR-0050 "Left out"). A service (text) line takes none.
-- crove_crm.sales_order_guard     gains one refusal: an order with a delivery that was not reversed is not cancelled (the cancel command checks it too, with a typed error).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The delivery
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_crm.sales_order_delivery (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  order_id uuid NOT NULL,
  line_no smallint NOT NULL,
  -- The set is the product's (SALES_ORDER_DELIVERY_KINDS in packages/db/src/schema.ts, compared with this constraint by check-unions.db.test.ts).
  kind text NOT NULL CHECK (kind IN ('delivery', 'reversal')),
  -- The day the goods left, in Vietnam's calendar; a reversal has none (it takes back the delivery it names).
  delivered_on date,
  reverses_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT sales_order_delivery_shape_check CHECK (
    (kind = 'delivery' AND delivered_on IS NOT NULL AND reverses_id IS NULL)
    OR (kind = 'reversal' AND delivered_on IS NULL AND reverses_id IS NOT NULL)),
  -- A delivery names a line of an order; deleting the order's lines (the org purge only) takes its deliveries with them.
  CONSTRAINT sales_order_delivery_line_fk FOREIGN KEY (org_id, order_id, line_no) REFERENCES crove_crm.sales_order_line (org_id, order_id, line_no) ON DELETE CASCADE,
  -- A reversal names a delivery of the same order and line: the four columns together.
  CONSTRAINT sales_order_delivery_key_uq UNIQUE (org_id, id, order_id, line_no),
  CONSTRAINT sales_order_delivery_reverses_fk FOREIGN KEY (org_id, reverses_id, order_id, line_no) REFERENCES crove_crm.sales_order_delivery (org_id, id, order_id, line_no) ON DELETE CASCADE
);
-- One delivery per line, ever, and one reversal per delivery; the plain index backs the line's foreign key and the order's read.
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_delivery_line_uq ON crove_crm.sales_order_delivery (org_id, order_id, line_no) WHERE kind = 'delivery';
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_delivery_reversal_uq ON crove_crm.sales_order_delivery (org_id, reverses_id) WHERE kind = 'reversal';
CREATE INDEX IF NOT EXISTS sales_order_delivery_order_idx ON crove_crm.sales_order_delivery (org_id, order_id, line_no, created_at);
SELECT crove_kernel.apply_tenant_rls('crove_crm.sales_order_delivery');
-- Append-only: tenant roles read and insert, never update or delete (APPEND_ONLY in the RLS matrix).
REVOKE UPDATE, DELETE ON crove_crm.sales_order_delivery FROM crove_tenant;
-- Owners, admins and members write; a viewer only reads. The row is made by the person who signs it, for an item line of a confirmed order.
DROP POLICY IF EXISTS sales_order_delivery_insert ON crove_crm.sales_order_delivery;
CREATE POLICY sales_order_delivery_insert ON crove_crm.sales_order_delivery AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR (EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = sales_order_delivery.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member'))
      AND sales_order_delivery.created_by = (SELECT crove_kernel.ctx_user_id())
      AND EXISTS (SELECT 1 FROM crove_crm.sales_order o JOIN crove_crm.sales_order_line l ON l.org_id = o.org_id AND l.order_id = o.id
        WHERE o.org_id = sales_order_delivery.org_id AND o.id = sales_order_delivery.order_id AND o.status = 'confirmed'
          AND l.line_no = sales_order_delivery.line_no AND l.kind = 'item')));

-- ---------------------------------------------------------------------------
-- 2. The order's guard: no cancellation of an order that was delivered
-- ---------------------------------------------------------------------------
-- The guard of Q4 (20261128170000) with one refusal added to the cancellation branch: a delivery nobody reversed. Every other rule is as it was.
CREATE OR REPLACE FUNCTION crove_crm.sales_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
  v_keep text[] := ARRAY['version', 'updated_by', 'updated_at'];
BEGIN
  IF v_actor IS NULL OR v_actor = 'system' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'an order is cancelled, never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - v_keep) IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
    IF (pg_catalog.to_jsonb(NEW) - v_keep - 'status' - 'cancelled_at' - 'cancel_reason') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_keep - 'status' - 'cancelled_at' - 'cancel_reason')
       OR NEW.cancelled_at IS NULL OR NEW.cancel_reason IS NULL THEN
      RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'a cancellation changes the status, its time and its reason only';
    END IF;
    IF EXISTS (SELECT 1 FROM crove_crm.sales_order_delivery d
      WHERE d.org_id = OLD.org_id AND d.order_id = OLD.id AND d.kind = 'delivery'
        AND NOT EXISTS (SELECT 1 FROM crove_crm.sales_order_delivery r WHERE r.org_id = d.org_id AND r.reverses_id = d.id AND r.kind = 'reversal')) THEN
      RAISE EXCEPTION 'ORDER_DELIVERED' USING ERRCODE = '42501', DETAIL = 'an order with a delivery that was not reversed is not cancelled';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ORDER_FROZEN' USING ERRCODE = '42501', DETAIL = 'an order does not change but to be cancelled once';
END $$;
REVOKE ALL ON FUNCTION crove_crm.sales_order_guard() FROM PUBLIC;
