// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end eSign Slice 1c smoke test (#3325, docs/plan/esign.md section 8):
// upload PDF -> manual placement with AI off -> copy Zalo link -> sequential mobile 375px signing + Mailpit OTP
// -> seal -> download & verify SHA-256 offline + cert lookup -> per-org MODULE_OFF 404.
import fs from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { MAILPIT_URL } from '../lib/mail.ts';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';

interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
}

// Builds a valid 1-page A4 PDF with exact byte-offset xref table for pdf-lib and pdf.js.
function createMinimalPdfBytes(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]!).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

async function latestMailTo(recipient: string, subjectIncludes?: string): Promise<MailpitMessage | null> {
  const searchRes = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${recipient}"`)}`);
  if (!searchRes.ok) throw new Error(`Mailpit search failed: ${searchRes.status}`);
  const listed = (await searchRes.json()) as { messages?: Array<{ ID: string; Subject: string }> | null };
  const matches = (listed.messages ?? []).filter((m) => !subjectIncludes || m.Subject.includes(subjectIncludes));
  const hit = matches[0];
  if (!hit) return null;
  const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${hit.ID}`);
  if (!msgRes.ok) throw new Error(`Mailpit message failed: ${msgRes.status}`);
  return (await msgRes.json()) as MailpitMessage;
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
}

test('eSign workflow: upload, manual field placement, mobile 375px sequential signing with Mailpit OTP, seal, verify SHA-256, and MODULE_OFF 404', async ({
  page,
  browser,
}) => {
  const ownerEmail = newEmail('sign-owner');
  const signer1Email = newEmail('sign-party-a');
  const signer2Email = newEmail('sign-party-b');
  const docTitle = 'Hop dong dich vu E2E';
  const pdfBuffer = createMinimalPdfBytes();

  await page.goto('/');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Cong ty Ky Ket E2E');

  const envelopeDetailUrl = await test.step('open eSign app and upload PDF draft', async () => {
    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: 'eSign', exact: true }).click();
    await nav.getByRole('link', { name: 'Hồ sơ ký', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes$`));

    const newEnvelopeBtn = page.getByTestId('sign-new-envelope-btn');
    await newEnvelopeBtn.click();
    const createDialog = page.getByTestId('sign-create-dialog');
    await expect(createDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(createDialog).toHaveCount(0);
    await expect(newEnvelopeBtn).toBeFocused();

    await newEnvelopeBtn.click();
    await expect(createDialog).toBeVisible();
    await page.getByTestId('sign-upload-pdf-input').setInputFiles({
      name: 'hop-dong-e2e.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer,
    });
    await page.locator('#sign-new-title').fill(docTitle);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dialog-discard')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tiếp tục nhập' })).toBeFocused();
    await page.getByRole('button', { name: 'Tiếp tục nhập' }).click();
    await expect(page.locator('#sign-new-title')).toHaveValue(docTitle);
    await page.getByTestId('sign-create-submit-btn').click();

    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes/[^/]+$`));
    await expect(page.getByRole('heading', { name: docTitle })).toBeVisible();
    return page.url();
  });

  const envelopeId = envelopeDetailUrl.split('/').pop() ?? '';
  expect(envelopeId).toBeTruthy();

  await test.step('wait for PDF inspect, configure sequential signers, place fields manually with AI off fallback visible', async () => {
    await expect.poll(
      async () => {
        const badgeVisible = await page.getByText('PDF đạt chuẩn', { exact: true }).isVisible();
        if (!badgeVisible) await page.reload();
        return badgeVisible;
      },
      { message: 'PDF inspect status to become passed', timeout: 60_000, intervals: [1500, 2500, 3500] },
    ).toBe(true);

    // Vy drawer opens cleanly from its trigger with AI-off notice and manual parity, and closes on Escape.
    const vyTrigger = page.getByTestId('vy-clause-trigger');
    await expect(vyTrigger).toBeVisible();
    await vyTrigger.click();
    await expect(page.getByTestId('vy-clause-panel')).toBeVisible();
    await expect(page.getByTestId('vy-ai-off-notice')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('vy-clause-panel')).toHaveCount(0);
    await expect(vyTrigger).toBeFocused();
    await expect(page.getByTestId('pdf-canvas-viewer').locator('canvas').first()).toBeVisible();

    await page.locator('#sign-routing-mode').selectOption('sequential');

    const form = page.getByTestId('add-signer-form');
    await form.locator('#signer-name').fill('Nguyen Van A');
    await form.locator('#signer-email').fill(signer1Email);
    await form.locator('#signer-delivery').selectOption('link');
    await form.getByRole('checkbox', { name: 'Yêu cầu xác thực OTP qua email' }).check();
    await form.getByRole('button', { name: 'Thêm người nhận' }).click();
    await expect(page.getByTestId('signer-list')).toContainText('Nguyen Van A');

    // Place signature field for Signer 1 (selected automatically when first added).
    await page.getByTestId('palette-add-signature').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(1);

    // Add Signer 2 routed via email after Signer 1.
    await form.locator('#signer-name').fill('Tran Thi B');
    await form.locator('#signer-email').fill(signer2Email);
    await form.locator('#signer-delivery').selectOption('email');
    await form.getByRole('button', { name: 'Thêm người nhận' }).click();
    await expect(page.getByTestId('signer-list')).toContainText('Tran Thi B');

    await page.locator('[data-testid^="signer-select-"]').nth(1).click();
    await page.getByTestId('palette-add-signature').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(2);

    await page.getByTestId('sign-save-fields-btn').click();
    await expect(page.getByTestId('sign-save-fields-btn')).toBeDisabled();

    // Human-gated confirmation dialog before sending.
    await page.getByTestId('sign-send-open-btn').click();
    const confirmDialog = page.getByRole('dialog', { name: 'Xác nhận gửi yêu cầu ký' });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Gửi yêu cầu ký' }).click();
    await expect(page.getByText('Đã gửi', { exact: true })).toBeVisible();
  });

  const signer1Url = await test.step('mint Zalo link for Signer 1 and verify fragment-only URL', async () => {
    const firstRow = page.locator('[data-testid^="signer-row-"]').first();
    const linkCard = page.getByTestId('minted-zalo-links-card');
    const urlInput = linkCard.locator('[data-testid^="zalo-link-input-"]').first();
    const prevUrl = (await urlInput.count()) > 0 ? await urlInput.inputValue() : '';
    const createLinkResponse = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/signer/create_link') && res.request().method() === 'POST',
    );
    await firstRow.getByRole('button', { name: 'Chép link Zalo' }).click();
    const linkRes = await createLinkResponse;
    expect(linkRes.status()).toBe(200);
    await expect(linkCard).toBeVisible();
    await expect.poll(() => urlInput.inputValue()).not.toBe(prevUrl);
    const url = await urlInput.inputValue();
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/-/sign');
    expect(parsed.search).toBe('');
    expect(parsed.hash.length).toBeGreaterThan(10);
    return url;
  });

  await test.step('Signer 1 completes mobile 375px signing ceremony with Mailpit email OTP', async () => {
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mobilePage = await mobileContext.newPage();
    try {
      await mobilePage.goto(signer1Url);
      await expect(mobilePage.getByTestId('sign-ceremony-otp')).toBeVisible({ timeout: 20_000 });
      // Token fragment is scrubbed immediately after load so history/referrers cannot leak it.
      await expect.poll(() => new URL(mobilePage.url()).hash).toBe('');
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.getByTestId('otp-request-btn').click();
      let otpCode = '';
      await expect
        .poll(
          async () => {
            const mail = await latestMailTo(signer1Email);
            const match = `${mail?.Text ?? ''} ${mail?.HTML ?? ''}`.match(/\b(\d{6})\b/);
            otpCode = match?.[1] ?? '';
            return otpCode;
          },
          { message: '6-digit email OTP in Mailpit', timeout: 60_000 },
        )
        .toMatch(/^\d{6}$/);

      await mobilePage.getByTestId('otp-code-input').fill(otpCode);
      await mobilePage.getByTestId('otp-verify-btn').click();

      await expect(mobilePage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 20_000 });
      await expect(mobilePage.getByTestId('ceremony-remaining-badge')).toBeVisible();
      await expect(mobilePage.getByTestId('pdf-canvas-viewer').locator('canvas').first()).toBeVisible();
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.locator('[data-testid^="ceremony-sign-btn-"]').first().click();
      await mobilePage.getByRole('tab', { name: 'Gõ tên' }).click();
      await mobilePage.locator('#typed-signature-input').fill('Nguyen Van A');
      await mobilePage.getByTestId('signature-pad-apply').click();

      await expect(mobilePage.getByTestId('ceremony-remaining-badge')).toHaveCount(0);
      await mobilePage.getByTestId('ceremony-consent-checkbox').check();
      await mobilePage.getByTestId('ceremony-submit-btn').click();
      await expect(mobilePage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 20_000 });
    } finally {
      await mobileContext.close();
    }
  });

  await test.step('Signer 2 receives sequential invitation via Mailpit and finishes signing', async () => {
    let signer2Url = '';
    await expect
      .poll(
        async () => {
          const mail = await latestMailTo(signer2Email);
          const text = `${mail?.Text ?? ''} ${mail?.HTML ?? ''}`;
          const match = text.match(/https?:\/\/[^\s"'<>]+\/-\/sign#[A-Za-z0-9_-]+/);
          signer2Url = match?.[0] ?? '';
          return signer2Url;
        },
        { message: 'sequential signing link email for Signer 2', timeout: 60_000 },
      )
      .toContain('/-/sign#');

    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mobilePage = await mobileContext.newPage();
    try {
      await mobilePage.goto(signer2Url);
      await expect(mobilePage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 20_000 });
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.locator('[data-testid^="ceremony-sign-btn-"]').first().click();
      await mobilePage.getByRole('tab', { name: 'Gõ tên' }).click();
      await mobilePage.locator('#typed-signature-input').fill('Tran Thi B');
      await mobilePage.getByTestId('signature-pad-apply').click();

      await mobilePage.getByTestId('ceremony-consent-checkbox').check();
      await mobilePage.getByTestId('ceremony-submit-btn').click();
      await expect(mobilePage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 20_000 });
    } finally {
      await mobileContext.close();
    }
  });

  const verificationTarget = await test.step('wait for sealing, download sealed PDF, and verify SHA-256 offline in /sign/verify', async () => {
    await page.goto(envelopeDetailUrl);
    await expect
      .poll(
        async () => {
          const sealedVisible = await page.getByText('Đã niêm phong SHA-256', { exact: true }).isVisible();
          if (!sealedVisible) await page.reload();
          return sealedVisible;
        },
        { message: 'envelope sealing to complete', timeout: 60_000, intervals: [1500, 2500, 3500] },
      )
      .toBe(true);

    const evidenceCard = page.getByTestId('sign-evidence-card');
    await expect(evidenceCard).toBeVisible();
    const evidenceText = (await evidenceCard.textContent()) ?? '';
    const certMatch = evidenceText.match(/(?:CS|SIG)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    const certificateCode = certMatch?.[0] ?? '';
    expect(certificateCode).toMatch(/^(?:CS|SIG)-/);

    const downloadPromise = page.waitForEvent('download');
    await evidenceCard.getByRole('button', { name: 'Tải bản đã niêm phong' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const sealedPdfBytes = await fs.readFile(downloadPath!);

    await page.goto(`/o/${slug}/sign/verify`);
    await expect(page.getByRole('heading', { name: 'Xác minh tệp PDF ngoại tuyến' })).toBeVisible();
    await page.getByTestId('verify-pdf-input').setInputFiles({
      name: download.suggestedFilename() || 'sealed.pdf',
      mimeType: 'application/pdf',
      buffer: sealedPdfBytes,
    });
    const shaBox = page.getByTestId('verify-computed-sha256');
    await expect(shaBox).toBeVisible();
    const digestText = (await shaBox.textContent()) ?? '';
    const shaMatch = digestText.match(/[a-f0-9]{64}/);
    expect(shaMatch?.[0]).toMatch(/^[a-f0-9]{64}$/);

    await page.getByTestId('verify-cert-code-input').fill(certificateCode);
    await page.getByTestId('verify-check-btn').click();
    const banner = page.getByTestId('verify-verdict-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Toàn vẹn - khớp bản niêm phong gốc');

    return { certificateCode, fileSha256: shaMatch![0] };
  });

  const directToken = await test.step('enable a 1-signer Direct Signing Link and sign from /-/sign/d#<token> on 375px mobile', async () => {
    const session = await storedSession(page);
    const rpcHeaders = {
      authorization: `Bearer ${session?.access_token ?? ''}`,
      'x-ludy-org': slug,
    };

    const createTplRes = await page.request.post('/api/rpc/sign/template/create', {
      headers: rpcHeaders,
      data: {
        json: {
          title: 'Mau NDA truc tiep E2E',
          sourceEnvelopeId: envelopeId,
          copyRolesAndFields: false,
          status: 'active',
        },
      },
    });
    expect(createTplRes.status(), await createTplRes.text()).toBe(200);
    const createdTpl = ((await createTplRes.json()) as { json: { templateId: string } }).json;

    const rolesRes = await page.request.post('/api/rpc/sign/template/roles_set', {
      headers: rpcHeaders,
      data: {
        json: {
          templateId: createdTpl.templateId,
          roles: [
            {
              roleKey: 'r1',
              signerRole: 'signer',
              roleLabel: 'Đối tác',
              routingOrder: 1,
              deliveryMode: 'link',
              requireEmailOtp: false,
            },
          ],
        },
      },
    });
    expect(rolesRes.status(), await rolesRes.text()).toBe(200);

    const fieldsRes = await page.request.post('/api/rpc/sign/template/fields_set', {
      headers: rpcHeaders,
      data: {
        json: {
          templateId: createdTpl.templateId,
          fields: [
            {
              roleKey: 'r1',
              fieldType: 'signature',
              pageNumber: 1,
              xNorm: 0.15,
              yNorm: 0.72,
              wNorm: 0.3,
              hNorm: 0.08,
              required: true,
            },
          ],
        },
      },
    });
    expect(fieldsRes.status(), await fieldsRes.text()).toBe(200);

    const linkRes = await page.request.post('/api/rpc/sign/template/direct_link_set', {
      headers: rpcHeaders,
      data: {
        json: {
          templateId: createdTpl.templateId,
          enabled: true,
          requireEmailOtp: false,
        },
      },
    });
    expect(linkRes.status(), await linkRes.text()).toBe(200);
    const minted = ((await linkRes.json()) as { json: { url: string | null; token: string | null } }).json;
    expect(minted.url).toContain('/-/sign/d#');
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const baseOrigin = new URL(page.url()).origin;
    const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const mobilePage = await mobileContext.newPage();
    try {
      await mobilePage.goto(`${baseOrigin}${minted.url!}`);
      await expect(mobilePage.getByTestId('sign-direct-ready')).toBeVisible({ timeout: 20_000 });
      expect(mobilePage.url()).not.toContain('#');
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.getByTestId('direct-recipient-name-input').fill('Le Minh C');
      await mobilePage.getByTestId('direct-start-btn').click();

      await expect(mobilePage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 20_000 });
      expect(mobilePage.url()).toMatch(/\/-\/sign$/);
      expect(mobilePage.url()).not.toContain('#');
      await assertNoHorizontalOverflow(mobilePage);

      await mobilePage.locator('[data-testid^="ceremony-sign-btn-"]').first().click();
      await mobilePage.getByRole('tab', { name: 'Gõ tên' }).click();
      await mobilePage.locator('#typed-signature-input').fill('Le Minh C');
      await mobilePage.getByTestId('signature-pad-apply').click();

      await mobilePage.getByTestId('ceremony-consent-checkbox').check();
      await mobilePage.getByTestId('ceremony-submit-btn').click();
      await expect(mobilePage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 20_000 });
    } finally {
      await mobileContext.close();
    }

    return minted.token!;
  });

  await test.step('disabling sign module per-org returns opaque 404 on public verify/view routes', async () => {
    const session = await storedSession(page);
    const toggleRes = await page.request.post('/api/rpc/org/setApp', {
      headers: {
        authorization: `Bearer ${session?.access_token ?? ''}`,
        'x-ludy-org': slug,
      },
      data: { json: { module: 'sign', enabled: false } },
    });
    expect(toggleRes.status(), await toggleRes.text()).toBe(200);

    const tokenFragment = new URL(signer1Url).hash.slice(1);
    const viewAfterOff = await page.request.post('/api/sign/view', {
      data: { token: tokenFragment },
    });
    expect(viewAfterOff.status()).toBe(404);

    const directAfterOff = await page.request.post('/api/sign/direct/view', {
      data: { token: directToken },
    });
    expect(directAfterOff.status()).toBe(404);

    const verifyAfterOff = await page.request.post('/api/sign/verify', {
      data: {
        certificateCode: verificationTarget.certificateCode,
        fileSha256: verificationTarget.fileSha256,
      },
    });
    expect(verifyAfterOff.status()).toBe(404);
  });
});
