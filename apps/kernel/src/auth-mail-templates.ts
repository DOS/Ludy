// SPDX-License-Identifier: AGPL-3.0-only
// Ludy-branded GoTrue email templates served over HTTP to the bundled Supabase Auth service (#3577).
// Only the exact five allowlisted HTML filenames are readable; request parameters never touch the filesystem.
import { readFileSync } from 'node:fs';
import { DEFAULT_BRAND_NAME } from './config.ts';

export const AUTH_MAIL_TEMPLATE_NAMES = ['confirmation', 'recovery', 'magic_link', 'invite', 'email_change'] as const;

export const AUTH_MAIL_TEMPLATE_ROUTE = '/auth-templates/:name';
export const AUTH_MAIL_TEMPLATE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TEMPLATES: Record<string, string> = Object.fromEntries(
  AUTH_MAIL_TEMPLATE_NAMES.map((name) => [
    `${name}.html`,
    readFileSync(new URL(`./auth-templates/${name}.html`, import.meta.url), 'utf8'),
  ]),
);

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

// Strip control/format characters and Go template braces so a configured brand name stays plain text inside Go html/template.
function cleanBrand(brand: string): string {
  const cleaned = brand
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}{}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || DEFAULT_BRAND_NAME;
}

const DEFAULT_WORDMARK = '<span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#17141F;vertical-align:middle;">Lud<span style="color:#0F8F7A;">y</span></span>';

export function renderAuthMailTemplate(fileName: string, brand = DEFAULT_BRAND_NAME): string | null {
  if (!Object.hasOwn(TEMPLATES, fileName)) return null;
  const raw = TEMPLATES[fileName] as string;
  const normalized = cleanBrand(brand);
  const safeBrand = escapeHtml(normalized);
  const wordmark =
    normalized === DEFAULT_BRAND_NAME
      ? DEFAULT_WORDMARK
      : `<span style="font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#17141F;vertical-align:middle;">${safeBrand}</span>`;
  return raw
    .replace(/<!--brand-wordmark-->[\s\S]*?<!--\/brand-wordmark-->/g, () => wordmark)
    .replace(/<!--brand-->[\s\S]*?<!--\/brand-->/g, () => safeBrand);
}
