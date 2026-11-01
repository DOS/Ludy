// SPDX-License-Identifier: AGPL-3.0-only
// The deal board end to end (#2226, docs/plan/crm.md step K2): a member adds three deals, moves one with the stage menu
// and drags another to Won; the columns, the order and the sums are still there after a reload. A second member moving
// a card the first one already moved gets a refusal, not a silent overwrite.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

// A native drag: press on the card, move over the target in steps so the browser fires dragover on it, then release. A
// target scrolled out of the board is reached the way a person would: hold the card at the board's right edge, where it
// scrolls by itself, until the target is in view.
async function drag(page: Page, card: Locator, target: Locator, at?: { x: number; y: number }): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const area = await page.getByTestId('deal-board').boundingBox();
  if (!from || !area) throw new Error('drag: an element is not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + 8);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 20, { steps: 3 });
  for (let i = 0; i < 60; i++) {
    const box = await target.boundingBox();
    if (box && box.x >= area.x && box.x + box.width <= area.x + area.width) break;
    await page.mouse.move(area.x + area.width - 20 - (i % 2), from.y + 20, { steps: 2 });
    await page.waitForTimeout(40);
  }
  const to = await target.boundingBox();
  if (!to) throw new Error('drag: the target is not visible');
  await page.mouse.move(to.x + (at?.x ?? to.width / 2), to.y + (at?.y ?? to.height / 2), { steps: 10 });
  await page.mouse.up();
}

test('a member adds deals, moves them between stages and the board keeps its order after a reload', async ({ page }) => {
  const email = newEmail('deals');
  await page.goto('/');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Cơ Hội');
  // A contact to sell to; the contacts screen comes with a later step, so it is made as the stack's database owner.
  exec(`INSERT INTO crove_kernel.party (org_id, name, kind) SELECT org_id, 'Khách hàng ABC', 'organization' FROM crove_kernel.tenant WHERE slug = :'slug'`, { slug });

  await page.getByRole('navigation').getByRole('link', { name: 'CRM', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Cơ hội' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals$`));
  const board = page.getByTestId('deal-board');
  await expect(board.getByRole('region', { name: 'Mới' })).toBeVisible();
  await expect(board.getByRole('region', { name: 'Thắng' })).toBeVisible();

  const column = (name: string) => board.getByRole('region', { name });
  const titles = (name: string) => column(name).getByTestId('deal-card').locator('p.font-medium').allTextContents();

  await test.step('adds three deals, each in the first stage', async () => {
    for (const [title, amount] of [['Gói kế toán năm', '15000000'], ['Tư vấn thuế', '4000000'], ['Báo cáo tài chính', '9500000']] as const) {
      await page.getByRole('button', { name: 'Thêm cơ hội' }).click();
      const form = page.getByRole('form', { name: 'Thêm cơ hội' });
      await form.getByLabel('Tên cơ hội').fill(title);
      await form.getByRole('searchbox', { name: 'Khách hàng' }).fill('ABC');
      await page.getByRole('button', { name: 'Khách hàng ABC' }).click();
      await form.getByLabel('Số tiền (VND)').fill(amount);
      await form.getByRole('button', { name: 'Thêm', exact: true }).click();
      await expect(column('Mới').getByTestId('deal-card').filter({ hasText: title })).toBeVisible();
    }
    expect(await titles('Mới')).toEqual(['Gói kế toán năm', 'Tư vấn thuế', 'Báo cáo tài chính']);
    await expect(column('Mới')).toContainText('3');
  });

  await test.step('the stage menu moves a card to another column', async () => {
    await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Tư vấn thuế' }).selectOption({ label: 'Báo giá' });
    await expect.poll(() => titles('Báo giá')).toEqual(['Tư vấn thuế']);
    expect(await titles('Mới')).toEqual(['Gói kế toán năm', 'Báo cáo tài chính']);
  });

  await test.step('dragging a card to Won closes it, and a card dragged before another takes its place', async () => {
    await drag(page, column('Mới').getByTestId('deal-card').filter({ hasText: 'Gói kế toán năm' }), column('Thắng'));
    await expect.poll(() => titles('Thắng')).toEqual(['Gói kế toán năm']);
    await drag(page, column('Mới').getByTestId('deal-card').filter({ hasText: 'Báo cáo tài chính' }), column('Báo giá').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế' }), { x: 20, y: 4 });
    await expect.poll(() => titles('Báo giá')).toEqual(['Báo cáo tài chính', 'Tư vấn thuế']);
  });

  await test.step('the order, the columns and the sums are the same after a reload', async () => {
    await page.reload();
    await expect.poll(() => titles('Báo giá')).toEqual(['Báo cáo tài chính', 'Tư vấn thuế']);
    expect(await titles('Thắng')).toEqual(['Gói kế toán năm']);
    expect(await titles('Mới')).toEqual([]);
    await expect(column('Báo giá')).toContainText('13.500.000');
    await expect(column('Thắng')).toContainText('15.000.000');
    const stored = sql<{ title: string; kind: string; closed: boolean }>(
      `SELECT d.title, s.kind, d.closed_at IS NOT NULL AS closed FROM crove_crm.deal d JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id JOIN crove_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug' ORDER BY d.title`,
      { slug },
    );
    expect(stored).toEqual([
      { title: 'Báo cáo tài chính', kind: 'open', closed: false },
      { title: 'Gói kế toán năm', kind: 'won', closed: true },
      { title: 'Tư vấn thuế', kind: 'open', closed: false },
    ]);
  });

  await test.step('a card moved elsewhere in the meantime is refused, and the board shows the real place', async () => {
    // Someone else moves the deal; this page still holds the old version.
    exec(`UPDATE crove_crm.deal SET version = version + 1 WHERE title = 'Tư vấn thuế'`);
    await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Tư vấn thuế' }).selectOption({ label: 'Thương lượng' });
    await expect(page.getByText('vừa được người khác sửa')).toBeVisible();
    await expect.poll(() => titles('Báo giá')).toContain('Tư vấn thuế');
  });
});
