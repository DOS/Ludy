// SPDX-License-Identifier: AGPL-3.0-only
// An image a customer mails to the org's Hộp thư address (#2758): the mail goes through the real inbound endpoint and the worker, and the thread
// shows the picture; a PDF in the same mail is listed by name with no bytes. The screen passes an axe scan with the image in it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

// compose.e2e.yml's INBOUND_SECRET.
const INBOUND_SECRET = 'e2e-only-inbound-secret-0123456789abcdef';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1').toString('base64');
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

function mail(to: string): string {
  const boundary = 'e2e-boundary-2758';
  return [
    'From: Khách Ảnh <khach-anh@mau.test>',
    `To: ${to}`,
    'Subject: Hàng bị hỏng',
    `Message-ID: <e2e-${Date.now()}@mau.test>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Ảnh hàng bị hỏng đây ạ.',
    `--${boundary}`,
    'Content-Type: image/png; name="hong.png"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="hong.png"',
    '',
    PNG_BASE64,
    `--${boundary}`,
    'Content-Type: application/pdf; name="hoa-don.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="hoa-don.pdf"',
    '',
    PDF_BASE64,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

test('a customer’s emailed photo shows in the Hộp thư thread and a PDF shows by name only (#2758)', async ({ page }) => {
  await signInNewUser(page, newEmail('email-images'));
  const slug = await createOrg(page, 'Công ty Ảnh Thư');
  await page.goto(`/o/${slug}/social/inbox`);
  const address = (await page.getByTestId('email-address').textContent())?.trim() ?? '';
  expect(address).toMatch(/@in\.e2e\.test$/);

  const accepted = await page.request.post('/api/inbound/email', {
    headers: { authorization: `Bearer ${INBOUND_SECRET}`, 'x-crove-recipient': address, 'content-type': 'message/rfc822' },
    data: Buffer.from(mail(address), 'utf8'),
  });
  expect(accepted.status()).toBe(202);

  // The worker parses the mail, files the thread and writes the picture; the list is read again until the thread is there.
  await expect(async () => {
    await page.goto(`/o/${slug}/social/inbox`);
    await expect(page.getByTestId('conversation-item')).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByTestId('conversation-item').click();
  const thread = page.getByTestId('conversation-thread');
  await expect(thread.getByText('Ảnh hàng bị hỏng đây ạ.')).toBeVisible();
  await expect(thread.getByTestId('conversation-image')).toHaveCount(1, { timeout: 30_000 });
  await expect(thread.getByTestId('conversation-image')).toBeVisible();
  // The PDF is a line with its name, type and size; its bytes were never kept.
  await expect(thread.getByText(/hoa-don\.pdf \(PDF, \d+ KB\)/)).toBeVisible();
  await expect(thread.getByText('hong.png')).toHaveCount(0);

  const scan = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact} ${v.id}`)).toEqual([]);
});
