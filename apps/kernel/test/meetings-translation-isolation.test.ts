// SPDX-License-Identifier: AGPL-3.0-only
// The database side of "a translation is never a source" (meetings integrations E1, #3184): the follow-up mail's facts, the search across meetings and every definer that reads
// meeting text name the original rows only. The only migrations that name the translation table are the one that makes it (with the functions that delete from it), the org
// purge's list in each restatement of it, and the one that gives it its second kind and its transcript triggers (E2, #3185, which names it to widen the kind and to delete from it); a later migration that names it is a visible change here, which only an owner decision moves. (The source side is modules/meetings/test/translation-isolation.test.ts.)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

describe('a translation is never a source: the migrations (E1, #3184)', () => {
  it('no migration but the three that make the table, purge it and give it the transcript kind names it, so no search definer, mail query or export reads it', () => {
    const naming = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql') && /crove_meetings\.translation\b/.test(readFileSync(join(MIGRATIONS, name), 'utf8')))
      .map((name) => name.replace(/^\d+_/, ''));
    // The org purge's list names every tenant table, so each later restatement of it (A5, #3163: the rough notes table) names this one too, as the list's entry and nothing else.
    expect(naming).toEqual(['crove_meetings_translation.sql', 'crove_kernel_org_purge_translation.sql', 'crove_kernel_org_purge_meeting_note.sql', 'crove_meetings_translation_transcript.sql']);
  });
});
