// SPDX-License-Identifier: AGPL-3.0-only
// The conversation core in Social (#2303), on the offline sandbox channel: a comment on a published post appears under the
// post, an owner answers it (the worker sends the reply through the sandbox and the message settles), hides it, adds a note and
// resolves it, and the comment inbox lists it as resolved. The comment itself is a demo one the owner asks the sandbox for, which
// takes the intake a platform's notice takes. Each test has its own user and org.
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

// A post published to the sandbox through the screens, then due now so the worker's sweep publishes it; returns its id.
async function publishOnSandbox(page: Page, channel: string, body: string): Promise<string> {
  await page.getByRole('navigation').getByRole('link', { name: 'Mạng xã hội' }).click();
  await page.getByRole('link', { name: 'Kết nối kênh' }).first().click();
  await page.getByLabel('Tên kênh thử').fill(channel);
  await page.getByRole('button', { name: 'Kết nối kênh thử' }).click();
  await expect(page.getByText(channel).first()).toBeVisible();
  await page.getByRole('link', { name: 'Quay lại' }).click();
  await page.getByRole('link', { name: 'Soạn bài' }).click();
  await page.getByLabel('Nội dung chung').fill(body);
  await page.getByRole('button', { name: 'Lưu và gửi duyệt' }).click();
  await expect(page).toHaveURL(/\/social\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  await expect(page.getByText('Lên lịch 1 kênh đã duyệt')).toBeVisible();
  await page.getByRole('button', { name: 'Lên lịch', exact: true }).click();
  const postId = new URL(page.url()).pathname.split('/').pop() ?? '';
  exec(`UPDATE crove_social.post_variant SET scheduled_at = now() - interval '1 second' WHERE post_id = :'post'`, { post: postId });
  await expect(page.locator('[data-slot="card"]').filter({ hasText: channel }).filter({ hasText: 'Viết riêng cho kênh này' }).getByText('Đã đăng', { exact: true })).toBeVisible({ timeout: 45_000 });
  return postId;
}

test('answers, hides, notes and resolves a comment on a published post, and the comment inbox lists it (#2303)', async ({ page }) => {
  await signInNewUser(page, newEmail('conversations-owner'));
  const slug = await createOrg(page, 'Công ty Bình Luận');
  const postId = await publishOnSandbox(page, 'Trang Bình Luận', 'Bài để khách bình luận');

  // The comments of a published post are under it; the owner asks the sandbox for a demo comment.
  const comments = page.getByTestId('post-comments');
  await comments.getByTestId('sandbox-comment-open').click();
  await comments.getByTestId('sandbox-comment-text').fill('Còn hàng không shop?');
  await comments.getByTestId('sandbox-comment-send').click();
  await expect(comments.getByTestId('conversation-item')).toHaveCount(1, { timeout: 30_000 });
  await expect(comments.getByTestId('conversation-tab-new')).toContainText('1');
  await expect(comments.getByTestId('conversation-thread').getByText('Còn hàng không shop?')).toBeVisible();

  // The answer goes out through the worker and the sandbox, and the thread waits for the customer.
  await comments.getByTestId('conversation-reply-text').fill('Dạ còn hàng ạ, bạn nhắn số điện thoại nhé.');
  await comments.getByTestId('conversation-send').click();
  await expect(comments.getByTestId('conversation-status')).toHaveText('Đang chờ');
  await expect
    .poll(() => sql<{ send_state: string }>(`SELECT m.send_state FROM crove_kernel.conversation_message m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug' AND m.direction = 'out'`, { slug })[0]?.send_state, { timeout: 30_000 })
    .toBe('sent');
  // One call row for it, made once.
  expect(sql<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.external_call c JOIN crove_kernel.tenant t ON t.org_id = c.org_id WHERE t.slug = :'slug' AND c.step = 'reply'`, { slug })[0]?.n).toBe('1');

  // Hide the customer's comment (the worker asks the sandbox), then an internal note.
  await comments.getByTestId('conversation-hide').first().click();
  await expect(comments.getByText('Đã ẩn', { exact: true })).toBeVisible({ timeout: 30_000 });
  await comments.getByTestId('conversation-note-text').fill('Khách quen, ưu tiên giao nhanh');
  await comments.getByTestId('conversation-note-add').click();
  await expect(comments.getByTestId('conversation-note')).toContainText('Khách quen, ưu tiên giao nhanh');

  // Resolve it; it leaves New and Pending and is in Resolved, here and in the comment inbox.
  await comments.getByTestId('conversation-resolve').click();
  await expect(comments.getByTestId('conversation-status')).toHaveText('Đã xong');
  await page.goto(`/o/${slug}/social/comments`);
  await expect(page.getByRole('heading', { name: 'Hộp bình luận' })).toBeVisible();
  await page.getByTestId('conversation-tab-resolved').click();
  await expect(page.getByTestId('conversation-item')).toHaveCount(1);
  await expect(page.getByTestId('conversation-thread').getByText('Dạ còn hàng ạ, bạn nhắn số điện thoại nhé.')).toBeVisible();
  await page.getByTestId('conversation-reopen').click();
  await expect(page.getByTestId('conversation-status')).not.toHaveText('Đã xong');
  expect(postId).not.toBe('');
});
