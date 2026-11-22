// SPDX-License-Identifier: AGPL-3.0-only
// Component, RBAC, 1-time secret reveal, dual-secret rotation grace, delivery log, and paired-label tests for SignWebhooksView (#4440).
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import {
  SignWebhooksView,
  canManageSignWebhooks,
} from '../src/components/sign/sign-webhooks-card.tsx';
import { catalog } from '../src/i18n/runtime.ts';
import type {
  SignWebhookDeliveryRecord,
  SignWebhookListResult,
  SignWebhookRecord,
} from '../src/lib/sign-api.ts';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    errorMessage: (e: unknown) => String(e),
  };
});

function assertPairedLabels(html: string): void {
  const labelForMatches = new Set(Array.from(html.matchAll(/<label[^>]+for="([^"]+)"/g), (m) => m[1]!));
  for (const tagMatch of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = tagMatch[0];
    if (tag.includes('type="hidden"')) continue;
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `control missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `control missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
}

function makeWebhook(overrides: Partial<SignWebhookRecord> = {}): SignWebhookRecord {
  return {
    id: '01900000-0000-7000-8000-000000000101',
    url: 'https://hooks.congty.vn/ludy/sign',
    events: ['sign.envelope.sent', 'sign.envelope.completed'],
    enabled: true,
    secretHint: 'whk_0123abcd',
    previousExpiresAt: null,
    consecutiveFailures: 0,
    failingSince: null,
    pausedReason: null,
    lastDeliveryAt: '2026-11-22T09:00:00.000Z',
    lastStatus: 'sent',
    createdBy: '01900000-0000-7000-8000-000000000010',
    createdAt: '2026-11-22T08:00:00.000Z',
    updatedAt: '2026-11-22T09:00:00.000Z',
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<SignWebhookDeliveryRecord> = {}): SignWebhookDeliveryRecord {
  return {
    id: '01900000-0000-7000-8000-000000000201',
    webhookId: '01900000-0000-7000-8000-000000000101',
    envelopeId: '01900000-0000-7000-8000-000000000301',
    eventType: 'sign.envelope.completed',
    status: 'sent',
    attempts: 1,
    lastCode: 200,
    handedAt: '2026-11-22T09:00:01.000Z',
    sentAt: '2026-11-22T09:00:02.000Z',
    createdAt: '2026-11-22T09:00:00.000Z',
    payload: null,
    ...overrides,
  };
}

function renderWebhooks(
  locale: 'vi' | 'en',
  props: {
    role: string | null;
    list: SignWebhookListResult | null;
    deliveries?: SignWebhookDeliveryRecord[];
    revealedSecret?: { webhookUrl: string; secret: string; hint: string } | null;
  },
): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <SignWebhooksView
        role={props.role}
        list={props.list}
        deliveries={props.deliveries ?? []}
        selectedWebhookId={null}
        revealedSecret={props.revealedSecret ?? null}
      />
    </IntlProvider>,
  );
}

describe('SignWebhooksView (#4440)', () => {
  it('permits only workspace owners and admins to manage eSign webhooks', () => {
    expect(canManageSignWebhooks('owner')).toBe(true);
    expect(canManageSignWebhooks('admin')).toBe(true);
    expect(canManageSignWebhooks('member')).toBe(false);
    expect(canManageSignWebhooks('viewer')).toBe(false);
    expect(canManageSignWebhooks(null)).toBe(false);
    expect(canManageSignWebhooks(undefined)).toBe(false);
  });

  it('renders read-only notice for members and viewers without inputs or management controls', () => {
    for (const role of ['member', 'viewer'] as const) {
      const html = renderWebhooks('vi', {
        role,
        list: { items: [makeWebhook()], brokerAvailable: true },
      });
      expect(html).toContain('data-testid="sign-webhooks-readonly-card"');
      expect(html).not.toContain('data-testid="sign-webhooks-create-form"');
      expect(html).not.toContain('hooks.congty.vn');
      expect(html).not.toContain('<input');
    }
  });

  it('renders create form, one-time secret reveal, rotation grace badge, auto-paused state, and delivery logs with paired labels', () => {
    const futureGrace = new Date(Date.now() + 12 * 3_600_000).toISOString();
    const activeWh = makeWebhook({ previousExpiresAt: futureGrace });
    const pausedWh = makeWebhook({
      id: '01900000-0000-7000-8000-000000000102',
      url: 'https://erp.congty.vn/webhooks/esign',
      enabled: false,
      pausedReason: 'failing',
      consecutiveFailures: 14,
    });

    const htmlVi = renderWebhooks('vi', {
      role: 'owner',
      list: { items: [activeWh, pausedWh], brokerAvailable: true },
      deliveries: [
        makeDelivery(),
        makeDelivery({
          id: '01900000-0000-7000-8000-000000000202',
          envelopeId: null,
          eventType: 'ping',
          status: 'failed',
          attempts: 9,
          lastCode: 502,
        }),
      ],
      revealedSecret: {
        webhookUrl: activeWh.url,
        secret: 'whsec_test_one_time_secret_0123456789abcdef',
        hint: activeWh.secretHint,
      },
    });

    expect(htmlVi).toContain('data-testid="sign-webhooks-privacy-banner"');
    expect(htmlVi).toContain('whsec_test_one_time_secret_0123456789abcdef');
    expect(htmlVi).toContain(`data-testid="sign-webhook-grace-${activeWh.id}"`);
    expect(htmlVi).toContain(`data-testid="sign-webhook-paused-alert-${pausedWh.id}"`);
    expect(htmlVi).toContain('502');
    expect(htmlVi).toContain('200');
    assertPairedLabels(htmlVi);

    const htmlEn = renderWebhooks('en', {
      role: 'admin',
      list: { items: [activeWh], brokerAvailable: true },
      deliveries: [makeDelivery()],
    });
    expect(htmlEn).toContain('Outbound signing webhooks (HMAC)');
    expect(htmlEn).toContain('Dual-secret grace until');
    assertPairedLabels(htmlEn);
  });
});
