// SPDX-License-Identifier: AGPL-3.0-only
// Who a said name points at (#3921): the Vietnamese forms people use in a meeting, with honorifics and without diacritics, one unambiguous person or nobody.
import { describe, expect, it } from 'vitest';
import { saidNameWords, suggestAssignee, type Person } from '../src/assignee-match.ts';

const p = (userId: string, name: string): Person => ({ userId, name });
const nam = p('nam', 'Trần Văn Nam');
const lan = p('lan', 'Lê Thị Lan');
const minhA = p('minhA', 'Nguyễn Văn Minh');
const minhB = p('minhB', 'Trần Minh');
const chi = p('chi', 'Nguyễn Linh Chi');
const quan = p('quan', 'Nguyễn Minh Quân');
const ID = (s: ReturnType<typeof suggestAssignee>) => (s === null ? null : `${s.source}:${s.userId}`);

describe('saidNameWords', () => {
  it('lowers the case and drops honorifics before the name, keeping the marks the speaker wrote', () => {
    expect(saidNameWords('Anh Minh')).toEqual(['minh']);
    expect(saidNameWords('chị Lan')).toEqual(['lan']);
    expect(saidNameWords('bác Hùng')).toEqual(['hùng']);
    expect(saidNameWords('chi Lan')).toEqual(['lan']);
    expect(saidNameWords('ông Nguyễn Văn Nam')).toEqual(['nguyễn', 'văn', 'nam']);
    expect(saidNameWords('anh/chị Hà')).toEqual(['hà']);
    expect(saidNameWords('  em   Đạt ')).toEqual(['đạt']);
  });
  it('drops the description after the name, but keeps a name that is also a word of one', () => {
    expect(saidNameWords('chị Lan bên kế toán')).toEqual(['lan']);
    expect(saidNameWords('anh Nam của team bán hàng')).toEqual(['nam']);
    expect(saidNameWords('Hoàng bộ phận kho')).toEqual(['hoàng']);
    // Phong, Tú and Trọng are given names, so they are never cut.
    expect(saidNameWords('anh Văn Phong')).toEqual(['văn', 'phong']);
    expect(saidNameWords('anh Tú')).toEqual(['tú']);
    expect(saidNameWords('chị Trọng Hà')).toEqual(['trọng', 'hà']);
  });
  it('does not take a word written with marks for an honorific it only looks like when folded', () => {
    // Dương (a family name), Chí and Bá are names; "dượng", "chị" and "bà" are the honorifics.
    expect(saidNameWords('Dương Văn Hùng')).toEqual(['dương', 'văn', 'hùng']);
    expect(saidNameWords('anh Chí Thanh')).toEqual(['chí', 'thanh']);
    expect(saidNameWords('Bá Hùng')).toEqual(['bá', 'hùng']);
    expect(saidNameWords('dượng Hùng')).toEqual(['hùng']);
  });
  it('is empty for a bare pronoun, which names no one, but keeps a name that follows one', () => {
    for (const said of ['anh', 'chị', 'Chi', 'em', 'Em', 'bạn', 'anh/chị']) expect(saidNameWords(said), said).toEqual([]);
    expect(saidNameWords('chị Chi')).toEqual(['chi']);
    expect(saidNameWords('anh Ba')).toEqual(['ba']);
  });
  it('is empty when there is no name, and ignores punctuation', () => {
    expect(saidNameWords('')).toEqual([]);
    expect(saidNameWords('  ')).toEqual([]);
    expect(saidNameWords('...')).toEqual([]);
    expect(saidNameWords('anh Minh, bên sales.')).toEqual(['minh']);
  });
});

