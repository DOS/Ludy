// SPDX-License-Identifier: AGPL-3.0-only
// Unit checks for Projects Public Roadmap contracts, embed origin validation, and OTP email rendering (#4399).
import { describe, expect, it } from 'vitest';
import {
  ROADMAP_ANNOUNCEMENT_STATUSES,
  normalizeRoadmapEmbedOrigin,
  zRoadmapAnnouncementCreateInput,
  zRoadmapBoardCreateInput,
  zRoadmapChangelogDraftInput,
  zRoadmapDedupeInput,
  zRoadmapEmbedOrigin,
  zRoadmapPublicOtpRequestInput,
  zRoadmapPublicOtpVerifyInput,
  zRoadmapPublicSubmitIdeaInput,
  zRoadmapPublicVoteInput,
  zRoadmapSignalValueByCurrency,
} from '@ludy/kernel-contract';
import {
  generateEphemeralOtpWrapKey,
  openEphemeralOtpCode,
  renderRoadmapOtpMail,
  renderRoadmapShippedMail,
  sealEphemeralOtpCode,
} from '../src/roadmap-mail.ts';
import {
  mcpRoadmapDemandSummary,
  mcpRoadmapIdeas,
  zMcpRoadmapDemandSummaryInput,
  zMcpRoadmapIdeasInput,
} from '../src/roadmap-mcp.ts';
import { formatMeetingTaskSource } from '../src/index.ts';
import { computeSignalRollup } from '../src/roadmap-signals.ts';

