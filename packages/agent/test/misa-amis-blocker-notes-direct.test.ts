// SPDX-License-Identifier: AGPL-3.0-only
// Regression guard for #4022: directly importing src/misa-amis-blocker-notes.ts or src/inbox.ts on
// its own (without going through src/index.ts) must initialize MISA_AMIS_BLOCKER_KINDS before
// inbox.ts builds zMisaAmisBlockerNotesOut with z.enum(MISA_AMIS_BLOCKER_KINDS).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '../src/meter.ts';
import {
  MISA_AMIS_BLOCKER_KINDS,
  checkMisaAmisBlockerNotes,
  misaAmisBlockerNotesFactsText,
  misaAmisBlockerNotesHaveNews,
  misaAmisBlockerNotesInstructions,
  misaAmisBlockerNotesPrompt,
  type MisaAmisBlockerKind,
  type MisaAmisBlockerNotesFacts,
} from '../src/misa-amis-blocker-notes.ts';

const FACTS: MisaAmisBlockerNotesFacts = { language: 'vi', kinds: ['item_code_unknown', 'vat_rate_unmapped'] };
const VALID_ITEM_NOTE = 'Dòng chứng từ chưa có mã hàng AMIS: hãy nhập mã hàng AMIS trong phần xem trước hoặc đặt mã AMIS cho mặt hàng trong Ludy.';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('direct module imports without src/index.ts (#4022)', () => {
  it('loads src/misa-amis-blocker-notes.ts directly at top level with all exports initialized', () => {
    const kinds: readonly MisaAmisBlockerKind[] = MISA_AMIS_BLOCKER_KINDS;
    expect(kinds).toContain('item_code_unknown');
    expect(kinds).toHaveLength(11);
    expect(misaAmisBlockerNotesHaveNews(FACTS)).toBe(true);
    expect(misaAmisBlockerNotesFactsText(FACTS)).toContain('item_code_unknown:');
    expect(misaAmisBlockerNotesInstructions('vi')).toContain('Vietnamese');
    expect(misaAmisBlockerNotesPrompt(FACTS)).toContain('Write one note for each kind.');
    expect(checkMisaAmisBlockerNotes(FACTS, { notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }] })).toEqual({
      kind: 'notes',
      notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }],
    });
  });

  it('loads src/misa-amis-blocker-notes.ts on its own from a fresh module registry', async () => {
    vi.resetModules();
    const mod = await import('../src/misa-amis-blocker-notes.ts');
    expect(mod.MISA_AMIS_BLOCKER_KINDS).toEqual(MISA_AMIS_BLOCKER_KINDS);
    expect(mod.checkMisaAmisBlockerNotes(FACTS, { notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }] })).toEqual({
      kind: 'notes',
      notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }],
    });
  });

  it('loads src/inbox.ts on its own from a fresh module registry and builds the blocker schema', async () => {
    vi.resetModules();
    const { InboxReader } = await import('../src/inbox.ts');
    const { withAiScope } = await import('../src/meter.ts');

    const stubbedReader = new InboxReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        misaAmisBlockerNotes: async () => ({
          output: { notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }] },
          usage: { inputTokens: 10, outputTokens: 10 },
        }),
      },
    );
    expect(await stubbedReader.misaAmisBlockerNotes(FACTS)).toEqual({
      kind: 'notes',
      notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify({ notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }] }) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const meter: AiMeter = { admit: async () => {}, record: async () => {} };
    const liveReader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    expect(await withAiScope({ orgId: 'org', meter }, () => liveReader.misaAmisBlockerNotes(FACTS))).toEqual({
      kind: 'notes',
      notes: [{ kind: 'item_code_unknown', text: VALID_ITEM_NOTE }],
    });
  });
});
