-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove kernel (issue #2306, plan docs/plan/conversations.md CV3, the last part): the intent a person applies to a conversation. Idempotent; applied
-- files stay untouched.
--
-- The suggestion of an intent is never stored: it is computed on read from the customer's words and shown as a suggestion (the AI coworker's, tainted,
-- never a fact). What is stored is the person's decision, one label per thread (question, order or price, complaint, invoice request, spam), the
-- member who applied it and when. The list filters by it. Only a person writes it: the guard below refuses the system and every other actor, a new
-- thread starts with no label, and a person's label names them. Nothing routes, assigns, resolves or hides a thread by its label.
SET LOCAL lock_timeout = '2s';

ALTER TABLE crove_kernel.conversation
  ADD COLUMN IF NOT EXISTS intent text CHECK (intent IN ('question', 'order_or_price', 'complaint', 'invoice_request', 'spam')),
  ADD COLUMN IF NOT EXISTS intent_set_by uuid,
  -- A label and the time it was applied come together, or neither is there.
  ADD COLUMN IF NOT EXISTS intent_set_at timestamptz CHECK ((intent IS NULL) = (intent_set_at IS NULL));
CREATE INDEX IF NOT EXISTS conversation_intent_idx ON crove_kernel.conversation (org_id, intent, last_message_at DESC NULLS LAST) WHERE intent IS NOT NULL;
GRANT UPDATE (intent, intent_set_by, intent_set_at) ON crove_kernel.conversation TO crove_tenant;

-- A thread starts with no label; a label is set, changed or cleared by a person in their own name and by nobody else. A database owner's own statement
-- has no context and is not held to it.
CREATE OR REPLACE FUNCTION crove_kernel.conversation_intent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor text := crove_kernel.ctx_actor_type();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.intent IS NOT NULL OR NEW.intent_set_by IS NOT NULL OR NEW.intent_set_at IS NOT NULL THEN
      RAISE EXCEPTION 'INTENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a conversation starts with no label';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.intent, NEW.intent_set_by, NEW.intent_set_at) IS NOT DISTINCT FROM (OLD.intent, OLD.intent_set_by, OLD.intent_set_at) THEN
    RETURN NEW;
  END IF;
  IF v_actor IS NOT NULL AND v_actor <> 'user' THEN
    RAISE EXCEPTION 'INTENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'only a person labels a conversation';
  END IF;
  IF v_actor = 'user' THEN
    IF NEW.intent IS NULL THEN
      IF NEW.intent_set_by IS NOT NULL THEN
        RAISE EXCEPTION 'INTENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a cleared label names nobody';
      END IF;
    ELSIF NEW.intent_set_by IS DISTINCT FROM crove_kernel.ctx_user_id() THEN
      RAISE EXCEPTION 'INTENT_FORBIDDEN' USING ERRCODE = '42501', DETAIL = 'a label names the member who applied it';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crove_kernel.conversation_intent_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS conversation_intent_guard ON crove_kernel.conversation;
CREATE TRIGGER conversation_intent_guard BEFORE INSERT OR UPDATE OF intent, intent_set_by, intent_set_at ON crove_kernel.conversation
  FOR EACH ROW EXECUTE FUNCTION crove_kernel.conversation_intent_guard();
