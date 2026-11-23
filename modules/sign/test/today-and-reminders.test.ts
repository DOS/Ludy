// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for deterministic Vy Today items, hr_contract confidentiality, sequential/parallel
// 24h pre-expiry eligibility, N1(a) direct-link suppression, and reminder email rendering (#3813).
import { describe, expect, it } from 'vitest';
import { TODAY_ITEMS_MAX, zTodayItems } from '@ludy/kernel-contract';
import {
  generateRawSigningToken,
  renderSignInviteMail,
  selectPreExpiryEligibleSigners,
  signTodayItemsOf,
  type SignPreExpirySignerCandidate,
  type SignTodayEnvelopeRow,
} from '../src/index.ts';

const NOW = new Date('2026-11-19T08:00:00.000Z');
const USER_CREATOR = '01900000-0000-7000-8000-000000000010';
const USER_OTHER_MEMBER = '01900000-0000-7000-8000-000000000020';
const USER_OWNER = '01900000-0000-7000-8000-000000000030';

function makeEnvelopeRow(overrides: Partial<SignTodayEnvelopeRow> & { id: string }): SignTodayEnvelopeRow {
  return {
    status: 'sent',
    source_kind: 'standalone',
    source_id: null,
    created_by: USER_CREATOR,
    expires_at: '2026-11-20T08:00:00.000Z',
    declined_at: null,
    updated_at: '2026-11-19T06:00:00.000Z',
    ...overrides,
  };
}

function makeSignerCandidate(
  overrides: Partial<SignPreExpirySignerCandidate> & { id: string },
): SignPreExpirySignerCandidate {
  return {
    routing_order: 1,
    signer_role: 'signer',
    role_label: 'Party A',
    email: 'signer@example.com',
    delivery_mode: 'email',
    status: 'pending',
    otp_verified_at: null,
    pre_expiry_reminded_at: null,
    ...overrides,
  };
}

