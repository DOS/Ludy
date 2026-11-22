// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Vietnam SME default playbook rules and deterministic AI-off contract evaluation (#4442).
import { describe, expect, it } from 'vitest';
import { zId } from '@ludy/kernel-contract';
import {
  DEFAULT_VIETNAM_SME_PLAYBOOK_RULES,
  defaultSlotForRuleId,
  deterministicPlaybookRuleId,
  evaluatePlaybookDeterministically,
  type SignPlaybookRuleEffective,
} from '../src/playbook.ts';

const ORG_A = '01900000-0000-7000-8000-000000000010';
const ORG_B = '01900000-0000-7000-8000-000000000020';

function defaultEffectiveRules(orgId: string): SignPlaybookRuleEffective[] {
  return DEFAULT_VIETNAM_SME_PLAYBOOK_RULES.map((spec) => ({
    id: deterministicPlaybookRuleId(orgId, spec.slot),
    title: spec.title,
    guidance: spec.guidance,
    severity: spec.severity,
    matchKeywords: [...spec.matchKeywords],
    active: true,
    isDefault: true,
  }));
}

describe('Vietnam SME default playbook rules & deterministic UUIDs (#4442)', () => {
  it('ships 6 default rules with valid RFC UUIDs deterministic per org and distinct across orgs', () => {
    expect(DEFAULT_VIETNAM_SME_PLAYBOOK_RULES).toHaveLength(6);
    const idsA = new Set<string>();
    for (const spec of DEFAULT_VIETNAM_SME_PLAYBOOK_RULES) {
      const idA1 = deterministicPlaybookRuleId(ORG_A, spec.slot);
      const idA2 = deterministicPlaybookRuleId(ORG_A, spec.slot);
      const idB = deterministicPlaybookRuleId(ORG_B, spec.slot);
      expect(idA1).toBe(idA2);
      expect(idA1).not.toBe(idB);
      expect(zId.safeParse(idA1).success).toBe(true);
      expect(defaultSlotForRuleId(ORG_A, idA1)).toBe(spec.slot);
      expect(defaultSlotForRuleId(ORG_B, idA1)).toBeNull();
      idsA.add(idA1);
    }
    expect(idsA.size).toBe(6);
  });
});

