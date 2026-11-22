// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PayrollPromptLeakError, reviewAttendanceAnomalies } from '../src/index.ts';

const SAMPLE_ANOMALIES = [
  {
    logId: '00000000-0000-7000-8000-000000000001',
    employeeId: '00000000-0000-7000-8000-000000000101',
    employeeName: 'Nguyễn Thị Lan',
    workDate: '2026-11-20',
    kind: 'missing_checkout' as const,
    workedMinutes: null,
  },
  {
    logId: '00000000-0000-7000-8000-000000000002',
    employeeId: '00000000-0000-7000-8000-000000000102',
    employeeName: 'Trần Văn Minh',
    workDate: '2026-11-22',
    kind: 'weekend_work' as const,
    workedMinutes: 480,
  },
];

describe('HR Stage 5C attendance coworker Ly (#4447)', () => {
  it('returns deterministic Vietnamese summary without calling AI when off or budget exhausted', async () => {
    let called = false;
    const offRes = await reviewAttendanceAnomalies(
      { month: '2026-11', language: 'vi', anomalies: SAMPLE_ANOMALIES },
      { generate: null, aiDisabledReason: 'off' },
    );
    expect(offRes.ai).toEqual({ ok: false, reason: 'off' });
    expect(offRes.summary).toContain('2026-11');
    expect(offRes.highlights.length).toBe(2);
    expect(called).toBe(false);

    const emptyRes = await reviewAttendanceAnomalies(
      { month: '2026-11', language: 'en', anomalies: [] },
      {
        generate: async () => {
          called = true;
          return { output: null };
        },
      },
    );
    expect(called).toBe(false);
    expect(emptyRes.summary).toContain('No attendance anomalies');
  });

  it('pseudonymizes employee names into E1..En before sending prompt and restores names cleanly', async () => {
    let seenPrompt = '';
    const res = await reviewAttendanceAnomalies(
      { month: '2026-11', language: 'vi', anomalies: SAMPLE_ANOMALIES },
      {
        generate: async ({ prompt }) => {
          seenPrompt = prompt;
          const parsed = JSON.parse(prompt) as { items: Array<{ alias: string; kind: string }> };
          const missingAlias = parsed.items.find((i) => i.kind === 'missing_checkout')?.alias ?? 'E1';
          const weekendAlias = parsed.items.find((i) => i.kind === 'weekend_work')?.alias ?? 'E2';
          return {
            output: {
              summary: 'Tháng 2026-11 có 2 bất thường cần rà soát trước khi chốt công.',
              highlights: [
                `${missingAlias} cần bổ sung giờ check-out ngày 2026-11-20.`,
                `${weekendAlias} có ca làm Chủ nhật 2026-11-22.`,
              ],
            },
          };
        },
      },
    );

    expect(seenPrompt).not.toContain('Nguyễn Thị Lan');
    expect(seenPrompt).not.toContain('Trần Văn Minh');
    expect(seenPrompt).toContain('E1');
    expect(seenPrompt).toContain('E2');
    expect(res.ai).toEqual({ ok: true, reason: 'ok' });
    expect(res.highlights.join('\n')).toContain('Nguyễn Thị Lan');
    expect(res.highlights.join('\n')).toContain('Trần Văn Minh');
  });

  it('refuses ungrounded invented numbers or markdown noise and degrades cleanly', async () => {
    const res = await reviewAttendanceAnomalies(
      { month: '2026-11', language: 'en', anomalies: SAMPLE_ANOMALIES },
      {
        generate: async () => ({
          output: {
            summary: 'There are 999 anomalies costing 5000000 VND this month.',
            highlights: [],
          },
        }),
      },
    );
    expect(res.ai).toEqual({ ok: false, reason: 'refused' });
    expect(res.summary).not.toContain('999');
  });

  it('never leaks raw PII into prompt and guards via PayrollPromptLeakError', async () => {
    const sneaky = [
      {
        logId: '00000000-0000-7000-8000-000000000009',
        employeeId: '00000000-0000-7000-8000-000000000109',
        employeeName: 'Alice Secret',
        workDate: 'Alice Secret 2026-11-20',
        kind: 'short_day' as const,
        workedMinutes: 60,
      },
    ];
    await expect(
      reviewAttendanceAnomalies(
        { month: '2026-11', language: 'en', anomalies: sneaky },
        { generate: async () => ({ output: null }) },
      ),
    ).rejects.toBeInstanceOf(PayrollPromptLeakError);
  });
});
