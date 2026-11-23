// SPDX-License-Identifier: AGPL-3.0-only
// Files attached to a note end to end (Notes v2 E2, #3561, docs/plan/notes-v2.md V2-5): a member attaches an image and a
// PDF from the file picker, pastes a screenshot into the editor (Ctrl+V), sees the image inline and opens it larger,
// sees the PDF viewer, and removes a file.
import { expect, test } from '@playwright/test';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
// The smallest PDF with one empty page.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

test('a member attaches an image and a PDF, pastes a screenshot, previews them inline and removes one', async ({ page }) => {
  await page.goto('/');
  await signInNewUser(page, newEmail('notes-attachments'));
  const slug = await createOrg(page, 'Công ty Đính Kèm');
  await page.goto(`/o/${slug}/notes`);

  await page.getByRole('button', { name: 'Ghi chú mới' }).first().click();
  await page.getByRole('textbox', { name: 'Tiêu đề' }).fill('Hồ sơ khách hàng');
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu' })).toBeVisible({ timeout: 10_000 });

  const items = page.getByTestId('note-attachment-item');

  await test.step('an image and a PDF from the file picker preview inline', async () => {
    await page.getByTestId('note-attachment-file-input').setInputFiles([
      { name: 'bien-lai.png', mimeType: 'image/png', buffer: PNG },
      { name: 'hop-dong.pdf', mimeType: 'application/pdf', buffer: PDF },
    ]);
    await expect(items).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByTestId('note-attachment-filename')).toHaveText(['bien-lai.png', 'hop-dong.pdf']);
    await expect(page.getByTestId('note-attachment-image')).toBeVisible();
    await expect(page.getByTestId('note-attachment-pdf-viewer')).toBeVisible();
    await page.getByTestId('note-attachment-image-button').click();
    await expect(page.getByTestId('note-attachment-lightbox-image')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('note-attachment-lightbox-image')).toHaveCount(0);
  });

  await test.step('a screenshot pasted into the editor is attached', async () => {
    const body = page.getByRole('textbox', { name: 'Nội dung' });
    await body.focus();
    await body.evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG.toString('base64'));
    await expect(items).toHaveCount(3, { timeout: 15_000 });
    await expect(page.getByTestId('note-attachment-image')).toHaveCount(2);
  });

  await test.step('a file is removed', async () => {
    await items.filter({ hasText: 'bien-lai.png' }).getByTestId('note-attachment-delete').click();
    await expect(items).toHaveCount(2);
    await expect(page.getByTestId('note-attachment-filename')).not.toContainText(['bien-lai.png']);
  });
});
