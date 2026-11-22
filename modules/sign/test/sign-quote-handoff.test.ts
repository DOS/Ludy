// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for sign.envelope.by_source priority/filtering and sign.envelope.completed non-PII outbox emission (#3512).
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
import {
  SIGN_BY_SOURCE_MAX,
  zSignEnvelopeBySourceInput,
  zSignEnvelopeBySourceResult,
} from '@ludy/kernel-contract';
import { eventPayloadProblem, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { envelopeSealComplete } from '../src/commands.ts';
import { envelopeBySource, selectLatestEnvelopesBySource, type SourceEnvelopeCandidate } from '../src/queries.ts';

const ORG_ID = '01900000-0000-7000-8000-000000000010';
const USER_ID = '01900000-0000-7000-8000-000000000020';
const QUOTE_1 = '01900000-0000-7000-8000-000000000101';
const QUOTE_2 = '01900000-0000-7000-8000-000000000102';
const QUOTE_3 = '01900000-0000-7000-8000-000000000103';
const QUOTE_MISSING = '01900000-0000-7000-8000-000000000199';
const ENV_1 = '01900000-0000-7000-8000-000000000201';
const ENV_2 = '01900000-0000-7000-8000-000000000202';
const ENV_3 = '01900000-0000-7000-8000-000000000203';
const ENV_4 = '01900000-0000-7000-8000-000000000204';
const ENV_5 = '01900000-0000-7000-8000-000000000205';
const SOURCE_FILE_ID = '01900000-0000-7000-8000-000000000301';
const SEALED_FILE_ID = '01900000-0000-7000-8000-000000000302';
const CERT_FILE_ID = '01900000-0000-7000-8000-000000000303';

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
      throw new Error('streamQuery not implemented in unit test');
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

function makeQueryCtx(trx: Transaction<Database>, actorType: 'user' | 'system' = 'user'): QueryContext {
  return {
    trx,
    orgId: ORG_ID,
    actor:
      actorType === 'user'
        ? { type: 'user', userId: USER_ID, aal: 'aal2', sessionId: 'sess-1' }
        : { type: 'system', component: 'sign-worker' },
    role: actorType === 'user' ? 'member' : null,
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

function makeCommandCtx(
  trx: Transaction<Database>,
  emitted: Array<{ type: string; payload: Record<string, unknown> }>,
): CommandContext {
  return {
    ...makeQueryCtx(trx, 'system'),
    commandId: '01900000-0000-7000-8000-000000000900',
    proposalId: null,
    now: new Date('2026-11-16T10:00:00.000Z'),
    build: 'test',
    emit: async (type: string, payload: Record<string, unknown>) => {
      const problem = eventPayloadProblem(payload, type);
      if (problem) throw new Error(`Invalid event payload: ${problem}`);
      emitted.push({ type, payload });
      return '01900000-0000-7000-8000-000000000901';
    },
    activity: async () => {},
    audit: () => {},
    permissionEntity: () => {},
    seal: async () => '',
    run: async () => ({}),
    tryRun: async () => ({ status: 'ok', result: {} }),
    defer: () => {},
  } as unknown as CommandContext;
}

describe('sign.envelope.by_source (#3512)', () => {
  it('prefers latest non-voided over voided and falls back to latest voided when only voided exist', () => {
    const candidates: SourceEnvelopeCandidate[] = [
      // QUOTE_1: voided envelope is newer than completed envelope -> completed still wins
      {
        id: ENV_1,
        title: 'Quote 1 Completed',
        status: 'completed',
        source_id: QUOTE_1,
        seal_status: 'sealed',
        certificate_code: 'CS-1111-2222-3333',
        completed_at: '2026-11-15T09:00:00.000Z',
        created_at: '2026-11-15T08:00:00.000Z',
        updated_at: '2026-11-15T09:05:00.000Z',
      },
      {
        id: ENV_2,
        title: 'Quote 1 Voided Later',
        status: 'voided',
        source_id: QUOTE_1,
        seal_status: null,
        certificate_code: null,
        completed_at: null,
        created_at: '2026-11-16T08:00:00.000Z',
        updated_at: '2026-11-16T08:30:00.000Z',
      },
      // QUOTE_2: older declined vs newer draft -> draft wins
      {
        id: ENV_3,
        title: 'Quote 2 Declined',
        status: 'declined',
        source_id: QUOTE_2,
        seal_status: null,
        certificate_code: null,
        completed_at: null,
        created_at: '2026-11-15T07:00:00.000Z',
        updated_at: '2026-11-15T07:30:00.000Z',
      },
      {
        id: ENV_4,
        title: 'Quote 2 New Draft',
        status: 'draft',
        source_id: QUOTE_2,
        seal_status: null,
        certificate_code: null,
        completed_at: null,
        created_at: '2026-11-16T07:00:00.000Z',
        updated_at: '2026-11-16T07:00:00.000Z',
      },
      // QUOTE_3: only voided exists -> picks latest voided
      {
        id: ENV_5,
        title: 'Quote 3 Voided Only',
        status: 'voided',
        source_id: QUOTE_3,
        seal_status: null,
        certificate_code: null,
        completed_at: null,
        created_at: '2026-11-16T06:00:00.000Z',
        updated_at: '2026-11-16T06:10:00.000Z',
      },
    ];

    const picked = selectLatestEnvelopesBySource(candidates, [QUOTE_MISSING, QUOTE_2, QUOTE_1, QUOTE_2, QUOTE_3]);
    expect(picked.map((r) => [r.source_id, r.id, r.status])).toEqual([
      [QUOTE_2, ENV_4, 'draft'],
      [QUOTE_1, ENV_1, 'completed'],
      [QUOTE_3, ENV_5, 'voided'],
    ]);
  });

  it('executes query with org/source filters, excludes cc signers from counts, and validates output contract', async () => {
    const { trx, queries } = createFakeTrx((compiled) => {
      if (compiled.sql.includes('"crove_sign"."envelope"')) {
        return {
          rows: [
            {
              id: ENV_1,
              title: 'BG-2026-0001 - Cong ty ABC',
              status: 'in_progress',
              source_id: QUOTE_1,
              seal_status: null,
              certificate_code: null,
              completed_at: null,
              created_at: new Date('2026-11-16T01:00:00.000Z'),
              updated_at: new Date('2026-11-16T02:00:00.000Z'),
            },
            {
              id: ENV_2,
              title: 'BG-2026-0001 - Voided',
              status: 'voided',
              source_id: QUOTE_1,
              seal_status: null,
              certificate_code: null,
              completed_at: null,
              created_at: new Date('2026-11-16T03:00:00.000Z'),
              updated_at: new Date('2026-11-16T03:05:00.000Z'),
            },
            {
              id: ENV_3,
              title: 'BG-2026-0002 - Cong ty XYZ',
              status: 'completed',
              source_id: QUOTE_2,
              seal_status: 'sealed',
              sealed_file_id: SEALED_FILE_ID,
              certificate_code: 'CS-ABCD-EFGH-1234',
              completed_at: new Date('2026-11-16T04:00:00.000Z'),
              created_at: new Date('2026-11-16T01:00:00.000Z'),
              updated_at: new Date('2026-11-16T04:05:00.000Z'),
            },
          ],
        };
      }
      if (compiled.sql.includes('"crove_sign"."signer"')) {
        return {
          rows: [
            { envelope_id: ENV_1, status: 'signed' },
            { envelope_id: ENV_1, status: 'pending' },
            { envelope_id: ENV_3, status: 'signed' },
          ],
        };
      }
      return { rows: [] };
    });

    const input = zSignEnvelopeBySourceInput.parse({
      sourceKind: 'crm_quote',
      sourceIds: [QUOTE_1, QUOTE_MISSING, QUOTE_2, QUOTE_1],
    });
    const result = await envelopeBySource.handler(makeQueryCtx(trx), input);

    expect(zSignEnvelopeBySourceResult.safeParse(result).success).toBe(true);
    expect(result.items).toEqual([
      {
        sourceId: QUOTE_1,
        envelopeId: ENV_1,
        title: 'BG-2026-0001 - Cong ty ABC',
        status: 'in_progress',
        sealStatus: null,
        sealedFileId: null,
        certificateCode: null,
        completedAt: null,
        signerCount: 2,
        signedCount: 1,
        createdAt: '2026-11-16T01:00:00.000Z',
        updatedAt: '2026-11-16T02:00:00.000Z',
      },
      {
        sourceId: QUOTE_2,
        envelopeId: ENV_3,
        title: 'BG-2026-0002 - Cong ty XYZ',
        status: 'completed',
        sealStatus: 'sealed',
        sealedFileId: SEALED_FILE_ID,
        certificateCode: 'CS-ABCD-EFGH-1234',
        completedAt: '2026-11-16T04:00:00.000Z',
        signerCount: 1,
        signedCount: 1,
        createdAt: '2026-11-16T01:00:00.000Z',
        updatedAt: '2026-11-16T04:05:00.000Z',
      },
    ]);

    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain('"org_id" = $1');
    expect(queries[0]!.sql).toContain('"source_kind" = $2');
    expect(queries[0]!.sql).toContain('"source_id" is not null');
    expect(queries[1]!.sql).toContain('"signer_role" != $');
    expect(queries[1]!.parameters).toContain('cc');
  });

  it('short-circuits standalone sourceKind, enforces input limits, and rejects non-user actors', async () => {
    const { trx, queries } = createFakeTrx(() => ({ rows: [] }));
    const standalone = await envelopeBySource.handler(makeQueryCtx(trx), {
      sourceKind: 'standalone',
      sourceIds: [QUOTE_1],
    });
    expect(standalone).toEqual({ items: [] });
    expect(queries).toHaveLength(0);

    await expect(
      envelopeBySource.handler(makeQueryCtx(trx, 'system'), {
        sourceKind: 'crm_quote',
        sourceIds: [QUOTE_1],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    expect(zSignEnvelopeBySourceInput.safeParse({ sourceKind: 'crm_quote', sourceIds: [] }).success).toBe(false);
    expect(
      zSignEnvelopeBySourceInput.safeParse({
        sourceKind: 'crm_quote',
        sourceIds: Array.from({ length: SIGN_BY_SOURCE_MAX + 1 }, () => QUOTE_1),
      }).success,
    ).toBe(false);
  });
});

describe('sign.envelope.completed outbox event (#3512)', () => {
  it('emits sign.envelope.completed with IDs and hashes/codes only (zero PII) when seal_complete succeeds', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const sealedSha = 'b'.repeat(64);
    const certSha = 'c'.repeat(64);

    const { trx } = createFakeTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('select * from "crove_sign"."envelope"') && sqlLower.includes('for update')) {
        return {
          rows: [
            {
              id: ENV_1,
              org_id: ORG_ID,
              title: 'Bao gia BG-2026-0001 - Nguyen Van A',
              status: 'completed',
              seal_status: null,
              source_kind: 'crm_quote',
              source_id: QUOTE_1,
              source_file_id: SOURCE_FILE_ID,
              source_sha256: 'a'.repeat(64),
              completed_at: new Date('2026-11-16T09:59:00.000Z'),
              version: 3,
              created_by: USER_ID,
            },
          ],
        };
      }
      if (sqlLower.includes('from "ludy_kernel"."file"')) {
        const fileId = compiled.parameters[1];
        if (fileId === SEALED_FILE_ID) {
          return {
            rows: [
              {
                id: SEALED_FILE_ID,
                source: 'sign_sealed',
                storage_key: 'sealed/doc.pdf',
                generation: 'gen-1',
                sha256: sealedSha,
              },
            ],
          };
        }
        return {
          rows: [
            {
              id: CERT_FILE_ID,
              source: 'sign_certificate',
              storage_key: 'sealed/cert.json',
              generation: 'gen-2',
              sha256: certSha,
            },
          ],
        };
      }
      if (sqlLower.includes('from "crove_sign"."envelope"')) {
        return { rows: [{ id: ENV_1 }] };
      }
      if (sqlLower.includes('from "crove_sign"."signing_event"')) {
        return { rows: [{ seq: 3, event_hash: 'd'.repeat(64) }] };
      }
      if (sqlLower.includes('insert into "crove_sign"."signing_event"')) {
        return {
          rows: [
            {
              id: '01900000-0000-7000-8000-000000000801',
              seq: 4,
              prev_event_hash: 'd'.repeat(64),
              event_hash: 'e'.repeat(64),
              occurred_at: new Date('2026-11-16T10:00:00.000Z'),
            },
          ],
        };
      }
      if (sqlLower.includes('from "crove_sign"."signer"')) {
        return { rows: [{ signer_role: 'signer', email: 'buyer@example.com' }] };
      }
      if (sqlLower.includes('member_emails')) {
        return { rows: [{ email: 'seller@example.com' }] };
      }
      if (sqlLower.includes('from "ludy_kernel"."tenant"')) {
        return { rows: [{ name: 'Cong ty Co phan ABC' }] };
      }
      if (sqlLower.includes('mail_address_hash')) {
        return { rows: [{ hash: 'f'.repeat(64) }] };
      }
      if (sqlLower.includes('mail_suppression') || sqlLower.includes('from "ludy_kernel"."mail_event"')) {
        return { rows: [] };
      }
      return { rows: [{ id: '01900000-0000-7000-8000-000000000802' }] };
    });

    const out = await envelopeSealComplete.handler(makeCommandCtx(trx, emitted), {
      envelopeId: ENV_1,
      outcome: 'sealed',
      certificateCode: 'CS-ABCD-EFGH-1234',
      sealedFileId: SEALED_FILE_ID,
      certificateFileId: CERT_FILE_ID,
    });

    expect(out).toMatchObject({
      envelopeId: ENV_1,
      sealStatus: 'sealed',
      sealedFileId: SEALED_FILE_ID,
      certificateFileId: CERT_FILE_ID,
      certificateCode: 'CS-ABCD-EFGH-1234',
    });
    expect(emitted).toEqual([
      {
        type: 'sign.envelope.completed',
        payload: {
          envelopeId: ENV_1,
          sourceKind: 'crm_quote',
          sourceId: QUOTE_1,
          sealedFileId: SEALED_FILE_ID,
          sealedSha256: sealedSha,
          certificateCode: 'CS-ABCD-EFGH-1234',
        },
      },
    ]);
    expect(eventPayloadProblem(emitted[0]!.payload, 'sign.envelope.completed')).toBeNull();
  });

  it('does not emit sign.envelope.completed on idempotent replay or seal failure', async () => {
    const emittedReplay: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { trx: replayTrx } = createFakeTrx(() => ({
      rows: [
        {
          id: ENV_1,
          status: 'completed',
          seal_status: 'sealed',
          sealed_file_id: SEALED_FILE_ID,
          certificate_file_id: CERT_FILE_ID,
          certificate_code: 'CS-ABCD-EFGH-1234',
        },
      ],
    }));
    const replayRes = await envelopeSealComplete.handler(makeCommandCtx(replayTrx, emittedReplay), {
      envelopeId: ENV_1,
      outcome: 'sealed',
      certificateCode: 'CS-ABCD-EFGH-1234',
      sealedFileId: SEALED_FILE_ID,
      certificateFileId: CERT_FILE_ID,
    });
    expect(replayRes).toMatchObject({ sealStatus: 'sealed', idempotent: true });
    expect(emittedReplay).toEqual([]);

    const emittedFailed: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { trx: failTrx } = createFakeTrx((compiled) => {
      const sqlLower = compiled.sql.toLowerCase();
      if (sqlLower.includes('select * from "crove_sign"."envelope"') && sqlLower.includes('for update')) {
        return {
          rows: [
            {
              id: ENV_1,
              org_id: ORG_ID,
              status: 'completed',
              seal_status: null,
              source_sha256: 'a'.repeat(64),
              version: 3,
            },
          ],
        };
      }
      if (sqlLower.includes('from "crove_sign"."envelope"')) {
        return { rows: [{ id: ENV_1 }] };
      }
      if (sqlLower.includes('from "crove_sign"."signing_event"')) {
        return { rows: [] };
      }
      if (sqlLower.includes('insert into "crove_sign"."signing_event"')) {
        return {
          rows: [
            {
              id: '01900000-0000-7000-8000-000000000803',
              seq: 1,
              prev_event_hash: null,
              event_hash: 'f'.repeat(64),
              occurred_at: new Date('2026-11-16T10:00:00.000Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const failRes = await envelopeSealComplete.handler(makeCommandCtx(failTrx, emittedFailed), {
      envelopeId: ENV_1,
      outcome: 'failed',
      error: 'extract timeout',
    });
    expect(failRes).toMatchObject({ sealStatus: 'failed' });
    expect(emittedFailed).toEqual([]);
  });

  it('sends completion copies to CC and link-mode recipients on standard envelopes while blocking unverified direct-link relays (#3774)', async () => {
    const sealedSha = 'b'.repeat(64);
    const certSha = 'c'.repeat(64);
    const runSeal = async (opts: {
      directLinkId: string | null;
      originActorLabel: string;
      recipients: Array<{ signer_role: string; email: string | null; delivery_mode: string }>;
    }): Promise<string[]> => {
      const queuedTo: string[] = [];
      const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const { trx } = createFakeTrx((compiled) => {
        const sqlLower = compiled.sql.toLowerCase();
        if (sqlLower.includes('select * from "crove_sign"."envelope"') && sqlLower.includes('for update')) {
          return {
            rows: [
              {
                id: ENV_1,
                org_id: ORG_ID,
                title: 'Hop dong dich vu',
                status: 'completed',
                seal_status: null,
                source_kind: 'standalone',
                source_id: null,
                direct_link_id: opts.directLinkId,
                source_file_id: SOURCE_FILE_ID,
                source_sha256: 'a'.repeat(64),
                completed_at: new Date('2026-11-16T09:59:00.000Z'),
                version: 3,
                created_by: USER_ID,
              },
            ],
          };
        }
        if (sqlLower.includes('from "ludy_kernel"."file"')) {
          const fileId = compiled.parameters[1];
          return {
            rows: [
              fileId === SEALED_FILE_ID
                ? { id: SEALED_FILE_ID, source: 'sign_sealed', storage_key: 's/doc.pdf', generation: 'g1', sha256: sealedSha }
                : { id: CERT_FILE_ID, source: 'sign_certificate', storage_key: 's/cert.json', generation: 'g2', sha256: certSha },
            ],
          };
        }
        if (sqlLower.includes('from "crove_sign"."envelope"')) {
          return { rows: [{ id: ENV_1 }] };
        }
        if (sqlLower.includes('select "actor_label" from "crove_sign"."signing_event"')) {
          return { rows: [{ actor_label: opts.originActorLabel }] };
        }
        if (sqlLower.includes('from "crove_sign"."signing_event"')) {
          return { rows: [{ seq: 3, event_hash: 'd'.repeat(64) }] };
        }
        if (sqlLower.includes('insert into "crove_sign"."signing_event"')) {
          return {
            rows: [
              {
                id: '01900000-0000-7000-8000-000000000801',
                seq: 4,
                prev_event_hash: 'd'.repeat(64),
                event_hash: 'e'.repeat(64),
                occurred_at: new Date('2026-11-16T10:00:00.000Z'),
              },
            ],
          };
        }
        if (sqlLower.includes('from "crove_sign"."signer"')) {
          return { rows: opts.recipients };
        }
        if (sqlLower.includes('member_emails')) {
          return { rows: [{ email: 'sender@example.com' }] };
        }
        if (sqlLower.includes('from "ludy_kernel"."tenant"')) {
          return { rows: [{ name: 'Cong ty Co phan ABC' }] };
        }
        if (sqlLower.includes('mail_address_hash')) {
          return { rows: [{ hash: 'f'.repeat(64) }] };
        }
        if (sqlLower.includes('mail_suppression') || sqlLower.includes('from "ludy_kernel"."mail_event"')) {
          return { rows: [] };
        }
        if (sqlLower.includes('insert into "ludy_kernel"."mail_message"')) {
          const toParam = compiled.parameters.find(
            (p): p is string => typeof p === 'string' && p.includes('@') && !p.startsWith('<'),
          );
          if (toParam) queuedTo.push(toParam);
          return { rows: [{ id: '01900000-0000-7000-8000-000000000802' }] };
        }
        return { rows: [{ id: '01900000-0000-7000-8000-000000000802' }] };
      });

      await envelopeSealComplete.handler(makeCommandCtx(trx, emitted), {
        envelopeId: ENV_1,
        outcome: 'sealed',
        certificateCode: 'CS-ABCD-EFGH-1234',
        sealedFileId: SEALED_FILE_ID,
        certificateFileId: CERT_FILE_ID,
      });
      return queuedTo.sort();
    };

    // Standard tenant envelope: link-mode CC + link-mode signer + email-mode signer all receive completion copies.
    const standardRecipients = await runSeal({
      directLinkId: null,
      originActorLabel: `user:${USER_ID}`,
      recipients: [
        { signer_role: 'signer', email: 'zalo-signer@example.com', delivery_mode: 'link' },
        { signer_role: 'cc', email: 'cc-archive@example.com', delivery_mode: 'link' },
        { signer_role: 'approver', email: 'approver@example.com', delivery_mode: 'email' },
        { signer_role: 'cc', email: null, delivery_mode: 'link' },
      ],
    });
    expect(standardRecipients).toEqual([
      'approver@example.com',
      'cc-archive@example.com',
      'sender@example.com',
      'zalo-signer@example.com',
    ]);

    // Direct-link envelope: unverified link-mode signer gets ZERO mail; OTP-verified email-mode signer gets mail.
    const directUnverified = await runSeal({
      directLinkId: '01900000-0000-7000-8000-000000000901',
      originActorLabel: 'system:sign-direct-link',
      recipients: [{ signer_role: 'signer', email: 'victim@example.com', delivery_mode: 'link' }],
    });
    expect(directUnverified).toEqual(['sender@example.com']);

    const directOtpVerified = await runSeal({
      directLinkId: '01900000-0000-7000-8000-000000000901',
      originActorLabel: 'system:sign-direct-link',
      recipients: [{ signer_role: 'signer', email: 'verified@example.com', delivery_mode: 'email' }],
    });
    expect(directOtpVerified).toEqual(['sender@example.com', 'verified@example.com']);

    // Defense in depth: pruned direct-link row (direct_link_id IS NULL via ON DELETE SET NULL) still blocks relay.
    const directPruned = await runSeal({
      directLinkId: null,
      originActorLabel: 'system:sign-direct-link',
      recipients: [{ signer_role: 'signer', email: 'pruned-victim@example.com', delivery_mode: 'link' }],
    });
    expect(directPruned).toEqual(['sender@example.com']);
  });
});