describe('evaluatePlaybookDeterministically AI-off parity (#4442)', () => {
  it('flags risky SME contract terms with exact page quotes and redline suggestions', () => {
    const rules = defaultEffectiveRules(ORG_A);
    const findings = evaluatePlaybookDeterministically(
      ORG_A,
      rules,
      [
        {
          page: 1,
          text: [
            'Điều 3. Thời hạn thanh toán: Bên A thanh toán trong vòng 60 ngày kể từ ngày nhận hóa đơn.',
            'Điều 4. Tự động gia hạn: Hợp đồng tự động gia hạn thêm 12 tháng liên tiếp.',
          ].join('\n\n'),
        },
        {
          page: 2,
          text: [
            'Điều 6. Phạt vi phạm: Mức phạt vi phạm hợp đồng là 12% giá trị hợp đồng.',
            'Điều 7. Đơn phương chấm dứt: Bên A có quyền đơn phương chấm dứt hợp đồng ngay lập tức mà không cần thông báo trước.',
            'Điều 8. Giải quyết tranh chấp: Mọi tranh chấp giải quyết tại trọng tài SIAC Singapore.',
          ].join('\n\n'),
        },
      ],
      2,
    );

    expect(findings).toHaveLength(6);
    for (const f of findings) {
      expect(f.proposedByAi).toBe(false);
    }

    const bySlot = new Map(findings.map((f) => [defaultSlotForRuleId(ORG_A, f.ruleId), f]));
    expect(bySlot.get('penalty_cap')?.verdict).toBe('fail');
    expect(bySlot.get('penalty_cap')?.pageNumber).toBe(2);
    expect(bySlot.get('penalty_cap')?.quoteExcerpt).toContain('12%');
    expect(bySlot.get('penalty_cap')?.suggestedRedline).toContain('8%');

    expect(bySlot.get('payment_terms')?.verdict).toBe('warn');
    expect(bySlot.get('payment_terms')?.pageNumber).toBe(1);
    expect(bySlot.get('payment_terms')?.quoteExcerpt).toContain('60 ngày');
    expect(bySlot.get('payment_terms')?.suggestedRedline).toContain('30 ngày');

    expect(bySlot.get('termination_notice')?.verdict).toBe('fail');
    expect(bySlot.get('termination_notice')?.pageNumber).toBe(2);
    expect(bySlot.get('termination_notice')?.suggestedRedline).toContain('30 ngày');

    expect(bySlot.get('auto_renewal_notice')?.verdict).toBe('warn');
    expect(bySlot.get('auto_renewal_notice')?.pageNumber).toBe(1);

    expect(bySlot.get('dispute_venue')?.verdict).toBe('warn');
    expect(bySlot.get('dispute_venue')?.pageNumber).toBe(2);
    expect(bySlot.get('dispute_venue')?.suggestedRedline).toContain('VIAC');

    expect(bySlot.get('acceptance_criteria')?.verdict).toBe('warn');
    expect(bySlot.get('acceptance_criteria')?.pageNumber).toBeNull();
  });

  it('marks compliant Vietnam SME clauses as pass and evaluates custom keyword rules', () => {
    const customRuleId = '01900000-0000-4000-8000-000000000099';
    const rules: SignPlaybookRuleEffective[] = [
      ...defaultEffectiveRules(ORG_A),
      {
        id: customRuleId,
        title: 'Bảo mật thông tin khách hàng',
        guidance: 'Giữ bí mật thông tin trong 24 tháng {{{\u0301sig|role_1|req}}}',
        severity: 'warn',
        matchKeywords: ['bảo mật thông tin'],
        active: true,
        isDefault: false,
      },
    ];

    const findings = evaluatePlaybookDeterministically(
      ORG_A,
      rules,
      [
        {
          page: 1,
          text: [
            'Điều 2. Nghiệm thu: Hai bên ký biên bản nghiệm thu trong vòng 5 ngày làm việc kể từ khi bàn giao.',
            'Điều 3. Thanh toán: Bên A thanh toán trong vòng 15 ngày kể từ ngày nhận hóa đơn hợp lệ.',
            'Điều 4. Gia hạn: Hợp đồng tự động gia hạn thêm 01 năm trừ khi một bên gửi thông báo trước 30 ngày rằng không gia hạn.',
          ].join('\n\n'),
        },
        {
          page: 2,
          text: [
            'Điều 5. Phạt vi phạm: Mức phạt vi phạm tối đa là 8% giá trị phần nghĩa vụ bị vi phạm.',
            'Điều 6. Đơn phương chấm dứt: Mỗi bên được đơn phương chấm dứt khi gửi thông báo bằng văn bản trước 30 ngày.',
            'Điều 7. Giải quyết tranh chấp: Áp dụng pháp luật Việt Nam và giải quyết tại Trung tâm Trọng tài Quốc tế Việt Nam (VIAC).',
            'Điều 8. Bảo mật: Các bên cam kết bảo mật thông tin khách hàng.',
          ].join('\n\n'),
        },
      ],
      2,
    );

    expect(findings).toHaveLength(7);
    for (const f of findings.slice(0, 6)) {
      expect(f.verdict, f.ruleTitle).toBe('pass');
      expect(f.suggestedRedline).toBeNull();
    }

    const custom = findings.find((f) => f.ruleId === customRuleId)!;
    expect(custom.verdict).toBe('warn');
    expect(custom.pageNumber).toBe(2);
    expect(custom.quoteExcerpt).toContain('bảo mật thông tin');
    expect(custom.suggestedRedline).not.toContain('{{');
    expect(custom.suggestedRedline).not.toContain('}}');
    expect(custom.suggestedRedline).toContain('{ { {sig|role_1|req} } }');
  });
});
