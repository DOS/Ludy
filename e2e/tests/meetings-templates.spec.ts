// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates an organization writes (#3578), end to end with no AI (#3805, part 2). An owner writes a template in Settings; the recorder picks it on a meeting, types under its
// own headings, shares, and the printable biên bản shows those headings in order. A member does not see the settings card, a refused call to write a template changes nothing, and the
// member still finds the owner's template in the picker of a meeting they recorded (every member reads the active ones). Two users in one org, each created confirmed without the sign-up form.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser, storedSession } from '../lib/session.ts';

const TEMPLATE = 'Giao ban tuần';

test('an owner writes a template and uses it on a meeting; a member cannot write one but can pick it (#3805)', async ({ browser, page }) => {
  const ownerEmail = newEmail('meetings-tpl-owner');
  const memberEmail = newEmail('meetings-tpl-member');
  await page.goto('/');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Công ty Mẫu Biên Bản');
  const member = await browser.newPage();
  await member.goto('/');
  await signInNewUser(member, memberEmail);
  exec(
    `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
     SELECT t.org_id, u.id, 'member' FROM crove_kernel.tenant t, crove_kernel.user_account u
      WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
    { slug, email: memberEmail },
  );

  // A stored meeting of the given recorder: recording one needs a microphone and is covered by meeting-record.spec.ts.
  const store = (title: string, email: string): string => {
    exec(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       SELECT t.org_id, gen_random_uuid(), :'title', 'vi', now(), now() + interval '30 minutes', 1800, u.id, 'attendees', 'ready', 'told_at_start', u.id, now(), '1.0', current_date + 30, current_date + 365
         FROM crove_kernel.tenant t, crove_kernel.user_account u WHERE t.slug = :'slug' AND lower(u.email) = lower(:'email')`,
      { slug, email, title },
    );
    return (sql<{ id: string }>(`SELECT m.id FROM crove_meetings.meeting m JOIN crove_kernel.tenant t ON t.org_id = m.org_id WHERE t.slug = :'slug' AND m.title = :'title'`, { slug, title })[0] as { id: string }).id;
  };
  const templates = () => sql<{ name: string }>(`SELECT x.name FROM crove_meetings.minutes_template x JOIN crove_kernel.tenant t ON t.org_id = x.org_id WHERE t.slug = :'slug' ORDER BY x.name`, { slug });

  await test.step('the owner writes a template with two sections in Settings', async () => {
    await page.goto(`/o/${slug}/settings`);
    const card = page.getByTestId('minutes-templates-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Thêm mẫu' }).click();
    await card.getByLabel('Tên mẫu').fill(TEMPLATE);
    await card.getByLabel('Tiêu đề mục 1').fill('Kết quả tuần');
    await card.getByRole('button', { name: 'Thêm mục' }).click();
    await card.getByLabel('Tiêu đề mục 2').fill('Việc tuần sau');
    await card.getByRole('button', { name: 'Tạo mẫu' }).click();
    const row = card.getByTestId('minutes-template');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(TEMPLATE);
    await expect(row).toContainText('2 mục');
    expect(templates()).toEqual([{ name: TEMPLATE }]);
  });

  const ownerMeeting = store('Họp giao ban tuần 47', ownerEmail);
  await test.step('the recorder picks the template and types under its headings', async () => {
    await page.goto(`/o/${slug}/meetings/${ownerMeeting}`);
    const panel = page.getByTestId('meeting-results');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Loại cuộc họp').selectOption({ label: `Mẫu của công ty: ${TEMPLATE}` });
    // The editor now has one box per heading of the template, and none of the built-in ones.
    await expect(panel.getByLabel('Kết quả tuần')).toBeVisible();
    await expect(panel.getByLabel('Việc tuần sau')).toBeVisible();
    await expect(panel.getByLabel('Tóm tắt', { exact: true })).toHaveCount(0);
    await panel.getByLabel('Kết quả tuần').fill('Đã chốt hợp đồng với khách A.');
    await panel.getByLabel('Việc tuần sau').fill('Gửi báo giá cho khách B.');
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && /saveSummary/.test(r.url()));
    await panel.getByRole('button', { name: 'Lưu bản nháp' }).click();
    expect((await saved).ok()).toBe(true);
    await panel.getByRole('button', { name: 'Chia sẻ cho người dự họp' }).click();
    await expect(panel.getByRole('heading', { name: 'Đã chia sẻ cho người dự họp' })).toBeVisible();
    // The shared text keeps the template's headings.
    await expect(panel).toContainText('Kết quả tuần');
    await expect(panel).toContainText('Gửi báo giá cho khách B.');
  });

  await test.step('the biên bản shows the template headings, numbered, in the order they were written', async () => {
    await page.getByTestId('meeting-results').getByRole('link', { name: 'Xem biên bản' }).click();
    const sheet = page.getByTestId('minutes-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: '1. Kết quả tuần' })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: '2. Việc tuần sau' })).toBeVisible();
    await expect(sheet).toContainText('Đã chốt hợp đồng với khách A.');
    await expect(sheet).toContainText('Gửi báo giá cho khách B.');
    const text = await sheet.innerText();
    expect(text.indexOf('1. Kết quả tuần')).toBeLessThan(text.indexOf('2. Việc tuần sau'));
  });

  await test.step('a member does not see the settings card', async () => {
    await member.goto(`/o/${slug}/settings`);
    await expect(member.getByRole('heading', { name: 'Cài đặt', level: 1 })).toBeVisible();
    await member.waitForLoadState('networkidle');
    await expect(member.getByTestId('minutes-templates-card')).toHaveCount(0);
  });

  await test.step('a call to write a template by a member is refused and changes nothing', async () => {
    const session = await storedSession(member);
    const refused = await member.request.post('/api/rpc/meetings/template/create', {
      headers: { authorization: `Bearer ${session?.access_token ?? ''}`, 'x-crove-org': slug, 'content-type': 'application/json' },
      data: { json: { name: 'Mẫu của thành viên', sections: [{ title: 'Một mục', hint: '' }] } },
    });
    expect(refused.status(), await refused.text()).toBe(403);
    expect(templates()).toEqual([{ name: TEMPLATE }]);
  });

  await test.step('a member who recorded a meeting finds the owner\'s template in the picker', async () => {
    const memberMeeting = store('Họp của thành viên', memberEmail);
    await member.goto(`/o/${slug}/meetings/${memberMeeting}`);
    const picker = member.getByTestId('template-picker').getByLabel('Loại cuộc họp');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option', { hasText: `Mẫu của công ty: ${TEMPLATE}` })).toHaveCount(1);
  });

  await member.close();
});
