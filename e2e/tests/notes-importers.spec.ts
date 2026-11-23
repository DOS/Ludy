// SPDX-License-Identifier: AGPL-3.0-only
// Notes v2 E5a (#3564) end to end: 1-step Evernote (.enex) and Todoist (.csv) importers with dry-run preview,
// fail-closed XXE/unsafe XML blocking, private visibility, tainted=true, preserved timestamps, attachments,
// inverted Todoist priorities (4->P1..1->P4), checklist steps, tags, sections, and member isolation.
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

test('1-step Evernote (.enex) and Todoist (.csv) importers with dry-run preview, persistence, and isolation', async ({
  page,
  browser,
}) => {
  const ownerEmail = newEmail('notes-import-owner');
  await page.goto('/');
  await signInNewUser(page, ownerEmail);
  const slug = await createOrg(page, 'Công ty Nhập Dữ Liệu');

  await test.step('Evernote (.enex): fail-closed on unsafe XXE, preview valid export, confirm import, and verify private + tainted in PG', async () => {
    await page.goto(`/o/${slug}/notes`);
    await page.getByTestId('notes-import-enex-btn').click();
    await expect(page.getByTestId('enex-import-dialog')).toBeVisible();

    const unsafeEnex = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<en-export><note><title>&xxe;</title><content><![CDATA[<en-note>bad</en-note>]]></content></note></en-export>`;

    await page.getByTestId('enex-import-file-input').setInputFiles({
      name: 'unsafe.enex',
      mimeType: 'application/xml',
      buffer: Buffer.from(unsafeEnex, 'utf8'),
    });
    await expect(page.getByTestId('import-parse-error')).toBeVisible();
    await expect(page.getByTestId('enex-import-confirm')).toBeDisabled();

    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    const validEnex = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <notebook>Tài liệu Evernote</notebook>
  <note>
    <title>Biên bản họp Evernote</title>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note>
  <p>Chốt kế hoạch triển khai.</p>
  <ul><li><en-todo checked="true"/>Ký hợp đồng</li></ul>
  <img src="https://tracker.invalid/pixel.gif" />
  <script>alert('xss')</script>
</en-note>]]></content>
    <created>20240501T090000Z</created>
    <updated>20240502T100000Z</updated>
    <tag>Evernote</tag>
    <tag>Kế hoạch</tag>
    <resource>
      <data encoding="base64">${pngBytes.toString('base64')}</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>so-do.png</file-name></resource-attributes>
    </resource>
  </note>
  <note>
    <title>Ghi chú thứ hai</title>
    <content><![CDATA[<en-note><p>Nội dung an toàn.</p></en-note>]]></content>
    <created>20240503T080000Z</created>
  </note>
</en-export>`;

    await page.getByTestId('enex-import-file-input').setInputFiles({
      name: 'evernote-backup.enex',
      mimeType: 'application/xml',
      buffer: Buffer.from(validEnex, 'utf8'),
    });

    const preview = page.getByTestId('enex-dry-run-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('2 ghi chú');
    await expect(preview).toContainText('1 tệp đính kèm');
    await expect(preview).toContainText('Tài liệu Evernote');
    await expect(preview).toContainText('1 ảnh từ xa');

    await page.getByTestId('enex-import-confirm').click();
    await expect(page.getByTestId('enex-import-dialog')).not.toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('note-row').filter({ hasText: 'Biên bản họp Evernote' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('note-row').filter({ hasText: 'Ghi chú thứ hai' })).toBeVisible();
    await page.getByTestId('note-row').filter({ hasText: 'Biên bản họp Evernote' }).click();
    await expect(page.getByRole('article').getByText('Riêng tư', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Nội dung' })).toHaveValue(/Chốt kế hoạch triển khai\./);
    await expect(page.getByRole('textbox', { name: 'Nội dung' })).not.toHaveValue(/alert\(/);
    await expect(page.getByRole('textbox', { name: 'Nội dung' })).not.toHaveValue(/tracker\.invalid/);
    await expect(page.getByText('so-do.png')).toBeVisible();

    const dbNotes = sql<{ title: string; visibility: string; tainted: boolean }>(
      `SELECT n.title, n.visibility, n.tainted
         FROM ludy_notes.note n
         JOIN ludy_kernel.tenant t ON t.org_id = n.org_id
        WHERE t.slug = :'slug'
        ORDER BY n.created_at ASC`,
      { slug },
    );
    expect(dbNotes).toEqual([
      { title: 'Biên bản họp Evernote', visibility: 'private', tainted: true },
      { title: 'Ghi chú thứ hai', visibility: 'private', tainted: true },
    ]);
  });

  await test.step('Todoist (.csv): preview BOM CSV, invert 4->P1..1->P4, import checklists/sections/tags, and verify in My Work', async () => {
    await page.goto(`/o/${slug}/my-work`);
    await page.getByTestId('my-work-import-csv-btn').click();
    await expect(page.getByTestId('todoist-import-dialog')).toBeVisible();

    const csv =
      '\uFEFFTYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,DATE,TIMEZONE,LABELS\r\n' +
      'section,Ưu tiên tuần,,1,1,,,\r\n' +
      'task,Chốt hợp đồng @vip,"Ghi chú nhiều dòng\nvới dấu phẩy, và ngoặc",4,1,2026-05-10,Asia/Ho_Chi_Minh,"Khách VIP"\r\n' +
      'task,Gửi bản PDF,,1,2,,,\r\n' +
      'task,Kiểm tra sổ sách,,1,1,,,\r\n';

    await page.getByTestId('todoist-import-file-input').setInputFiles({
      name: 'Cong viec [9988].csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });

    const preview = page.getByTestId('todoist-dry-run-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('2 việc');
    await expect(preview).toContainText('1 bước kiểm tra');
    await expect(preview).toContainText('1 mục');
    await expect(preview).toContainText('P1 1');
    await expect(preview).toContainText('P4 1');
    await expect(preview).toContainText('Cong viec');

    await page.getByTestId('todoist-import-confirm').click();
    await expect(page.getByTestId('todoist-import-dialog')).not.toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('todo-row').filter({ hasText: 'Chốt hợp đồng' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Chốt hợp đồng' }).getByTestId('todo-priority-badge')).toContainText('P1');
    await expect(page.getByTestId('todo-row').filter({ hasText: 'Kiểm tra sổ sách' })).toBeVisible();

    const dbTodos = sql<{ title: string; priority: number; tainted: boolean; tags: string[] }>(
      `SELECT td.title, td.priority, td.tainted, td.tags
         FROM ludy_notes.todo td
         JOIN ludy_kernel.tenant t ON t.org_id = td.org_id
        WHERE t.slug = :'slug'
        ORDER BY td.priority ASC`,
      { slug },
    );
    expect(dbTodos).toEqual([
      { title: 'Chốt hợp đồng', priority: 1, tainted: true, tags: ['vip', 'khách vip'] },
      { title: 'Kiểm tra sổ sách', priority: 4, tainted: true, tags: [] },
    ]);
  });

  await test.step('other org member sees zero imported private notes, notebooks, lists, or todos', async () => {
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      const otherEmail = newEmail('notes-import-member');
      await otherPage.goto('/');
      await signInNewUser(otherPage, otherEmail);
      exec(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         SELECT t.org_id, u.id, 'member'
           FROM ludy_kernel.tenant t, ludy_kernel.user_account u
          WHERE t.slug = :'slug' AND u.email = :'otherEmail'`,
        { slug, otherEmail },
      );

      await otherPage.goto(`/o/${slug}/notes`);
      await expect(otherPage.getByTestId('note-row')).toHaveCount(0);
      await otherPage.goto(`/o/${slug}/my-work`);
      await expect(otherPage.getByTestId('todo-row')).toHaveCount(0);
    } finally {
      await otherContext.close();
    }
  });
});
