// SPDX-License-Identifier: AGPL-3.0-only
// Tests for Ludy-branded GoTrue auth email templates, strict HTTP serving, and compose wiring (#3577).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import {
  AUTH_MAIL_TEMPLATE_CSP,
  AUTH_MAIL_TEMPLATE_NAMES,
  renderAuthMailTemplate,
} from '../src/auth-mail-templates.ts';
import { loadConfig } from '../src/config.ts';
import { contentSecurityPolicy, createHttpApp } from '../src/http.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATE_DIR = join(ROOT, 'apps/kernel/src/auth-templates');

const VOID_TAGS = new Set(['meta', 'br', 'hr', 'img', 'link']);

function assertBalancedHtml(html: string, name: string): void {
  expect(html, `${name} doctype`).toMatch(/^<!doctype html>/i);
  expect(html, `${name} lang=vi`).toContain('<html lang="vi">');
  const stack: string[] = [];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const tagName = match[2];
    if (!tagName) continue;
    const tag = tagName.toLowerCase();
    if (VOID_TAGS.has(tag)) continue;
    const closing = match[1] === '/';
    const selfClosed = (match[3] ?? '').trimEnd().endsWith('/');
    if (!closing && !selfClosed) {
      stack.push(tag);
    } else if (closing) {
      const opened = stack.pop();
      expect(opened, `${name} closing </${tag}>`).toBe(tag);
    }
  }
  expect(stack, `${name} unclosed tags`).toEqual([]);
}

