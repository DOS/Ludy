// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AiBudgetExhaustedError,
  InboxReader,
  computeLaborCompliance,
  promptLeaks,
  reviewLaborCompliance,
  type LaborComplianceInput,
} from '../src/index.ts';

const BASE_INPUT: LaborComplianceInput = {
  kind: 'labor_register',
  period: '2026-06-30',
  asOf: '2026-06-30',
  language: 'vi',
  employees: [
    {
      // Missing identity, missing insurance, missing birthDate AND address -> unique birthDateOrAddress = 1; fixed_term expiring within 30 days.
      employeeId: '00000000-0000-4000-8000-000000000001',
      erased: false,
      endedOn: null,
      hasIdentityNumber: false,
      hasInsuranceNumber: false,
      hasBirthDate: false,
      hasAddress: false,
      contractKind: 'fixed_term',
      contractStartDate: '2025-07-15',
      contractTermMonths: 12,
    },
    {
      // Unwritten contract (`none`): should NOT count toward missingInsuranceNumber, only unwrittenNoneContracts.
      employeeId: '00000000-0000-4000-8000-000000000002',
      erased: false,
      endedOn: null,
      hasIdentityNumber: true,
      hasInsuranceNumber: false,
      hasBirthDate: true,
      hasAddress: true,
      contractKind: 'none',
      contractStartDate: null,
      contractTermMonths: null,
    },
    {
      // Erased employee: excluded from missing-field / contract alerts, still counted in `checked`.
      employeeId: '00000000-0000-4000-8000-000000000003',
      erased: true,
      endedOn: '2026-03-01',
      hasIdentityNumber: false,
      hasInsuranceNumber: false,
      hasBirthDate: false,
      hasAddress: false,
      contractKind: 'indefinite',
      contractStartDate: '2024-01-01',
      contractTermMonths: null,
    },
  ],
};

