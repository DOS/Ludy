// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace push address card focus and secret non-persistence (#4350, follow-up of #4348).
// The default E2E stack runs with MARKETPLACE_PROVIDERS=sandbox and PUBLIC_URL=http://localhost:8080 (which isLocalUrl requires
// for EINVOICE_SANDBOX, ADS_SANDBOX, and sandbox, whereas marketplaceHookBaseUsable requires a non-local https: PUBLIC_URL and
// no offline push-capable fake marketplace adapter exists). The first test verifies the unmodified stack hides the push card;
// the second seeds a real tiktok_shop connection in PostgreSQL, stubs only marketplace/providers (push: true) and
// marketplace/connections/pushHookSet (persisting only key_sha256 in PostgreSQL and returning a one-time https push URL), and
// runs marketplace/connections/list and marketplace/connections/pushHook against the real kernel and database to exercise
// automatic focus to the read-only address field, focus return on Close, and zero persistence across navigation, reload,
// storage, and subsequent network traffic.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { exec, sql } from '../lib/db.ts';
import { createOrg, newEmail, signInNewUser } from '../lib/session.ts';
import { openSettingsTab } from '../lib/settings.ts';

test('the push address card stays hidden when the deployment lacks a push-capable adapter and https PUBLIC_URL', async ({ page }) => {
  await signInNewUser(page, newEmail('marketplace-push-off'));
  await createOrg(page, 'Công ty Sàn Chưa Đẩy');
  await page.getByRole('banner').getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await openSettingsTab(page, 'connections');

  const marketplaceCard = page.getByRole('group', { name: 'Sàn thương mại điện tử: lấy đơn từ tài khoản người bán' });
  await expect(marketplaceCard).toBeVisible();
  await marketplaceCard.getByRole('button', { name: 'Kết nối', exact: true }).click();
  await expect(marketplaceCard.getByTestId('marketplace-connection')).toContainText('Sàn thử nghiệm (shopee)');
  await expect(marketplaceCard.getByRole('region', { name: 'Nhận thông báo đẩy từ sàn' })).toHaveCount(0);
});

