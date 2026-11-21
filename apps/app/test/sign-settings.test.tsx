// SPDX-License-Identifier: AGPL-3.0-only
// Component, role-gate, #62 legal gate, and accessibility tests for /o/$slug/sign/settings (#3554).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignCaConnectionRecord, SignCaSettingsResult } from '../src/lib/sign-api.ts';
import {
  PUBLIC_CA_PROVIDERS,
  SignSettingsPage,
  SignSettingsView,
  buildLiveCredentials,
  canManageSignCa,
  type LiveProviderFormState,
} from '../src/routes/sign-settings.tsx';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {
      org: {
        get: {
          queryOptions: () => ({
            queryKey: ['org', 'get'],
            queryFn: () => Promise.reject(new Error('not fetched in static render')),
          }),
        },
      },
    },
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

function makeSandboxConnection(overrides: Partial<SignCaConnectionRecord> = {}): SignCaConnectionRecord {
  return {
    id: '01900000-0000-7000-8000-000000000001',
    provider: 'sandbox',
    label: 'Sandbox PAdES Cong ty',
    certRef: 'sandbox-default',
    status: 'active',
    lastTestState: 'works',
    lastTestedAt: '2026-11-18T03:00:00.000Z',
    createdBy: '01900000-0000-7000-8000-000000000002',
    createdAt: '2026-11-18T02:00:00.000Z',
    updatedAt: '2026-11-18T03:00:00.000Z',
    ...overrides,
  };
}

function renderView(
  locale: 'vi' | 'en',
  role: string | null,
  settings: SignCaSettingsResult,
): string {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <SignSettingsView role={role} settings={settings} />
    </IntlProvider>,
  );
}

