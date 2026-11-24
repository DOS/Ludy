// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Contract Vault scoring, diacritic folding, and SQL visibility filter tests (#4439).
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Database, MemberRole } from '@ludy/db';
import type { QueryContext } from '@ludy/kernel-runtime';
import {
  foldVaultSearchText,
  parseSignVaultQuery,
  scoreSignVaultCandidates,
  vaultSearch,
  type SignVaultCandidateInput,
} from '../src/vault.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const MEMBER_ID = '01900000-0000-7000-8000-000000000014';
const ENV_1 = '01900000-0000-7000-8000-000000000201';
const ENV_2 = '01900000-0000-7000-8000-000000000202';

function createFakeTrx(
  onQuery: (compiled: CompiledQuery) => QueryResult<Record<string, unknown>>,
): { trx: Transaction<Database>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const conn: DatabaseConnection = {
    executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(compiled);
      return onQuery(compiled) as QueryResult<R>;
    },
    streamQuery: (() => {
      throw new Error('streamQuery not implemented');
    }) as DatabaseConnection['streamQuery'],
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => conn,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (inst) => new PostgresIntrospector(inst),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { trx: db as unknown as Transaction<Database>, queries };
}

function makeUserQueryCtx(trx: Transaction<Database>, userId: string, role: MemberRole): QueryContext {
  return {
    trx,
    orgId: ORG_ID,
    actor: { type: 'user', userId, aal: 'aal1', sessionId: 'sess-vault' },
    role,
    query: async () => ({ status: 'not_installed', module: 'sign' }),
    reviserOf: () => null,
    agent: null,
    memberVy: null,
    installed: () => true,
    command: () => null,
    open: async () => '',
    openMany: async (items) => items.map(() => ''),
  };
}

