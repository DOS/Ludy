// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the recording import (meetings integrations C1, issue #3173), every minute in the worker. Three steps, none of which downloads a recording:
//   1. The recordings a member chose to import (status `importing`) are handed to the queue, one job each (meetings-import.ts downloads them).
//   2. Expiry: what the member did not claim within 55 minutes, a claim that never finished, a download that never ended, and suggestions past 14 days; the staging bytes of what failed are deleted.
//   3. The suggestions: each active connection that is due (never listed, or last listed 10 minutes ago, or the member asked to refresh) is asked for the recordings its platform finished in the last
//      14 days, through its adapter, and the answer replaces the connection's suggestions. A platform's notice or this list only SUGGESTS; the click alone starts a download.
// A failure for one row or connection never stops the others; a connection that cannot be listed gets a short code and waits 10 minutes (the platform refusing its token expires it).
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { MeetingPlatformError, type MeetingPlatformAdapter } from '@crove/channel';
import { MEETING_PLATFORM_LIST_DAYS, meetingPlatformBinding, type MeetingPlatformProvider } from '@crove/kernel-contract';
import { DomainError, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import type { MeetingsImportJob } from './meetings-import.ts';

export const MEETINGS_IMPORT_SWEEP_CRON = '* * * * *';
export const MEETINGS_IMPORT_SWEEP_EXPIRE_SECONDS = 120;
// Rows and connections one pass handles at most; the rest wait for the next minute.
const OPEN_PER_PASS = 200;
const CONNECTIONS_PER_PASS = 50;

const ACTOR = { type: 'system' as const, component: 'meetings.import' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface MeetingsImportSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  broker: CredentialBroker;
  store: BlobStore;
  adapters: Readonly<Partial<Record<string, MeetingPlatformAdapter>>>;
  // Hands one recording to the kernel-meeting-import queue (a singleton job per recording).
  send: (job: MeetingsImportJob) => Promise<unknown>;
  now?: () => Date;
}

interface OpenRow {
  org_id: string;
  id: string;
  connection_id: string;
  provider: MeetingPlatformProvider;
  external_id: string;
  has_audio: boolean;
  has_video: boolean;
  size_bytes: string | null;
  staging_key: string;
}

export async function runMeetingsImportSweep(deps: MeetingsImportSweepDeps): Promise<{ handedOver: number; expired: number; listed: number; failures: number }> {
  const done = { handedOver: 0, expired: 0, listed: 0, failures: 0 };
  const now = deps.now ?? (() => new Date());

  const open = await sql<OpenRow>`SELECT org_id, id, connection_id, provider, external_id, has_audio, has_video, size_bytes, staging_key FROM crove_kernel.meeting_platform_import_open(${OPEN_PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of open.rows) {
    try {
      await deps.send({
        orgId: row.org_id,
        id: row.id,
        connectionId: row.connection_id,
        provider: row.provider,
        externalId: row.external_id,
        hasAudio: row.has_audio,
        hasVideo: row.has_video,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        stagingKey: row.staging_key,
      });
      done.handedOver += 1;
    } catch (error) {
      done.failures += 1;
      console.warn(`[meetings-import-sweep] recording ${row.id.slice(0, 8)} not handed over`, codeOf(error));
    }
  }

  // Expiry: the definer fails what is overdue and returns the staging keys whose bytes must go.
  try {
    const expired = await sql<{ staging_key: string }>`SELECT staging_key FROM crove_kernel.meeting_platform_recording_sweep()`.execute(deps.workerDb);
    for (const row of expired.rows) {
      await deps.store.delete(row.staging_key).catch((error) => console.warn('[meetings-import-sweep] staged bytes not deleted', codeOf(error)));
      done.expired += 1;
    }
  } catch (error) {
    done.failures += 1;
    console.warn('[meetings-import-sweep] expiry', codeOf(error));
  }

  // The suggestions of the connections that are due.
  const due = await sql<{ org_id: string; connection_id: string; provider: MeetingPlatformProvider }>`SELECT org_id, connection_id, provider FROM crove_kernel.meeting_platform_sync_due(NULL::uuid, NULL::uuid, ${CONNECTIONS_PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of due.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    const adapter = deps.adapters[row.provider];
    try {
      if (!adapter) throw new MeetingPlatformError('platform_unavailable');
      const sealed = await deps.runtime.query<{ keyId: string; envelope: string; provider: string; externalAccount: string }>('kernel.meeting_platform.credential', { connectionId: row.connection_id }, ctx);
      const secret = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, meetingPlatformBinding(row.org_id, sealed.provider as MeetingPlatformProvider, sealed.externalAccount));
      const parsed = JSON.parse(secret) as { accessToken?: unknown; refreshToken?: unknown };
      if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') throw new MeetingPlatformError('connection_expired');
      const since = new Date(now().getTime() - MEETING_PLATFORM_LIST_DAYS * 86_400_000);
      const listed = await adapter.list({ accessToken: parsed.accessToken, ...(typeof parsed.refreshToken === 'string' ? { refreshToken: parsed.refreshToken } : {}) }, since);
      await deps.runtime.execute('kernel.meeting_platform.recording_replace', { connectionId: row.connection_id, rows: listed.slice(0, 100) }, ctx);
      done.listed += 1;
    } catch (error) {
      done.failures += 1;
      const code = error instanceof MeetingPlatformError ? error.code : error instanceof DomainError && /MEETING_PLATFORM_(NOT_ACTIVE|OWNER_LEFT)/.test(error.code) ? 'connection_expired' : 'platform_unavailable';
      console.warn(`[meetings-import-sweep] connection ${row.connection_id.slice(0, 8)} not listed`, codeOf(error));
      await deps.runtime
        .execute('kernel.meeting_platform.sync_failed', { connectionId: row.connection_id, code, expired: code === 'connection_expired' }, ctx)
        .catch((inner) => console.warn('[meetings-import-sweep] could not record the failure', codeOf(inner)));
    }
  }
  return done;
}
