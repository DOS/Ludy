// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for project weekly status email rendering, HTML escaping, and strict payload validation (#2609).
import { describe, expect, it } from 'vitest';
import { renderProjectWeeklyStatusMail } from '../src/project-weekly-status-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const VALID_INPUT: MailTemplateInput = {
  messageId: '00000000-0000-4000-8000-000000000001',
  subject: 'Bao cao tuan: Ra mat Q4',
  payload: {
    batchId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    projectName: 'Ra mat Q4 <script>alert(1)</script>',
    orgName: 'Cong ty A & B',
    projectPath: '/o/cong-ty-ab/projects/22222222-2222-4222-8222-222222222222',
    from: '2026-11-10',
    to: '2026-11-16',
    nextFrom: '2026-11-17',
    nextTo: '2026-11-23',
    counts: {
      totalVisible: 9,
      doneThisWeek: 3,
      overdue: 1,
      waiting: 2,
      dueNextWeek: 4,
    },
    summary: 'Dong 1 <b>khong</b> chay script.\n\nDong 2\nCo "ngoac" & \'don\'.',
    language: 'vi',
    aiGenerated: true,
  },
  publicUrl: 'https://app.example.test/',
  inboundAddress: null,
  brand: 'Ludy',
  execute: async () => undefined as never,
};

describe('renderProjectWeeklyStatusMail (#2609)', () => {
  it('renders Vietnamese plain text and escaped HTML with counts, dates, AI notice, and project link', () => {
    const out = renderProjectWeeklyStatusMail(VALID_INPUT);
    expect(out.subject).toBe('Bao cao tuan: Ra mat Q4');
    expect(out.text).toContain('10/11/2026 đến 16/11/2026');
    expect(out.text).toContain('Hoàn thành tuần này: 3');
    expect(out.text).toContain('Quá hạn: 1');
    expect(out.text).toContain('Đang chờ: 2');
    expect(out.text).toContain('Sắp đến hạn tuần tới: 4');
    expect(out.text).toContain('đồng nghiệp AI');
    expect(out.text).toContain('https://app.example.test/o/cong-ty-ab/projects/22222222-2222-4222-8222-222222222222');

    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<b>khong</b>');
    expect(out.html).toContain('Ra mat Q4 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('Cong ty A &amp; B');
    expect(out.html).toContain('Dong 1 &lt;b&gt;khong&lt;/b&gt; chay script.');
    expect(out.html).toContain('Dong 2<br>Co &quot;ngoac&quot; &amp; &#39;don&#39;.');
    expect(out.html).toContain('href="https://app.example.test/o/cong-ty-ab/projects/22222222-2222-4222-8222-222222222222"');
  });

  it('renders English copy without AI attribution notice when aiGenerated is false', () => {
    const out = renderProjectWeeklyStatusMail({
      ...VALID_INPUT,
      subject: 'Weekly status: Launch Q4',
      payload: {
        ...VALID_INPUT.payload,
        projectName: 'Launch Q4',
        orgName: 'Acme Co',
        summary: 'Shipped milestone.',
        language: 'en',
        aiGenerated: false,
      },
    });
    expect(out.text).toContain('2026-11-10 to 2026-11-16');
    expect(out.text).toContain('Completed this week: 3');
    expect(out.text).toContain('Due next week: 4');
    expect(out.text).not.toContain('AI coworker');
    expect(out.html).toContain('Open project');
    expect(out.html).not.toContain('AI coworker');
  });

  it('rejects missing subject or invalid projectPath/payload instead of falling back', () => {
    expect(() => renderProjectWeeklyStatusMail({ ...VALID_INPUT, subject: null })).toThrow();
    expect(() =>
      renderProjectWeeklyStatusMail({
        ...VALID_INPUT,
        payload: { ...VALID_INPUT.payload, projectPath: 'https://evil.invalid/phish' },
      }),
    ).toThrow();
    expect(() =>
      renderProjectWeeklyStatusMail({
        ...VALID_INPUT,
        payload: { ...VALID_INPUT.payload, summary: '   ' },
      }),
    ).toThrow();
  });
});