test('creating a push address moves focus to the read-only field, Close returns focus, and leaving persists no address', async ({ page }) => {
  await signInNewUser(page, newEmail('marketplace-push'));
  const slug = await createOrg(page, 'Công ty Nhận Push Sàn');

  const [tenant] = sql<{ orgId: string; ownerId: string }>(
    `SELECT t.org_id AS "orgId", m.user_id AS "ownerId"
     FROM ludy_kernel.tenant t
     JOIN ludy_kernel.tenant_member m ON m.org_id = t.org_id AND m.role = 'owner'
     WHERE t.slug = :'slug'
     LIMIT 1`,
    { slug },
  );
  expect(tenant?.orgId).toBeTruthy();
  expect(tenant?.ownerId).toBeTruthy();

  const orgId = tenant!.orgId;
  const ownerId = tenant!.ownerId;
  const channelId = randomUUID();
  const connectionId = randomUUID();
  exec(
    `INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by)
     VALUES (:'orgId'::uuid, :'channelId'::uuid, 'marketplace_tiktok_shop', :'externalId', 'tiktok_shop (tiktok_shop)', :'ownerId'::uuid)`,
    { orgId, channelId, externalId: `e2e-tiktok-${connectionId.slice(0, 8)}`, ownerId },
  );
  exec(
    `INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform)
     VALUES (:'orgId'::uuid, :'connectionId'::uuid, :'channelId'::uuid, 'marketplace_tiktok_shop', 'tiktok_shop')`,
    { orgId, connectionId, channelId },
  );

  const issuedSecrets: Array<{ key: string; keyHash: string; address: string }> = [];
  const outgoingRequests: Array<{ url: string; method: string; postData: string; headers: string }> = [];
  const rpcResponses: Array<{ url: string; body: string }> = [];
  const pendingResponses: Promise<void>[] = [];

  await page.route('**/api/rpc/marketplace/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        json: {
          adapters: [
            {
              id: 'tiktok_shop',
              offline: false,
              push: true,
              connectFields: ['appKey', 'appSecret', 'serviceId'],
              platforms: ['tiktok_shop'],
            },
          ],
          platforms: [
            { platform: 'shopee', adapter: false, adapters: [] },
            { platform: 'tiktok_shop', adapter: true, adapters: ['tiktok_shop'] },
            { platform: 'lazada', adapter: false, adapters: [] },
          ],
        },
      }),
    });
  });

  await page.route('**/api/rpc/marketplace/connections/pushHookSet', async (route) => {
    const payload = route.request().postDataJSON() as { json?: { id?: string; idempotencyKey?: string } } | null;
    expect(payload?.json?.id).toBe(connectionId);
    expect(payload?.json?.idempotencyKey).toBeUndefined();

    const key = randomBytes(16).toString('base64url');
    const keyHash = createHash('sha256').update(key, 'utf8').digest('hex');
    const address = `https://e2e.example.test/api/marketplace/tiktok_shop/webhook/${key}`;
    const created = issuedSecrets.length === 0;
    exec(
      `INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256)
       VALUES (:'orgId'::uuid, :'connectionId'::uuid, :'keyHash')
       ON CONFLICT ON CONSTRAINT marketplace_hook_connection_uq DO UPDATE SET
         key_sha256 = EXCLUDED.key_sha256,
         rotated_at = pg_catalog.clock_timestamp(),
         rejected_count = 0,
         rejected_window_start = NULL,
         stopped_at = NULL`,
      { orgId, connectionId, keyHash },
    );
    issuedSecrets.push({ key, keyHash, address });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ json: { adapter: 'tiktok_shop', address, created } }),
    });
  });

  page.on('request', (request) => {
    outgoingRequests.push({
      url: request.url(),
      method: request.method(),
      postData: request.postData() ?? '',
      headers: JSON.stringify(request.headers()),
    });
  });
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/rpc/') || url.endsWith('/api/rpc/marketplace/connections/pushHookSet')) return;
    pendingResponses.push(
      response
        .text()
        .then((body) => {
          rpcResponses.push({ url, body });
        })
        .catch(() => undefined),
    );
  });

  await page.getByRole('banner').getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await openSettingsTab(page, 'connections');

  const marketplaceCard = page.getByRole('group', { name: 'Sàn thương mại điện tử: lấy đơn từ tài khoản người bán' });
  const pushCard = marketplaceCard.getByRole('region', { name: 'Nhận thông báo đẩy từ sàn' });

  await test.step('the owner opens the push address card before any address exists', async () => {
    await expect(marketplaceCard.getByTestId('marketplace-connection')).toContainText('tiktok_shop (tiktok_shop)');
    await expect(pushCard).toBeVisible();
    await expect(pushCard.getByText('Chưa có địa chỉ thông báo.')).toBeVisible();
    await expect(pushCard.getByLabel('Địa chỉ nhận thông báo')).toHaveCount(0);
    await expect(pushCard.getByRole('button', { name: 'Tạo địa chỉ', exact: true })).toBeVisible();
  });

  await test.step('creating the address shows it once and moves focus to the read-only field', async () => {
    await pushCard.getByRole('button', { name: 'Tạo địa chỉ', exact: true }).click();
    const addressField = pushCard.getByLabel('Địa chỉ nhận thông báo');
    await expect(addressField).toBeVisible();

    const first = issuedSecrets[0];
    expect(first).toBeTruthy();
    await expect(addressField).toHaveValue(first!.address);
    await expect(addressField).toHaveAttribute('readonly', '');
    await expect(addressField).not.toBeEditable();
    await expect(addressField).toBeFocused();
    await expect
      .poll(() =>
        addressField.evaluate((el: HTMLInputElement) => ({
          start: el.selectionStart,
          end: el.selectionEnd,
        })),
      )
      .toEqual({ start: 0, end: first!.address.length });

    await expect(pushCard.getByText('Hãy sao chép địa chỉ này ngay. Địa chỉ chỉ hiện một lần; sau khi đóng, chỉ có thể tạo địa chỉ mới.')).toBeVisible();
    // Wait for the real pushHook invalidation refetch so the card reflects the stored hook.
    await expect(pushCard.getByText(/Địa chỉ tạo lúc/)).toBeVisible();
  });

  await test.step('clicking Close hides the address and returns focus to the trigger button', async () => {
    await pushCard.getByRole('button', { name: 'Tôi đã dán xong, ẩn địa chỉ', exact: true }).click();
    await expect(pushCard.getByLabel('Địa chỉ nhận thông báo')).toHaveCount(0);
    const triggerButton = pushCard.getByRole('button', { name: 'Đổi địa chỉ mới', exact: true });
    await expect(triggerButton).toBeVisible();
    await expect(triggerButton).toBeFocused();
  });

  await test.step('rotating asks for confirmation, moves focus to the replacement address, and Close returns focus', async () => {
    await pushCard.getByRole('button', { name: 'Đổi địa chỉ mới', exact: true }).click();
    const confirmButton = pushCard.getByRole('button', { name: 'Đúng, đổi địa chỉ ngay', exact: true });
    await expect(confirmButton).toBeVisible();
    await expect(confirmButton).toBeFocused();
    await confirmButton.click();

    const addressField = pushCard.getByLabel('Địa chỉ nhận thông báo');
    await expect(addressField).toBeVisible();
    const second = issuedSecrets[1];
    expect(second).toBeTruthy();
    expect(second!.address).not.toBe(issuedSecrets[0]!.address);
    await expect(addressField).toHaveValue(second!.address);
    await expect(addressField).toHaveAttribute('readonly', '');
    await expect(addressField).toBeFocused();
    await expect(
      pushCard.getByText('Địa chỉ này đã thay một địa chỉ có sẵn; địa chỉ cũ không còn hoạt động. Hãy dán địa chỉ mới này vào ứng dụng trên sàn.'),
    ).toBeVisible();
    await expect(pushCard.getByText(/Đổi lúc/)).toBeVisible();

    await pushCard.getByRole('button', { name: 'Tôi đã dán xong, ẩn địa chỉ', exact: true }).click();
    await expect(pushCard.getByLabel('Địa chỉ nhận thông báo')).toHaveCount(0);
    const triggerButton = pushCard.getByRole('button', { name: 'Đổi địa chỉ mới', exact: true });
    await expect(triggerButton).toBeFocused();
  });

  const requestCheckpoint = outgoingRequests.length;
  const secrets = issuedSecrets;
  expect(secrets).toHaveLength(2);

  await test.step('leaving, re-entering, reloading, storage, and subsequent requests hold no secret push address', async () => {
    await openSettingsTab(page, 'org');
    await expect(page.getByText('Hồ sơ thuế', { exact: true })).toBeVisible();
    await expect(pushCard).toHaveCount(0);

    await openSettingsTab(page, 'connections');
    await expect(pushCard).toBeVisible();
    await expect(pushCard.getByText(/Địa chỉ tạo lúc/)).toBeVisible();
    await expect(pushCard.getByLabel('Địa chỉ nhận thông báo')).toHaveCount(0);
    await expect(pushCard.getByRole('button', { name: 'Đổi địa chỉ mới', exact: true })).toBeVisible();

    const domAfterReenter = await page.evaluate(() => document.documentElement.innerHTML);
    for (const secret of secrets) {
      expect(domAfterReenter).not.toContain(secret.address);
      expect(domAfterReenter).not.toContain(secret.key);
    }

    await page.reload();
    await expect(pushCard).toBeVisible();
    await expect(pushCard.getByText(/Địa chỉ tạo lúc/)).toBeVisible();
    await expect(pushCard.getByLabel('Địa chỉ nhận thông báo')).toHaveCount(0);

    const domAfterReload = await page.evaluate(() => document.documentElement.innerHTML);
    for (const secret of secrets) {
      expect(domAfterReload).not.toContain(secret.address);
      expect(domAfterReload).not.toContain(secret.key);
    }

    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      }),
    );
    for (const secret of secrets) {
      expect(stored).not.toContain(secret.address);
      expect(stored).not.toContain(secret.key);
    }

    const subsequentRequests = outgoingRequests.slice(requestCheckpoint);
    expect(subsequentRequests.length).toBeGreaterThan(0);
    for (const req of subsequentRequests) {
      const serialized = `${req.method} ${req.url} ${req.headers} ${req.postData}`;
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret.address);
        expect(serialized).not.toContain(secret.key);
      }
    }

    await Promise.all(pendingResponses);
    const pushHookStatusResponses = rpcResponses.filter((r) => r.url.endsWith('/api/rpc/marketplace/connections/pushHook'));
    expect(pushHookStatusResponses.length).toBeGreaterThan(0);
    for (const res of rpcResponses) {
      for (const secret of secrets) {
        expect(res.body).not.toContain(secret.address);
        expect(res.body).not.toContain(secret.key);
      }
    }

    const [hookRow] = sql<{ keyHash: string }>(
      `SELECT key_sha256 AS "keyHash" FROM ludy_finance.marketplace_hook WHERE org_id = :'orgId'::uuid AND marketplace_connection_id = :'connectionId'::uuid`,
      { orgId, connectionId },
    );
    expect(hookRow?.keyHash).toBe(secrets[1]!.keyHash);
  });
});
