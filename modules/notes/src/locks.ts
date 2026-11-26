// SPDX-License-Identifier: AGPL-3.0-only
// Canonical PostgreSQL advisory transaction locks shared across notes, notebooks, to-dos, imports, and Vy commands.
import { sql } from 'kysely';
import type { QueryContext } from '@ludy/kernel-runtime';

export async function lockNotebook(ctx: Pick<QueryContext, 'trx' | 'orgId'>, notebookId: string, shared = false): Promise<void> {
  const lockKey = `notes.notebook:${ctx.orgId.toLowerCase()}:${notebookId.toLowerCase()}`;
  if (shared) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(ctx.trx);
  } else {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(ctx.trx);
  }
}

export async function lockNotebookReorder(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<void> {
  const lockKey = `notes.notebook.reorder:${ctx.orgId.toLowerCase()}`;
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(ctx.trx);
}

export async function lockNote(ctx: Pick<QueryContext, 'trx' | 'orgId'>, noteId: string, shared = false): Promise<void> {
  const lockKey = `notes.note:${ctx.orgId.toLowerCase()}:${noteId.toLowerCase()}`;
  if (shared) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(ctx.trx);
  } else {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`.execute(ctx.trx);
  }
}
