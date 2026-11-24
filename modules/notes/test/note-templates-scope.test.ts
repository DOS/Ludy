// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for whole-org legal-entity scope guards on notes.template.create/update/delete (#4229).
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
import type { CommandContext } from '@ludy/kernel-runtime';
import { noteTemplateCreate, noteTemplateDelete, noteTemplateUpdate } from '../src/notes.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const AUTHOR = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000003';
const TPL_ID = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-24T12:00:00.000Z');

function createFakeTrx(opts: {
  wholeOrg: boolean;
  templateRow?: {
    id: string;
    author_user_id: string;
    visibility: 'private' | 'org';
    name: string;
    title: string;
    body: string;
    tags: string[];
    revision: number;
    created_at: Date;
    updated_at: Date;
  };
}): { trx: Transaction<Database>; writes: CompiledQuery[] } {
  const writes: CompiledQuery[] = [];
  const conn: DatabaseConnection = {
    executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
      const sqlText = compiled.sql.toLowerCase();
      if (sqlText.includes('ctx_le_scope')) {
        return { rows: [{ whole: opts.wholeOrg }] } as QueryResult<R>;
      }
      if (sqlText.startsWith('insert into') || sqlText.startsWith('update ') || sqlText.startsWith('delete from')) {
        writes.push(compiled);
        return { rows: [{ id: TPL_ID, visibility: 'private', revision: (opts.templateRow?.revision ?? 0) + 1 }] } as QueryResult<R>;
      }
      if (sqlText.includes('from "ludy_notes"."note_template"')) {
        return { rows: opts.templateRow ? [opts.templateRow] : [] } as QueryResult<R>;
      }
      return { rows: [] } as QueryResult<R>;
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
  return { trx: db as unknown as Transaction<Database>, writes };
}

function makeCtx(trx: Transaction<Database>, userId: string, role: MemberRole): CommandContext {
  return {
    orgId: ORG,
    role,
    now: NOW,
    actor: { type: 'user', userId, aal: 'aal1' },
    audit: () => {},
    trx,
  } as unknown as CommandContext;
}

describe('notes.template whole-org legal-entity scope guards (#4229)', () => {
  it('blocks branch-scoped notes.template.create with visibility=org before writing, while allowing private', async () => {
    const scoped = createFakeTrx({ wholeOrg: false });
    await expect(
      noteTemplateCreate.handler(makeCtx(scoped.trx, AUTHOR, 'member'), {
        name: 'Mau chung',
        title: '',
        body: '',
        tags: [],
        visibility: 'org',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(scoped.writes).toHaveLength(0);

    const priv = await noteTemplateCreate.handler(makeCtx(scoped.trx, AUTHOR, 'member'), {
      name: 'Mau rieng',
      title: '',
      body: '',
      tags: [],
      visibility: 'private',
    });
    expect(priv).toEqual({ templateId: TPL_ID, revision: 1 });
    expect(scoped.writes).toHaveLength(1);

    const whole = createFakeTrx({ wholeOrg: true });
    const shared = await noteTemplateCreate.handler(makeCtx(whole.trx, AUTHOR, 'member'), {
      name: 'Mau chung',
      title: '',
      body: '',
      tags: [],
      visibility: 'org',
    });
    expect(shared).toEqual({ templateId: TPL_ID, revision: 1 });
    expect(whole.writes).toHaveLength(1);
  });

  it('blocks branch-scoped notes.template.update to visibility=org before locking, while allowing author demotion to private', async () => {
    const baseRow = {
      id: TPL_ID,
      author_user_id: AUTHOR,
      visibility: 'private' as const,
      name: 'Mau cu',
      title: '',
      body: '',
      tags: [],
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
    };
    const scoped = createFakeTrx({ wholeOrg: false, templateRow: baseRow });
    await expect(
      noteTemplateUpdate.handler(makeCtx(scoped.trx, AUTHOR, 'member'), {
        templateId: TPL_ID,
        revision: 1,
        name: 'Nang cap org',
        title: '',
        body: '',
        tags: [],
        visibility: 'org',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(scoped.writes).toHaveLength(0);

    const scopedOrgRow = createFakeTrx({ wholeOrg: false, templateRow: { ...baseRow, visibility: 'org' } });
    const demoted = await noteTemplateUpdate.handler(makeCtx(scopedOrgRow.trx, AUTHOR, 'member'), {
      templateId: TPL_ID,
      revision: 1,
      name: 'Thu ve rieng',
      title: '',
      body: '',
      tags: [],
      visibility: 'private',
    });
    expect(demoted).toEqual({ templateId: TPL_ID, revision: 2 });
    expect(scopedOrgRow.writes).toHaveLength(1);

    // Non-author admin without whole-org scope is also denied management by assertMayManageTemplate.
    const scopedAdmin = createFakeTrx({ wholeOrg: false, templateRow: { ...baseRow, visibility: 'org' } });
    await expect(
      noteTemplateDelete.handler(makeCtx(scopedAdmin.trx, ADMIN, 'admin'), { templateId: TPL_ID }),
    ).rejects.toMatchObject({ code: 'NOTE_TEMPLATE_AUTHOR_ONLY', status: 403 });
    expect(scopedAdmin.writes).toHaveLength(0);
  });
});