describe('projects roadmap embed origins and contracts (#4399)', () => {
  it('accepts strict HTTPS origins without path, query, fragment, trailing slash, or wildcards and rejects unsafe inputs', () => {
    expect(normalizeRoadmapEmbedOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(normalizeRoadmapEmbedOrigin('HTTPS://Portal.Example.VN:8443')).toBe('https://portal.example.vn:8443');

    expect(normalizeRoadmapEmbedOrigin('https://app.example.com/')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('http://app.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://*.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://app.example.com/path')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('https://user@app.example.com')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('*')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeRoadmapEmbedOrigin('null')).toBeNull();

    expect(zRoadmapEmbedOrigin.parse('HTTPS://portal.example.com')).toBe('https://portal.example.com');
    expect(() => zRoadmapEmbedOrigin.parse('http://insecure.example.com')).toThrow();
    expect(() => zRoadmapEmbedOrigin.parse('https://app.example.com/')).toThrow();
    expect(() => zRoadmapEmbedOrigin.parse('https://*.example.com')).toThrow();
  });

  it('validates board slugs, 6-digit OTP inputs, and trims idea submissions safely', () => {
    const board = zRoadmapBoardCreateInput.parse({
      title: '  Lo trinh san pham 2027  ',
      slug: 'Roadmap-Q1',
      embedAllowedOrigins: ['HTTPS://app.example.com', 'https://docs.example.com:8443'],
    });
    expect(board.title).toBe('Lo trinh san pham 2027');
    expect(board.slug).toBe('roadmap-q1');
    expect(board.embedAllowedOrigins).toEqual(['https://app.example.com', 'https://docs.example.com:8443']);

    expect(() => zRoadmapBoardCreateInput.parse({ title: 'X', slug: 'bad/slug' })).toThrow();

    expect(zRoadmapPublicOtpRequestInput.parse({ email: '  voter@example.test  ' })).toEqual({
      email: 'voter@example.test',
    });
    expect(zRoadmapPublicOtpVerifyInput.parse({ email: 'voter@example.test', code: '048291' }).code).toBe('048291');
    expect(() => zRoadmapPublicOtpVerifyInput.parse({ email: 'voter@example.test', code: 'abc123' })).toThrow();

    const idea = zRoadmapPublicSubmitIdeaInput.parse({
      title: '  Dark mode exports  ',
      summary: '   Please export monthly totals in PDF.   ',
      category: '  Reporting  ',
      displayName: '  Minh  ',
    });
    expect(idea).toEqual({
      title: 'Dark mode exports',
      summary: 'Please export monthly totals in PDF.',
      category: 'Reporting',
      displayName: 'Minh',
    });
  });
});

describe('renderRoadmapOtpMail (#4399)', () => {
  it('renders vi and en emails cleanly while escaping HTML special characters and stripping header newlines', () => {
    const payload = {
      lang: 'vi' as const,
      orgName: 'Cong ty\r\n<script>alert(1)</script>',
      boardId: '00000000-0000-4000-8000-000000000002',
      boardTitle: '<b>Public</b> & "Ideas"',
      otpId: '00000000-0000-4000-8000-000000000003',
      expiresAt: '2027-01-01T00:10:00.000Z',
    };

    const viMail = renderRoadmapOtpMail(payload, { brand: 'Ludy', code: '492817' });
    expect(viMail.text).toContain('492817');
    expect(viMail.text).not.toContain('\r\n<script>');
    expect(viMail.html).toContain('&lt;b&gt;Public&lt;/b&gt; &amp; &quot;Ideas&quot;');
    expect(viMail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(viMail.html).not.toContain('<script>');
    expect(viMail.html).toContain('492817');

    const enMail = renderRoadmapOtpMail({ ...payload, lang: 'en' }, { brand: 'Ludy', code: '771122' });
    expect(enMail.text).toContain('Your verification code for');
    expect(enMail.text).toContain('771122');
    expect(enMail.html).toContain('Verification code');
    expect(enMail.html).toContain('771122');
  });

  it('seals and opens 6-digit OTPs under ephemeral worker-RAM keys with AAD binding and zero digits in wrapKey', () => {
    const key = generateEphemeralOtpWrapKey();
    expect(key).toMatch(/^[a-p]{64}$/);
    expect(key).not.toMatch(/\d/);

    const aad = 'board-1:otp-1';
    const sealed = sealEphemeralOtpCode('482910', key, aad);
    expect(sealed).not.toContain('482910');
    expect(openEphemeralOtpCode(sealed, key, aad)).toBe('482910');

    expect(() => openEphemeralOtpCode(sealed, key, 'board-1:otp-other')).toThrow();
    expect(() => openEphemeralOtpCode(sealed, generateEphemeralOtpWrapKey(), aad)).toThrow();
  });
});

describe('Slice 2 announcements, shipped email renderer, subscribe toggle, & MCP read descriptors (#4400)', () => {
  it('validates announcement inputs, subscribe action, and Vy AI RPC contracts', () => {
    expect(ROADMAP_ANNOUNCEMENT_STATUSES).toEqual(['draft', 'published']);

    const ann = zRoadmapAnnouncementCreateInput.parse({
      boardId: '00000000-0000-4000-8000-000000000001',
      title: '  Ban cap nhat thang 3  ',
      bodyMd: '  ## Tinh nang moi\n- Da ho tro CSV  ',
      linkedItemIds: ['00000000-0000-4000-8000-000000000002'],
    });
    expect(ann.title).toBe('Ban cap nhat thang 3');
    expect(ann.linkedItemIds).toEqual(['00000000-0000-4000-8000-000000000002']);

    expect(zRoadmapPublicVoteInput.parse({ action: 'subscribe', notifyOnShip: true })).toEqual({
      action: 'subscribe',
      notifyOnShip: true,
    });
    expect(() => zRoadmapPublicVoteInput.parse({ action: 'subscribe' })).toThrow();

    expect(zRoadmapDedupeInput.parse({ boardId: '00000000-0000-4000-8000-000000000001' }).boardId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(
      zRoadmapChangelogDraftInput.parse({
        boardId: '00000000-0000-4000-8000-000000000001',
        itemIds: ['00000000-0000-4000-8000-000000000002'],
        language: 'en',
      }).language,
    ).toBe('en');
  });

  it('renders shipped announcement emails safely with HTML escaping, markdown blocks, shipped badges, and fragment unsubscribe URL', () => {
    const payload = {
      lang: 'vi' as const,
      orgName: 'Cong ty A <script>x</script>',
      orgSlug: 'acme',
      boardId: '00000000-0000-4000-8000-000000000001',
      boardSlug: 'roadmap',
      boardTitle: 'Lo trinh & Gop y',
      announcementId: '00000000-0000-4000-8000-000000000005',
      subscriberId: '00000000-0000-4000-8000-000000000006',
    };

    const rendered = renderRoadmapShippedMail(payload, {
      brand: 'Ludy',
      publicUrl: 'https://app.ludy.vn/',
      announcementTitle: 'Phat hanh **bao cao CSV**',
      bodyMd: '## Diem noi bat\n- **Xuat CSV** nhanh chong\n- Tham khao [tai lieu](https://docs.ludy.vn/csv) hoac [xss](javascript:alert(1))\n- <img src=x onerror=alert(1)>',
      linkedItems: [{ id: '1', publicTitle: 'Xuat CSV hoa don' }],
      unsubToken: 'unsub_token_abcdef_123456',
    });

    expect(rendered.subject).toBe('[Lo trinh & Gop y] Phat hanh **bao cao CSV**');
    expect(rendered.text).toContain('Xuat CSV hoa don');
    expect(rendered.text).toContain('https://app.ludy.vn/-/roadmap/acme/roadmap#unsubscribe=unsub_token_abcdef_123456');
    expect(rendered.text).toContain('https://app.ludy.vn/-/roadmap/acme/roadmap?tab=changelog');
    expect(rendered.html).toContain('<h2');
    expect(rendered.html).toContain('<strong>Xuat CSV</strong>');
    expect(rendered.html).toContain('href="https://docs.ludy.vn/csv"');
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.html).toContain('[xss](javascript:alert(1))');
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).toContain('href="https://app.ludy.vn/-/roadmap/acme/roadmap#unsubscribe=unsub_token_abcdef_123456"');
  });

  it('pins strict MCP read descriptors and bounds for projects.mcp.roadmap_*', () => {
    expect(mcpRoadmapIdeas.mcp).toEqual({ scope: 'ludy.read' });
    expect(mcpRoadmapIdeas.access).toEqual(['owner', 'admin']);
    expect(mcpRoadmapDemandSummary.mcp).toEqual({ scope: 'ludy.read' });
    expect(mcpRoadmapDemandSummary.access).toEqual(['owner', 'admin']);

    expect(zMcpRoadmapIdeasInput.parse({}).limit).toBe(25);
    expect(() => zMcpRoadmapIdeasInput.parse({ limit: 51 })).toThrow();
    expect(zMcpRoadmapDemandSummaryInput.parse({}).topLimit).toBe(10);
    expect(() => zMcpRoadmapDemandSummaryInput.parse({ topLimit: 21 })).toThrow();
  });
});

describe('computeSignalRollup (#4492)', () => {
  it('partitions multi-currency totals strictly by currency using decimal.js precision and deduplicates account labels', () => {
    const boardId = '00000000-0000-4000-8000-000000000001';
    const itemA = '00000000-0000-4000-8000-000000000010';
    const itemB = '00000000-0000-4000-8000-000000000011';

    const rollup = computeSignalRollup(boardId, [
      {
        roadmapItemId: itemA,
        sourceType: 'crm.deal',
        accountLabel: 'Cong ty ABC',
        dealValue: '15000000.10',
        dealCurrency: 'VND',
      },
      {
        roadmapItemId: itemA,
        sourceType: 'kernel.conversation',
        accountLabel: '  cong ty abc ',
        dealValue: '5000000.20',
        dealCurrency: 'VND',
      },
      {
        roadmapItemId: itemA,
        sourceType: 'crm.deal',
        accountLabel: 'Global Buyer Inc',
        dealValue: '1200.55',
        dealCurrency: 'USD',
      },
      {
        roadmapItemId: itemB,
        sourceType: 'meetings.meeting',
        accountLabel: 'Global Buyer Inc',
        dealValue: '300.45',
        dealCurrency: 'USD',
      },
      {
        roadmapItemId: itemB,
        sourceType: 'meetings.meeting',
        accountLabel: null,
        dealValue: null,
        dealCurrency: null,
      },
    ]);

    expect(rollup.boardId).toBe(boardId);
    expect(rollup.totalSignals).toBe(5);
    expect(rollup.distinctAccountCount).toBe(2);
    expect(rollup.sourceCounts).toEqual({ crmDeal: 2, conversation: 1, meeting: 2 });
    expect(rollup.valueByCurrency).toEqual([
      { currency: 'USD', totalAmount: '1501.00', signalCount: 2 },
      { currency: 'VND', totalAmount: '20000000.30', signalCount: 2 },
    ]);

    expect(rollup.byItem).toEqual([
      {
        roadmapItemId: itemA,
        totalSignals: 3,
        distinctAccountCount: 2,
        sourceCounts: { crmDeal: 2, conversation: 1, meeting: 0 },
        valueByCurrency: [
          { currency: 'USD', totalAmount: '1200.55', signalCount: 1 },
          { currency: 'VND', totalAmount: '20000000.30', signalCount: 2 },
        ],
      },
      {
        roadmapItemId: itemB,
        totalSignals: 2,
        distinctAccountCount: 1,
        sourceCounts: { crmDeal: 0, conversation: 0, meeting: 2 },
        valueByCurrency: [{ currency: 'USD', totalAmount: '300.45', signalCount: 1 }],
      },
    ]);
  });

  it('validates multi-signal aggregate currency totals exceeding 16 integer digits (#4492)', () => {
    const parsed = zRoadmapSignalValueByCurrency.parse({
      currency: 'USD',
      totalAmount: '19999999999999999.98',
      signalCount: 2,
    });
    expect(parsed.totalAmount).toBe('19999999999999999.98');
    expect(() => zRoadmapSignalValueByCurrency.parse({ currency: 'USD', totalAmount: '-1.00', signalCount: 1 })).toThrow();
    expect(() => zRoadmapSignalValueByCurrency.parse({ currency: 'USD', totalAmount: 'invalid', signalCount: 1 })).toThrow();
  });

  it('falls back to published meeting summary when draft summary and decisions are whitespace only', () => {
    const formatted = formatMeetingTaskSource({
      meeting: {
        title: 'Customer Sync Q1',
      } as Parameters<typeof formatMeetingTaskSource>[0]['meeting'],
      results: {
        meetingId: '00000000-0000-4000-8000-000000000010',
        isRecorder: true,
        transcriptUnread: 0,
        draft: {
          id: '00000000-0000-4000-8000-000000000011',
          feature: 'manual',
          stage: 'draft',
          summary: '   \n  ',
          decisions: ['   ', '\t'],
          tainted: false,
        },
        published: {
          id: '00000000-0000-4000-8000-000000000012',
          feature: 'manual',
          stage: 'published',
          summary: 'Customers requested scheduled PDF reports.',
          decisions: ['Prioritize weekly PDF digest'],
          tainted: false,
        },
        items: [],
      },
      notes: null,
      transcript: null,
    });

    expect(formatted.sourceTitle).toBe('Customer Sync Q1');
    expect(formatted.sourceBody).toContain('Summary:\nCustomers requested scheduled PDF reports.');
    expect(formatted.sourceBody).toContain('Decisions:\n- Prioritize weekly PDF digest');
  });

  it('treats U+200D-only draft summary and decisions as empty and falls back to published summary', () => {
    const formatted = formatMeetingTaskSource({
      meeting: {
        title: 'Customer Sync Q1',
      } as Parameters<typeof formatMeetingTaskSource>[0]['meeting'],
      results: {
        meetingId: '00000000-0000-4000-8000-000000000010',
        isRecorder: true,
        transcriptUnread: 0,
        draft: {
          id: '00000000-0000-4000-8000-000000000011',
          feature: 'manual',
          stage: 'draft',
          summary: '\u200D \u200D',
          decisions: ['\u200D'],
          tainted: false,
        },
        published: {
          id: '00000000-0000-4000-8000-000000000012',
          feature: 'manual',
          stage: 'published',
          summary: 'Published summary after ZWJ draft.',
          decisions: ['Ship ZWJ check'],
          tainted: false,
        },
        items: [],
      },
      notes: null,
      transcript: null,
    });

    expect(formatted.sourceBody).toContain('Summary:\nPublished summary after ZWJ draft.');
    expect(formatted.sourceBody).toContain('Decisions:\n- Ship ZWJ check');
  });
});
