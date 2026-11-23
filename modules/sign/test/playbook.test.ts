// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for Vietnam SME default playbook rules and deterministic AI-off contract evaluation (#4442).
import { describe, expect, it } from 'vitest';
import { SIGN_PLAYBOOK_MAX_TOTAL_CHARS, zId } from '@ludy/kernel-contract';
import {
  DEFAULT_VIETNAM_SME_PLAYBOOK_RULES,
  computePlaybookCheckRevision,
  computePlaybookRuleRevision,
  defaultSlotForRuleId,
  deterministicPlaybookRuleId,
  evaluatePlaybookDeterministically,
  zPlaybookRecordCheckInput,
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

  it('evaluates long unpunctuated paragraphs past 480 chars and flags worst multi-page penalty clause', () => {
    const penaltyRule = defaultEffectiveRules(ORG_A).find(
      (r) => defaultSlotForRuleId(ORG_A, r.id) === 'penalty_cap',
    )!;
    const filler = 'hai bên thống nhất nghĩa vụ phối hợp thực hiện đúng tiến độ bàn giao và bảo hành sản phẩm '.repeat(7);
    const longClause = `Điều 6. Phạt vi phạm hợp đồng: ${filler} bên vi phạm chịu mức phạt bằng 14% giá trị hợp đồng.`;

    const longFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [penaltyRule],
      [{ page: 1, text: longClause }],
      1,
    );
    expect(longFindings[0]?.verdict).toBe('fail');
    expect(longFindings[0]?.quoteExcerpt).toContain('14%');

    const multiPageFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [penaltyRule],
      [
        { page: 1, text: 'Điều 5. Phạt vi phạm: Mức phạt vi phạm hợp đồng là 5% giá trị phần nghĩa vụ vi phạm.' },
        { page: 2, text: 'Điều 9. Phạt vi phạm: Mức phạt vi phạm hợp đồng bổ sung là 14% giá trị hợp đồng.' },
      ],
      2,
    );
    expect(multiPageFindings[0]?.verdict).toBe('fail');
    expect(multiPageFindings[0]?.pageNumber).toBe(2);
    expect(multiPageFindings[0]?.quoteExcerpt).toContain('14%');
  });

  it('parses full percentage tokens without suffix slicing (8.001% and 150%)', () => {
    const penaltyRule = defaultEffectiveRules(ORG_A).find(
      (r) => defaultSlotForRuleId(ORG_A, r.id) === 'penalty_cap',
    )!;

    const precisionFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [penaltyRule],
      [{ page: 1, text: 'Điều 6. Phạt vi phạm: Mức phạt vi phạm là 8.001% giá trị hợp đồng.' }],
      1,
    );
    expect(precisionFindings[0]?.verdict).not.toBe('pass');
    expect(precisionFindings[0]?.verdict).toBe('warn');

    const overHundredFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [penaltyRule],
      [{ page: 1, text: 'Điều 6. Phạt vi phạm: Mức phạt vi phạm là 150% giá trị hợp đồng.' }],
      1,
    );
    expect(overHundredFindings[0]?.verdict).toBe('fail');
  });

  it('respects edited rule guidance thresholds and prevents custom rules from inheriting built-in 8% caps', () => {
    const defaults = defaultEffectiveRules(ORG_A);
    const termRule = defaults.find((r) => defaultSlotForRuleId(ORG_A, r.id) === 'termination_notice')!;
    const editedTermRule: SignPlaybookRuleEffective = {
      ...termRule,
      guidance: 'Điều khoản đơn phương chấm dứt phải báo trước tối thiểu 30 ngày và cân bằng hai bên.',
    };
    const termFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [editedTermRule],
      [{ page: 1, text: 'Điều 6. Đơn phương chấm dứt: Mỗi bên được đơn phương chấm dứt khi báo trước 15 ngày.' }],
      1,
    );
    expect(termFindings[0]?.verdict).toBe('warn');

    const penaltyRule = defaults.find((r) => defaultSlotForRuleId(ORG_A, r.id) === 'penalty_cap')!;
    const noCapPenaltyRule: SignPlaybookRuleEffective = {
      ...penaltyRule,
      guidance: 'Cấm hoàn toàn mọi điều khoản phạt vi phạm dưới mọi hình thức.',
    };
    const noCapFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [noCapPenaltyRule],
      [{ page: 1, text: 'Điều 5. Phạt vi phạm: Mức phạt vi phạm là 5% giá trị hợp đồng.' }],
      1,
    );
    expect(noCapFindings[0]?.verdict).toBe('warn');

    const customNoLiquidatedDamages: SignPlaybookRuleEffective = {
      id: '01900000-0000-4000-8000-000000000188',
      title: 'Prohibit liquidated damages',
      guidance: 'Prohibit all liquidated damages clauses.',
      severity: 'critical',
      matchKeywords: ['liquidated damages'],
      active: true,
      isDefault: false,
    };
    const customFindings = evaluatePlaybookDeterministically(
      ORG_A,
      [customNoLiquidatedDamages],
      [{ page: 1, text: 'Section 8: Seller shall pay liquidated damages of 5% of contract value.' }],
      1,
    );
    expect(customFindings[0]?.verdict).toBe('warn');
  });

  it('enforces termination parity, opt-out-bound auto-renewal days, separate law/venue, and full acceptance evidence', () => {
    const bySlot = new Map(
      defaultEffectiveRules(ORG_A).map((r) => [defaultSlotForRuleId(ORG_A, r.id)!, r]),
    );

    const oneSidedTerm = evaluatePlaybookDeterministically(
      ORG_A,
      [bySlot.get('termination_notice')!],
      [{ page: 1, text: "Section 7. Termination: The buyer may terminate this agreement on 30 days' prior written notice." }],
      1,
    );
    expect(oneSidedTerm[0]?.verdict).toBe('warn');

    const renewWithoutOptOutDays = evaluatePlaybookDeterministically(
      ORG_A,
      [bySlot.get('auto_renewal_notice')!],
      [{ page: 1, text: 'This contract will auto-renew for 90 days unless either party gives prior written notice.' }],
      1,
    );
    expect(renewWithoutOptOutDays[0]?.verdict).toBe('warn');

    const renewWithOptOutDays = evaluatePlaybookDeterministically(
      ORG_A,
      [bySlot.get('auto_renewal_notice')!],
      [{ page: 1, text: "This contract will auto-renew for 90 days unless either party gives at least 30 days' prior written notice." }],
      1,
    );
    expect(renewWithOptOutDays[0]?.verdict).toBe('pass');
    expect(renewWithOptOutDays[0]?.rationale).toContain('30 ngày');

    const vnLawForeignVenue = evaluatePlaybookDeterministically(
      ORG_A,
      [bySlot.get('dispute_venue')!],
      [{ page: 1, text: 'Governing law and dispute resolution: Vietnamese law governs; arbitration is seated in Singapore.' }],
      1,
    );
    expect(vnLawForeignVenue[0]?.verdict).toBe('warn');

    const partialAcceptance = evaluatePlaybookDeterministically(
      ORG_A,
      [bySlot.get('acceptance_criteria')!],
      [{ page: 1, text: 'Section 4. Handover: The parties shall sign an acceptance certificate upon delivery.' }],
      1,
    );
    expect(partialAcceptance[0]?.verdict).toBe('warn');
  });

  it('bounds total extracted text, aligns promptVersion max to 32, and updates revisions deterministically', () => {
    const validBase = {
      envelopeId: '01900000-0000-7000-8000-000000000001',
      sourceSha256: 'a'.repeat(64),
      mode: 'deterministic' as const,
      promptVersion: null,
      extractedPages: [
        { page: 1, text: 'x'.repeat(250_000) },
        { page: 2, text: 'x'.repeat(250_000) },
        { page: 3, text: 'x'.repeat(250_000) },
      ],
    };
    expect(zPlaybookRecordCheckInput.safeParse(validBase).success).toBe(true);

    const overTotal = {
      ...validBase,
      extractedPages: [
        ...validBase.extractedPages,
        { page: 4, text: 'x'.repeat(SIGN_PLAYBOOK_MAX_TOTAL_CHARS - 749_999) },
      ],
    };
    expect(zPlaybookRecordCheckInput.safeParse(overTotal).success).toBe(false);

    const longPromptVer = {
      ...validBase,
      mode: 'ai' as const,
      promptVersion: 'p'.repeat(33),
      evaluatedRules: [{ ruleId: '01900000-0000-7000-8000-000000000002', revision: 'b'.repeat(64) }],
    };
    expect(zPlaybookRecordCheckInput.safeParse(longPromptVer).success).toBe(false);

    const aiWithoutEvaluatedRules = {
      ...validBase,
      mode: 'ai' as const,
      promptVersion: 'sign-playbook-v1',
    };
    expect(zPlaybookRecordCheckInput.safeParse(aiWithoutEvaluatedRules).success).toBe(false);

    const rule = defaultEffectiveRules(ORG_A)[0]!;
    const rev1 = computePlaybookRuleRevision(rule);
    const rev2 = computePlaybookRuleRevision({ ...rule, guidance: `${rule.guidance} updated` });
    expect(rev1).not.toBe(rev2);

    const checkRev1 = computePlaybookCheckRevision({
      id: '01900000-0000-7000-8000-000000000010',
      sourceSha256: 'a'.repeat(64),
      mode: 'deterministic',
      updatedAt: '2027-01-01T00:00:00.000Z',
      findings: [],
    });
    const checkRev2 = computePlaybookCheckRevision({
      id: '01900000-0000-7000-8000-000000000011',
      sourceSha256: 'a'.repeat(64),
      mode: 'deterministic',
      updatedAt: '2027-01-01T00:00:00.000Z',
      findings: [],
    });
    expect(checkRev1).not.toBe(checkRev2);
  });
});
