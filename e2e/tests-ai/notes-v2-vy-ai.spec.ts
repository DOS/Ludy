// SPDX-License-Identifier: AGPL-3.0-only
// Notes v2 T4b & E5b (#3563): end-to-end Vy daily planner (notes.todo_plan) on My Work and inbox organizer (notes.organize)
// on Notes against e2e/fake-model. Proves zero automatic writes during proposal generation, "Đề xuất" badge visibility,
// and 1-click human confirmation running caller-owned reschedule/update commands cleanly.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test('Vy daily planner (todo_plan) and inbox organizer (organize) propose cleanly and apply only on click (#3563)', async ({ page }) => {
  const email = newEmail('notes-v2-vy');
  await signInNewUser(page, email);
  const slug = await createOrg(page, 'Công ty Vy Ghi Chú V2');

  let overdueTodoId = '';
  let unfiledNoteId = '';
  let notebookId = '';

  await test.step('seed an overdue to-do, an open today to-do, an unfiled private note, and a target notebook', async () => {
    exec(
      `INSERT INTO ludy_notes.todo (org_id, owner_user_id, title, priority, due_on, time_zone, sort_key)
       SELECT t.org_id, u.id, 'Nộp tờ khai thuế quá hạn', 1, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 2, 'Asia/Ho_Chi_Minh', '000001'
         FROM ludy_kernel.tenant t, ludy_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    exec(
      `INSERT INTO ludy_notes.todo (org_id, owner_user_id, title, priority, due_on, time_zone, sort_key)
       SELECT t.org_id, u.id, 'Gọi khách chốt báo giá', 2, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'Asia/Ho_Chi_Minh', '000002'
         FROM ludy_kernel.tenant t, ludy_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    exec(
      `INSERT INTO ludy_notes.notebook (org_id, author_user_id, visibility, name, sort_key)
       SELECT t.org_id, u.id, 'private', 'Hồ sơ tài chính', '000001'
         FROM ludy_kernel.tenant t, ludy_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );
    exec(
      `INSERT INTO ludy_notes.note (org_id, author_user_id, visibility, title, body)
       SELECT t.org_id, u.id, 'private', 'Hóa đơn điện tháng 11', 'Cần lưu vào sổ tay tài chính'
         FROM ludy_kernel.tenant t, ludy_kernel.user_account u
        WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email },
    );

    overdueTodoId = (
      sql<{ id: string }>(
        `SELECT td.id FROM ludy_notes.todo td JOIN ludy_kernel.tenant t ON t.org_id = td.org_id
         WHERE t.slug = :'slug' AND td.title = 'Nộp tờ khai thuế quá hạn'`,
        { slug },
      )[0] as { id: string }
    ).id;
    notebookId = (
      sql<{ id: string }>(
        `SELECT nb.id FROM ludy_notes.notebook nb JOIN ludy_kernel.tenant t ON t.org_id = nb.org_id
         WHERE t.slug = :'slug' AND nb.name = 'Hồ sơ tài chính'`,
        { slug },
      )[0] as { id: string }
    ).id;
    unfiledNoteId = (
      sql<{ id: string }>(
        `SELECT n.id FROM ludy_notes.note n JOIN ludy_kernel.tenant t ON t.org_id = n.org_id
         WHERE t.slug = :'slug' AND n.title = 'Hóa đơn điện tháng 11'`,
        { slug },
      )[0] as { id: string }
    ).id;
  });

  await test.step('My Work: ask Vy to plan today without auto-writing, then apply overdue reschedule in 1 click', async () => {
    await page.goto(`/o/${slug}/my-work`);
    const trigger = page.getByTestId('my-work-vy-plan-btn');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const planner = page.getByTestId('my-work-vy-planner');
    await expect(planner).toBeVisible();
    await expect(planner.getByTestId('my-work-vy-ai-badge')).toContainText('Vy đề xuất · AI');
    await expect(planner.getByTestId(`my-work-vy-focus-item-${overdueTodoId}`)).toBeVisible();
    await expect(planner.getByTestId(`my-work-vy-reschedule-proposal-badge-${overdueTodoId}`)).toContainText('Đề xuất');
    // Hallucinated ID from fake-model is dropped deterministically.
    await expect(planner.getByTestId('my-work-vy-dropped')).toBeVisible();

    const revisionBefore = (
      sql<{ revision: number }>(`SELECT revision FROM ludy_notes.todo WHERE id = :'id'`, { id: overdueTodoId })[0] as {
        revision: number;
      }
    ).revision;
    expect(revisionBefore).toBe(1);

    await planner.getByTestId(`my-work-vy-reschedule-apply-${overdueTodoId}`).click();
    await expect(planner.getByTestId(`my-work-vy-reschedule-applied-badge-${overdueTodoId}`)).toBeVisible();

    const revisionAfter = (
      sql<{ revision: number }>(`SELECT revision FROM ludy_notes.todo WHERE id = :'id'`, { id: overdueTodoId })[0] as {
        revision: number;
      }
    ).revision;
    expect(revisionAfter).toBe(2);
  });

  await test.step('Notes: ask Vy to organize inbox without auto-writing, then apply notebook + tags in 1 click', async () => {
    await page.goto(`/o/${slug}/notes`);
    const trigger = page.getByTestId('notes-vy-organize-btn');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const organizer = page.getByTestId('notes-vy-organizer');
    await expect(organizer).toBeVisible();
    await expect(organizer.getByTestId('notes-vy-organize-ai-badge')).toContainText('Vy đề xuất · AI');
    await expect(organizer.getByTestId(`notes-vy-organize-proposal-badge-${unfiledNoteId}`)).toContainText('Đề xuất');
    await expect(organizer.getByTestId('notes-vy-organize-dropped')).toBeVisible();

    // Nothing modified in DB prior to explicit confirmation.
    const noteBefore = sql<{ notebook_id: string | null }>(
      `SELECT notebook_id FROM ludy_notes.note WHERE id = :'id'`,
      { id: unfiledNoteId },
    )[0] as { notebook_id: string | null };
    expect(noteBefore.notebook_id).toBeNull();

    await organizer.getByTestId(`notes-vy-organize-apply-${unfiledNoteId}`).click();
    await expect(organizer.getByTestId(`notes-vy-organize-applied-badge-${unfiledNoteId}`)).toBeVisible();

    const noteAfter = sql<{ notebook_id: string | null; tags: string[] }>(
      `SELECT notebook_id, tags FROM ludy_notes.note WHERE id = :'id'`,
      { id: unfiledNoteId },
    )[0] as { notebook_id: string | null; tags: string[] };
    expect(noteAfter.notebook_id).toBe(notebookId);
    expect(noteAfter.tags).toEqual(expect.arrayContaining(['hộp-thư', 'cần-xem']));
  });
});
