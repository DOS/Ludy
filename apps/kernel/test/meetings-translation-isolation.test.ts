// SPDX-License-Identifier: AGPL-3.0-only
// The database side of "a translation is never a source" (meetings integrations E1, #3184): the follow-up mail's facts, the search across meetings and every definer that reads
// meeting text name the original rows only. The only migrations that name the translation table are the one that makes it (with the functions that delete from it), the org
// purge's list in each restatement of it, and the one that gives it its second kind and its transcript triggers (E2, #3185, which names it to widen the kind and to delete from it); a later migration that names it is a visible change here, which only an owner decision moves. The latest entry is #3194's: the 30-day purge of a removed member's Vy rows deletes the member's translations (the follow-up the E1 plan line recorded, promoted by the Meetings PO on 2026-11-17 under the owner's core-first direction); it reads only org_id, member_user_id and created_at, never the body, so the table is still never a source. The next two are #3584's, the follow-up of #3194 (promoted by the Meetings PO on 2026-11-17 under the owner's core-first direction): the owner's count of a member's translations and live preview lines, and the restatement of the purge and its due list that adds the preview lines; both read org_id, member_user_id and created_at plus a count, never the body. (The source side is modules/meetings/test/translation-isolation.test.ts.) The last two are #3186's (E3, translation into Chinese, Japanese and Korean, taken out of the Icebox by the owner on 2026-11-18 and approved by the Meetings PO): the first widens the target language CHECK and the second validates it; #3186 widens the target language CHECK only, never reads the table as a source.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

describe('a translation is never a source: the migrations (E1, #3184)', () => {
  it('no migration but the ones that make the table, purge it and give it the transcript kind names it, so no search definer, mail query or export reads it', () => {
    const naming = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql') && /crove_meetings\.translation\b/.test(readFileSync(join(MIGRATIONS, name), 'utf8')))
      .map((name) => name.replace(/^\d+_/, ''));
    // The org purge's list names every tenant table, so each later restatement of it (A5, #3163: the rough notes table; B1, #3165: the calendar cache; A6, #3164: the member's webhook tables; B4, #3168; C1, #3173: the meeting platform import tables; #2591: projects; #3323: sign; #3394: payroll_leave_entry; #3412: hr departments; #3310 C3b: outbox_held; #3526: sign templates; #3578: minutes templates; #3558: personal to-do lists) names this one too, as the list's entry and nothing else; the purge of a former member's Vy rows, which deletes by org and member and judges the latest exit by created_at (#3194), and the index that serves its reads sit before the last five restatements (the e-invoice notice's, the to-do lists', the supplier bank accounts' and the supplier payments' of #3113, the MISA AMIS connection's of #3875 and the MISA AMIS push table's of #3902).
    // #3844 (chapters): crove_meetings_chapters.sql restates personal_erase to reach chapter titles; the translation branch is unchanged (it deletes translations of touched meetings), never read as a source.
    expect(naming).toEqual([
      'crove_meetings_translation.sql',
      'crove_kernel_org_purge_translation.sql',
      'crove_kernel_org_purge_meeting_note.sql',
      'crove_meetings_translation_transcript.sql',
      'crove_kernel_org_purge_calendar_agenda.sql',
      'crove_kernel_org_purge_meeting_hook.sql',
      'crove_kernel_org_purge_meeting_chat.sql',
      'crove_kernel_org_purge_meeting_platform.sql',
      'crove_kernel_org_purge_projects.sql',
      'crove_kernel_org_purge_sign.sql',
      'crove_kernel_org_purge_hr_leave.sql',
      'crove_kernel_org_purge_hr_departments.sql',
      'crove_kernel_org_purge_outbox_held.sql',
      'crove_kernel_org_purge_hr_recruiting.sql',
      'crove_kernel_org_purge_sign_templates.sql',
      'crove_meetings_translation_member_idx.sql',
      'crove_kernel_member_vy_translation_purge.sql',
      'crove_kernel_org_purge_minutes_templates.sql',
      'crove_meetings_member_private_counts.sql',
      'crove_kernel_member_vy_live_line_purge.sql',
      'crove_kernel_org_purge_einvoice_notice.sql',
      'crove_kernel_org_purge_todo_list.sql',
      'crove_kernel_org_purge_supplier_bank_account.sql',
      'crove_kernel_org_purge_supplier_payment.sql',
      'crove_meetings_chapters.sql',
      'crove_kernel_org_purge_misa_amis_connection.sql',
      'crove_meetings_translation_targets.sql',
      'crove_meetings_translation_targets_validate.sql',
      'crove_kernel_org_purge_misa_amis_push.sql',
      // #3955 (morning notice): the purge restatement that adds crove_meetings.morning_notice restates the whole list, the translation table included; its body is the previous one.
      'crove_kernel_org_purge_morning_notice.sql',
      // #4043 (glossary): the purge restatement that adds crove_meetings.glossary_term restates the whole list, the translation table included; its body is the previous one.
      'crove_kernel_org_purge_glossary_term.sql',
    ]);
  });
});