describe('signTodayItemsOf (#3813)', () => {
  it('surfaces pending envelopes expiring within 48h and declined envelopes within 14d, ordered with flags first and zero free text', () => {
    const rows: SignTodayEnvelopeRow[] = [
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000101',
        status: 'sent',
        expires_at: '2026-11-20T20:00:00.000Z', // +36h -> included
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000102',
        status: 'in_progress',
        expires_at: '2026-11-19T13:15:00.000Z', // +5.25h -> ceil 6h -> included earlier
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000103',
        status: 'sent',
        expires_at: '2026-11-21T09:00:00.000Z', // +49h -> outside 48h window
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000104',
        status: 'sent',
        expires_at: '2026-11-19T07:59:00.000Z', // already past now -> excluded
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000105',
        status: 'declined',
        expires_at: null,
        declined_at: '2026-11-19T04:00:00.000Z', // declined today (0 days)
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000106',
        status: 'declined',
        expires_at: null,
        declined_at: '2026-11-16T07:00:00.000Z', // declined 3 days ago
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000107',
        status: 'declined',
        expires_at: null,
        declined_at: '2026-11-01T00:00:00.000Z', // older than 14 days -> excluded
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000108',
        status: 'declined',
        expires_at: null,
        declined_at: '2026-11-19T05:00:00.000Z',
        decline_acknowledged_at: '2026-11-19T06:00:00.000Z', // already acknowledged -> excluded
      }),
    ];

    const items = signTodayItemsOf(rows, {
      userId: USER_CREATOR,
      role: 'member',
      now: NOW,
    });

    expect(zTodayItems.safeParse(items).success).toBe(true);
    expect(items).toEqual([
      {
        kind: 'flag',
        app: 'sign',
        id: 'declined:01900000-0000-7000-8000-000000000105',
        title: { key: 'sign.envelopeDeclinedToday', params: {} },
        severity: 'warn',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000105',
      },
      {
        kind: 'flag',
        app: 'sign',
        id: 'declined:01900000-0000-7000-8000-000000000106',
        title: { key: 'sign.envelopeDeclinedDays', params: { days: 3 } },
        severity: 'warn',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000106',
      },
      {
        kind: 'deadline',
        app: 'sign',
        id: 'expiring:01900000-0000-7000-8000-000000000102',
        title: { key: 'sign.envelopeExpiringHours', params: { hours: 6 } },
        dueAt: '2026-11-19T13:15:00.000Z',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000102',
      },
      {
        kind: 'deadline',
        app: 'sign',
        id: 'expiring:01900000-0000-7000-8000-000000000101',
        title: { key: 'sign.envelopeExpiringHours', params: { hours: 36 } },
        dueAt: '2026-11-20T20:00:00.000Z',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000101',
      },
    ]);
  });

  it('strictly hides hr_contract envelopes from ordinary members and viewers while allowing owner, admin, and creator', () => {
    const rows: SignTodayEnvelopeRow[] = [
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000201',
        source_kind: 'hr_contract',
        source_id: '01900000-0000-7000-8000-000000000901',
        created_by: USER_CREATOR,
        status: 'sent',
        expires_at: '2026-11-19T20:00:00.000Z',
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000202',
        source_kind: 'hr_contract',
        source_id: '01900000-0000-7000-8000-000000000902',
        created_by: USER_CREATOR,
        status: 'declined',
        expires_at: null,
        declined_at: '2026-11-19T05:00:00.000Z',
      }),
      makeEnvelopeRow({
        id: '01900000-0000-7000-8000-000000000203',
        source_kind: 'standalone',
        created_by: USER_CREATOR,
        status: 'sent',
        expires_at: '2026-11-19T22:00:00.000Z',
      }),
    ];

    // Another member NEVER sees hr_contract envelopes, only the standalone envelope.
    const otherMemberItems = signTodayItemsOf(rows, {
      userId: USER_OTHER_MEMBER,
      role: 'member',
      now: NOW,
    });
    expect(otherMemberItems.map((i) => i.id)).toEqual([
      'expiring:01900000-0000-7000-8000-000000000203',
    ]);

    // Viewers get zero actionable items regardless of source_kind.
    expect(signTodayItemsOf(rows, { userId: USER_CREATOR, role: 'viewer', now: NOW })).toEqual([]);
    expect(signTodayItemsOf(rows, { userId: USER_OTHER_MEMBER, role: null, now: NOW })).toEqual([]);

    // Owner, admin, and the creator see all three envelopes.
    expect(signTodayItemsOf(rows, { userId: USER_OWNER, role: 'owner', now: NOW })).toHaveLength(3);
    expect(signTodayItemsOf(rows, { userId: USER_OTHER_MEMBER, role: 'admin', now: NOW })).toHaveLength(3);
    expect(signTodayItemsOf(rows, { userId: USER_CREATOR, role: 'member', now: NOW })).toHaveLength(3);
  });

  it('caps Today items at TODAY_ITEMS_MAX with a sign.more overflow row', () => {
    const rows = Array.from({ length: TODAY_ITEMS_MAX + 5 }, (_, idx) =>
      makeEnvelopeRow({
        id: `01900000-0000-7000-8000-${String(idx + 1).padStart(12, '0')}`,
        status: 'sent',
        expires_at: new Date(NOW.getTime() + (idx + 1) * 60_000).toISOString(),
      }),
    );

    const items = signTodayItemsOf(rows, {
      userId: USER_OWNER,
      role: 'owner',
      now: NOW,
    });

    expect(items).toHaveLength(TODAY_ITEMS_MAX);
    const tail = items.at(-1);
    expect(tail).toEqual({
      kind: 'flag',
      app: 'sign',
      id: 'more',
      title: { key: 'sign.more', params: { count: 6 } },
      count: 6,
      severity: 'warn',
      href: '/sign/envelopes',
    });
  });

  it('computes declinedToday vs declinedDays across midnight in Vietnam time (UTC+07:00)', () => {
    // 23:55 Vietnam time on 2026-11-18 is 2026-11-18T16:55:00Z; 08:00 Vietnam time on 2026-11-19 is 2026-11-19T01:00:00Z (only 8h05m apart, but next calendar day).
    const morningNow = new Date('2026-11-19T01:00:00.000Z');
    const items = signTodayItemsOf(
      [
        makeEnvelopeRow({
          id: '01900000-0000-7000-8000-000000000251',
          status: 'declined',
          expires_at: null,
          declined_at: '2026-11-18T16:55:00.000Z',
        }),
        makeEnvelopeRow({
          id: '01900000-0000-7000-8000-000000000252',
          status: 'declined',
          expires_at: null,
          declined_at: '2026-11-18T17:05:00.000Z', // 00:05 Vietnam time on 2026-11-19 -> same calendar day
        }),
      ],
      { userId: USER_OWNER, role: 'owner', now: morningNow },
    );
    expect(items.map((i) => ({ id: i.id, title: i.title }))).toEqual([
      {
        id: 'declined:01900000-0000-7000-8000-000000000252',
        title: { key: 'sign.envelopeDeclinedToday', params: {} },
      },
      {
        id: 'declined:01900000-0000-7000-8000-000000000251',
        title: { key: 'sign.envelopeDeclinedDays', params: { days: 1 } },
      },
    ]);
  });
});

