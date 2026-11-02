// SPDX-License-Identifier: AGPL-3.0-only
// A receipt photographed with the phone's camera (issue #2384), end to end on a phone-sized viewport: the Inbox's "Chụp
// hóa đơn" opens the rear camera through the file input, a stack of photos in a row each becomes its own file, and a photo
// larger than the direct upload limit is shrunk on the device before it goes up, still a JPEG of the same receipt. The
// stack runs with no AI endpoint, so what is checked here is the way in; the reading of a photo (Vy, the checks, the
// proposal) is covered by the extraction tests.
import { expect, test, type Page } from '@playwright/test';
import { sql } from '../lib/db.ts';
import { createOrg, newEmail, signUp } from '../lib/session.ts';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// A small valid JPEG (a 1x1 pixel), made different for each photo by a trailing comment segment.
function tinyJpeg(n: number): Buffer {
  const base = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );
  return Buffer.concat([base, Buffer.from(`photo-${n}`)]);
}

// A PNG larger than the 4 MB direct upload limit, drawn in the page: noise of small amplitude over a gradient, so it is
// large as a PNG and compresses well as a JPEG, as a receipt photo does.
async function bigPng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const width = 2600;
    const height = 2000;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const image = context.createImageData(width, height);
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = Math.floor(i / width);
      image.data[i * 4] = Math.min(255, Math.floor((x / width) * 200) + Math.floor(next() * 40));
      image.data[i * 4 + 1] = Math.min(255, Math.floor((y / height) * 200) + Math.floor(next() * 40));
      image.data[i * 4 + 2] = 120 + Math.floor(next() * 40);
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('no png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

test('photograph receipts on a phone: the camera opens, each photo is its own file, a large one is shrunk first', async ({ page }) => {
  const slug = await test.step('sign up and create an org', async () => {
    await page.goto('/');
    await signUp(page, newEmail('capture'));
    const created = await createOrg(page, 'Công ty chụp hóa đơn');
    await expect(page.getByRole('heading', { name: 'Chứng từ chờ duyệt' })).toBeVisible();
    return created;
  });

  const files = () =>
    sql<{ filename: string; content_type: string; size_bytes: string }>(
      `SELECT f.filename, f.content_type, f.size_bytes::text FROM crove_kernel.file f JOIN crove_kernel.tenant t ON t.org_id = f.org_id WHERE t.slug = :'slug' ORDER BY f.filename`,
      { slug },
    );

  await test.step('the button opens the rear camera: one photo at a time, images only', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('capture-button').click();
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(false);
    const input = page.locator('input[type=file]');
    await expect(input).toHaveAttribute('capture', 'environment');
    await expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    await picked.setFiles({ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: tinyJpeg(1) });
  });

  await test.step('the ordinary upload button is still the file picker, for several files', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Tải chứng từ lên' }).click();
    const picked = await chooser;
    expect(picked.isMultiple()).toBe(true);
    await expect(page.locator('input[type=file]')).not.toHaveAttribute('capture', /.*/);
    await picked.setFiles([]);
  });

  await test.step('five photos in a row give five files', async () => {
    for (let n = 2; n <= 5; n++) {
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('capture-button').click();
      await (await chooser).setFiles({ name: `IMG_000${n}.jpg`, mimeType: 'image/jpeg', buffer: tinyJpeg(n) });
    }
    await expect.poll(() => files().length, { timeout: 60_000 }).toBe(5);
    expect(files().map((f) => f.filename)).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg', 'IMG_0004.jpg', 'IMG_0005.jpg']);
    expect(files().every((f) => f.content_type === 'image/jpeg')).toBe(true);
  });

  await test.step('a photo larger than the direct upload limit is shrunk on the device and goes up as a JPEG', async () => {
    const png = await bigPng(page);
    expect(png.length).toBeGreaterThan(4 * 1024 * 1024);
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('capture-button').click();
    await (await chooser).setFiles({ name: 'hoa-don-lon.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => files().length, { timeout: 120_000 }).toBe(6);
    const shrunk = files().find((f) => f.filename === 'hoa-don-lon.jpg');
    expect(shrunk).toBeDefined();
    expect(shrunk?.content_type).toBe('image/jpeg');
    expect(Number(shrunk?.size_bytes)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Number(shrunk?.size_bytes)).toBeGreaterThan(50 * 1024);
  });
});
