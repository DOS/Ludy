// The product name users see (BRAND_NAME, issue #1040). Messages and guides say `{brand}` where they name the
// product; the catalogs handed to use-intl have it filled in, so no t() call passes it. The kernel serves the name in
// /api/config; main.tsx sets it once, before the first render, and "Ludy" stands until then (or when the server
// sends none). `{brandSlug}` is the same name as a file-name prefix ("ludy", "ten-moi"; #1045). `{gm}`, `{finance}`,
// `{sales}`, `{marketing}` and `{system}` are the names of the AI coworkers by what they cover (#1683, #2410), whatever the brand: a
// message names the coworker of its own area (Ludy Kế toán's, Engage's Inbox, customers and sales, Engage's marketing) and the
// general manager where the work spans apps. The names are in one place, COWORKER_ROSTER (@crove/kernel-contract).
import { COWORKER_KEYS, COWORKER_ROSTER, brandSlug, type CoworkerKey as RosterKey } from '@crove/kernel-contract';

export const DEFAULT_BRAND = 'Ludy';
// The AI coworkers by role (DESIGN.md 1.1); the names are the roster's.
export const COWORKERS = COWORKER_ROSTER;
export type CoworkerKey = RosterKey;

function fillCoworkers(text: string): string {
  let out = text;
  for (const key of COWORKER_KEYS) out = out.replaceAll(`{${key}}`, COWORKERS[key]);
  return out;
}

// The same rule as the kernel's BRAND_NAME: plain text, so it needs no escaping in HTML or an ICU message beyond the
// apostrophe. Anything else from the server is ignored rather than shown.
const BRAND_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'+_!()-]*$/u;
const BRAND_MAX = 40;

let current = DEFAULT_BRAND;
const listeners = new Set<() => void>();

export function brandName(): string {
  return current;
}

// The configured name when it is valid, else "Ludy". Calls `subscribeBrand` listeners when it changes.
export function setBrandName(name: unknown): void {
  const next = typeof name === 'string' && name.trim().length <= BRAND_MAX && BRAND_PATTERN.test(name.trim()) ? name.trim() : DEFAULT_BRAND;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Plain text (a guide line, a template sheet) with `{brand}`, `{brandSlug}` and the coworkers' names filled in.
export function withBrand(text: string, brand = current): string {
  return fillCoworkers(text.replaceAll('{brandSlug}', brandSlug(brand)).replaceAll('{brand}', brand));
}

// A downloaded file's name with the product name as its prefix: `crove-ke-hoach-2026-10.csv` under BRAND_NAME "Tên Mới"
// is saved as `ten-moi-ke-hoach-2026-10.csv`. Names the kernel or a module chose keep their `crove-` there (#1045).
export function brandFileName(name: string, brand = current): string {
  return name.startsWith('crove-') ? `${brandSlug(brand)}-${name.slice('crove-'.length)}` : name;
}

// The name as literal text inside an ICU message: an apostrophe is doubled, the only character of the allowed set
// that ICU treats specially.
function icuLiteral(brand: string): string {
  return brand.replaceAll("'", "''");
}

// `{brand}` and the coworkers' names replaced in every message of a catalog, at the type level too: use-intl then sees no
// `brand` or coworker argument, so callers pass none. "Ludy" stands in for the name in the types; only the arguments
// matter there.
type FillSlug<S extends string> = S extends `${infer Head}{brandSlug}${infer Tail}` ? `${Head}ludy${FillSlug<Tail>}` : S;
type FillBrand<S extends string> = S extends `${infer Head}{brand}${infer Tail}` ? `${Head}Ludy${FillBrand<Tail>}` : S;
// Each `{name}` of a coworker becomes the name; any other braces (an ICU argument, a plural) are kept as they are.
type FillCoworkers<S extends string> = S extends `${infer Head}{${infer Key}}${infer Tail}`
  ? Key extends CoworkerKey
    ? `${Head}${(typeof COWORKERS)[Key]}${FillCoworkers<Tail>}`
    : `${Head}{${Key}}${FillCoworkers<Tail>}`
  : S;
export type Branded<T> = { readonly [K in keyof T]: T[K] extends string ? FillCoworkers<FillSlug<FillBrand<T[K]>>> : Branded<T[K]> };

export function brandCatalog<T extends object>(messages: T, brand: string): Branded<T> {
  const literal = icuLiteral(brand);
  const slug = brandSlug(brand);
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return fillCoworkers(value.replaceAll('{brandSlug}', slug).replaceAll('{brand}', literal));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]));
    return value;
  };
  return fill(messages) as Branded<T>;
}
