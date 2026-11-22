// SPDX-License-Identifier: AGPL-3.0-only
// The title of a tainted task is written out with a visible code for the characters that reorder or hide text (#4370), like the Inbox card does; a person's own title is shown as typed.
import { describe, expect, it } from 'vitest';
import { taskTitleText } from '../src/lib/task-title.ts';

describe('the title of a task as it is shown', () => {
  it('writes the direction marks, the zero-width and the tag characters of a tainted title out as visible codes', () => {
    expect(taskTitleText({ title: 'Gọi khách‮txt.exe', tainted: true })).toBe('Gọi khách⟨U+202E⟩txt.exe');
    expect(taskTitleText({ title: 'a​b⁦c⁩d﻿e\u{e0041}', tainted: true })).toBe('a⟨U+200B⟩b⟨U+2066⟩c⟨U+2069⟩d⟨U+FEFF⟩e⟨U+E0041⟩');
  });

  it('marks what the Inbox card marks: controls, the invisible operators, the deprecated format characters and the annotation marks', () => {
    expect(taskTitleText({ title: 'Pay\u2062ment\u2063\u180e\u0085\u206a\ufff9', tainted: true })).toBe('Pay\u27e8U+2062\u27e9ment\u27e8U+2063\u27e9\u27e8U+180E\u27e9\u27e8U+0085\u27e9\u27e8U+206A\u27e9\u27e8U+FFF9\u27e9');
  });

  it('keeps the zero-width joiner of an emoji, and shows a person\'s own title as typed', () => {
    expect(taskTitleText({ title: 'Nhóm 👨‍👩‍👧', tainted: true })).toBe('Nhóm 👨‍👩‍👧');
    expect(taskTitleText({ title: 'Của người‮', tainted: false })).toBe('Của người‮');
    expect(taskTitleText({ title: 'Của người‮' })).toBe('Của người‮');
  });
});
