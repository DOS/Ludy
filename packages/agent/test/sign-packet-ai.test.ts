// SPDX-License-Identifier: AGPL-3.0-only
// Meter, zero-tools, 64 KiB proportional cap, and citation grounding tests for multi-document packet consistency (#4722).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiBudgetExhaustedError,
  AiMeterMissingError,
  SIGN_PACKET_CONSISTENCY_TEXT_BYTES,
  SignAiReader,
  checkSignPacketConsistency,
  signPacketConsistencyPrompt,
  withAiScope,
  type AiCall,
  type AiMeter,
  type AiUsage,
  type SignPacketConsistencyRequest,
} from '../src/index.ts';

const CONFIG = { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 };

const DOC_1_ID = '01900000-0000-7000-8000-000000000101';
const DOC_2_ID = '01900000-0000-7000-8000-000000000102';

const PACKET_REQUEST: SignPacketConsistencyRequest = {
  envelopeTitle: 'Bo ho so hop dong dich vu 2026',
  documents: [
    {
      documentId: DOC_1_ID,
      docIndex: 1,
      title: 'Hop dong chinh',
      pageCount: 2,
      pages: [
        { page: 1, text: 'Ben A: Cong ty TNHH Alpha\nBen B: Cong ty TNHH Beta\nNgay ky: 20/03/2026' },
        { page: 2, text: 'Tong gia tri hop dong: 120.000.000 VND (bao gom VAT).' },
      ],
      missingSignatureField: false,
    },
    {
      documentId: DOC_2_ID,
      docIndex: 2,
      title: 'Phu luc 01 - Bao gia chi tiet',
      pageCount: 1,
      pages: [
        { page: 1, text: 'Phu luc 01 kem theo Hop dong.\nTong cong thanh toan: 150.000.000 VND.' },
      ],
      missingSignatureField: true,
    },
  ],
};

