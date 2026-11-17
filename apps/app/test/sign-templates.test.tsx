// SPDX-License-Identifier: AGPL-3.0-only
// Component, accessibility, and helper tests for /sign/templates UI (#3526).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import type { SignTemplateDetail } from '../src/lib/sign-api.ts';
import { buildDirectSigningUrl } from '../src/lib/sign-hash.ts';
import { DirectLinkCard, TemplateRolesCard, canAutoSendTemplate } from '../src/routes/sign-templates.tsx';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ slug: 'acme' }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  return {
    orpc: {},
    queryClient: new QC(),
    client: {},
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
  };
});

function makeTemplateDetail(overrides: Partial<SignTemplateDetail> = {}): SignTemplateDetail {
  return {
    template: {
      id: '01900000-0000-7000-8000-000000000010',
      title: 'Hop dong dich vu',
      description: 'Mau dung hang thang',
      routingMode: 'parallel',
      subject: null,
      message: null,
      expiresInHours: 168,
      status: 'active',
      inspectStatus: 'passed',
      inspectError: null,
      sourceFileId: '01900000-0000-7000-8000-000000000011',
      sourceSha256: 'a'.repeat(64),
      pageCount: 1,
      pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      version: 1,
      archivedAt: null,
      createdBy: '01900000-0000-7000-8000-000000000012',
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
    roles: [
      {
        id: '01900000-0000-7000-8000-000000000021',
        roleKey: 'r1',
        signerRole: 'signer',
        roleLabel: 'Khach hang ky',
        routingOrder: 1,
        deliveryMode: 'link',
        requireEmailOtp: false,
      },
      {
        id: '01900000-0000-7000-8000-000000000022',
        roleKey: 'cc1',
        signerRole: 'cc',
        roleLabel: 'Ke toan CC',
        routingOrder: 2,
        deliveryMode: 'email',
        requireEmailOtp: false,
      },
    ],
    fields: [
      {
        id: '01900000-0000-7000-8000-000000000031',
        templateRoleId: '01900000-0000-7000-8000-000000000021',
        roleKey: 'r1',
        fieldType: 'signature',
        pageNumber: 1,
        xNorm: 0.5,
        yNorm: 0.7,
        wNorm: 0.24,
        hNorm: 0.08,
        label: 'Chu ky',
        required: true,
        fontSizePt: null,
      },
    ],
    directLink: {
      id: '01900000-0000-7000-8000-000000000041',
      enabled: true,
      requireEmailOtp: true,
      lastRotatedAt: null,
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

function assertPairedLabels(html: string): void {
  const labelForMatches = new Set(Array.from(html.matchAll(/<label[^>]+for="([^"]+)"/g), (m) => m[1]!));
  for (const tagMatch of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = tagMatch[0];
    if (tag.includes('type="hidden"')) continue;
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `control missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `control missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
  for (const cbMatch of html.matchAll(/<button[^>]+role="checkbox"[^>]*>/g)) {
    const tag = cbMatch[0];
    const idMatch = tag.match(/\bid="([^"]+)"/);
    expect(idMatch, `checkbox missing id: ${tag}`).not.toBeNull();
    expect(labelForMatches.has(idMatch![1]!), `checkbox missing paired <label for="${idMatch![1]}">`).toBe(true);
  }
}

describe('eSign templates UI components (#3526)', () => {
  it('formats direct signing links strictly in the URL fragment (/-/sign/d#<token>)', () => {
    const token = 'A'.repeat(43);
    const url = buildDirectSigningUrl(token, 'https://app.crove.vn');
    expect(url).toBe(`https://app.crove.vn/-/sign/d#${token}`);
    expect(url).not.toContain('?token=');
  });

  it('enforces canAutoSendTemplate rules cleanly for Signer vs Approver roles', () => {
    const ready = makeTemplateDetail();
    expect(canAutoSendTemplate(ready)).toBe(true);

    const noSig = makeTemplateDetail({ fields: [] });
    expect(canAutoSendTemplate(noSig)).toBe(false);

    const approverOnly = makeTemplateDetail({
      roles: [
        {
          id: '01900000-0000-7000-8000-000000000099',
          roleKey: 'r1',
          signerRole: 'approver',
          roleLabel: 'Quan ly',
          routingOrder: 1,
          deliveryMode: 'link',
          requireEmailOtp: false,
        },
      ],
      fields: [],
    });
    expect(canAutoSendTemplate(approverOnly)).toBe(true);

    const uninspected = makeTemplateDetail({
      template: { ...ready.template, inspectStatus: 'pending', pageCount: null },
    });
    expect(canAutoSendTemplate(uninspected)).toBe(false);
  });

  it('renders TemplateRolesCard and DirectLinkCard in vi and en with paired labels and zero secret leaks', () => {
    const detail = makeTemplateDetail();
    const freshToken = 'B'.repeat(43);
    const freshUrl = buildDirectSigningUrl(freshToken, 'https://app.crove.vn');

    for (const locale of ['vi', 'en'] as const) {
      const rolesHtml = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <TemplateRolesCard
            roles={detail.roles.map((r) => ({ ...r, localId: r.id }))}
            editable={true}
            saving={false}
            onChangeRoles={() => {}}
            onSaveRoles={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(rolesHtml);
      expect(rolesHtml).toContain('r1');
      expect(rolesHtml).toContain('cc1');

      const directHtml = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={catalog(locale)}>
          <DirectLinkCard
            detail={detail}
            freshDirectUrl={freshUrl}
            pending={false}
            onToggleEnabled={() => {}}
            onToggleOtp={() => {}}
            onRotate={() => {}}
            onCopyUrl={() => {}}
          />
        </IntlProvider>,
      );
      assertPairedLabels(directHtml);
      expect(directHtml).toContain(freshUrl);
      expect(directHtml).not.toContain('token_sha256');
    }

    // Two active non-CC roles show rule hint instead of enable switch.
    const multiRoleDetail = makeTemplateDetail({
      roles: [
        ...detail.roles,
        {
          id: '01900000-0000-7000-8000-000000000023',
          roleKey: 'r2',
          signerRole: 'approver',
          roleLabel: 'Duyet',
          routingOrder: 2,
          deliveryMode: 'email',
          requireEmailOtp: false,
        },
      ],
      directLink: null,
    });
    const blockedHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" messages={catalog('vi')}>
        <DirectLinkCard
          detail={multiRoleDetail}
          freshDirectUrl={null}
          pending={false}
          onToggleEnabled={() => {}}
          onToggleOtp={() => {}}
          onRotate={() => {}}
          onCopyUrl={() => {}}
        />
      </IntlProvider>,
    );
    expect(blockedHtml).not.toContain('sign-tpl-direct-enabled');
  });
});