describe('pre-export labor compliance coworker (#3372)', () => {
  it('computes deterministic findings and counts cleanly with AI off', async () => {
    const result = await reviewLaborCompliance(BASE_INPUT, { generate: null });
    expect(result.ai).toEqual({ ok: false, reason: 'off' });
    expect(result.summary).toBeNull();
    expect(result.counts).toEqual({
      checked: 3,
      employeesMissingIdentity: 1,
      employeesMissingInsuranceNumber: 1,
      employeesMissingBirthDateOrAddress: 1,
      unwrittenNoneContracts: 1,
      contractAlerts: 1,
    });
    expect(result.findings).toEqual([
      { employeeId: '00000000-0000-4000-8000-000000000001', code: 'contract_expiring_soon', fieldOrRule: 'Labor Code 2019 Art. 20(2) & Art. 35/36' },
      { employeeId: '00000000-0000-4000-8000-000000000001', code: 'MISSING_ADDRESS', fieldOrRule: 'address' },
      { employeeId: '00000000-0000-4000-8000-000000000001', code: 'MISSING_BIRTH_DATE', fieldOrRule: 'birthDate' },
      { employeeId: '00000000-0000-4000-8000-000000000001', code: 'MISSING_IDENTITY_NUMBER', fieldOrRule: 'identityNumber' },
      { employeeId: '00000000-0000-4000-8000-000000000001', code: 'MISSING_INSURANCE_NUMBER', fieldOrRule: 'insuranceNumber' },
      { employeeId: '00000000-0000-4000-8000-000000000002', code: 'UNWRITTEN_NONE_CONTRACT', fieldOrRule: 'Labor Code 2019 Art. 14' },
    ]);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('sends only shuffled aliases and boolean/enum flags in prompts and restores verified names', async () => {
    let seenPrompt = '';
    const displayNames = new Map([
      ['00000000-0000-4000-8000-000000000001', 'Nguyễn Văn An'],
      ['00000000-0000-4000-8000-000000000002', 'Trần Thị Bình'],
    ]);
    // With random always picking index 0 on a 2-element array [e1, e2]: i=1 swaps idx 1 & 0 -> [e2, e1], so E1 = employee 2, E2 = employee 1.
    const result = await reviewLaborCompliance(BASE_INPUT, {
      forbidden: ['Nguyễn Văn An', 'Trần Thị Bình', '123 Lê Lợi', '2025-07-15'],
      displayNames,
      random: () => 0,
      generate: async ({ prompt }) => {
        seenPrompt = prompt;
        return {
          output: {
            summary: 'Cần bổ sung hồ sơ định danh, mã BHXH và rà soát thời hạn hợp đồng trước khi xuất bảng kê.',
            notes: [
              { id: 'N2', sentence: 'E2 thiếu số định danh và mã BHXH.' },
              { id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' },
            ],
          },
          usage: { inputTokens: 20, outputTokens: 15 },
        };
      },
    });

    expect(promptLeaks(seenPrompt, ['Nguyễn Văn An', 'Trần Thị Bình', '123 Lê Lợi', '2025-07-15'])).toEqual([]);
    expect(seenPrompt).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(seenPrompt).toContain('- N1 | E1 (contract=none): unwrittenNoneContract');
    expect(seenPrompt).toContain('- N2 | E2 (contract=fixed_term):');
    expect(result.ai).toEqual({ ok: true, reason: 'ok' });
    expect(result.summary).toBe(
      'Sổ quản lý lao động: đã kiểm tra 3 hồ sơ (1 thiếu CCCD/CMND, 1 thiếu mã BHXH, 1 thiếu ngày sinh hoặc địa chỉ, 1 chưa có hợp đồng văn bản, 1 cảnh báo hợp đồng). Cần bổ sung hồ sơ định danh, mã BHXH và rà soát thời hạn hợp đồng trước khi xuất bảng kê.',
    );
    expect(result.notes).toEqual([
      'Nguyễn Văn An thiếu số định danh và mã BHXH.',
      'Trần Thị Bình chưa có hợp đồng lao động bằng văn bản.',
    ]);
  });

  it('refuses AI responses with hallucinated numbers, cross-person alias swaps, wrong finding categories, or links', async () => {
    const cases = [
      // Hallucinated number / count mismatch ("All 3 records missing identity" when checked=3, missingIdentity=1): AI summary allows zero unverified numbers.
      { summary: 'All 3 employee records are missing identity numbers.', notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }] },
      // Invalid / unknown alias E9:
      { summary: 'Cần hoàn thiện hồ sơ nhân sự.', notes: [{ id: 'N1', sentence: 'E9 chưa có hợp đồng lao động bằng văn bản.' }] },
      // Cross-person alias swap (answering N1 which owns E1 using valid alias E2):
      { summary: 'Cần hoàn thiện hồ sơ nhân sự.', notes: [{ id: 'N1', sentence: 'E2 thiếu số định danh.' }] },
      // Wrong finding category attribution (E1 only has unwrittenNoneContract, not missingIdentity):
      { summary: 'Cần hoàn thiện hồ sơ nhân sự.', notes: [{ id: 'N1', sentence: 'E1 thiếu số định danh.' }] },
      // Link / URL:
      { summary: 'Xem thêm tại https://example.com trước khi xuất.', notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }] },
    ];
    for (const bad of cases) {
      const result = await reviewLaborCompliance(BASE_INPUT, {
        random: () => 0,
        generate: async () => ({ output: bad }),
      });
      expect(result.ai).toEqual({ ok: false, reason: 'refused' });
      expect(result.summary).toBeNull();
      expect(result.counts.checked).toBe(3);
      expect(result.findings.length).toBe(6);
    }
  });

  it('degrades cleanly to deterministic results on AiBudgetExhaustedError and provider errors', async () => {
    const budgetResult = await reviewLaborCompliance(BASE_INPUT, {
      generate: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
    });
    expect(budgetResult.ai).toEqual({ ok: false, reason: 'budget' });
    expect(budgetResult.summary).toBeNull();
    expect(budgetResult.counts.unwrittenNoneContracts).toBe(1);

    const unavailableResult = await reviewLaborCompliance(BASE_INPUT, {
      generate: async () => {
        throw new Error('upstream timeout');
      },
    });
    expect(unavailableResult.ai).toEqual({ ok: false, reason: 'unavailable' });
    expect(unavailableResult.summary).toBeNull();
    expect(unavailableResult.counts.contractAlerts).toBe(1);
  });

  it('routes cleanly through InboxReader.laborCheck', async () => {
    const reader = new InboxReader(
      { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'test-model' },
      {
        laborCheck: async () => ({
          output: {
            summary: 'Cần bổ sung hồ sơ và theo dõi gia hạn hợp đồng.',
            notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }],
          },
        }),
      },
    );
    const { counts } = computeLaborCompliance(BASE_INPUT);
    expect(counts.checked).toBe(3);
    const res = await reader.laborCheck(BASE_INPUT, { random: () => 0 });
    expect(res.ai).toEqual({ ok: true, reason: 'ok' });
    expect(res.counts.checked).toBe(3);
  });

  it('flags missing term months on fixed_term contracts and honors explicit insured overrides', () => {
    const out = computeLaborCompliance({
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          // fixed_term without term months -> MISSING_CONTRACT_TERM; explicitly un-insured (`insured: false`) -> no MISSING_INSURANCE_NUMBER.
          employeeId: '00000000-0000-4000-8000-000000000010',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: false,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'fixed_term',
          contractStartDate: '2026-01-01',
          contractTermMonths: null,
          insured: false,
        },
        {
          // none contract explicitly marked `insured: true` without insuranceNumber -> counts toward missingInsuranceNumber.
          employeeId: '00000000-0000-4000-8000-000000000011',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: false,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'none',
          contractStartDate: null,
          contractTermMonths: null,
          insured: true,
        },
      ],
    });
    expect(out.counts).toEqual({
      checked: 2,
      employeesMissingIdentity: 0,
      employeesMissingInsuranceNumber: 1,
      employeesMissingBirthDateOrAddress: 0,
      unwrittenNoneContracts: 1,
      contractAlerts: 1,
    });
    expect(out.findings).toEqual([
      { employeeId: '00000000-0000-4000-8000-000000000010', code: 'MISSING_CONTRACT_TERM', fieldOrRule: 'contractTermMonths' },
      { employeeId: '00000000-0000-4000-8000-000000000011', code: 'MISSING_INSURANCE_NUMBER', fieldOrRule: 'insuranceNumber' },
      { employeeId: '00000000-0000-4000-8000-000000000011', code: 'UNWRITTEN_NONE_CONTRACT', fieldOrRule: 'Labor Code 2019 Art. 14' },
    ]);
  });

  it('emits Art. 20(2) renewal alerts from fixedTermSequence and refuses birth-date AI claims when only address is missing', async () => {
    const seqOut = computeLaborCompliance({
      kind: '01pli',
      period: '2026-H2',
      asOf: '2026-12-31',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000021',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'fixed_term',
          contractStartDate: '2026-04-01',
          contractTermMonths: 12,
          fixedTermSequence: 2,
          insured: true,
        },
        {
          employeeId: '00000000-0000-4000-8000-000000000022',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'fixed_term',
          contractStartDate: '2026-07-01',
          contractTermMonths: null,
          fixedTermSequence: 3,
          insured: true,
        },
      ],
    });
    expect(seqOut.findings).toEqual([
      {
        employeeId: '00000000-0000-4000-8000-000000000021',
        code: 'final_fixed_term_renewal',
        fieldOrRule: 'Labor Code 2019 Art. 20(2)',
      },
      {
        employeeId: '00000000-0000-4000-8000-000000000022',
        code: 'MISSING_CONTRACT_TERM',
        fieldOrRule: 'contractTermMonths',
      },
      {
        employeeId: '00000000-0000-4000-8000-000000000022',
        code: 'must_convert_to_indefinite',
        fieldOrRule: 'Labor Code 2019 Art. 20(2)',
      },
    ]);

    const onlyAddressMissing: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000023',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: false,
          contractKind: 'indefinite',
          contractStartDate: '2025-01-01',
          contractTermMonths: null,
          insured: true,
        },
      ],
    };
    const refusedBirthClaim = await reviewLaborCompliance(onlyAddressMissing, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Cần bổ sung ngày sinh trước khi xuất bảng kê.',
          notes: [{ id: 'N1', sentence: 'E1 chưa có địa chỉ liên hệ.' }],
        },
      }),
    });
    expect(refusedBirthClaim.ai).toEqual({ ok: false, reason: 'refused' });
    expect(refusedBirthClaim.summary).toBeNull();

    const acceptedAddressClaim = await reviewLaborCompliance(onlyAddressMissing, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.',
          notes: [{ id: 'N1', sentence: 'E1 chưa có địa chỉ liên hệ.' }],
        },
      }),
    });
    expect(acceptedAddressClaim.ai).toEqual({ ok: true, reason: 'ok' });

    const onlyFinalRenewal: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'en',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000024',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'fixed_term',
          contractStartDate: '2026-01-01',
          contractTermMonths: 12,
          fixedTermSequence: 2,
          insured: true,
        },
      ],
    };
    const refusedWrongAlert = await reviewLaborCompliance(onlyFinalRenewal, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Please review the contract renewal limit before exporting.',
          notes: [{ id: 'N1', sentence: 'E1 has an expired contract and must convert to an indefinite contract.' }],
        },
      }),
    });
    expect(refusedWrongAlert.ai).toEqual({ ok: false, reason: 'refused' });
    expect(refusedWrongAlert.summary).toBeNull();

    const acceptedFinalRenewal = await reviewLaborCompliance(onlyFinalRenewal, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Please track the final fixed-term contract renewal before exporting.',
          notes: [{ id: 'N1', sentence: 'E1 is on its final fixed-term contract renewal.' }],
        },
      }),
    });
    expect(acceptedFinalRenewal.ai).toEqual({ ok: true, reason: 'ok' });

    const refusedExpiredOnExpiringSoon = await reviewLaborCompliance(BASE_INPUT, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Có hợp đồng đã hết hạn cần xử lý ngay.',
          notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }],
        },
      }),
    });
    expect(refusedExpiredOnExpiringSoon.ai).toEqual({ ok: false, reason: 'refused' });

    // Contradictory / complacent / evasive / over-quantified AI outputs and false birth-date synonyms must be refused.
    const contradictoryCases = [
      { summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.', notes: [{ id: 'N1', sentence: 'E1 có đầy đủ địa chỉ liên hệ.' }] },
      { summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.', notes: [{ id: 'N1', sentence: 'E1 không thiếu địa chỉ liên hệ.' }] },
      { summary: 'Update the missing address.', notes: [{ id: 'N1', sentence: 'E1 has a valid address.' }] },
      { summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.', notes: [{ id: 'N1', sentence: 'E1 cần lưu ý thêm trước khi xuất.' }] },
      { summary: 'Tất cả hồ sơ đã đầy đủ, không có thiếu sót.', notes: [{ id: 'N1', sentence: 'E1 chưa có địa chỉ liên hệ.' }] },
      { summary: 'All records are complete and ready to export.', notes: [{ id: 'N1', sentence: 'E1 is missing an address.' }] },
      { summary: 'Cần bổ sung ngày tháng năm sinh trước khi xuất bảng kê.', notes: [{ id: 'N1', sentence: 'E1 chưa có địa chỉ liên hệ.' }] },
    ];
    for (const bad of contradictoryCases) {
      const refused = await reviewLaborCompliance(onlyAddressMissing, {
        random: () => 0,
        generate: async () => ({ output: bad }),
      });
      expect(refused.ai, JSON.stringify(bad)).toEqual({ ok: false, reason: 'refused' });
      expect(refused.summary).toBeNull();
    }

    const overQuantifiedSummaries = [
      'Tất cả hồ sơ đều thiếu số định danh.',
      'Phần lớn hồ sơ thiếu địa chỉ liên hệ.',
      'All fixed-term contracts are expiring soon.',
      'Hai hồ sơ thiếu địa chỉ liên hệ.',
      'Three employees lack insurance numbers.',
    ];
    for (const summary of overQuantifiedSummaries) {
      const refused = await reviewLaborCompliance(BASE_INPUT, {
        random: () => 0,
        generate: async () => ({
          output: { summary, notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }] },
        }),
      });
      expect(refused.ai, summary).toEqual({ ok: false, reason: 'refused' });
      expect(refused.summary).toBeNull();
    }

    // Spelled numbers inside per-employee notes must also be refused.
    const refusedSpelledInNote = await reviewLaborCompliance(onlyAddressMissing, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.',
          notes: [{ id: 'N1', sentence: 'E1 thiếu hai mục địa chỉ liên hệ.' }],
        },
      }),
    });
    expect(refusedSpelledInNote.ai).toEqual({ ok: false, reason: 'refused' });

    // Clean roster (zero missing fields, zero alerts): refuse deficit/incomplete claims and accept honest clean confirmation.
    const cleanInput: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000030',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'indefinite',
          contractStartDate: '2025-01-01',
          contractTermMonths: null,
          insured: true,
        },
      ],
    };
    for (const badClean of [
      'Hồ sơ chưa đầy đủ, cần bổ sung trước khi xuất.',
      'Có vấn đề cần cập nhật trước khi xuất.',
    ]) {
      const refusedClean = await reviewLaborCompliance(cleanInput, {
        generate: async () => ({ output: { summary: badClean, notes: [] } }),
      });
      expect(refusedClean.ai, badClean).toEqual({ ok: false, reason: 'refused' });
      expect(refusedClean.summary).toBeNull();
    }
    const acceptedClean = await reviewLaborCompliance(cleanInput, {
      generate: async () => ({
        output: { summary: 'Không có thiếu sót hay cảnh báo, hồ sơ sẵn sàng đối chiếu trước khi xuất.', notes: [] },
      }),
    });
    expect(acceptedClean.ai).toEqual({ ok: true, reason: 'ok' });

    // Existential 'Có hợp đồng sắp hết hạn...' in summary remains accepted even when another worker has unwrittenNoneContract.
    const acceptedMixedSummary = await reviewLaborCompliance(BASE_INPUT, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Có hợp đồng sắp hết hạn và trường hợp chưa ký hợp đồng lao động văn bản.',
          notes: [{ id: 'N1', sentence: 'E1 chưa có hợp đồng lao động bằng văn bản.' }],
        },
      }),
    });
    expect(acceptedMixedSummary.ai).toEqual({ ok: true, reason: 'ok' });

    // Refuses affirmative claims that contract term months are recorded when missingContractTerm is flagged, while accepting accurate warnings.
    const missingTermOnly: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000031',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'fixed_term',
          contractStartDate: '2026-01-01',
          contractTermMonths: null,
          insured: false,
        },
      ],
    };
    for (const badTermNote of [
      'E1 đã ghi số tháng hợp đồng.',
      'E1 có đầy đủ số tháng hợp đồng.',
      'E1 has specified term months.',
      'E1 term months are complete.',
    ]) {
      const refusedTerm = await reviewLaborCompliance(missingTermOnly, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: 'Cần bổ sung số tháng hợp đồng còn thiếu trước khi xuất sổ.',
            notes: [{ id: 'N1', sentence: badTermNote }],
          },
        }),
      });
      expect(refusedTerm.ai, badTermNote).toEqual({ ok: false, reason: 'refused' });
      expect(refusedTerm.summary).toBeNull();
    }
    for (const goodTermNote of ['E1 chưa ghi số tháng hợp đồng.', 'E1 cần bổ sung số tháng hợp đồng.']) {
      const acceptedTerm = await reviewLaborCompliance(missingTermOnly, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: 'Cần bổ sung số tháng hợp đồng còn thiếu trước khi xuất sổ.',
            notes: [{ id: 'N1', sentence: goodTermNote }],
          },
        }),
      });
      expect(acceptedTerm.ai, goodTermNote).toEqual({ ok: true, reason: 'ok' });
    }

    // Refuses passport / CCCD / citizen-ID claims when only address is missing, and refuses passport denials when identity is missing.
    for (const badPassportNote of [
      'E1 thiếu địa chỉ và hộ chiếu.',
      'E1 is missing address and passport.',
      'E1 cần bổ sung địa chỉ và căn cước công dân.',
    ]) {
      const refusedPassport = await reviewLaborCompliance(onlyAddressMissing, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: 'Cần cập nhật địa chỉ liên hệ còn thiếu.',
            notes: [{ id: 'N1', sentence: badPassportNote }],
          },
        }),
      });
      expect(refusedPassport.ai, badPassportNote).toEqual({ ok: false, reason: 'refused' });
      expect(refusedPassport.summary).toBeNull();
    }
    const missingIdentityOnly: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000032',
          erased: false,
          endedOn: null,
          hasIdentityNumber: false,
          hasInsuranceNumber: true,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'indefinite',
          contractStartDate: '2025-01-01',
          contractTermMonths: null,
          insured: true,
        },
      ],
    };
    for (const badIdentityDenial of ['E1 đã có hộ chiếu.', 'E1 has a valid passport.']) {
      const refusedDenial = await reviewLaborCompliance(missingIdentityOnly, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: 'Cần bổ sung thông tin định danh cá nhân còn thiếu.',
            notes: [{ id: 'N1', sentence: badIdentityDenial }],
          },
        }),
      });
      expect(refusedDenial.ai, badIdentityDenial).toEqual({ ok: false, reason: 'refused' });
    }
    const acceptedPassportWarning = await reviewLaborCompliance(missingIdentityOnly, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Cần bổ sung thông tin định danh cá nhân còn thiếu.',
          notes: [{ id: 'N1', sentence: 'E1 thiếu số CCCD hoặc hộ chiếu.' }],
        },
      }),
    });
    expect(acceptedPassportWarning.ai).toEqual({ ok: true, reason: 'ok' });

    // Refuses readiness / completion summaries and ungrounded filler when issues exist, while accepting honest grounded warnings.
    for (const badSummary of [
      'Hồ sơ sẵn sàng nộp báo cáo.',
      'Ready for submission.',
      'Dữ liệu đã hoàn chỉnh.',
      'Cần bổ sung địa chỉ nhưng hồ sơ vẫn sẵn sàng nộp báo cáo.',
      'Cần rà soát thêm trước khi tiếp tục.',
    ]) {
      const refusedSummary = await reviewLaborCompliance(onlyAddressMissing, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: badSummary,
            notes: [{ id: 'N1', sentence: 'E1 thiếu địa chỉ.' }],
          },
        }),
      });
      expect(refusedSummary.ai, badSummary).toEqual({ ok: false, reason: 'refused' });
      expect(refusedSummary.summary).toBeNull();
    }
    for (const honestSummary of [
      'Hồ sơ chưa sẵn sàng xuất vì thiếu địa chỉ.',
      'Địa chỉ liên hệ còn thiếu, cần cập nhật để sẵn sàng nộp.',
    ]) {
      const acceptedSummary = await reviewLaborCompliance(onlyAddressMissing, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: honestSummary,
            notes: [{ id: 'N1', sentence: 'E1 thiếu địa chỉ.' }],
          },
        }),
      });
      expect(acceptedSummary.ai, honestSummary).toEqual({ ok: true, reason: 'ok' });
    }

    // Refuses per-employee notes or summaries claiming a missing field has already been supplemented/updated/completed.
    for (const badNote of [
      'E1 đã bổ sung địa chỉ liên hệ.',
      'Địa chỉ liên hệ của E1 đã được cập nhật.',
      'E1 updated address.',
      'E1 already supplemented contact address.',
    ]) {
      const refusedCompletionNote = await reviewLaborCompliance(onlyAddressMissing, {
        random: () => 0,
        generate: async () => ({
          output: {
            summary: 'Cần bổ sung địa chỉ liên hệ còn thiếu.',
            notes: [{ id: 'N1', sentence: badNote }],
          },
        }),
      });
      expect(refusedCompletionNote.ai, badNote).toEqual({ ok: false, reason: 'refused' });
      expect(refusedCompletionNote.summary).toBeNull();
      expect(refusedCompletionNote.notes).toEqual(['1 hồ sơ thiếu ngày sinh hoặc địa chỉ liên hệ.']);
    }
    const noneContractOnly: LaborComplianceInput = {
      kind: 'labor_register',
      period: '2026-06-30',
      asOf: '2026-06-30',
      language: 'vi',
      employees: [
        {
          employeeId: '00000000-0000-4000-8000-000000000033',
          erased: false,
          endedOn: null,
          hasIdentityNumber: true,
          hasInsuranceNumber: false,
          hasBirthDate: true,
          hasAddress: true,
          contractKind: 'none',
          contractStartDate: null,
          contractTermMonths: null,
          insured: false,
        },
      ],
    };
    const refusedNoneContractNote = await reviewLaborCompliance(noneContractOnly, {
      random: () => 0,
      generate: async () => ({
        output: {
          summary: 'Cần ký hợp đồng lao động bằng văn bản.',
          notes: [{ id: 'N1', sentence: 'E1 đã ký hợp đồng lao động.' }],
        },
      }),
    });
    expect(refusedNoneContractNote.ai).toEqual({ ok: false, reason: 'refused' });
    expect(refusedNoneContractNote.summary).toBeNull();
    expect(refusedNoneContractNote.notes.join(' ')).not.toContain('đã ký');

    const acceptedUnresolvedNote = await reviewLaborCompliance(onlyAddressMissing, {
      random: () => 0,
      displayNames: new Map([['00000000-0000-4000-8000-000000000023', 'Nguyễn Văn Địa Chỉ']]),
      generate: async () => ({
        output: {
          summary: 'Cần bổ sung địa chỉ liên hệ còn thiếu.',
          notes: [{ id: 'N1', sentence: 'E1 chưa cập nhật địa chỉ, cần bổ sung trước khi xuất.' }],
        },
      }),
    });
    expect(acceptedUnresolvedNote.ai).toEqual({ ok: true, reason: 'ok' });
    expect(acceptedUnresolvedNote.notes).toEqual(['Nguyễn Văn Địa Chỉ chưa cập nhật địa chỉ, cần bổ sung trước khi xuất.']);
  });
});
