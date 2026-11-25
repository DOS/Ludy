// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_HEADER, type HrCvExtractDraft } from '@ludy/kernel-contract';

vi.mock('../src/lib/auth.ts', () => ({
  accessToken: vi.fn(async () => 'test-token'),
  afterMfaRefusal: vi.fn(),
  auth: vi.fn(),
  getConfig: vi.fn(() => ({ uploads: 'local' })),
  secondFactorStillOwed: vi.fn(async () => false),
}));

vi.mock('../src/lib/api-base.ts', () => ({
  apiUrl: (path: string) => `http://localhost${path}`,
  serverOrigin: () => 'http://localhost',
}));

const { extractRecruitingCv, setCurrentOrg } = await import('../src/lib/api.ts');

const JOB_ID = '00000000-0000-7000-8000-000000000444';
const SAMPLE_DRAFT: HrCvExtractDraft = {
  openingId: null,
  openingTitle: null,
  displayName: 'Nguyễn Văn An',
  email: 'an.nguyen@example.com',
  phone: '0912345678',
  yearsExperience: 4,
  matchedSkills: ['Excel'],
  suggestedSource: 'direct',
  notes: 'Tóm tắt CV',
  aiSummary: null,
  sourceKind: 'pdf_text',
  extractedChars: 120,
  textPreview: 'Nguyễn Văn An',
  ai: { ok: false, reason: 'ai_off' },
  tainted: true,
  draftKind: 'proposal',
  autoSaved: false,
  autonomousDecision: 'none',
};

describe('extractRecruitingCv GET poll retries (#4446)', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    setCurrentOrg('org-alpha');
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = origFetch;
    setCurrentOrg(null);
  });

  it('retries temporary GET 500/UPLOAD_BUSY failures for the same jobId and snapped orgSlug', async () => {
    const seenUrls: string[] = [];
    const seenOrgs: Array<string | null> = [];
    let pollStep = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seenUrls.push(url);
      const hdrs = init?.headers as Record<string, string> | undefined;
      seenOrgs.push(hdrs?.[ORG_HEADER] ?? null);

      if (url.endsWith('/api/hr/recruiting/cv-extract')) {
        // Simulate switching active org right after initial POST submission.
        setCurrentOrg('org-beta');
        return new Response(JSON.stringify({ status: 'pending', jobId: JOB_ID }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }

      pollStep += 1;
      if (pollStep === 1) {
        return new Response(JSON.stringify({ code: 'INTERNAL', message: 'Audit failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pollStep === 2) {
        return new Response(JSON.stringify({ code: 'UPLOAD_BUSY', message: 'Busy' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pollStep === 3) {
        throw new TypeError('Failed to fetch');
      }
      return new Response(JSON.stringify({ status: 'ready', jobId: JOB_ID, draft: SAMPLE_DRAFT }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf', { type: 'application/pdf' });
    const promise = extractRecruitingCv(file, { useAi: false });
    await vi.runAllTimersAsync();
    const draft = await promise;

    expect(draft).toEqual(SAMPLE_DRAFT);
    expect(seenUrls).toHaveLength(5);
    expect(seenUrls.slice(1)).toEqual([
      `http://localhost/api/hr/recruiting/cv-extract/${JOB_ID}?useAi=false`,
      `http://localhost/api/hr/recruiting/cv-extract/${JOB_ID}?useAi=false`,
      `http://localhost/api/hr/recruiting/cv-extract/${JOB_ID}?useAi=false`,
      `http://localhost/api/hr/recruiting/cv-extract/${JOB_ID}?useAi=false`,
    ]);
    expect(seenOrgs).toEqual(['org-alpha', 'org-alpha', 'org-alpha', 'org-alpha', 'org-alpha']);
  });

  it('surfaces auth, scope, and terminal extraction errors immediately without retrying', async () => {
    for (const errCase of [
      { status: 401, code: 'UNAUTHORIZED', message: 'Session expired' },
      { status: 403, code: 'FORBIDDEN', message: 'Forbidden' },
      { status: 404, code: 'MODULE_OFF', message: 'HR disabled' },
      { status: 422, code: 'HR_CV_EXTRACT_FAILED', message: 'Corrupt PDF' },
    ]) {
      let pollCalls = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/hr/recruiting/cv-extract')) {
          return new Response(JSON.stringify({ status: 'pending', jobId: JOB_ID }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        }
        pollCalls += 1;
        return new Response(JSON.stringify({ code: errCase.code, message: errCase.message }), {
          status: errCase.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf', { type: 'application/pdf' });
      const promise = extractRecruitingCv(file);
      const rejection = expect(promise).rejects.toMatchObject({ status: errCase.status, code: errCase.code });
      await vi.runAllTimersAsync();
      await rejection;
      expect(pollCalls).toBe(1);
    }
  });

  it('aborts hung GET polls at the remaining 20s deadline via AbortSignal (#4487)', async () => {
    const pollSignals: AbortSignal[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/hr/recruiting/cv-extract')) {
        return new Response(JSON.stringify({ status: 'pending', jobId: JOB_ID }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      const signal = init?.signal;
      expect(signal).toBeDefined();
      if (signal) pollSignals.push(signal);
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf', { type: 'application/pdf' });
    const settled = extractRecruitingCv(file).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(21_000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ name: 'ClientError', message: 'hrRecruiting.cvExtract.timedOut' });
    }
    expect(pollSignals).toHaveLength(1);
    expect(pollSignals[0]!.aborted).toBe(true);
  });
});
