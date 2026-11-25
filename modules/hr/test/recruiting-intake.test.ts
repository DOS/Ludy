// SPDX-License-Identifier: AGPL-3.0-only
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
import type { Database } from '@ludy/db';
import type { CommandContext, QueryContext } from '@ludy/kernel-runtime';
import {
  buildCvExtractDraft,
  cvExtractCompleteCommand,
  cvExtractContextQuery,
  cvExtractRequestCommand,
  inferSuggestedSource,
} from '../src/recruiting-intake.ts';

describe('modules/hr recruiting-intake Stage 5D (#4446)', () => {
  it('validates exact allowed URL hostnames, hostname 253/254 bounds, and 200k-dot inputs without ReDoS (CWE-1333)', async () => {
    expect(inferSuggestedSource('Profile: https://zalo.me./contact')).toBe('zalo_oa');
    expect(inferSuggestedSource('Profile: https://m.fb.com/candidate')).toBe('facebook');
    expect(inferSuggestedSource('Profile: https://evil.example/?next=fb.com')).toBe('direct');

    const mkHost = (prefixLen: number, suffix: string) => {
      const labels: string[] = [];
      let rem = prefixLen;
      while (rem > 0) {
        const take = Math.min(60, rem);
        labels.push('a'.repeat(take));
        rem -= take;
        if (rem > 0) rem -= 1; // dot separator
      }
      return `${labels.join('.')}.${suffix}`;
    };
    const domain253 = mkHost(253 - 'zalo.me'.length - 1, 'zalo.me');
    const domain254 = `${mkHost(253 - 'zalo.me'.length - 1, 'zalo.me')}.`;
    const domainOver254 = `${mkHost(254 - 'zalo.me'.length - 1, 'zalo.me')}`;
    expect(domain253.length).toBe(253);
    expect(domain254.length).toBe(254);
    expect(domainOver254.length).toBe(254); // without trailing dot -> > 253 stripped
    expect(inferSuggestedSource(`https://${domain253}/u`)).toBe('zalo_oa');
    expect(inferSuggestedSource(`https://${domain254}/u`)).toBe('zalo_oa');
    expect(inferSuggestedSource(`https://${domainOver254}/u`)).toBe('direct');

    const hostileUrlText = `http://${'.'.repeat(199_000)}a/`;
    expect(inferSuggestedSource(hostileUrlText)).toBe('direct');

    const draft = await buildCvExtractDraft({
      text: hostileUrlText,
      sourceKind: 'pdf_text',
      openingId: null,
      openingTitle: null,
      requiredSkills: ['MISA AMIS', 'Excel'],
    });
    expect(draft.suggestedSource).toBe('direct');
    expect(draft.email).toBeNull();
  });

  it('persists useAi=false in request audit and normalizes UUID case in cv_extract context queries', async () => {
    const orgId = '0195f0a0-0000-7000-8000-000000000001';
    const entityId = '0195f0a0-0000-7000-8000-000000000010';
    const openingId = '0195f0a0-0000-7000-8000-000000000020';
    const otherOpeningId = '0195f0a0-0000-7000-8000-000000000021';
    const jobId = '0195f0a0-0000-7000-8000-000000000030';
    const inputSha = 'a'.repeat(64);
    const resultSha = 'b'.repeat(64);

    let storedUseAi = false;
    let storedEntity = entityId.toUpperCase();
    const createFakeTrx = (mode: 'request' | 'context') => {
      const conn: DatabaseConnection = {
        executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
          const text = compiled.sql;
          if (mode === 'request') {
            if (text.includes('job_opening')) {
              return {
                rows: [{ id: openingId, legal_entity_id: entityId, title: 'Kế toán', required_skills: ['MISA'], status: 'open' }],
              } as unknown as QueryResult<R>;
            }
            if (text.includes('legal_entity')) {
              return { rows: [{ id: entityId }] } as unknown as QueryResult<R>;
            }
            return { rows: [] } as unknown as QueryResult<R>;
          }
          if (text.includes('audit_event')) {
            return {
              rows: [
                {
                  command: 'hr.recruiting.cv_extract.request',
                  input_sha256: inputSha,
                  legal_entity_id: storedEntity,
                  opening_id: openingId,
                  use_ai: storedUseAi ? 'true' : 'false',
                  result_sha256: null,
                  complete_ok: null,
                  complete_error_code: null,
                },
                {
                  command: 'hr.recruiting.cv_extract.complete',
                  input_sha256: null,
                  legal_entity_id: null,
                  opening_id: null,
                  use_ai: null,
                  result_sha256: resultSha,
                  complete_ok: 'true',
                  complete_error_code: null,
                },
              ],
            } as unknown as QueryResult<R>;
          }
          if (text.includes('job_opening')) {
            return {
              rows: [{ id: openingId, legal_entity_id: entityId, title: 'Kế toán', required_skills: ['MISA'], status: 'open' }],
            } as unknown as QueryResult<R>;
          }
          if (text.includes('legal_entity')) {
            return { rows: [{ id: entityId }] } as unknown as QueryResult<R>;
          }
          return { rows: [] } as unknown as QueryResult<R>;
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
      return new Kysely<Database>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => driver,
          createIntrospector: (inst) => new PostgresIntrospector(inst),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      }) as unknown as Transaction<Database>;
    };

    const audits: Array<Record<string, unknown>> = [];
    const reqCtx = {
      trx: createFakeTrx('request'),
      orgId,
      actor: { type: 'user', userId: 'u1', aal: 'aal1', sessionId: 's1' },
      role: 'admin',
      emit: () => {},
      audit: (detail: Record<string, unknown>) => audits.push(detail),
    } as unknown as CommandContext;

    const reqRes = await cvExtractRequestCommand.handler(reqCtx, {
      jobId,
      kind: 'pdf_text',
      legalEntityId: entityId.toUpperCase(),
      openingId,
      sizeBytes: 1024,
      sha256: inputSha,
      useAi: false,
    });
    expect(reqRes.useAi).toBe(false);
    expect(audits[0]?.useAi).toBe(false);

    const qCtx = {
      trx: createFakeTrx('context'),
      orgId,
      actor: { type: 'user', userId: 'u1', aal: 'aal1', sessionId: 's1' },
      role: 'admin',
    } as unknown as QueryContext;

    // Uppercase UUID inputs must match stored entityId/openingId case-insensitively and still surface stored useAi=false.
    const ctxRes = await cvExtractContextQuery.handler(qCtx, {
      jobId,
      legalEntityId: entityId.toLowerCase(),
      openingId: openingId.toUpperCase(),
    });
    expect(ctxRes.useAi).toBe(false);
    expect(ctxRes.openingId).toBe(openingId);

    // Mismatched UUIDs must still throw HR_CANDIDATE_WRONG_ENTITY.
    storedUseAi = true;
    storedEntity = entityId;
    await expect(
      cvExtractContextQuery.handler(qCtx, { jobId, openingId: otherOpeningId }),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_WRONG_ENTITY', status: 422 });
  });

  it('prevents a late ok:false dead-letter completion from overriding an earlier ok:true completion (#4487)', async () => {
    const orgId = '00000000-0000-7000-8000-000000000010';
    const entityId = '00000000-0000-7000-8000-000000000011';
    const jobId = '00000000-0000-7000-8000-000000000099';
    const inputSha = 'a'.repeat(64);
    const resultSha = 'b'.repeat(64);

    const completeAudits: Array<Record<string, unknown>> = [];
    const makeTrx = (withPriorSuccess: boolean) => {
      const conn: DatabaseConnection = {
        executeQuery: async <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
          const text = q.sql;
          if (text.includes('detail ->> \'ok\' = \'true\'')) {
            return { rows: withPriorSuccess ? [{ id: '1' }] : [] } as unknown as QueryResult<R>;
          }
          if (text.includes('ludy_kernel.audit_event')) {
            return {
              rows: [
                // Simulate a stale failure row arriving newest first alongside an older ok:true row.
                {
                  command: 'hr.recruiting.cv_extract.complete',
                  input_sha256: null,
                  legal_entity_id: null,
                  opening_id: null,
                  use_ai: null,
                  result_sha256: null,
                  complete_ok: 'false',
                  complete_error_code: 'HR_CV_EXTRACT_FAILED',
                },
                {
                  command: 'hr.recruiting.cv_extract.complete',
                  input_sha256: null,
                  legal_entity_id: null,
                  opening_id: null,
                  use_ai: null,
                  result_sha256: resultSha,
                  complete_ok: 'true',
                  complete_error_code: null,
                },
                {
                  command: 'hr.recruiting.cv_extract.request',
                  input_sha256: inputSha,
                  legal_entity_id: entityId,
                  opening_id: null,
                  use_ai: 'true',
                  result_sha256: null,
                  complete_ok: null,
                  complete_error_code: null,
                },
              ],
            } as unknown as QueryResult<R>;
          }
          if (text.includes('legal_entity')) {
            return { rows: [{ id: entityId }] } as unknown as QueryResult<R>;
          }
          return { rows: [] } as unknown as QueryResult<R>;
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
      return new Kysely<Database>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => driver,
          createIntrospector: (inst) => new PostgresIntrospector(inst),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      }) as unknown as Transaction<Database>;
    };

    await cvExtractCompleteCommand.handler(
      {
        trx: makeTrx(true),
        orgId,
        actor: { type: 'system', component: 'hr.cv_extract' },
        emit: () => {},
        audit: (detail: Record<string, unknown>) => completeAudits.push(detail),
      } as unknown as CommandContext,
      { jobId, ok: false, resultSha256: null, errorCode: 'HR_CV_EXTRACT_FAILED' },
    );
    expect(completeAudits).toEqual([{ jobId, skippedLateFailure: true }]);

    const resolved = await cvExtractContextQuery.handler(
      {
        trx: makeTrx(true),
        orgId,
        actor: { type: 'user', userId: 'u1', aal: 'aal1', sessionId: 's1' },
        role: 'admin',
      } as unknown as QueryContext,
      { jobId },
    );
    expect(resolved.resultSha256).toBe(resultSha);
    expect(resolved.failedCode).toBeNull();
  });
});
