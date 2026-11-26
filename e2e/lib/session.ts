// Sign-up and sign-in through the SPA, as a user does it, and confirmed users made without the sign-up form.
import { expect, type Page } from '@playwright/test';
import { compose } from './compose.ts';
import { authLink } from './mail.ts';

export const PASSWORD = 'e2e-password-0123';

export function newEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

// Signs up, opens the confirmation link from the email in the same browser (PKCE) and lands on onboarding.
export async function signUp(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByText('Đã gửi email xác nhận')).toBeVisible();
  await page.goto(await authLink(email, /Xác nhận địa chỉ email/i));
  await expect(page).toHaveURL(/\/onboarding$/);
}

// Supabase Auth's admin API, called by Node inside the kernel container: the /auth/v1 proxy never forwards /admin
// (http.ts), while the container reaches Supabase Auth on the compose network and holds the stack's JWT secret, so the
// secret never leaves it. It signs a service_role token that lives a minute. argv: email, password.
const CREATE_CONFIRMED_USER = `
import { createHmac } from 'node:crypto';
const [email, password] = process.argv.slice(1);
const missing = ['AUTH_JWT_SECRET', 'AUTH_UPSTREAM_URL', 'AUTH_ISSUER'].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error('The kernel container lacks ' + missing.join(', ') + '; is the stack fully started?');
  process.exit(1);
}
const part =(value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ role: 'service_role', aud: 'authenticated', iss: process.env.AUTH_ISSUER, iat: now, exp: now + 60 });
const token = unsigned + '.' + createHmac('sha256', process.env.AUTH_JWT_SECRET).update(unsigned).digest('base64url');
const response = await fetch(process.env.AUTH_UPSTREAM_URL + '/admin/users', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (!response.ok) {
  console.error('Supabase Auth admin: ' + response.status + ' ' + (await response.text()));
  process.exit(1);
}
`;

// Creates a user whose email is already confirmed, without the sign-up form. Supabase Auth allows each client address
// a burst of 30 sign-ups, then one per 10 s (auth-rate-limits.spec.ts), and this runner is one address for the whole
// suite, so a test whose subject is not sign-up starts its users here and keeps the UI sign-ups for the specs about
// sign-up and onboarding (auth.spec.ts, onboarding.spec.ts, invite-preclaim.spec.ts and the others that call signUp).
// Acts on the same compose project as the database helpers, so it throws on a non-default E2E_BASE_URL without
// E2E_COMPOSE_PROJECT.
export function createConfirmedUser(email: string, password = PASSWORD): void {
  compose(['exec', '-T', 'ludy', 'node', '--input-type=module', '-e', CREATE_CONFIRMED_USER, email, password]);
}

// A confirmed user created with createConfirmedUser, signed in through the login form, on onboarding (no org yet).
export async function signInNewUser(page: Page, email: string, password = PASSWORD): Promise<void> {
  createConfirmedUser(email, password);
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/onboarding$/);
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}

// The app's own sign-out control. Where it is depends on the screen, and the screen is told by the address: inside an
// org (/o/<slug>/...) it is behind the sidebar's account popover, and on the screens outside an org (onboarding, /mfa,
// /clients) it is a button on the page itself.
// The path is taken from the address, not from whichever control happens to be visible at that moment. On a route change
// the address is the new one while the old screen is still drawn: right after the code is accepted on /mfa the URL is
// already the org overview, yet the /mfa screen and its own sign-out button stay up for a moment. A click aimed at that
// button is lost when the screen is replaced, and inside an org no page-level sign-out button exists to resolve again, so
// the click would wait out the whole test timeout (#4906). Each path then waits for the control of its own screen, which
// the click does by itself (visible, enabled and stable), so no sleep and no retry is needed.
export async function signOut(page: Page): Promise<void> {
  const insideOrg = /^\/o\/[^/]+(\/|$)/.test(new URL(page.url()).pathname);
  if (insideOrg) {
    const topBar = page.getByRole('banner');
    await topBar.getByRole('button', { name: /^Tài khoản:/ }).click();
    await topBar.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    return;
  }
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
}

// The screen offers "Một mình tôi" (only Tài chính, Cộng tác and Ludy AI on) by default (#4802); the specs that follow in an org use every app, so the helper
// picks "Có nhân viên" unless a spec asks for the other.
export async function createOrg(page: Page, name: string, kind: 'solo' | 'team' = 'team'): Promise<string> {
  await page.getByLabel('Tên công ty hoặc hộ kinh doanh').fill(name);
  await page.getByRole('radio', { name: kind === 'team' ? /^Có nhân viên/ : /^Một mình tôi/ }).check();
  await page.getByRole('button', { name: 'Tạo tổ chức' }).click();
  await expect(page).toHaveURL(/\/o\/[^/]+\/overview$/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// The session auth-js keeps in localStorage (storage key `ludy-auth`).
export async function storedSession(page: Page): Promise<StoredSession | null> {
  const raw = await page.evaluate(() => window.localStorage.getItem('ludy-auth'));
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}

export function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}
