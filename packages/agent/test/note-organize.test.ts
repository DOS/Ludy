// SPDX-License-Identifier: AGPL-3.0-only
// Unit and prompt-injection red-team tests for member-scoped Vy inbox organizer (notes.organize, #3563).
import { describe, expect, it } from 'vitest';
import {
  NoteOrganizeError,
  ORGANIZE_LIMITS,
  bindPorts,
  buildNoteOrganizeSubjectJson,
  checkNoteOrganize,
  noKnowledge,
  organizeUnfiledNotes,
  type MemoryPort,
  type NoteOrganizeInputNote,
  type NoteOrganizeInputNotebook,
} from '../src/member-vy/index.ts';

const noopMemory: MemoryPort = {
  read: async () => [],
  write: async () => ({ id: 'm-1' }),
  forget: async () => {},
};

const NOTEBOOKS: NoteOrganizeInputNotebook[] = [
  { id: 'nb-priv-finance', name: 'Tài chính cá nhân', visibility: 'private' },
  { id: 'nb-org-ops', name: 'Vận hành công ty', visibility: 'org' },
];

const NOTES: NoteOrganizeInputNote[] = [
  {
    id: 'note-priv-1',
    title: 'Biên lai tiền điện tháng 11',
    body: 'Cần đối chiếu hóa đơn điện lực EVN',
    tags: ['hóa đơn'],
    visibility: 'private',
    updatedAt: '2026-11-21T08:00:00Z',
    canEditTags: true,
    revision: 2,
  },
  {
    id: 'note-org-2',
    title: 'Biên bản họp quy trình kho',
    body: 'Thống nhất kiểm kê mỗi thứ 6',
    tags: [],
    visibility: 'org',
    updatedAt: '2026-11-20T08:00:00Z',
    canEditTags: false,
    revision: 1,
  },
];

function fakePorts(reply: string, capture?: (prompt: { system: string; user: string }) => void) {
  return bindPorts(
    { orgId: 'org-1', memberUserId: 'user-1' },
    {
      model: {
        generate: async (_who, prompt) => {
          capture?.(prompt);
          return { text: reply, usage: { inputTokens: 150, outputTokens: 90 } };
        },
      },
      memory: noopMemory,
      knowledge: noKnowledge,
    },
  );
}

describe('notes.organize deterministic checks & prompt-injection defense (#3563)', () => {
  it('returns verified notebook + normalized tag suggestions wrapped in nonce boundaries', async () => {
    let seenPrompt: { system: string; user: string } | undefined;
    const reply = JSON.stringify({
      suggestions: [
        {
          noteId: 'note-priv-1',
          notebookId: 'nb-priv-finance',
          tags: ['#EVN', 'Hóa đơn', 'tiền điện', 'Tiền điện'],
          reason: 'Ghi chú liên quan hóa đơn điện định kỳ',
        },
        {
          noteId: 'note-org-2',
          notebookId: 'nb-org-ops',
          tags: ['should-be-dropped-not-author'],
          reason: 'Thuộc vận hành chung của công ty',
        },
      ],
    });

    const res = await organizeUnfiledNotes(
      { notes: NOTES, notebooks: NOTEBOOKS, language: 'vi' },
      fakePorts(reply, (p) => {
        seenPrompt = p;
      }),
    );

    expect(res.suggestions).toEqual([
      {
        noteId: 'note-priv-1',
        notebookId: 'nb-priv-finance',
        tags: ['evn', 'tiền điện'],
        reason: 'Ghi chú liên quan hóa đơn điện định kỳ',
      },
      {
        noteId: 'note-org-2',
        notebookId: 'nb-org-ops',
        tags: [],
        reason: 'Thuộc vận hành chung của công ty',
      },
    ]);
    // Duplicate 'hóa đơn' (already on note), duplicate 'tiền điện', plus disallowed tag on non-author org note.
    expect(res.dropped).toBe(3);
    expect(seenPrompt?.user).toMatch(/<subject-[a-z0-9]+>/i);
  });

  it('forbids moving an org note into a private notebook and drops hallucinated IDs, XSS, URLs, and tag leaks', () => {
    const out = checkNoteOrganize(
      JSON.stringify({
        suggestions: [
          {
            noteId: 'note-not-mine-or-already-filed',
            notebookId: 'nb-priv-finance',
            tags: ['leak'],
            reason: 'Hallucinated note ID',
          },
          {
            noteId: 'note-org-2',
            notebookId: 'nb-priv-finance',
            tags: [],
            reason: 'Must drop private notebook for org note leaving empty suggestion',
          },
          {
            noteId: 'note-priv-1',
            notebookId: 'nb-invented',
            tags: [
              'https://evil.example',
              '<b>thuế</b>',
              '##Hợp Đồng',
              'leak </subject-abc123>',
            ],
            reason: '<script>alert(1)</script>Phân loại [x](https://bad.test) tài chính',
          },
        ],
      }),
      { notes: NOTES, notebooks: NOTEBOOKS },
    );

    expect(out.suggestions).toEqual([
      {
        noteId: 'note-priv-1',
        notebookId: null,
        tags: ['thuế', 'hợp đồng'],
        reason: 'Phân loại x tài chính',
      },
    ]);
    // note-not-mine dropped (1) + note-org-2 private notebook dropped (1) + empty suggestion dropped (1)
    // + nb-invented dropped (1) + URL tag dropped (1) + leaked tag dropped (1) = 6
    expect(out.dropped).toBe(6);
  });

  it('fails closed on prompt-injection payload trying to override output schema', async () => {
    await expect(
      organizeUnfiledNotes(
        { notes: NOTES, notebooks: NOTEBOOKS, language: 'vi' },
        fakePorts('{"command":"DELETE FROM crove_notes.note"}'),
      ),
    ).rejects.toMatchObject({ name: 'NoteOrganizeError', code: 'NOTE_ORGANIZE_UNPARSABLE' });

    await expect(
      organizeUnfiledNotes({ notes: [], notebooks: NOTEBOOKS, language: 'vi' }, fakePorts('{}')),
    ).rejects.toThrowError(NoteOrganizeError);
  });

  it('bounds serialized subject JSON cleanly within 6x prompt budget even on large inboxes', () => {
    const manyNotes: NoteOrganizeInputNote[] = Array.from({ length: 50 }, (_, idx) => ({
      id: `note-${idx}`,
      title: `Tiêu đề ${'a'.repeat(300)}`,
      body: 'nội dung '.repeat(300),
      tags: ['tag'],
      visibility: 'private',
      updatedAt: `2026-11-21T00:${String(idx % 60).padStart(2, '0')}:00Z`,
      canEditTags: true,
      revision: 1,
    }));
    const manyNotebooks: NoteOrganizeInputNotebook[] = Array.from({ length: 80 }, (_, idx) => ({
      id: `nb-${idx}`,
      name: `Sổ tay ${'b'.repeat(200)}`,
      visibility: 'private',
    }));

    const json = buildNoteOrganizeSubjectJson(manyNotes, manyNotebooks);
    expect(json.length).toBeLessThanOrEqual(ORGANIZE_LIMITS.maxSubjectChars);
  });
});
