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
  exec(`INSERT INTO ludy_kernel.party (org_id, name, kind) SELECT org_id, 'Khách hàng ABC', 'organization' FROM ludy_kernel.tenant WHERE slug = :'slug'`, { slug });

  await page.getByRole('navigation').getByRole('link', { name: 'Engage', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Cơ hội' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/deals$`));
  const board = page.getByTestId('deal-board');

  await test.step('an org with no deal sees one action and the customer import, not five empty columns (#3647)', async () => {
    await expect(page.getByText('Bảng chưa có cơ hội nào.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thêm cơ hội' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Nhập khách hàng từ tệp' })).toBeVisible();
    await expect(board).toHaveCount(0);
    // Nothing else to press: no stage button in the header, and no filter bar over a board with nothing to filter.
    await expect(page.getByRole('button', { name: 'Giai đoạn' })).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Tìm kiếm' })).toHaveCount(0);
  });

  const column = (name: string) => board.getByRole('region', { name });
  const titles = (name: string) => column(name).getByTestId('deal-card').getByTestId('deal-title').allTextContents();

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

  await test.step('from 1280 wide every stage, Thắng and Thua included, is on screen with no sideways scroll (#3647)', async () => {
    // Thắng and Thua share one closed column, so the six stages take five; a 1280 px laptop (content about 930 px) and a 1440 one both hold them.
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['Mới', 'Báo giá', 'Thắng', 'Thua']) {
        const box = await column(name).boundingBox();
        expect(box, `${name} at ${width}`).not.toBeNull();
        expect(box!.x, `${name} at ${width}`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${name} at ${width}`).toBeLessThanOrEqual(width);
      }
      expect(await board.evaluate((el) => el.scrollWidth - el.clientWidth), `scroll at ${width}`).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole('heading', { level: 2, name: 'Thua' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Bộ lọc khác' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('Phụ trách')).toBeVisible();
    await expect(page.getByLabel('Từ số tiền')).toHaveCount(0);
  });

  await test.step('a card opens the deal in a side sheet with its details, quotes and bookings; Esc closes it and focus returns to the card (#3648)', async () => {
    const open = column('Mới').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế' }).getByTestId('deal-card-open');
    await expect(column('Mới').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế' }).getByTestId('deal-card-owner')).toBeVisible();
    await open.click();
    const sheet = page.getByTestId('deal-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Tư vấn thuế', exact: true })).toBeVisible();
    for (const name of ['Thông tin cơ hội', 'Báo giá', 'Lịch hẹn']) await expect(sheet.getByRole('heading', { name, exact: true }).first()).toBeVisible();
    await expect(sheet.getByRole('form', { name: 'Sửa cơ hội' }).getByLabel('Tên cơ hội')).toHaveValue('Tư vấn thuế');
    await expect(sheet.getByRole('button', { name: 'Tạo báo giá' })).toBeVisible();
    // Focus moved into the sheet; Escape closes it and gives the focus back to the card.
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  await test.step('editing in the sheet saves the deal and closes it', async () => {
    await column('Mới').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế' }).getByTestId('deal-card-open').click();
    const form = page.getByTestId('deal-sheet').getByRole('form', { name: 'Sửa cơ hội' });
    await form.getByLabel('Tên cơ hội').fill('Tư vấn thuế quý');
    await form.getByRole('button', { name: 'Lưu', exact: true }).click();
    await expect(page.getByTestId('deal-sheet')).toHaveCount(0);
    await expect(column('Mới').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế quý' })).toBeVisible();
    // Put the name back for the steps below.
    await column('Mới').getByTestId('deal-card').filter({ hasText: 'Tư vấn thuế quý' }).getByTestId('deal-card-open').click();
    const again = page.getByTestId('deal-sheet').getByRole('form', { name: 'Sửa cơ hội' });
    await again.getByLabel('Tên cơ hội').fill('Tư vấn thuế');
    await again.getByRole('button', { name: 'Lưu', exact: true }).click();
    // The exact title: "Tư vấn thuế quý" also contains it, and the move below must run on the refreshed card, not on one whose version is behind.
    await expect(column('Mới').getByTestId('deal-title').filter({ hasText: /^Tư vấn thuế$/ })).toBeVisible();
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
      `SELECT d.title, s.kind, d.closed_at IS NOT NULL AS closed FROM crove_crm.deal d JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id JOIN ludy_kernel.tenant t ON t.org_id = d.org_id WHERE t.slug = :'slug' ORDER BY d.title`,
      { slug },
    );
    expect(stored).toEqual([
      { title: 'Báo cáo tài chính', kind: 'open', closed: false },
      { title: 'Gói kế toán năm', kind: 'won', closed: true },
      { title: 'Tư vấn thuế', kind: 'open', closed: false },
    ]);
  });

  await test.step('a card moved elsewhere in the meantime is refused, and the board shows the real place', async () => {
    // Someone else moves the deal while this page missed the stream's hint (#3293: a write now sends one, so the trigger is off for this statement); this page still holds the old version.
    exec(`SET session_replication_role = replica;
       UPDATE crove_crm.deal SET version = version + 1 WHERE title = 'Tư vấn thuế'`);
    await page.getByRole('combobox', { name: 'Giai đoạn của cơ hội Tư vấn thuế' }).selectOption({ label: 'Thương lượng' });
    await expect(page.getByText('vừa được người khác sửa')).toBeVisible();
    await expect.poll(() => titles('Báo giá')).toContain('Tư vấn thuế');
  });

  await test.step('a card moved by someone else shows in its new column with no reload (the stream hint, #3293)', async () => {
    // A write by another member: the deal trigger sends the hint, the board reads again through its normal query, and the hint holds no title.
    exec(
      `UPDATE crove_crm.deal d SET stage_id = (SELECT s.id FROM crove_crm.pipeline_stage s WHERE s.org_id = d.org_id AND s.name = 'Thương lượng'), version = version + 1, updated_at = now()
       WHERE d.title = 'Báo cáo tài chính'`,
    );
    await expect.poll(() => titles('Thương lượng'), { timeout: 15_000 }).toEqual(['Báo cáo tài chính']);
    expect(await titles('Báo giá')).toEqual(['Tư vấn thuế']);
  });

  await test.step('a deal won more than 30 days ago is off the board, and "Xem tất cả" in Thắng lists it (crm.md section 6)', async () => {
    exec(
      `SET session_replication_role = replica;
       UPDATE crove_crm.deal SET closed_at = now() - interval '45 days' WHERE title = 'Gói kế toán năm' AND org_id = (SELECT org_id FROM ludy_kernel.tenant WHERE slug = :'slug')`,
      { slug },
    );
    await page.reload();
    await expect(column('Thắng').getByTestId('deal-card')).toHaveCount(0);
    // Only the closed columns have the control.
    await expect(board.getByRole('button', { name: 'Xem tất cả' })).toHaveCount(2);
    await expect(column('Mới').getByRole('button', { name: /Xem tất cả/ })).toHaveCount(0);
    await column('Thắng').getByRole('button', { name: 'Xem tất cả cơ hội ở giai đoạn Thắng trong danh sách' }).click();
    await expect(page.getByRole('tab', { name: 'Danh sách', selected: true })).toBeVisible();
    await expect(page.getByLabel('Trạng thái', { exact: true })).toHaveValue('won');
    await expect(page.getByRole('table').getByText('Gói kế toán năm')).toBeVisible();
    await expect(page.getByRole('table').getByText('Tư vấn thuế')).toHaveCount(0);
  });

  await test.step('on a phone the board is one tab away and its Thua column opens the list of lost deals', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/o/${slug}/deals`);
    await page.getByRole('tab', { name: 'Bảng' }).click();
    await board.getByRole('button', { name: 'Xem tất cả cơ hội ở giai đoạn Thua trong danh sách' }).click();
    await expect(page.getByRole('tab', { name: 'Danh sách', selected: true })).toBeVisible();
    await expect(page.getByLabel('Trạng thái', { exact: true })).toHaveValue('lost');
  });
});