describe('GoTrue auth mail templates (#3577)', () => {
  it('ships all 5 Vietnamese-first Ludy-branded HTML templates with PKCE and unexpected-request notes', () => {
    expect([...AUTH_MAIL_TEMPLATE_NAMES]).toEqual(['confirmation', 'recovery', 'magic_link', 'invite', 'email_change']);

    for (const name of AUTH_MAIL_TEMPLATE_NAMES) {
      const filePath = join(TEMPLATE_DIR, `${name}.html`);
      const raw = readFileSync(filePath, 'utf8');
      const rendered = renderAuthMailTemplate(`${name}.html`);
      expect(rendered).not.toBeNull();

      for (const html of [raw, rendered as string]) {
        assertBalancedHtml(html, name);
        expect(html, `${name} ConfirmationURL link`).toContain('href="{{ .ConfirmationURL }}"');
        expect(html, `${name} ConfirmationURL fallback`).toContain('>{{ .ConfirmationURL }}</a>');
        expect(html, `${name} Vietnamese heading`).toMatch(/<h1[^>]*>[\s\S]+<\/h1>/);
        expect(html, `${name} PKCE same-browser guidance`).toContain('trình duyệt');
        expect(html, `${name} unexpected-request notice`).toContain('bỏ qua thư này');
        expect(html, `${name} English line underneath`).toContain('English:');
        expect(html, `${name} same-browser English line`).toContain('browser');
        expect(html, `${name} English div sets lang="en"`).toContain('<div lang="en"');
        expect(html, `${name} decorative mark hidden from screen readers`).toContain('aria-hidden="true"');
        expect(html, `${name} CTA tap target >= 44px`).toContain('min-height:44px;box-sizing:border-box;font-size:15px;font-weight:600;line-height:20px;');
        expect(html, `${name} CTA vertical padding >= 13px`).toContain('padding:13px 22px;');
        expect(html, `${name} Ludy brand violet button`).toContain('#612BD3');
        expect(html, `${name} Ludy brand teal accent`).toContain('#0F8F7A');
        expect(html, `${name} no em/en dashes`).not.toMatch(/[\u2014\u2013]|&mdash;|&ndash;/);
        expect(html, `${name} no scripts or svgs`).not.toMatch(/<script\b|<svg\b/i);
        expect(html, `${name} no external URLs or project refs`).not.toMatch(/https?:\/\/|supabase\.co|ludy\.local|localhost/i);
        expect(html, `${name} no real email addresses`).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
        expect(html, `${name} no secret shapes or env refs`).not.toMatch(/SERVICE_ROLE|JWT_SECRET|PRIVATE KEY|AKIA|ASIA|whsec_|re_[A-Za-z0-9]+/);
      }
    }

    const emailChange = renderAuthMailTemplate('email_change.html') ?? '';
    expect(emailChange).toContain('{{ .Email }}');
    expect(emailChange).toContain('{{ .NewEmail }}');
  });

  it('keeps Go template conditionals balanced across all 5 templates', () => {
    for (const name of AUTH_MAIL_TEMPLATE_NAMES) {
      const html = renderAuthMailTemplate(`${name}.html`) ?? '';
      const ifs = (html.match(/\{\{\s*if\b/g) ?? []).length;
      const ends = (html.match(/\{\{\s*end\b/g) ?? []).length;
      expect(ifs, name).toBe(ends);
      // Every Go template action must have matching braces.
      const stripped = html.replace(/\{\{[^}]+\}\}/g, '');
      expect(stripped, name).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('escapes custom BRAND_NAME and strips template braces to prevent template injection', () => {
    const custom = renderAuthMailTemplate('confirmation.html', "Sổ & Co's {{ .Secret }}");
    expect(custom).not.toBeNull();
    expect(custom).toContain('Sổ &amp; Co&#39;s .Secret');
    expect(custom).not.toContain('{{ .Secret }}');
    expect(custom).toContain('{{ .ConfirmationURL }}');
  });

  it('wires all 5 GOTRUE_MAILER_TEMPLATES_* and GOTRUE_MAILER_SUBJECTS_* in docker-compose.yml and .env.example', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const authMailerDocs = envExample
      .split('\n')
      .filter((line) => line.includes('AUTH_MAILER_'))
      .join('\n');
    for (const name of AUTH_MAIL_TEMPLATE_NAMES) {
      const upper = name.toUpperCase();
      expect(compose).toContain(`GOTRUE_MAILER_TEMPLATES_${upper}: \${AUTH_MAILER_TEMPLATES_${upper}:-http://ludy:8080/auth-templates/${name}.html}`);
      expect(compose).toContain(`GOTRUE_MAILER_SUBJECTS_${upper}: \${AUTH_MAILER_SUBJECTS_${upper}:-`);
      expect(authMailerDocs).toContain(`# AUTH_MAILER_TEMPLATES_${upper}=`);
      expect(authMailerDocs).toContain(`# AUTH_MAILER_SUBJECTS_${upper}=`);
    }
    expect(compose).not.toMatch(/supabase\.co|SERVICE_ROLE|-----BEGIN [A-Z ]*PRIVATE KEY-----|whsec_[A-Za-z0-9]+/);
    expect(authMailerDocs).not.toMatch(/supabase\.co|SERVICE_ROLE|-----BEGIN [A-Z ]*PRIVATE KEY-----|whsec_|re_[A-Za-z0-9]+/);
    expect(envExample).not.toMatch(/supabase\.co|SERVICE_ROLE|-----BEGIN [A-Z ]*PRIVATE KEY-----|whsec_[A-Za-z0-9]+/);
  });
});

describe('HTTP /auth-templates/:name route (#3577)', () => {
  function makeApp(brandName?: string) {
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/x',
      AUTH_JWT_SECRET: 'x'.repeat(32),
      AUTH_ISSUER: 'crove-auth',
      AUTH_UPSTREAM_URL: 'http://127.0.0.1:9',
      WEB_DIST: '/nonexistent',
      ...(brandName ? { BRAND_NAME: brandName } : {}),
    });
    const reserve = vi.fn();
    const runtime = { installed: () => false, modules: () => ['kernel'] } as unknown as Runtime;
    const app = createHttpApp({
      config,
      runtime,
      store: {} as BlobStore,
      authenticate: async () => {
        throw new Error('should not authenticate');
      },
      pool: {} as pg.Pool,
      aiEnabled: false,
      emailLimiter: { reserve, release: vi.fn() },
    });
    return { app, reserve };
  }

  it('serves the 5 allowlisted HTML templates with strict headers and never touches auth email rate limits', async () => {
    const { app, reserve } = makeApp();
    for (const name of AUTH_MAIL_TEMPLATE_NAMES) {
      const res = await app.request(`/auth-templates/${name}.html`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type')?.toLowerCase()).toBe('text/html; charset=utf-8');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-security-policy')).toBe(AUTH_MAIL_TEMPLATE_CSP);
      const body = await res.text();
      expect(body).toContain('{{ .ConfirmationURL }}');
      expect(body).toContain('Lud<span style="color:#0F8F7A;">y</span>');

      const head = await app.request(`/auth-templates/${name}.html`, { method: 'HEAD' });
      expect(head.status, `HEAD ${name}`).toBe(200);
      expect(await head.text()).toBe('');
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it('applies custom BRAND_NAME in served templates while keeping SPA CSP unchanged', async () => {
    const { app } = makeApp("Sổ & Co's");
    const res = await app.request('/auth-templates/confirmation.html');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sổ &amp; Co&#39;s');
    expect(contentSecurityPolicy('/auth/v1', null)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' http://localhost; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ludy-sw",
    );
  });

  it('refuses unknown filenames, path traversal, directory listing, and non-GET methods with 404', async () => {
    const { app } = makeApp();
    for (const path of [
      '/auth-templates/',
      '/auth-templates/confirmation',
      '/auth-templates/unknown.html',
      '/auth-templates/..%2Fconfig.ts',
      '/auth-templates/%2e%2e%2fpackage.json',
      '/auth-templates/confirmation.html/extra',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
    }
    const post = await app.request('/auth-templates/confirmation.html', { method: 'POST' });
    expect(post.status).toBe(404);
  });
});