function completion(content: unknown, promptTokens = 140, completionTokens = 70) {
  return {
    id: 'chatcmpl-packet-test',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(content) },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkSignPacketConsistency citation grounding (#4722)', () => {
  it('keeps grounded findings and drops hallucinated quotes, out-of-range pages, or unknown docIndex', () => {
    const res = checkSignPacketConsistency(PACKET_REQUEST, {
      summaryText: 'Phat hien chenh lech gia tri giua hop dong chinh va phu luc.',
      findings: [
        {
          kind: 'mismatched_total',
          severity: 'critical',
          title: 'Gia tri hop dong lech voi phu luc',
          explanation: 'Hop dong ghi 120.000.000 VND nhung phu luc ghi 150.000.000 VND.',
          docIndex: 2,
          documentTitle: 'Phu luc 01',
          pageNumber: 1,
          quoteExcerpt: 'Tong cong thanh toan: 150.000.000 VND.',
        },
        {
          kind: 'mismatched_date',
          severity: 'warn',
          title: 'Quoted text does not exist',
          explanation: 'Fabricated quote check.',
          docIndex: 1,
          documentTitle: 'Hop dong chinh',
          pageNumber: 1,
          quoteExcerpt: 'Clause 99 does not exist anywhere in PDF',
        },
        {
          kind: 'mismatched_party',
          severity: 'warn',
          title: 'Out-of-range page',
          explanation: 'Page 99 is outside Doc 1.',
          docIndex: 1,
          documentTitle: 'Hop dong chinh',
          pageNumber: 99,
          quoteExcerpt: 'Ben A: Cong ty TNHH Alpha',
        },
        {
          kind: 'annex_gap',
          severity: 'info',
          title: 'Unknown docIndex',
          explanation: 'References doc 5.',
          docIndex: 5,
          documentTitle: 'Phu luc 05',
          pageNumber: 1,
          quoteExcerpt: 'Phu luc 01',
        },
      ],
    });

    expect(res.kind).toBe('findings');
    expect(res.code).toBe('OK');
    expect(res.droppedCount).toBe(3);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({
      kind: 'mismatched_total',
      severity: 'critical',
      documentId: DOC_2_ID,
      documentTitle: 'Phu luc 01 - Bao gia chi tiet',
      pageNumber: 1,
      quoteExcerpt: 'Tong cong thanh toan: 150.000.000 VND.',
      source: 'ai',
      tainted: true,
    });
  });

  it('caps total extracted text proportionally at 64 KiB across documents without dropping later docs', () => {
    const hugeChunk = 'A'.repeat(60_000);
    const prompt = signPacketConsistencyPrompt({
      envelopeTitle: 'Packet lon',
      documents: [
        {
          documentId: DOC_1_ID,
          docIndex: 1,
          title: 'Tai lieu 1',
          pageCount: 1,
          pages: [{ page: 1, text: hugeChunk }],
        },
        {
          documentId: DOC_2_ID,
          docIndex: 2,
          title: 'Tai lieu 2',
          pageCount: 1,
          pages: [{ page: 1, text: 'MARKER_DOC_2_PRESERVED ' + 'B'.repeat(40_000) }],
        },
      ],
    });

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(SIGN_PACKET_CONSISTENCY_TEXT_BYTES + 4096);
    expect(prompt).toContain('Tai lieu 1');
    expect(prompt).toContain('Tai lieu 2');
    expect(prompt).toContain('MARKER_DOC_2_PRESERVED');
  });

  it('returns NO_TEXT without calling the model when all packet documents have empty pages', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const reader = new SignAiReader(CONFIG);
    const meter: AiMeter = { admit: async () => {}, record: async () => {} };

    const res = await withAiScope({ orgId: 'org-1', meter }, () =>
      reader.checkPacketConsistency({
        envelopeTitle: 'Empty scans',
        documents: [
          { documentId: DOC_1_ID, docIndex: 1, title: 'Scan 1', pageCount: 1, pages: [{ page: 1, text: '   ' }] },
        ],
      }),
    );

    expect(res).toEqual({ kind: 'none', code: 'NO_TEXT', summaryText: null, findings: [], droppedCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces AiMeter, budget exhaustion, zero tools, and metered sign.packet_consistency billing', async () => {
    const reader = new SignAiReader(CONFIG);
    await expect(reader.checkPacketConsistency(PACKET_REQUEST)).rejects.toBeInstanceOf(AiMeterMissingError);

    const exhaustedMeter: AiMeter = {
      admit: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
      record: async () => {},
    };
    await expect(
      withAiScope({ orgId: 'org-1', meter: exhaustedMeter }, () => reader.checkPacketConsistency(PACKET_REQUEST)),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);

    const admitted: AiCall[] = [];
    const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
    const bodies: Array<Record<string, unknown>> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify(
            completion({
              summaryText: 'Phat hien chenh lech gia tri giua hop dong chinh va phu luc.',
              findings: [
                {
                  kind: 'mismatched_total',
                  severity: 'critical',
                  title: 'Lech tong gia tri',
                  explanation: 'Hop dong ghi 120.000.000 VND khac phu luc ghi 150.000.000 VND.',
                  docIndex: 2,
                  documentTitle: 'Phu luc 01',
                  pageNumber: 1,
                  quoteExcerpt: 'Tong cong thanh toan: 150.000.000 VND.',
                },
              ],
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const meter: AiMeter = {
      admit: async (call) => {
        admitted.push(call);
      },
      record: async (call, usage) => {
        recorded.push({ call, usage });
      },
    };

    const res = await withAiScope({ orgId: 'org-packet-1', meter }, () => reader.checkPacketConsistency(PACKET_REQUEST));
    expect(res.kind).toBe('findings');
    expect(res.findings).toHaveLength(1);
    expect(admitted).toEqual([
      {
        orgId: 'org-packet-1',
        feature: 'sign.packet_consistency',
        module: 'sign',
        agentId: null,
        memberRunId: null,
      },
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      call: {
        orgId: 'org-packet-1',
        feature: 'sign.packet_consistency',
        module: 'sign',
        agentId: null,
        memberRunId: null,
      },
      usage: { inputTokens: 140, outputTokens: 70 },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
  });
});
