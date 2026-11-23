// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { ExtractClient } from '@ludy/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { hrCvBlobKey } from '@ludy/mod-hr';
import { runHrCvExtractJob } from '../src/hr-cv-worker.ts';

const ORG_ID = '00000000-0000-7000-8000-000000000001';
const JOB_ID = '00000000-0000-7000-8000-000000000077';

describe('runHrCvExtractJob appOn fail-closed gate (#4446)', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4\n%%EOF');
  const sha = sha256Hex(bytes);
  const storageKey = hrCvBlobKey(ORG_ID, sha);

  it('rethrows transient appOn lookup errors to queue retry before reading BlobStore or calling sandbox', async () => {
    const store = { get: vi.fn(), put: vi.fn() } as unknown as BlobStore;
    const extract = { extract: vi.fn() } as unknown as ExtractClient;
    const runtime = {
      appOn: vi.fn(async () => {
        throw new Error('pg pool timeout');
      }),
      execute: vi.fn(),
    } as unknown as Pick<Runtime, 'execute' | 'appOn'>;

    await expect(
      runHrCvExtractJob(
        { runtime, store, extract },
        { orgId: ORG_ID, jobId: JOB_ID, storageKey, kind: 'pdf_text', sha256: sha, sizeBytes: bytes.byteLength },
      ),
    ).rejects.toThrow('pg pool timeout');
    expect(store.get).not.toHaveBeenCalled();
    expect(extract.extract).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('returns MODULE_OFF cleanly without touching BlobStore or sandbox when hr is confirmed false', async () => {
    const store = { get: vi.fn(), put: vi.fn() } as unknown as BlobStore;
    const extract = { extract: vi.fn() } as unknown as ExtractClient;
    const runtime = {
      appOn: vi.fn(async () => false),
      execute: vi.fn(),
    } as unknown as Pick<Runtime, 'execute' | 'appOn'>;

    const res = await runHrCvExtractJob(
      { runtime, store, extract },
      { orgId: ORG_ID, jobId: JOB_ID, storageKey, kind: 'pdf_text', sha256: sha, sizeBytes: bytes.byteLength },
    );
    expect(res).toMatchObject({ jobId: JOB_ID, ok: false, errorCode: 'MODULE_OFF' });
    expect(store.get).not.toHaveBeenCalled();
    expect(extract.extract).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();
  });
});