describe('suggestAssignee', () => {
  const room = [nam, lan, minhA];
  const org = [quan, chi, minhB, p('hoang', 'Hoàng Gia Hùng')];

  it('finds the one attendee a given name, a run of words or the whole name belongs to, with or without marks and honorifics', () => {
    for (const said of ['anh Nam', 'nam', 'NAM', 'Anh Nam', 'văn nam', 'Van Nam', 'Trần Văn Nam', 'tran van nam', 'ông Trần Văn Nam']) expect(ID(suggestAssignee(said, room, org)), said).toBe('attendee:nam');
    for (const said of ['chị Lan', 'chi lan', 'Lan', 'chị Lan bên kế toán', 'thị Lan']) expect(ID(suggestAssignee(said, room, org)), said).toBe('attendee:lan');
  });

  it('does not take a family name, a middle word, or a run that leaves out the given name for a person', () => {
    expect(suggestAssignee('Trần', room, org)).toBeNull();
    expect(suggestAssignee('anh Văn', room, org)).toBeNull();
    expect(suggestAssignee('Thị', room, org)).toBeNull();
    expect(suggestAssignee('Trần Văn', room, org)).toBeNull();
    expect(suggestAssignee('Lê Thị', room, org)).toBeNull();
    expect(suggestAssignee('Nguyễn Minh', [], org)).toBeNull();
  });

  it('never takes a bare pronoun for a given name: "chị" is not Chi and "anh" is not Anh', () => {
    const anh = p('anh', 'Nguyễn Tuấn Anh');
    expect(suggestAssignee('chị', [lan], [chi])).toBeNull();
    expect(suggestAssignee('Chi', [lan], [chi])).toBeNull();
    expect(suggestAssignee('anh', [anh, lan], [])).toBeNull();
    expect(ID(suggestAssignee('chị Chi', [lan], [chi]))).toBe('member:chi');
    expect(ID(suggestAssignee('anh Anh', [anh, lan], []))).toBe('attendee:anh');
  });

  it('keeps a family name or a given name that looks like an honorific once its marks are dropped', () => {
    const duong = p('duong', 'Dương Văn Hùng');
    const tran = p('tran', 'Trần Văn Hùng');
    const chiThanh = p('ct', 'Nguyễn Chí Thanh');
    const leThanh = p('lt', 'Lê Văn Thanh');
    // "Dương Văn Hùng" names Dương, not the attendee Trần Văn Hùng, who matches only by "Văn Hùng".
    expect(ID(suggestAssignee('Dương Văn Hùng', [tran], [duong]))).toBe('member:duong');
    expect(ID(suggestAssignee('anh Chí Thanh', [leThanh], [chiThanh]))).toBe('member:ct');
  });

  it('compares with the marks the speaker wrote, and folds only when they wrote none', () => {
    const thu = p('thu', 'Nguyễn Thị Thu');
    const thuMarked = p('thuM', 'Lê Anh Thư');
    expect(ID(suggestAssignee('chị Thư', [thu], [thuMarked]))).toBe('member:thuM');
    expect(suggestAssignee('chị Thư', [thu], [])).toBeNull();
    // No marks: both Thu and Thư answer, so it is ambiguous when both are in the room.
    expect(suggestAssignee('chị Thu', [thu, thuMarked], [])).toBeNull();
    expect(ID(suggestAssignee('chi thu', [thu], []))).toBe('attendee:thu');
    expect(ID(suggestAssignee('Ha', [p('ha', 'Trần Thu Hà')], []))).toBe('attendee:ha');
  });

  it('reads a display name by what comes before a bracket, a dash or a comma', () => {
    expect(suggestAssignee('anh Toán', [p('n', 'Nguyễn Văn Nam - Kế toán')], [])).toBeNull();
    expect(ID(suggestAssignee('anh Nam', [p('n', 'Nguyễn Văn Nam - Kế toán')], []))).toBe('attendee:n');
    expect(ID(suggestAssignee('chị Lan', [p('l', 'Lê Thị Lan (KT)')], []))).toBe('attendee:l');
    expect(ID(suggestAssignee('chị Lan', [p('l', 'Lê Thị Lan, Kế toán')], []))).toBe('attendee:l');
  });

  it('falls back to the one other member of the org when no attendee answers', () => {
    expect(ID(suggestAssignee('anh Quân', room, org))).toBe('member:quan');
    expect(ID(suggestAssignee('chị Chi', room, org))).toBe('member:chi');
    expect(ID(suggestAssignee('Gia Hùng', room, org))).toBe('member:hoang');
    expect(ID(suggestAssignee('hung', room, org))).toBe('member:hoang');
  });

  it('suggests nobody when two attendees answer, and does not then look at the org', () => {
    expect(suggestAssignee('anh Minh', [minhA, p('minhC', 'Phạm Minh')], org)).toBeNull();
    // Two attendees named Nam: the org member named Nam must not be offered instead.
    expect(suggestAssignee('Nam', [nam, p('nam2', 'Lê Nam')], [p('nam3', 'Hà Nam')])).toBeNull();
  });

  it('suggests nobody when two members of the org answer and no attendee does', () => {
    expect(suggestAssignee('anh Minh', [nam, lan], [minhA, minhB])).toBeNull();
  });

  it('prefers the attendee over a member of the org with the same name, and never offers an attendee twice', () => {
    expect(ID(suggestAssignee('Nam', room, [p('nam9', 'Hà Nam')]))).toBe('attendee:nam');
    // The attendees are also in the org list: still one person.
    expect(ID(suggestAssignee('Nam', room, [...room, quan]))).toBe('attendee:nam');
  });

  it('suggests nobody for an unknown name, an empty text, or a name nobody has an exact word for', () => {
    expect(suggestAssignee('bạn Hùng', room, [quan, chi])).toBeNull();
    expect(suggestAssignee('', room, org)).toBeNull();
    expect(suggestAssignee('mọi người', room, org)).toBeNull();
    expect(suggestAssignee('Nam Anh', room, org)).toBeNull();
    expect(suggestAssignee('anh Na', room, org)).toBeNull();
  });

  it('handles a person with no usable name and a name of one word', () => {
    expect(suggestAssignee('Hà', [p('ha', 'Hà')], [])).toMatchObject({ userId: 'ha', source: 'attendee' });
    expect(suggestAssignee('Hà', [p('x', '')], [])).toBeNull();
  });
});
