-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove finance (issue #2512, ADR-0045 point 1, plan stock-and-marketplaces.md sections 8.1 and 8.2): the items of stock, the names a source uses for them, and the
-- ledger of stock moves. Idempotent; applied files stay untouched. Nothing here posts an entry: the stock only mirrors what the books already hold.
--
-- stock_item    one item of stock per legal entity: a code (unique per entity), a name, one base unit, the kind (`goods` first), the stock account it is booked to, the
--               trade it is sold in, and an active flag. An item is deactivated, never deleted. Owners, admins and members write items; a tenant role updates only the
--               name, the unit, the account, the trade and the flag, and the unit and the account are fixed once a move names the item.
-- stock_alias   a name a source uses for an item (a purchase line's normalized description, a marketplace SKU) and the factor to the item's unit (a carton of 12).
--               Unique per entity and source. Inserted and deleted by owners, admins and members, never updated.
-- stock_move    the ledger of stock, treated like the books' own: APPEND-ONLY. A signed quantity, a date and the source (a line of a posted document, a manual entry, or
--               the reversal of an earlier move). No role updates or deletes a row (no grant, and the kernel's append-only trigger), a correction is a reversing move of the
--               opposite quantity, and a move is reversed at most once. Written only by commands, through the one write path.
--               On hand is the sum of an item's moves and its cost is recomputed from them: neither is a column.
--
-- Quantities are numeric(20, 6) (crove_finance.quantity), never floating point. Every table has org_id, PRIMARY KEY (org_id, id), RLS with a RESTRICTIVE `le_scope`
-- per legal entity, and the legal entity of an alias or a move is its item's. The org purge deletes the aliases and the items no move names, and keeps the moves with the
-- items they name, as it keeps the ledger (the next migration).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_item (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  unit text NOT NULL CHECK (char_length(unit) BETWEEN 1 AND 30),
  kind text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods')),
  -- A chart account code (156 for goods, or a sub-account of it); the command checks it is in the entity's chart and fits the kind.
  stock_account text NOT NULL CHECK (stock_account ~ '^[0-9]{3,10}(\.[A-Z0-9]{1,20})?$'),
  trade text NOT NULL DEFAULT 'goods' CHECK (trade IN ('goods', 'services', 'catering', 'other')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- Backs the composite keys of the aliases and the moves: their entity is their item's.
  CONSTRAINT stock_item_entity_id_uq UNIQUE (org_id, legal_entity_id, id),
  CONSTRAINT stock_item_entity_fk FOREIGN KEY (org_id, legal_entity_id) REFERENCES crove_kernel.legal_entity (org_id, id),
  CONSTRAINT stock_item_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
-- A code is one per entity whatever its case, because a line is matched to it without case.
CREATE UNIQUE INDEX IF NOT EXISTS stock_item_code_uq ON crove_finance.stock_item (org_id, legal_entity_id, (pg_catalog.lower(code)));
CREATE INDEX IF NOT EXISTS stock_item_entity_idx ON crove_finance.stock_item (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS stock_item_created_by_idx ON crove_finance.stock_item (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_item');
-- An item is deactivated, never deleted; only these columns change.
REVOKE DELETE, UPDATE ON crove_finance.stock_item FROM crove_tenant;
GRANT UPDATE (name, unit, stock_account, trade, active, updated_at) ON crove_finance.stock_item TO crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_item;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id ON crove_finance.stock_item
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill();
ALTER TABLE crove_finance.stock_item ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_item;
CREATE POLICY le_scope ON crove_finance.stock_item AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
-- Owners, admins and members write (the roles that post purchases and sales); a viewer only reads. The system context writes too (a job that assigns lines).
DROP POLICY IF EXISTS stock_item_insert ON crove_finance.stock_item;
CREATE POLICY stock_item_insert ON crove_finance.stock_item AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS stock_item_update ON crove_finance.stock_item;
CREATE POLICY stock_item_update ON crove_finance.stock_item AS RESTRICTIVE FOR UPDATE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')))
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_item.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- The unit and the stock account of an item that has moves are fixed: a quantity means its unit, and the account is where its value is booked.
CREATE OR REPLACE FUNCTION crove_finance.stock_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.unit IS DISTINCT FROM OLD.unit OR NEW.stock_account IS DISTINCT FROM OLD.stock_account)
     AND EXISTS (SELECT 1 FROM crove_finance.stock_move m WHERE m.org_id = OLD.org_id AND m.item_id = OLD.id) THEN
    RAISE EXCEPTION 'STOCK_ITEM_IN_USE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_item_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;

-- ---------------------------------------------------------------------------
-- 2. Aliases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_alias (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  item_id uuid NOT NULL,
  -- Where the name comes from: `text` for a document line's description, or a marketplace.
  source text NOT NULL DEFAULT 'text' CHECK (source ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- The name as the source writes it, normalized (the command's normalizer: trimmed, lower case, spaces collapsed), or the SKU.
  alias_key text NOT NULL CHECK (char_length(alias_key) BETWEEN 1 AND 300),
  -- How many of the item's units one of the source's is (a carton of 12).
  factor numeric(18, 6) NOT NULL DEFAULT 1 CHECK (factor > 0),
  -- The unit of the source the factor was taught in ('thùng'): a line of the same name in another unit does not match, so a factor is never applied to a unit it was not made for.
  -- NULL when none was given (the name then matches whatever the unit).
  source_unit text CHECK (source_unit IS NULL OR char_length(source_unit) BETWEEN 1 AND 40),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  CONSTRAINT stock_alias_key_uq UNIQUE (org_id, legal_entity_id, source, alias_key),
  CONSTRAINT stock_alias_item_fk FOREIGN KEY (org_id, legal_entity_id, item_id) REFERENCES crove_finance.stock_item (org_id, legal_entity_id, id),
  CONSTRAINT stock_alias_member_fk FOREIGN KEY (org_id, created_by) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE INDEX IF NOT EXISTS stock_alias_item_idx ON crove_finance.stock_alias (org_id, legal_entity_id, item_id);
CREATE INDEX IF NOT EXISTS stock_alias_entity_idx ON crove_finance.stock_alias (legal_entity_id, org_id);
CREATE INDEX IF NOT EXISTS stock_alias_created_by_idx ON crove_finance.stock_alias (org_id, created_by) WHERE created_by IS NOT NULL;
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_alias');
-- An alias is taught and forgotten, never changed.
REVOKE UPDATE ON crove_finance.stock_alias FROM crove_tenant;
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_alias;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, item_id ON crove_finance.stock_alias
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.stock_item', 'item_id');
ALTER TABLE crove_finance.stock_alias ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_alias;
CREATE POLICY le_scope ON crove_finance.stock_alias AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS stock_alias_insert ON crove_finance.stock_alias;
CREATE POLICY stock_alias_insert ON crove_finance.stock_alias AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_alias.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));
DROP POLICY IF EXISTS stock_alias_delete ON crove_finance.stock_alias;
CREATE POLICY stock_alias_delete ON crove_finance.stock_alias AS RESTRICTIVE FOR DELETE TO crove_tenant
  USING ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_alias.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- ---------------------------------------------------------------------------
-- 3. Moves (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crove_finance.stock_move (
  org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT crove_kernel.uuid_v7(),
  legal_entity_id uuid NOT NULL,
  item_id uuid NOT NULL,
  move_date date NOT NULL,
  -- Signed: in is positive, out is negative. Never zero.
  quantity crove_finance.quantity NOT NULL CHECK (quantity <> 0),
  -- `document_line`: a line of a posted purchase or sale (document_id and line_no name it); `manual`: a count or an opening entry a person made; `reversal`: the
  -- opposite of an earlier move (reverses_move_id).
  source_type text NOT NULL CHECK (source_type IN ('document_line', 'manual', 'reversal')),
  document_id uuid,
  line_no int,
  -- The try of this line: 1 for the first move a line makes, 2 for the one that replaces it once the first was reversed, and so on. A line has one live move: the one of its latest try.
  line_attempt int CHECK (line_attempt IS NULL OR line_attempt >= 1),
  reverses_move_id uuid,
  -- The member who made it, as an id with no foreign key: removing a member must not update an append-only row (the books name their authors the same way).
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (org_id, id),
  -- A document line move names its document, line and try; a manual move or a reversal names none of them.
  CONSTRAINT stock_move_source_ck CHECK (
    CASE WHEN source_type = 'document_line' THEN document_id IS NOT NULL AND line_no IS NOT NULL AND line_attempt IS NOT NULL
         ELSE document_id IS NULL AND line_no IS NULL AND line_attempt IS NULL END
  ),
  CONSTRAINT stock_move_reversal_ck CHECK ((source_type = 'reversal') = (reverses_move_id IS NOT NULL)),
  CONSTRAINT stock_move_item_fk FOREIGN KEY (org_id, legal_entity_id, item_id) REFERENCES crove_finance.stock_item (org_id, legal_entity_id, id),
  CONSTRAINT stock_move_line_fk FOREIGN KEY (org_id, document_id, line_no) REFERENCES crove_finance.purchase_line (org_id, document_id, line_no),
  CONSTRAINT stock_move_reverses_fk FOREIGN KEY (org_id, reverses_move_id) REFERENCES crove_finance.stock_move (org_id, id)
);
-- A try of a line moves stock once, and a move is reversed once.
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_line_uq ON crove_finance.stock_move (org_id, document_id, line_no, line_attempt) WHERE source_type = 'document_line';
CREATE INDEX IF NOT EXISTS stock_move_document_idx ON crove_finance.stock_move (org_id, document_id, line_no) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_move_reversal_uq ON crove_finance.stock_move (org_id, reverses_move_id) WHERE reverses_move_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_move_item_idx ON crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date);
CREATE INDEX IF NOT EXISTS stock_move_entity_idx ON crove_finance.stock_move (legal_entity_id, org_id);
-- SELECT and INSERT only: no UPDATE or DELETE grant for a tenant role.
SELECT crove_kernel.apply_tenant_rls('crove_finance.stock_move', true);
DROP TRIGGER IF EXISTS b_legal_entity ON crove_finance.stock_move;
CREATE TRIGGER b_legal_entity BEFORE INSERT OR UPDATE OF legal_entity_id, item_id ON crove_finance.stock_move
  FOR EACH ROW EXECUTE FUNCTION crove_finance.legal_entity_fill('crove_finance.stock_item', 'item_id');
ALTER TABLE crove_finance.stock_move ENABLE ALWAYS TRIGGER b_legal_entity;
DROP POLICY IF EXISTS le_scope ON crove_finance.stock_move;
CREATE POLICY le_scope ON crove_finance.stock_move AS RESTRICTIVE FOR ALL TO crove_tenant
  USING ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]))
  WITH CHECK ('*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]) OR legal_entity_id::text = ANY ((SELECT crove_kernel.ctx_le_scope())::text[]));
DROP POLICY IF EXISTS stock_move_insert ON crove_finance.stock_move;
CREATE POLICY stock_move_insert ON crove_finance.stock_move AS RESTRICTIVE FOR INSERT TO crove_tenant
  WITH CHECK ((SELECT crove_kernel.ctx_actor_type()) = 'system'
    OR EXISTS (SELECT 1 FROM crove_kernel.tenant_member m WHERE m.org_id = stock_move.org_id AND m.user_id = (SELECT crove_kernel.ctx_user_id()) AND m.role IN ('owner', 'admin', 'member')));

-- Append-only for every role, like the books: the kernel's guard refuses every UPDATE, DELETE and TRUNCATE. The org purge keeps the moves, as it keeps the ledger (the stock
-- book is an accounting record), together with the items they name.
SELECT crove_kernel.make_append_only('crove_finance.stock_move');

-- A reversal is the exact opposite of an earlier move of the same item that is not itself a reversal; the unique index above says it happens once. A line's second try
-- (the replacement of a move reversed because the line was assigned to the wrong item) needs the first one reversed. The item row is held FOR SHARE while a move is written, so
-- a change of the item's unit or account cannot slip in between the check that it has no moves and its first move.
CREATE OR REPLACE FUNCTION crove_finance.stock_move_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM crove_finance.stock_item i WHERE i.org_id = NEW.org_id AND i.id = NEW.item_id FOR SHARE;
  IF NEW.source_type = 'document_line' AND NEW.line_attempt > 1
     AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_move p JOIN crove_finance.stock_move r ON r.org_id = p.org_id AND r.reverses_move_id = p.id
       WHERE p.org_id = NEW.org_id AND p.document_id = NEW.document_id AND p.line_no = NEW.line_no AND p.source_type = 'document_line' AND p.line_attempt = NEW.line_attempt - 1) THEN
    RAISE EXCEPTION 'STOCK_LINE_ATTEMPT' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_type = 'reversal'
     AND NOT EXISTS (
       SELECT 1 FROM crove_finance.stock_move o
       WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_move_id AND o.item_id = NEW.item_id AND o.source_type <> 'reversal' AND o.quantity = -NEW.quantity) THEN
    RAISE EXCEPTION 'STOCK_REVERSAL' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_finance.stock_move_guard() FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant;
DROP TRIGGER IF EXISTS stock_move_guard ON crove_finance.stock_move;
CREATE TRIGGER stock_move_guard BEFORE INSERT ON crove_finance.stock_move FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_move_guard();

DROP TRIGGER IF EXISTS stock_item_guard ON crove_finance.stock_item;
CREATE TRIGGER stock_item_guard BEFORE UPDATE ON crove_finance.stock_item FOR EACH ROW EXECUTE FUNCTION crove_finance.stock_item_guard();
