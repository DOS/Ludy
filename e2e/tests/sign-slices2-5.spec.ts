// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Page } from '@playwright/test';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.js';

/**
 * Playwright E2E coverage for eSign Slices 2 through 5 (DOS/Ludy #4606).
 *
 * Test 1 covers Slice 2 & Slice 4: reusable 1-signer template with signature,
 * stamp, dropdown, and text fields, public hub + direct signing link with
 * URL fragment scrubbing, mobile 375x812 completion ceremony, and sealed
 * SHA-256 evidence + certificate verification.
 *
 * Test 2 covers Slice 5b/5c/5d/5e: SME Playbook rule configuration, API key
 * creation/revocation, HMAC webhook SSRF rejection + valid URL creation/cleanup,
 * FormDialog PDF upload, deterministic Playbook check (AI off) + override,
 * KYC attachment upload + deterministic check + manual confirmation, and
 * external REST API /api/v1/sign/* auth, opaque 404, and no-store checks.
 */

function escapePdfLiteral(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createTextPdfBytes(lines: readonly string[]): Buffer {
  const safeLines = lines.length > 0 ? lines : ['Ludy eSign E2E Document'];
  const commands = [
    'BT',
    '/F1 11 Tf',
    '50 780 Td',
    '14 TL',
    ...safeLines.map((line) => `(${escapePdfLiteral(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const streamLength = Buffer.byteLength(commands, 'latin1');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${commands}\nendstream\nendobj\n`,
  ];

  const header = '%PDF-1.4\n';
  const chunks: string[] = [header];
  let offset = Buffer.byteLength(header, 'latin1');
  const offsets: number[] = [];

  for (const obj of objects) {
    offsets.push(offset);
    chunks.push(obj);
    offset += Buffer.byteLength(obj, 'latin1');
  }

  const xrefOffset = offset;
  const xrefRows = offsets.map((pos) => `${String(pos).padStart(10, '0')} 00000 n \n`).join('');
  chunks.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefRows}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.from(chunks.join(''), 'latin1');
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe('eSign Slices 2-5 E2E', () => {
  test('Slice 2 & 4: template with stamp/dropdown/text fields, public hub & direct link ceremony, and sealing', async ({
    page,
    browser,
  }) => {
    const email = newEmail('esign-s24');
    await signInNewUser(page, email);
    const slug = await createOrg(page, 'E2E eSign S24');

    await page.getByRole('navigation').getByRole('link', { name: 'eSign', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Mẫu tài liệu', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/templates`));

    const templateTitle = `Service Addendum Template ${Date.now()}`;
    await page.getByTestId('sign-tpl-new-btn').click();
    await page.locator('#sign-tpl-create-title').fill(templateTitle);
    await page.locator('#sign-tpl-create-desc').fill('Reusable 1-signer addendum with Slice 4 fields');
    await page.locator('#sign-tpl-create-file').setInputFiles({
      name: 'template-addendum.pdf',
      mimeType: 'application/pdf',
      buffer: createTextPdfBytes([
        'REUSABLE SERVICE ADDENDUM',
        'Party A: Ludy Pilot Partner Co., Ltd.',
        'Party B: Customer Counterparty',
        'Please complete signature, stamp, billing cycle, and branch code below.',
      ]),
    });
    await page.getByTestId('sign-tpl-create-submit-btn').click();

    await expect(page.getByTestId('pdf-canvas-viewer').locator('canvas').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('sign-tpl-activate-btn')).toBeEnabled({ timeout: 60_000 });

    // Define 1 signer role and save roles.
    await page.getByTestId('sign-tpl-add-role-btn').click();
    await page.locator('#sign-tpl-role-label-0').fill('Client Signer');
    const saveRolesResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/template/roles_set') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-tpl-save-roles-btn').click();
    expect((await saveRolesResp).status()).toBe(200);
    await expect(page.locator('#sign-tpl-active-role')).toBeVisible();

    // Place signature, stamp, dropdown (with custom options), and text fields.
    await page.getByTestId('sign-tpl-add-field-signature').click();
    await page.getByTestId('sign-tpl-add-field-stamp').click();
    await page.getByTestId('sign-tpl-add-field-dropdown').click();
    await expect(page.getByTestId('field-options-editor')).toBeVisible();
    await page.getByTestId('field-option-input-0').fill('12 months');
    await page.getByTestId('field-option-input-1').fill('24 months');
    await page.getByTestId('sign-tpl-add-field-text').click();

    const saveFieldsResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/template/fields_set') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-tpl-save-fields-btn').click();
    expect((await saveFieldsResp).status()).toBe(200);
    await expect(page.getByText('1 vai trò | 4 ô ký')).toBeVisible();

    // Activate template, enable Direct Signing Link, and toggle Public Hub visibility.
    await page.getByTestId('sign-tpl-activate-btn').click();
    const directToggle = page.getByRole('checkbox', { name: 'Bật liên kết ký trực tiếp' });
    await expect(directToggle).toBeVisible();

    const enableDirectResp = page.waitForResponse(
      (res) =>
        res.url().includes('/api/rpc/sign/template/direct_link_set') && res.request().method() === 'POST',
    );
    await directToggle.click();
    expect((await enableDirectResp).status()).toBe(200);
    await expect(directToggle).toHaveAttribute('aria-checked', 'true');

    const directUrlInput = page.locator('#sign-tpl-direct-url');
    await expect(directUrlInput).toBeVisible();
    const directUrl = await directUrlInput.inputValue();
    expect(directUrl).toContain('/-/sign/d#');

    const publicHubToggle = page.getByRole('checkbox', {
      name: 'Hiển thị trên cổng biểu mẫu công khai',
    });
    await expect(publicHubToggle).toBeVisible();
    const enableHubResp = page.waitForResponse(
      (res) =>
        res.url().includes('/api/rpc/sign/template/direct_link_set') && res.request().method() === 'POST',
    );
    await publicHubToggle.click();
    expect((await enableHubResp).status()).toBe(200);
    await expect(publicHubToggle).toHaveAttribute('aria-checked', 'true');

    const publicHubUrlInput = page.getByTestId('sign-tpl-public-hub-url-input');
    await expect(publicHubUrlInput).toBeVisible();
    const publicHubUrl = await publicHubUrlInput.inputValue();
    expect(publicHubUrl).toContain(`/-/sign/p/${slug}`);

    // Unauthenticated mobile viewport verification for Public Hub + Direct Link ceremony.
    const origin = new URL(page.url()).origin;
    const publicCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const publicPage = await publicCtx.newPage();

    try {
      await publicPage.goto(`${origin}/-/sign/p/${slug}`);
      await expect(publicPage.getByTestId('sign-public-hub-directory')).toBeVisible({ timeout: 30_000 });
      await expect(publicPage.getByTestId('sign-public-hub-list')).toContainText(templateTitle);
      await assertNoHorizontalOverflow(publicPage);

      // Open direct signing link; verify fragment token is scrubbed from URL cleanly.
      await publicPage.goto(directUrl);
      await expect(publicPage.getByTestId('sign-direct-ready')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => new URL(publicPage.url()).hash).toBe('');
      await assertNoHorizontalOverflow(publicPage);

      const recipientName = 'Tran Thi Binh';
      await publicPage.getByTestId('direct-recipient-name-input').fill(recipientName);
      await publicPage.getByTestId('direct-start-btn').click();

      await expect(publicPage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => new URL(publicPage.url()).hash).toBe('');
      await expect(publicPage.getByTestId('pdf-canvas-viewer').locator('canvas').first()).toBeVisible({
        timeout: 30_000,
      });
      await assertNoHorizontalOverflow(publicPage);

      // Complete typed signature field.
      await publicPage.locator('[data-testid^="ceremony-sign-btn-"]', { hasText: 'Bấm để ký' }).first().click();
      await publicPage
        .getByRole('tab', { name: 'Gõ tên' })
        .or(publicPage.getByRole('button', { name: 'Gõ tên' }))
        .click();
      await publicPage.locator('#typed-signature-input').fill(recipientName);
      await publicPage.getByTestId('signature-pad-apply').click();

      // Complete stamp pad modal on generate tab.
      await publicPage.locator('[data-testid^="ceremony-sign-btn-"]', { hasText: 'Bấm đóng dấu' }).first().click();
      await publicPage.getByTestId('stamp-primary-input').fill('CONG TY BINH AN');
      await publicPage.getByTestId('stamp-subtitle-input').fill('MST 0312345678');
      await publicPage.getByTestId('stamp-pad-apply').click();

      // Complete dropdown and text fields.
      await publicPage.locator('[data-testid^="ceremony-dropdown-"]').first().selectOption('24 months');
      await publicPage.getByPlaceholder('Nhập nội dung...').first().fill('HCM Branch 01');

      // Accept legal consent and submit signed ceremony.
      const consentCheckbox = publicPage.getByTestId('ceremony-consent-checkbox');
      await expect(consentCheckbox).toBeEnabled();
      await consentCheckbox.check();
      const submitBtn = publicPage.getByTestId('ceremony-submit-btn');
      await expect(submitBtn).toBeEnabled();
      await submitBtn.click();

      await expect(publicPage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 30_000 });
    } finally {
      await publicCtx.close();
    }

    // Verify completed envelope appears in org envelopes list and becomes SHA-256 sealed with certificate.
    // Force a fresh page load so TanStack Query does not serve the empty list cached within 10s staleTime.
    await page.getByRole('navigation').getByRole('link', { name: 'Hồ sơ ký', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes`));
    await page.reload();

    const envelopeRowLink = page.getByRole('link', { name: new RegExp(templateTitle) }).first();
    await expect(envelopeRowLink).toBeVisible({ timeout: 30_000 });
    await envelopeRowLink.click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes/[^/]+$`));

    await expect(page.getByText('Đã niêm phong SHA-256')).toBeVisible({ timeout: 60_000 });

    const evidenceCard = page.getByTestId('sign-evidence-card');
    await expect(evidenceCard).toBeVisible();
    await expect(evidenceCard).toContainText('SHA-256 bản niêm phong', { timeout: 20_000 });
    await expect(evidenceCard).toContainText('Chuỗi băm toàn vẹn');
    await expect(evidenceCard).toContainText(/(?:CS|SIG)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });

  test('Slice 5: Playbook rules & check, API keys & webhook SSRF safety, KYC upload & check, and /api/v1/sign/*', async ({
    page,
    browser,
    playwright,
  }) => {
    const email = newEmail('esign-s5');
    await signInNewUser(page, email);
    const slug = await createOrg(page, 'E2E eSign S5');

    const session = await storedSession(page);
    expect(session?.access_token).toBeTruthy();

    // 1. eSign Settings: Playbook rules, scoped API key, and HMAC webhook validation.
    await page.getByRole('navigation').getByRole('link', { name: 'eSign', exact: true }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Chữ ký số & con dấu', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/settings`));

    // Verify 6 VN SME default playbook rules and add a custom keyword rule.
    const playbookCard = page.getByTestId('sign-playbook-rules-card');
    await expect(playbookCard).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('playbook-rules-list').locator('li')).toHaveCount(6);

    await page.getByTestId('playbook-add-rule-btn').click();
    await page.locator('#playbook-rule-title').fill('Custom Exclusivity Check');
    await page.locator('#playbook-rule-guidance').fill('Flag custom exclusivity clause for manual review');
    await page.locator('#playbook-rule-keywords').fill('exclusivity_e2e_clause');
    await page.getByTestId('playbook-save-rule-btn').click();
    await expect(page.getByTestId('playbook-rules-list').locator('li')).toHaveCount(7);

    // Create a scoped API key (sign:read + sign:draft) and capture its once-shown secret.
    const apiKeysSection = page.getByTestId('sign-api-keys-section');
    await expect(apiKeysSection).toBeVisible();
    await page.getByTestId('sign-api-key-name-input').fill('E2E Partner Integration Key');
    await expect(page.getByTestId('sign-api-key-scope-read')).toBeChecked();
    await page.getByTestId('sign-api-key-scope-draft').check();

    await page.getByTestId('sign-api-key-create-btn').click();
    await expect(page.getByTestId('sign-api-key-secret-banner')).toBeVisible({ timeout: 15_000 });
    const apiKeySecret = await page.getByTestId('sign-api-key-secret-input').inputValue();
    expect(apiKeySecret).toMatch(/^ludy_sk_/);
    await page.getByTestId('sign-api-key-dismiss-btn').click();
    await expect(page.getByTestId('sign-api-key-list')).toContainText('E2E Partner Integration Key');

    // Webhook SSRF check: private loopback IP must be rejected at Zod validation with 400.
    const webhooksSection = page.getByTestId('sign-webhooks-section');
    await expect(webhooksSection).toBeVisible();
    await expect(page.getByTestId('sign-webhooks-count-badge')).toContainText('0 / 20 địa chỉ');

    const ssrfUrlInput = page.getByTestId('sign-webhook-new-url-input');
    await ssrfUrlInput.fill('https://127.0.0.1/ssrf-blocked');
    const ssrfResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/webhook/create') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-webhook-create-submit').click();
    expect((await ssrfResp).status()).toBe(400);
    await expect(page.getByTestId('sign-webhooks-count-badge')).toContainText('0 / 20 địa chỉ');
    await expect(page.getByTestId('sign-webhooks-list')).toHaveCount(0);
    await expect(page.getByTestId('sign-webhooks-secret-reveal')).toHaveCount(0);

    // Valid public HTTPS webhook creation (no ping fired; deleted right after secret verification).
    await ssrfUrlInput.fill('https://example.com/ludy-esign-webhook');
    const createWebhookResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/webhook/create') && res.request().method() === 'POST',
    );
    await page.getByTestId('sign-webhook-create-submit').click();
    expect((await createWebhookResp).status()).toBe(200);

    await expect(page.getByTestId('sign-webhooks-secret-reveal')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('sign-webhooks-secret-value')).toHaveText(/^whsec_[A-Za-z0-9_-]+$/);
    await page.getByTestId('sign-webhooks-secret-dismiss').click();
    await expect(page.getByTestId('sign-webhooks-list')).toContainText('https://example.com/ludy-esign-webhook');
    await expect(page.getByTestId('sign-webhooks-count-badge')).toContainText('1 / 20 địa chỉ');

    await webhooksSection.locator('[data-testid^="sign-webhook-delete-"]').first().click();
    await page
      .getByRole('dialog', { name: 'Xóa địa chỉ webhook này?' })
      .getByRole('button', { name: 'Xóa', exact: true })
      .click();
    await expect(page.getByTestId('sign-webhooks-count-badge')).toContainText('0 / 20 địa chỉ');

    // 2. Upload contract PDF via FormDialog, inspect, run deterministic Playbook check + manual override.
    await page.getByRole('navigation').getByRole('link', { name: 'Hồ sơ ký', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes`));

    await page.getByTestId('sign-new-envelope-btn').click();
    await expect(page.getByTestId('sign-create-dialog')).toBeVisible();

    const contractTitle = `Vendor Agreement S5 ${Date.now()}`;
    await page.getByTestId('sign-upload-pdf-input').setInputFiles({
      name: 'vendor-contract-s5.pdf',
      mimeType: 'application/pdf',
      buffer: createTextPdfBytes([
        'VENDOR SERVICE AGREEMENT',
        'Party A: Cong ty TNHH ABC Viet Nam (MST 0312345678)',
        'Party B: Nguyen Van An',
        'Governing law: laws of Vietnam under Ho Chi Minh City court.',
        'Payment term: net 45 days after receipt of valid VAT invoice.',
        'Late penalty: 12% per month on overdue balance.',
        'Clause: exclusivity_e2e_clause applies during the initial term.',
      ]),
    });
    await page.locator('#sign-new-title').fill(contractTitle);
    await page.getByTestId('sign-create-submit-btn').click();

    await expect(page).toHaveURL(new RegExp(`/o/${slug}/sign/envelopes/[^/]+$`), { timeout: 30_000 });
    const envelopeId = new URL(page.url()).pathname.split('/').pop()!;

    // Wait for pdf_inspect to finish before sending or running checks.
    await expect(async () => {
      const badge = page.getByText('PDF đạt chuẩn', { exact: true });
      if (!(await badge.isVisible())) {
        await page.reload();
      }
      await expect(badge).toBeVisible();
    }).toPass({ timeout: 60_000, intervals: [2000, 3000] });

    // Run deterministic SME Playbook check with zero LLM dependency.
    const envPlaybookCard = page.getByTestId('envelope-playbook-card');
    await expect(envPlaybookCard).toBeVisible();
    await page.getByTestId('playbook-run-rule-btn').click();
    await expect(page.getByTestId('playbook-findings-list')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('playbook-summary-counts')).toBeVisible();
    await expect(page.getByTestId('playbook-findings-list')).toContainText('Custom Exclusivity Check');
    await expect(page.getByTestId('playbook-run-rule-btn')).toBeEnabled({ timeout: 20_000 });

    // Verify AI check gracefully surfaces notice when AI endpoint is disabled in E2E stack,
    // and wait for mutation/invalidation to settle so override uses the current check revision.
    await page.getByTestId('playbook-run-ai-btn').click();
    await expect(page.getByTestId('playbook-ai-notice')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('playbook-run-ai-btn')).toBeEnabled({ timeout: 20_000 });

    // Apply a manual override on the first finding row and assert persisted badge.
    const overrideSelect = page.locator('[data-testid^="playbook-override-select-"]').first();
    const currentStatus = await overrideSelect.inputValue();
    const overrideOptions = await overrideSelect.locator('option').evaluateAll((opts) =>
      opts.map((opt) => (opt as HTMLOptionElement).value).filter((v) => v.length > 0),
    );
    const nextStatus =
      (overrideOptions.includes('pass') && currentStatus !== 'pass'
        ? 'pass'
        : overrideOptions.find((v) => v !== currentStatus)) ?? overrideOptions[0];
    if (nextStatus) {
      await overrideSelect.selectOption(nextStatus);
    }
    await page.locator('[data-testid^="playbook-override-note-"]').first().fill('Owner approved threshold');
    await page.locator('[data-testid^="playbook-override-save-"]').first().click();
    await expect(page.locator('[data-testid^="playbook-overridden-badge-"]').first()).toContainText(
      'Đã xác nhận tay',
      { timeout: 15_000 },
    );

    // 3. Add link-based signer, place signature + KYC attachment fields, and send envelope.
    const signerName = 'Nguyen Van An';
    const addSignerForm = page.getByTestId('add-signer-form');
    await addSignerForm.locator('#signer-name').fill(signerName);
    await addSignerForm.locator('#signer-delivery').selectOption('link');
    await addSignerForm.getByRole('button', { name: 'Thêm người nhận' }).click();
    await expect(page.getByTestId('signer-list')).toContainText(signerName, { timeout: 15_000 });

    await page.getByTestId('palette-add-signature').click();
    await page.getByTestId('palette-add-attachment').click();
    await expect(page.locator('[data-testid^="placed-field-"]')).toHaveCount(2);
    const saveFieldsBtn = page.getByTestId('sign-save-fields-btn');
    await expect(saveFieldsBtn).toBeEnabled();
    await saveFieldsBtn.click();
    await expect(saveFieldsBtn).toBeDisabled({ timeout: 15_000 });

    await page.getByTestId('sign-send-open-btn').click();
    const sendConfirmDialog = page.getByRole('dialog', { name: 'Xác nhận gửi yêu cầu ký' });
    await expect(sendConfirmDialog).toBeVisible();
    await sendConfirmDialog.getByRole('button', { name: 'Gửi yêu cầu ký' }).click();
    await expect(page.getByText('Đã gửi', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    const zaloLinksCard = page.getByTestId('minted-zalo-links-card');
    await expect(zaloLinksCard).toBeVisible({ timeout: 15_000 });
    const zaloLinkInput = zaloLinksCard.locator('[data-testid^="zalo-link-input-"]').first();
    const prevUrl = await zaloLinkInput.inputValue();

    const mintResp = page.waitForResponse(
      (res) => res.url().includes('/api/rpc/sign/signer/create_link') && res.request().method() === 'POST',
    );
    await page.locator('[data-testid^="signer-row-"]').first().getByRole('button', { name: 'Chép link Zalo' }).click();
    expect((await mintResp).status()).toBe(200);

    await expect.poll(() => zaloLinkInput.inputValue(), { timeout: 15_000 }).not.toBe(prevUrl);
    const mintedLink = await zaloLinkInput.inputValue();
    expect(mintedLink).toContain('/-/sign#');

    // 4. Unauthenticated mobile signer signs and uploads KYC attachment PDF.
    const signerCtx = await browser.newContext({
      viewport: { width: 375, height: 812 },
    });
    const signerPage = await signerCtx.newPage();

    try {
      await signerPage.goto(mintedLink);
      await expect(signerPage.getByTestId('sign-ceremony-ready')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => new URL(signerPage.url()).hash).toBe('');
      await expect(signerPage.getByTestId('pdf-canvas-viewer').locator('canvas').first()).toBeVisible({
        timeout: 30_000,
      });
      await assertNoHorizontalOverflow(signerPage);

      await signerPage.locator('[data-testid^="ceremony-sign-btn-"]', { hasText: 'Bấm để ký' }).first().click();
      await signerPage
        .getByRole('tab', { name: 'Gõ tên' })
        .or(signerPage.getByRole('button', { name: 'Gõ tên' }))
        .click();
      await signerPage.locator('#typed-signature-input').fill(signerName);
      await signerPage.getByTestId('signature-pad-apply').click();

      await signerPage.locator('[data-testid^="ceremony-attachment-input-"]').first().setInputFiles({
        name: 'kyc-dossier.pdf',
        mimeType: 'application/pdf',
        buffer: createTextPdfBytes([
          'DOSSIER XAC MINH KYC',
          'Doanh nghiep: Cong ty TNHH ABC Viet Nam',
          'Ma so thue MST: 0312345678',
          'Nguoi dai dien: Nguyen Van An',
          'So CCCD: 079090001234',
        ]),
      });

      const attachmentSummary = signerPage.locator('[data-testid^="ceremony-attachment-summary-"]').first();
      await expect(attachmentSummary).toBeVisible({ timeout: 20_000 });
      await expect(attachmentSummary).toContainText('kyc-dossier.pdf');
      await expect(attachmentSummary).toContainText('SHA-256:');

      const consentCheckbox = signerPage.getByTestId('ceremony-consent-checkbox');
      await expect(consentCheckbox).toBeEnabled();
      await consentCheckbox.check();
      await signerPage.getByTestId('ceremony-submit-btn').click();
      await expect(signerPage.getByTestId('sign-ceremony-completed')).toBeVisible({ timeout: 30_000 });
    } finally {
      await signerCtx.close();
    }

    // 5. Inspect KYC attachment on envelope detail: deterministic check, preview, and manual match.
    await page.reload();
    const kycCard = page.getByTestId('sign-kyc-card');
    await expect(kycCard).toBeVisible({ timeout: 30_000 });

    await kycCard.locator('[id^="kyc-expected-entity-"]').first().fill('Cong ty TNHH ABC Viet Nam');
    await kycCard.locator('[id^="kyc-expected-mst-"]').first().fill('0312345678');
    await kycCard.locator('[data-testid^="sign-kyc-run-deterministic-"]').first().click();

    const kycDetList = kycCard.locator('[data-testid^="sign-kyc-deterministic-list-"]').first();
    await expect(kycDetList).toBeVisible({ timeout: 20_000 });
    await expect(kycDetList).toContainText('0312345678');

    await kycCard.locator('[data-testid^="sign-kyc-toggle-preview-"]').first().click();
    await expect(kycCard.locator('[data-testid^="sign-kyc-preview-pane-"]').first()).toBeVisible({
      timeout: 15_000,
    });

    await kycCard.locator('[id^="kyc-manual-note-"]').first().fill('Matched tax ID 0312345678 and CCCD');
    await kycCard.locator('[data-testid^="sign-kyc-confirm-matched-"]').first().click();
    await expect(kycCard.locator('[data-testid^="sign-kyc-status-"]').first()).toContainText('Đã khớp', {
      timeout: 15_000,
    });

    // Wait for background SHA-256 sealing before hitting /api/v1/sign/envelopes/:id/sealed.
    await expect(page.getByText('Đã niêm phong SHA-256')).toBeVisible({ timeout: 60_000 });
    const evidenceCard = page.getByTestId('sign-evidence-card');
    await expect(evidenceCard).toBeVisible();
    await expect(evidenceCard).toContainText('SHA-256 bản niêm phong', { timeout: 20_000 });
    await expect(evidenceCard).toContainText('Chuỗi băm toàn vẹn');

    // 6. External REST API /api/v1/sign/* verification using an unauthenticated APIRequestContext (no cookies).
    const baseURL = new URL(page.url()).origin;
    const apiCtx = await playwright.request.newContext({ baseURL });

    try {
      const queryTokenRes = await apiCtx.get('/api/v1/sign/envelopes?token=ludy_sk_forbidden');
      expect(queryTokenRes.status()).toBe(400);

      const invalidKeyRes = await apiCtx.get('/api/v1/sign/envelopes', {
        headers: { authorization: 'Bearer ludy_sk_invalid_000000' },
      });
      expect(invalidKeyRes.status()).toBe(401);

      const authHeaders = { authorization: `Bearer ${apiKeySecret}` };
      const listRes = await apiCtx.get('/api/v1/sign/envelopes', { headers: authHeaders });
      expect(listRes.status()).toBe(200);
      expect(listRes.headers()['cache-control']).toContain('no-store');
      expect(await listRes.text()).toContain(envelopeId);

      const detailRes = await apiCtx.get(`/api/v1/sign/envelopes/${envelopeId}`, { headers: authHeaders });
      expect(detailRes.status()).toBe(200);

      const sealedRes = await apiCtx.get(`/api/v1/sign/envelopes/${envelopeId}/sealed`, {
        headers: authHeaders,
      });
      expect(sealedRes.status()).toBe(200);
      expect(sealedRes.headers()['content-type']).toContain('application/pdf');
      expect((await sealedRes.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

      const certRes = await apiCtx.get(`/api/v1/sign/envelopes/${envelopeId}/certificate`, {
        headers: authHeaders,
      });
      expect(certRes.status()).toBe(200);

      const tplRes = await apiCtx.get('/api/v1/sign/templates', { headers: authHeaders });
      expect(tplRes.status()).toBe(200);

      // Opaque 404 when sign module is disabled on the org, then re-enable.
      const rpcHeaders = {
        authorization: `Bearer ${session?.access_token ?? ''}`,
        'x-ludy-org': slug,
      };
      const disableSignRes = await page.request.post('/api/rpc/org/setApp', {
        headers: rpcHeaders,
        data: { json: { module: 'sign', enabled: false } },
      });
      expect(disableSignRes.status(), await disableSignRes.text()).toBe(200);

      const opaque404Res = await apiCtx.get('/api/v1/sign/envelopes', { headers: authHeaders });
      expect(opaque404Res.status()).toBe(404);

      const enableSignRes = await page.request.post('/api/rpc/org/setApp', {
        headers: rpcHeaders,
        data: { json: { module: 'sign', enabled: true } },
      });
      expect(enableSignRes.status(), await enableSignRes.text()).toBe(200);

      // Revoke the API key in Settings and verify immediate 401 rejection.
      await page.goto(`${baseURL}/o/${slug}/sign/settings`);
      await expect(page.getByTestId('sign-api-keys-section')).toBeVisible({ timeout: 20_000 });
      await page.locator('[data-testid^="sign-api-key-revoke-btn-"]').first().click();
      await page
        .getByRole('dialog', { name: 'Thu hồi khóa API này?' })
        .getByRole('button', { name: 'Thu hồi', exact: true })
        .click();

      await expect
        .poll(async () => (await apiCtx.get('/api/v1/sign/envelopes', { headers: authHeaders })).status(), {
          timeout: 15_000,
        })
        .toBe(401);
    } finally {
      await apiCtx.dispose();
    }
  });
});
