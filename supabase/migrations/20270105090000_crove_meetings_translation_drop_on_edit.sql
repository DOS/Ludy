-- SPDX-License-Identifier: AGPL-3.0-only
-- Crove meetings, issue #3204 (E1, #3184, found by the Platform PO's shared-core review of #3200, note 5): a member's private translation of a summary no longer outlives an in-place edit
-- of the text it translated. translation_drop_stale (E1, restated in 20261231120000) already drops a stage's summary translations, every member's, when a result or action item row is
-- deleted or changes stage. A row whose TEXT changed in place was left: other members' translations of the old text stayed (marked stale in the app) with words the edit may have removed on
-- purpose, such as a person's name, until each member asked again or personal_erase ran. Idempotent; applied files stay untouched.
--
-- 1. meeting_result: an update of the summary or the decisions that changes either drops the translations of that stage.
-- 2. action_item: an update of the title that changes it drops the translations of that stage.
-- The text a summary translation holds is the summary, the decisions and the action item titles (readTranslationSource), so those are the columns that count; a change of who, when, flags, the
-- taint or the status says nothing of the translated words and drops nothing. The same definer as for a delete or a stage change does it: it deletes by meeting and stage only, and its UPDATE
-- branch (the old and the new stage, the same here) is the one these triggers use. No function is restated.
SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS meeting_result_translation_edit ON crove_meetings.meeting_result;
CREATE TRIGGER meeting_result_translation_edit AFTER UPDATE OF summary, decisions ON crove_meetings.meeting_result
  FOR EACH ROW WHEN (OLD.summary IS DISTINCT FROM NEW.summary OR OLD.decisions IS DISTINCT FROM NEW.decisions) EXECUTE FUNCTION crove_meetings.translation_drop_stale();

DROP TRIGGER IF EXISTS action_item_translation_edit ON crove_meetings.action_item;
CREATE TRIGGER action_item_translation_edit AFTER UPDATE OF title ON crove_meetings.action_item
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION crove_meetings.translation_drop_stale();