describe('/sign/settings UI (#3554)', () => {
  it('allows only workspace owners and admins to manage CA connections', () => {
    expect(canManageSignCa('owner')).toBe(true);
    expect(canManageSignCa('admin')).toBe(true);
    expect(canManageSignCa('member')).toBe(false);
    expect(canManageSignCa('viewer')).toBe(false);
    expect(canManageSignCa(null)).toBe(false);
    expect(canManageSignCa(undefined)).toBe(false);
  });

  it('shows offline Sandbox PAdES controls and gates VNPT/Viettel/MISA behind #62 legal review by default', () => {
    const htmlVi = renderView('vi', 'owner', {
      liveCaEnabled: false,
      brokerAvailable: false,
      connections: [],
    });

    expect(htmlVi).toContain('data-testid="sign-ca-sandbox-card"');
    expect(htmlVi).toContain('Bật Sandbox PAdES');
    expect(htmlVi).toContain('data-testid="sign-ca-legal-gate-banner"');
    for (const provider of PUBLIC_CA_PROVIDERS) {
      expect(htmlVi).toContain(`data-testid="sign-ca-gated-badge-${provider}"`);
    }
    expect(htmlVi).toContain('Chờ thẩm định pháp lý &amp; cấp kết nối');
    expect(htmlVi).toContain('VNPT SmartCA');
    expect(htmlVi).toContain('Viettel MySign');
    expect(htmlVi).toContain('MISA WeSign');
    expect(htmlVi).not.toContain('sign-ca-save-vnpt_smartca');
    assertPairedLabels(htmlVi);

    const htmlEn = renderView('en', 'admin', {
      liveCaEnabled: false,
      brokerAvailable: false,
      connections: [],
    });
    expect(htmlEn).toContain('Enable Sandbox PAdES');
    expect(htmlEn).toContain('Pending legal review');
    assertPairedLabels(htmlEn);
  });

  it('renders active Sandbox connection with test state, test button, and disable button for owners/admins', () => {
    const html = renderView('vi', 'admin', {
      liveCaEnabled: false,
      brokerAvailable: false,
      connections: [makeSandboxConnection()],
    });

    expect(html).toContain('Đang bật');
    expect(html).toContain('Kết nối hoạt động tốt');
    expect(html).toContain('data-testid="sign-ca-sandbox-test"');
    expect(html).toContain('data-testid="sign-ca-sandbox-disable"');
    assertPairedLabels(html);
  });

  it('renders read-only CA status for members and viewers without editable inputs or action buttons', () => {
    for (const role of ['member', 'viewer'] as const) {
      const html = renderView('vi', role, {
        liveCaEnabled: true,
        brokerAvailable: true,
        connections: [makeSandboxConnection()],
      });

      expect(html).toContain('data-testid="sign-ca-readonly-banner"');
      expect(html).toContain('Sandbox PAdES Cong ty');
      expect(html).not.toContain('data-testid="sign-ca-sandbox-save"');
      expect(html).not.toContain('data-testid="sign-ca-sandbox-test"');
      expect(html).not.toContain('data-testid="sign-ca-sandbox-disable"');
      expect(html).not.toContain('<input');
    }
  });

  it('renders accessible provider-specific credential inputs and builds valid adapter payloads when liveCaEnabled is true', () => {
    const html = renderView('en', 'owner', {
      liveCaEnabled: true,
      brokerAvailable: true,
      connections: [],
    });

    expect(html).not.toContain('Pending legal review');
    expect(html).toContain('data-testid="sign-ca-save-vnpt_smartca"');
    expect(html).toContain('data-testid="sign-ca-save-viettel_mysign"');
    expect(html).toContain('data-testid="sign-ca-save-misa_wesign"');
    expect(html).toContain('id="ca-vnpt_smartca-sp-id"');
    expect(html).toContain('id="ca-vnpt_smartca-sp-password"');
    expect(html).toContain('id="ca-vnpt_smartca-user-id"');
    expect(html).toContain('id="ca-viettel_mysign-profile-id"');
    expect(html).toContain('id="ca-misa_wesign-client-key"');
    expect(html).toContain('id="ca-misa_wesign-username"');
    expect(html).toContain('id="ca-misa_wesign-password"');
    assertPairedLabels(html);

    const baseForm: LiveProviderFormState = {
      label: 'Test CA',
      certRef: 'cert-1',
      spId: 'sp-01',
      spPassword: 'sp-pw',
      clientId: 'cid-01',
      clientSecret: 'csec-01',
      clientKey: 'ckey-01',
      userId: 'uid-01',
      profileId: 'prof-01',
      serialNumber: 'SER-01',
      username: 'user-01',
      password: 'pw-01',
      taxCode: '0101234567',
      baseUrl: '',
    };

    expect(buildLiveCredentials('vnpt_smartca', baseForm)).toEqual({
      provider: 'vnpt_smartca',
      spId: 'sp-01',
      spPassword: 'sp-pw',
      userId: 'uid-01',
      serialNumber: 'SER-01',
    });
    expect(buildLiveCredentials('viettel_mysign', baseForm)).toEqual({
      provider: 'viettel_mysign',
      clientId: 'cid-01',
      clientSecret: 'csec-01',
      userId: 'uid-01',
      profileId: 'prof-01',
    });
    expect(buildLiveCredentials('misa_wesign', baseForm)).toEqual({
      provider: 'misa_wesign',
      clientId: 'cid-01',
      clientKey: 'ckey-01',
      username: 'user-01',
      password: 'pw-01',
      taxCode: '0101234567',
      userId: 'uid-01',
    });
  });

  it('shows broker missing notice and disables live CA save buttons when liveCaEnabled is true without broker', () => {
    const html = renderView('vi', 'owner', {
      liveCaEnabled: true,
      brokerAvailable: false,
      connections: [],
    });

    expect(html).toContain('data-testid="sign-ca-broker-missing-banner"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="sign-ca-save-vnpt_smartca"/);
  });

  it('hydrates SignSettingsPage from org.get and sign.ca-settings queries', () => {
    const qc = new QueryClient();
    qc.setQueryData(['org', 'get'], { role: 'owner' });
    qc.setQueryData(['sign', 'ca-settings'], {
      liveCaEnabled: false,
      brokerAvailable: false,
      connections: [makeSandboxConnection()],
    } satisfies SignCaSettingsResult);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
          <SignSettingsPage />
        </IntlProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('data-testid="sign-settings-page"');
    expect(html).toContain('Sandbox PAdES Cong ty');
    expect(html).toContain('Chờ thẩm định pháp lý &amp; cấp kết nối');
  });
});