describe('selectPreExpiryEligibleSigners (#3813)', () => {
  it('selects only active email-mode non-CC signers without pre_expiry_reminded_at in parallel mode', () => {
    const candidates: SignPreExpirySignerCandidate[] = [
      makeSignerCandidate({ id: 's-email-pending', status: 'pending', delivery_mode: 'email' }),
      makeSignerCandidate({ id: 's-email-viewed', status: 'viewed', delivery_mode: 'email', email: 'viewed@example.com' }),
      makeSignerCandidate({
        id: 's-already-reminded',
        status: 'pending',
        delivery_mode: 'email',
        pre_expiry_reminded_at: '2026-11-19T05:00:00.000Z',
      }),
      makeSignerCandidate({ id: 's-link-mode', status: 'pending', delivery_mode: 'link' }),
      makeSignerCandidate({ id: 's-signed', status: 'signed', delivery_mode: 'email' }),
      makeSignerCandidate({ id: 's-cc', signer_role: 'cc', status: 'pending', delivery_mode: 'email' }),
      makeSignerCandidate({ id: 's-bad-email', status: 'pending', delivery_mode: 'email', email: 'a@example.com, b@example.com' }),
    ];

    expect(selectPreExpiryEligibleSigners('parallel', candidates).map((s) => s.id)).toEqual([
      's-email-pending',
      's-email-viewed',
    ]);
  });

  it('respects sequential routing_order and never reminds waiting later-turn signers', () => {
    const step1Pending = [
      makeSignerCandidate({ id: 's-1', routing_order: 1, status: 'pending', delivery_mode: 'link' }),
      makeSignerCandidate({ id: 's-2', routing_order: 2, status: 'waiting', delivery_mode: 'email', email: 'step2@example.com' }),
    ];
    // Step 1 is still pending (via Zalo link), so Step 2 (waiting) MUST NOT be reminded.
    expect(selectPreExpiryEligibleSigners('sequential', step1Pending)).toEqual([]);

    const step1SignedStep2Active = [
      makeSignerCandidate({ id: 's-1', routing_order: 1, status: 'signed', delivery_mode: 'link' }),
      makeSignerCandidate({ id: 's-2', routing_order: 2, status: 'pending', delivery_mode: 'email', email: 'step2@example.com' }),
      makeSignerCandidate({ id: 's-3', routing_order: 3, status: 'waiting', delivery_mode: 'email', email: 'step3@example.com' }),
    ];
    expect(selectPreExpiryEligibleSigners('sequential', step1SignedStep2Active).map((s) => s.id)).toEqual(['s-2']);
  });

  it('enforces N1(a) direct-link suppression: requires otp_verified_at on direct-link envelopes', () => {
    const unverifiedDirect = [
      makeSignerCandidate({
        id: 's-unverified',
        delivery_mode: 'email',
        status: 'pending',
        email: 'victim@example.com',
        otp_verified_at: null,
      }),
    ];
    expect(
      selectPreExpiryEligibleSigners('parallel', unverifiedDirect, { isDirectLinkEnvelope: true }),
    ).toEqual([]);

    const verifiedDirect = [
      makeSignerCandidate({
        id: 's-verified',
        delivery_mode: 'email',
        status: 'viewed',
        email: 'verified@example.com',
        otp_verified_at: '2026-11-19T07:00:00.000Z',
      }),
    ];
    expect(
      selectPreExpiryEligibleSigners('parallel', verifiedDirect, { isDirectLinkEnvelope: true }).map((s) => s.id),
    ).toEqual(['s-verified']);

    // Active-view 15-minute grace window: signer who opened the ceremony 5 minutes ago is deferred, while 20 minutes ago is eligible.
    const graceCandidates = [
      makeSignerCandidate({
        id: 's-viewing-now',
        status: 'viewed',
        viewed_at: '2026-11-19T07:55:00.000Z',
      }),
      makeSignerCandidate({
        id: 's-viewed-earlier',
        status: 'viewed',
        email: 'earlier@example.com',
        viewed_at: '2026-11-19T07:40:00.000Z',
      }),
    ];
    expect(selectPreExpiryEligibleSigners('parallel', graceCandidates, { now: NOW }).map((s) => s.id)).toEqual([
      's-viewed-earlier',
    ]);
  });
});

