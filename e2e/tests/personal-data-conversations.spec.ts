// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Dữ liệu cá nhân customer conversation lookup and step-up erasure (#3669):
// owners and admins search by phone number or email, see direct vs linked-contact matches in the Hội thoại section,
// pass WCAG 2.2 AA accessibility and mobile touch-target checks, and erase one customer at a time with MFA step-up.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { nextTotp } from '../lib/totp.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

async function enrollTotpInStepUp(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Bật xác thực hai lớp' }).click();
  const secret = (await page.getByLabel('Khóa thiết lập').textContent())?.trim() ?? '';
  if (!secret) throw new Error('Expected non-empty TOTP setup key');
  const { code } = await nextTotp(secret);
  await page.getByLabel('Mã xác thực').fill(code);
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
}

test('finds customer conversations by phone and email on Settings > Dữ liệu cá nhân and erases them with step-up (#3669)', async ({ page }) => {
  await signInNewUser(page, newEmail('pd-conversations'));
  const slug = await createOrg(page, 'Công ty Dữ Liệu Hội Thoại');

  // Seed WhatsApp direct, Facebook Page linked-contact, Email direct, and an unrelated Facebook thread mentioning the phone in text.
  exec(
    `WITH o AS (
       SELECT t.org_id, m.user_id AS owner_id
       FROM ludy_kernel.tenant t
       JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id AND m.role = 'owner'
       WHERE t.slug = :'slug'
       LIMIT 1
     ),
     ch_wa AS (
       INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       SELECT org_id, 'whatsapp', 'wa-' || :'slug', 'WhatsApp Hỗ Trợ', 'active', owner_id FROM o RETURNING org_id, id
     ),
     ch_fb AS (
       INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       SELECT org_id, 'facebook_page', 'fb-e2e-1', 'Trang Facebook E2E', 'active', owner_id FROM o RETURNING org_id, id
     ),
     ch_em AS (
       INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       SELECT org_id, 'email', 'inbox', 'Email', 'active', owner_id FROM o RETURNING org_id, id
     ),
     p AS (
       INSERT INTO ludy_kernel.party (org_id, kind, name, phone)
       SELECT org_id, 'person', 'Công ty Lan Hương', '+84 901 234 567' FROM o RETURNING org_id, id
     ),
     id_wa AS (
       INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       SELECT org_id, 'whatsapp', '84901234567', 'Chị Lan WhatsApp' FROM o RETURNING org_id, id
     ),
     id_wa_only AS (
       INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       SELECT org_id, 'whatsapp', '84907778888', 'Khách WhatsApp Độc Lập' FROM o RETURNING org_id, id
     ),
     id_fb_linked AS (
       INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       SELECT org_id, 'facebook_page', 'fb-psid-linked-99', 'Khách FB Liên Kết' FROM o RETURNING org_id, id
     ),
     id_fb_body AS (
       INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       SELECT org_id, 'facebook_page', 'fb-psid-body-88', 'Khách Chỉ Nhắc Trong Tin' FROM o RETURNING org_id, id
     ),
     id_em AS (
       INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       SELECT org_id, 'email', 'khach-e2e@example.test', 'Anh Minh Email' FROM o RETURNING org_id, id
     ),
     c_wa AS (
       INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_message_at, last_inbound_at)
       SELECT ch_wa.org_id, ch_wa.id, 'direct', 'wa-t1', id_wa.id, 'new', 1, now(), now() FROM ch_wa, id_wa RETURNING org_id, channel_connection_id, id
     ),
     c_wa_only AS (
       INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_message_at, last_inbound_at)
       SELECT ch_wa.org_id, ch_wa.id, 'direct', 'wa-only-t1', id_wa_only.id, 'new', 1, now(), now() FROM ch_wa, id_wa_only RETURNING org_id, channel_connection_id, id
     ),
     c_fb_linked AS (
       INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, party_id, status, last_seq, last_message_at, last_inbound_at)
       SELECT ch_fb.org_id, ch_fb.id, 'comment_thread', 'fb-t1', id_fb_linked.id, p.id, 'new', 1, now(), now() FROM ch_fb, id_fb_linked, p RETURNING org_id, channel_connection_id, id
     ),
     c_fb_body AS (
       INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_message_at, last_inbound_at)
       SELECT ch_fb.org_id, ch_fb.id, 'direct', 'fb-t2', id_fb_body.id, 'new', 1, now(), now() FROM ch_fb, id_fb_body RETURNING org_id, channel_connection_id, id
     ),
     c_em AS (
       INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_message_at, last_inbound_at)
       SELECT ch_em.org_id, ch_em.id, 'email', 'em-t1', id_em.id, 'new', 1, now(), now() FROM ch_em, id_em RETURNING org_id, channel_connection_id, id
     ),
     m_wa AS (
       INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_identity_id, body, tainted)
       SELECT c_wa.org_id, c_wa.id, c_wa.channel_connection_id, 'direct', 1, 'in', 'm-wa-1', now(), 'contact', id_wa.id, 'Nhắn từ WhatsApp', true FROM c_wa, id_wa
     ),
     m_wa_only AS (
       INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_identity_id, body, tainted)
       SELECT c_wa_only.org_id, c_wa_only.id, c_wa_only.channel_connection_id, 'direct', 1, 'in', 'm-wa-only-1', now(), 'contact', id_wa_only.id, 'Nhắn riêng WhatsApp không có CRM', true FROM c_wa_only, id_wa_only
     ),
     m_fb_linked AS (
       INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_identity_id, body, tainted)
       SELECT c_fb_linked.org_id, c_fb_linked.id, c_fb_linked.channel_connection_id, 'comment_thread', 1, 'in', 'm-fb-1', now(), 'contact', id_fb_linked.id, 'Bình luận đã gắn liên hệ', true FROM c_fb_linked, id_fb_linked
     ),
     m_fb_body AS (
       INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_identity_id, body, tainted)
       SELECT c_fb_body.org_id, c_fb_body.id, c_fb_body.channel_connection_id, 'direct', 1, 'in', 'm-fb-2', now(), 'contact', id_fb_body.id, 'Gọi cho tôi 0901234567 hoặc khach-e2e@example.test', true FROM c_fb_body, id_fb_body
     )
     INSERT INTO ludy_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, external_message_id, sent_at, author_kind, author_identity_id, body, tainted)
     SELECT c_em.org_id, c_em.id, c_em.channel_connection_id, 'email', 1, 'in', 'm-em-1', now(), 'contact', id_em.id, 'Hỏi qua email', true FROM c_em, id_em`,
    { slug },
  );

  await page.goto(`/o/${slug}/personal-data`);
  const input = page.getByLabel('Email, số điện thoại, mã số thuế hoặc số căn cước');

  // Searching a WhatsApp-only number with 0 rows in org.personalData shows Hội thoại and MUST NOT render the empty-state banner.
  await input.fill('0907 778 888');
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/org/personalData') && r.status() === 200),
    page.waitForResponse((r) => r.url().includes('/conversations/personalDataFind') && r.status() === 200),
    page.getByRole('button', { name: 'Tìm', exact: true }).click(),
  ]);
  const section = page.getByTestId('personal-data-conversations-results');
  await expect(section).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByText('Không tìm thấy dữ liệu nào khớp')).toHaveCount(0);
  await expect(section.getByTestId('personal-data-conversation-row')).toHaveCount(1);
  await expect(section).toContainText('Khách WhatsApp Độc Lập');

  // Cancel confirmation keeps the thread, then confirming prompts MFA step-up and erases only that WhatsApp customer.
  await section.getByTestId('personal-data-conversation-erase').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Khách WhatsApp Độc Lập');
  await dialog.getByRole('button', { name: 'Giữ lại' }).click();
  await expect(dialog).toBeHidden();

  await section.getByTestId('personal-data-conversation-erase').click();
  await dialog.getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
  await enrollTotpInStepUp(page);
  await expect(page.getByText('Không tìm thấy dữ liệu nào khớp')).toBeVisible({ timeout: 30_000 });
  expect(
    sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM ludy_kernel.conversation c JOIN ludy_kernel.tenant t ON t.org_id = c.org_id WHERE t.slug = :'slug' AND c.external_thread_id = 'wa-only-t1'`,
      { slug },
    )[0]?.n,
  ).toBe('0');

  // Searching an email identity shows Hội thoại alongside the Email match.
  await input.fill('khach-e2e@example.test');
  await page.getByRole('button', { name: 'Tìm', exact: true }).click();
  await expect(section.getByTestId('personal-data-conversation-row')).toHaveCount(1);
  await expect(section).toContainText('Anh Minh Email');
  await expect(section).toContainText('khach-e2e@example.test');
  await expect(section).not.toContainText('Khách Chỉ Nhắc Trong Tin');

  // Searching the phone number shows both Direct WhatsApp and Linked-contact Facebook rows, passes axe & 44 px tap targets on mobile,
  // warns before erasing the linked CRM party first, and erases WhatsApp cleanly within the active aal2 window without re-prompting MFA.
  await input.fill('0901 234 567');
  await page.getByRole('button', { name: 'Tìm', exact: true }).click();
  await expect(section.getByTestId('personal-data-conversation-row')).toHaveCount(2);
  await expect(section).toContainText('Chị Lan WhatsApp');
  await expect(section).toContainText('Trực tiếp');
  await expect(section).toContainText('Khách FB Liên Kết');
  await expect(section).toContainText('Qua liên hệ');
  await expect(section).toContainText('Công ty Lan Hương');
  await expect(section).not.toContainText('Khách Chỉ Nhắc Trong Tin');

  await page.getByRole('button', { name: 'Xóa dữ liệu của người này', exact: true }).click();
  await expect(page.getByTestId('personal-data-linked-erase-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scan = await new AxeBuilder({ page })
      .include('[data-testid="personal-data-conversations-results"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const bad = scan.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${width}: ${v.id}`);
    expect(bad).toEqual([]);
  }
  const btnBox = await section.getByTestId('personal-data-conversation-erase').first().boundingBox();
  expect(btnBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.setViewportSize({ width: 1280, height: 900 });

  await section.getByRole('button', { name: /Xóa hội thoại của Chị Lan WhatsApp/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xóa vĩnh viễn' }).click();
  await expect(section.getByTestId('personal-data-conversation-row')).toHaveCount(1);
  await expect(section).not.toContainText('Chị Lan WhatsApp');
  await expect(section).toContainText('Khách FB Liên Kết');

  // Audit event holds counts/kind only, never searched phone/email or customer names.
  const audits = sql<{ detail: unknown }>(
    `SELECT a.detail FROM ludy_kernel.audit_event a JOIN ludy_kernel.tenant t ON t.org_id = a.org_id WHERE t.slug = :'slug' AND a.command = 'kernel.conversation.personal_data_find' AND a.outcome = 'ok'`,
    { slug },
  );
  expect(audits.length).toBeGreaterThanOrEqual(3);
  const serialized = JSON.stringify(audits);
  for (const pii of ['khach-e2e@example.test', '0901234567', '0907778888', 'Chị Lan WhatsApp', 'Khách WhatsApp Độc Lập', 'Anh Minh Email']) {
    expect(serialized).not.toContain(pii);
  }
});