describe('scoreSignVaultCandidates deterministic search (#4439)', () => {
  const CANDIDATES: SignVaultCandidateInput[] = [
    {
      envelopeId: ENV_1,
      title: 'Hợp đồng dịch vụ phần mềm Minh Anh',
      subject: null,
      status: 'completed',
      sourceKind: 'standalone',
      pageCount: 3,
      completedAt: '2026-11-20T08:00:00.000Z',
      updatedAt: '2026-11-20T08:00:00.000Z',
      sharedSummaryJson: null,
      obligation: {
        counterpartyName: 'Công ty TNHH Thương mại Minh Anh',
        effectiveDate: '2026-12-01',
        expiryDate: '2027-11-30',
        renewalNoticeDays: 30,
        autoRenew: true,
        contractValue: '24000000.0000',
        currency: 'VND',
        obligationsJson: [
          {
            id: 'obl-1',
            title: 'Thanh toán đợt 1 theo hợp đồng',
            dueDate: '2026-12-15',
            status: 'pending',
            pageNumber: 2,
            quoteExcerpt: 'Thanh toán đợt 1 trị giá 12.000.000 VND trước ngày 15/12/2026.',
          },
        ],
      },
      analysis: {
        summaryText: 'Hợp đồng dịch vụ phần mềm thời hạn 12 tháng.',
        riskClausesJson: [
          {
            title: 'Phạt chậm thanh toán',
            severity: 'medium',
            pageNumber: 2,
            quote: 'Mức phạt chậm thanh toán là 0,05%/ngày trên số tiền chậm trả.',
            explanation: 'Cần theo dõi lịch thanh toán đúng hạn.',
          },
        ],
      },
    },
    {
      envelopeId: ENV_2,
      title: 'Thỏa thuận bảo mật thông tin Đại Dương',
      subject: null,
      status: 'sent',
      sourceKind: 'standalone',
      pageCount: 2,
      completedAt: null,
      updatedAt: '2026-11-21T08:00:00.000Z',
      sharedSummaryJson: {
        summaryText: 'Cam kết bảo mật tài liệu kỹ thuật kiến trúc đám mây trong 24 tháng.',
        keyTerms: [
          {
            label: 'Thời hạn bảo mật',
            value: '24 tháng kể từ ngày ký',
            pageNumber: 1,
            quoteExcerpt: 'Bên nhận cam kết giữ bí mật hồ sơ kỹ thuật trong 24 tháng.',
          },
        ],
      },
      obligation: null,
      analysis: null,
    },
  ];

  it('matches Vietnamese queries with or without diacritics, formats decimal money, and isolates entity tokens', () => {
    expect(foldVaultSearchText('Điều khoản Đền bù & Phạt chậm')).toBe('dieu khoan den bu phat cham');

    const penaltyMatches = scoreSignVaultCandidates(CANDIDATES, 'dieu khoan phat cham thanh toan la gi?');
    expect(penaltyMatches).toHaveLength(1);
    expect(penaltyMatches[0]?.envelopeId).toBe(ENV_1);
    expect(penaltyMatches[0]?.contractValue).toBe('24000000');
    expect(penaltyMatches[0]?.snippets.some((s) => s.kind === 'clause' && s.pageNumber === 2)).toBe(true);

    // Renewal intent question without entity filter surfaces only contracts with renewal/expiry terms.
    const renewalMatches = scoreSignVaultCandidates(CANDIDATES, 'Which contracts expire this quarter?');
    expect(renewalMatches.map((m) => m.envelopeId)).toEqual([ENV_1]);

    // Entity token + renewal intent ("Đại Dương hết hạn khi nào?") never leaks unrelated expiring contract ENV_1!
    const entityFiltered = scoreSignVaultCandidates(CANDIDATES, 'Đại Dương hết hạn khi nào?');
    expect(entityFiltered.map((m) => m.envelopeId)).toEqual([ENV_2]);
    expect(parseSignVaultQuery('Đại Dương hết hạn khi nào?').entityFoldedTokens).toEqual(['dai', 'duong']);

    // Sender shared summary prose (summaryText) and keyTerm quoteExcerpt are indexed accurately.
    const summaryTextMatches = scoreSignVaultCandidates(CANDIDATES, 'kiến trúc đám mây');
    expect(summaryTextMatches.map((m) => m.envelopeId)).toEqual([ENV_2]);
    expect(summaryTextMatches[0]?.snippets[0]?.kind).toBe('shared_summary');
    expect(scoreSignVaultCandidates(CANDIDATES, 'hồ sơ kỹ thuật').map((m) => m.envelopeId)).toEqual([ENV_2]);

    // Unmatched secret token returns empty array.
    expect(scoreSignVaultCandidates(CANDIDATES, 'BiMatKhongTonTai999')).toEqual([]);
  });

  it('compiles hr_contract, ADR-0047 meeting_minutes, and confirmed-obligation SQL filters in sign.vault.search', async () => {
    const { trx, queries } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('org_app_on')) {
        return { rows: [{ enabled: true }] };
      }
      if (compiled.sql.includes('from "ludy_sign"."envelope"')) {
        return {
          rows: [
            {
              id: ENV_1,
              title: 'Hợp đồng Minh Anh',
              subject: null,
              status: 'completed',
              source_kind: 'standalone',
              source_id: null,
              source_sha256: 'a'.repeat(64),
              page_count: 2,
              shared_summary_json: null,
              completed_at: '2026-11-20T00:00:00.000Z',
              updated_at: '2026-11-20T00:00:00.000Z',
              created_by: MEMBER_ID,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const memberCtx = makeUserQueryCtx(trx, MEMBER_ID, 'member');
    const res = await vaultSearch.handler(memberCtx, { question: 'Minh Anh', limit: 10 });
    expect(res.items).toHaveLength(1);

    const envelopeSql = queries.find((q) => q.sql.includes('from "ludy_sign"."envelope"'));
    expect(envelopeSql?.sql).toContain('can_access_meeting_minutes_envelope');
    expect(envelopeSql?.parameters).toContain('hr_contract');
    expect(envelopeSql?.parameters).toContain('meeting_minutes');

    const obligationSql = queries.find((q) => q.sql.includes('from "ludy_sign"."envelope_obligation"'));
    expect(obligationSql?.parameters).toContain('confirmed');
  });

  it('normalizes combining diacritic marks (\\p{M}) and omits stray colons in empty/partial clause labels (#4510)', () => {
    // NFD decomposed Vietnamese query should fold identically to precomposed NFC input and still match exact phrase.
    const nfdQuestion = 'Hơ\u0323p đô\u0300ng di\u0323ch vu\u0323 Minh Anh hê\u0301t ha\u0323n khi na\u0300o?';
    expect(foldVaultSearchText('Ho\u0300a Bi\u0300nh \u0301')).toBe('hoa binh');
    const nfdMatches = scoreSignVaultCandidates(CANDIDATES, nfdQuestion);
    expect(nfdMatches.map((m) => m.envelopeId)).toContain(ENV_1);

    // Non-composed combining accents on Latin tokens should strip cleanly instead of splitting tokens with spaces.
    const strayAccentMatch = scoreSignVaultCandidates(
      [
        {
          ...CANDIDATES[0]!,
          envelopeId: '01900000-0000-7000-8000-000000000099',
          title: 'Vendor\u0301 Agreement Alpha',
          obligation: null,
          analysis: {
            summaryText: 'Test combining mark cleanup.',
            riskClausesJson: [
              { title: 'Only Title', severity: 'low', pageNumber: 1, quote: '', explanation: '' },
              { title: '', severity: 'low', pageNumber: 1, quote: '', explanation: 'Only Explanation' },
              { title: '', severity: 'low', pageNumber: 1, quote: '', explanation: '' },
            ],
          },
        },
      ],
      'Vendor Only',
    );
    expect(strayAccentMatch).toHaveLength(1);
    const clauseExcerpts = strayAccentMatch[0]!.snippets
      .filter((s) => s.kind === 'clause')
      .map((s) => s.excerpt);
    expect(clauseExcerpts.sort()).toEqual(['Only Explanation', 'Only Title']);
    expect(clauseExcerpts.some((e) => e.startsWith(':') || e.endsWith(':'))).toBe(false);
  });
});
