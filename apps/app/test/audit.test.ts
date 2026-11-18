// The audit log screen's filter (#672), its filters in the URL (#1445) and its command labels (#1654).
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { auditFilter, auditForm, auditTargetChoices, commandLabel, isSystemRow, lowerFirst, nextAuditCursor, parseAuditSearch, withCommandLabels } from '../src/lib/audit.ts';

const empty = { actor: '', command: '', outcome: '', target: '', targetType: '', from: '', to: '' };

describe('audit filter', () => {
  it('sends only what the server accepts', () => {
    expect(auditFilter(empty)).toEqual({});
    expect(auditFilter({ ...empty, actor: 'system', command: 'kernel.org.set_address', outcome: 'denied', from: '2026-10-01', to: '2026-10-31' })).toEqual({
      actor: 'system',
      command: 'kernel.org.set_address',
      outcome: 'denied',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(auditFilter({ ...empty, target: ' 0192F0AA-1111-7222-8333-944445555666 ' })).toEqual({ targetId: '0192f0aa-1111-7222-8333-944445555666' });
    expect(auditFilter({ ...empty, target: '0192f0aa', outcome: 'maybe', from: '1/10/2026' })).toEqual({});
    // A target's type narrows a whole target id only.
    expect(auditFilter({ ...empty, target: '0192f0aa-1111-7222-8333-944445555666', targetType: 'kernel.proposal' })).toEqual({
      targetId: '0192f0aa-1111-7222-8333-944445555666',
      targetType: 'kernel.proposal',
    });
    expect(auditFilter({ ...empty, target: '0192f0aa', targetType: 'kernel.proposal' })).toEqual({});
    expect(auditFilter({ ...empty, target: '0192f0aa-1111-7222-8333-944445555666', targetType: 'Kernel Proposal' })).toEqual({ targetId: '0192f0aa-1111-7222-8333-944445555666' });
  });

  it('reads its filters from the URL, a proposal link included, and drops what is not well formed (#1445)', () => {
    const id = '0192F0AA-1111-7222-8333-944445555666';
    const search = parseAuditSearch({ targetType: 'kernel.proposal', targetId: id });
    expect(search).toEqual({ targetType: 'kernel.proposal', targetId: id.toLowerCase() });
    expect(auditFilter(auditForm(search))).toEqual({ targetType: 'kernel.proposal', targetId: id.toLowerCase() });
    expect(
      parseAuditSearch({ actor: 'system', command: 'finance.', outcome: 'denied', from: '2026-10-01', to: '2026-10-31', extra: 'x' }),
    ).toEqual({ actor: 'system', command: 'finance.', outcome: 'denied', from: '2026-10-01', to: '2026-10-31' });
    expect(parseAuditSearch({ actor: 'someone', command: 'DROP TABLE', outcome: 'maybe', targetType: 'proposal', targetId: 'x', from: '1/10/2026', to: 5 })).toEqual({});
    // A type with no id to narrow is not kept in the form.
    expect(auditForm(parseAuditSearch({ targetType: 'kernel.proposal' }))).toEqual(empty);
  });

  it('pages after the last row while more follow', () => {
    const item = { id: 'b', at: '2026-10-01T00:00:00.000Z' } as never;
    expect(nextAuditCursor({ items: [item], more: true })).toEqual({ at: '2026-10-01T00:00:00.000Z', id: 'b' });
    expect(nextAuditCursor({ items: [item], more: false })).toBeUndefined();
    expect(nextAuditCursor({ items: [], more: true })).toBeUndefined();
  });

  it('labels a command in each language, and gives null for a name without a label', () => {
    expect(commandLabel(vi.commands, 'kernel.proposal.approve')).toBe('Duyệt đề xuất');
    expect(commandLabel(en.commands, 'kernel.proposal.approve')).toBe('Approve a proposal');
    expect(commandLabel(vi.commands, 'kernel.proposal.gone')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.proposal')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.proposal.approve.more')).toBeNull();
    expect(commandLabel(vi.commands, 'kernel.toString')).toBeNull();
  });

  it('adds a label column after the command column and keeps every other cell as written', () => {
    const csv =
      '﻿occurred_at,actor_name,command,outcome,detail\r\n' +
      '2026-10-01T00:00:00.000Z,"Lê, Văn A",kernel.proposal.approve,ok,"a ""quoted"", line\r\nand more"\r\n' +
      "2026-10-02T00:00:00.000Z,'=1+1,kernel.retired,failed,\r\n";
    const labels = (name: string) => (name === 'kernel.proposal.approve' ? 'Duyệt, "nhanh"' : null);
    expect(withCommandLabels(csv, labels)).toBe(
      '﻿occurred_at,actor_name,command,command_label,outcome,detail\r\n' +
        '2026-10-01T00:00:00.000Z,"Lê, Văn A",kernel.proposal.approve,"Duyệt, ""nhanh""",ok,"a ""quoted"", line\r\nand more"\r\n' +
        "2026-10-02T00:00:00.000Z,'=1+1,kernel.retired,,failed,\r\n",
    );
    expect(withCommandLabels('a,b\r\n1,2\r\n', labels)).toBe('a,b\r\n1,2\r\n');
    // A last line without its line break, ending in an empty cell, is kept.
    expect(withCommandLabels('command,detail\r\nkernel.x,', labels)).toBe('command,command_label,detail\r\nkernel.x,,\r\n');
  });
});

// The activity log in words (#3595).
describe('activity log in words', () => {
  it('counts a system row as one nobody did, and an AI app over MCP as not one', () => {
    expect(isSystemRow({ actorType: 'system', via: null })).toBe(true);
    expect(isSystemRow({ actorType: 'system', via: { kind: 'mcp', clientName: 'Claude Desktop' } })).toBe(false);
    expect(isSystemRow({ actorType: 'user', via: null })).toBe(false);
    expect(isSystemRow({ actorType: 'agent', via: null })).toBe(false);
  });

  it('opens the log with the system rows shown only when the link says so', () => {
    expect(parseAuditSearch({ system: '1' })).toEqual({ system: '1' });
    expect(parseAuditSearch({ system: 'yes' })).toEqual({});
  });

  it('lowers the first letter of a label for a sentence, and keeps a name or an acronym', () => {
    expect(lowerFirst('Duyệt đề xuất')).toBe('duyệt đề xuất');
    expect(lowerFirst('Approve a proposal')).toBe('approve a proposal');
    expect(lowerFirst('Vy ghi nhớ một mục')).toBe('Vy ghi nhớ một mục');
    expect(lowerFirst('AI budget')).toBe('AI budget');
  });

  it('finds an object by a name or a number: a party, a document (by its proposal when it has one) and an entry', () => {
    const choices = auditTargetChoices({
      parties: [{ id: 'p1', name: 'Công ty ABC', taxCode: '0312345678' }],
      documents: [
        { id: 'd1', series: 'C26TAA', number: '0000012', partyName: 'Công ty ABC', proposalId: 'pr1' },
        { id: 'd2', series: '', number: 'PC-7', partyName: 'Anh Nam', proposalId: null },
      ],
      entries: [{ id: 'e1', description: 'Chi phí quảng cáo', entryDate: '2026-11-02' }],
    });
    expect(choices.map((c) => [c.kind, c.id, c.label, c.hint])).toEqual([
      ['party', 'p1', 'Công ty ABC', '0312345678'],
      ['document', 'pr1', 'C26TAA 0000012', 'Công ty ABC'],
      ['document', 'd2', 'PC-7', 'Anh Nam'],
      ['entry', 'e1', 'Chi phí quảng cáo', '2026-11-02'],
    ]);
  });

  it('keeps the raw fields in the CSV file: the command, the system rows and the detail line', () => {
    const csv = 'occurred_at,actor_type,command,detail\r\n2026-11-02T00:00:00.000Z,system,kernel.notification.dispatch,aal=aal2; policy.P10=self_approved\r\n';
    const out = withCommandLabels(csv, (name) => commandLabel(vi.commands, name));
    expect(out).toContain('system,kernel.notification.dispatch,Gửi thông báo,aal=aal2; policy.P10=self_approved');
  });

  it('has the same sentences and object names in both languages, and no raw module code as an object name', () => {
    const keys = (node: unknown, path = ''): string[] =>
      typeof node === 'object' && node !== null ? Object.entries(node).flatMap(([k, v]) => keys(v, path ? `${path}.${k}` : k)) : [path];
    expect(keys(en.audit.done).sort()).toEqual(keys(vi.audit.done).sort());
    expect(keys(en.audit.objects).sort()).toEqual(keys(vi.audit.objects).sort());
    // Every sentence is for a command the screen has a label for.
    for (const path of keys(vi.audit.done)) expect(commandLabel(vi.commands, path), path).not.toBeNull();
    for (const text of keys(vi.audit.objects).map((k) => commandLabel(vi.audit.objects, k))) expect(text).not.toMatch(/^[a-z_]+(\.[a-z_]+)*$/);
  });
});