describe('renderSignInviteMail pre-expiry copy (#3813)', () => {
  it('renders polite 24h pre-expiry reminder notice for both signers and approvers with fragment-only URL', () => {
    const token = generateRawSigningToken();
    const signerMail = renderSignInviteMail(
      {
        lang: 'vi',
        orgName: 'Cong ty TNHH Sao Mai',
        envelopeId: '01900000-0000-7000-8000-000000000301',
        signerId: '01900000-0000-7000-8000-000000000302',
        docTitle: 'Hop dong tu van 2026',
        roleLabel: 'Ben B',
        signerRole: 'signer',
        preExpiry: true,
        expiresAt: '2026-11-20T08:00:00.000Z',
      },
      {
        publicUrl: 'https://ludy.example.com',
        brand: 'Ludy',
        token,
        signerName: 'Tran Minh',
        isReminder: true,
      },
    );

    expect(signerMail.text).toContain('sap den han ky trong vong 24 gio toi');
    expect(signerMail.html).toContain('sap den han ky trong vong 24 gio toi');
    expect(signerMail.text).toContain(`https://ludy.example.com/-/sign#${token}`);
    expect(signerMail.text).not.toContain(`?token=${token}`);

    const approverMail = renderSignInviteMail(
      {
        lang: 'vi',
        orgName: 'Cong ty TNHH Sao Mai',
        envelopeId: '01900000-0000-7000-8000-000000000301',
        signerId: '01900000-0000-7000-8000-000000000303',
        docTitle: 'De nghi thanh toan',
        roleLabel: 'Giam doc',
        signerRole: 'approver',
        preExpiry: true,
        expiresAt: '2026-11-20T08:00:00.000Z',
      },
      {
        publicUrl: 'https://ludy.example.com',
        brand: 'Ludy',
        token,
        signerName: 'Le Lan',
        signerRole: 'approver',
        isReminder: true,
      },
    );

    expect(approverMail.text).toContain('sap den han phe duyet trong vong 24 gio toi');
    expect(approverMail.html).toContain('sap den han phe duyet trong vong 24 gio toi');
  });
});
