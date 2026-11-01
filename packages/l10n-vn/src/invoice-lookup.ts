// SPDX-License-Identifier: AGPL-3.0-only
// The seller's lookup link and lookup code ("mã tra cứu") printed on an invoice PDF or written in the email that carries
// it (plan docs/plan/einvoice-lookup.md, #2258, slice 1). Deterministic: a provider table and plain text matching, no AI
// and no network. Everything it reads is untrusted text, so it only ever returns a link whose host is in the table (exact,
// or the one VNPT pattern), over https, with no credentials or port; anything else is not a link.

export const LOOKUP_PROVIDERS = ['misa', 'viettel', 'vnpt', 'bkav', 'easyinvoice', 'fpt'] as const;
export type LookupProvider = (typeof LOOKUP_PROVIDERS)[number];

interface ProviderSpec {
  id: LookupProvider;
  name: string;
  // Exact lookup hosts (lower case).
  hosts: readonly string[];
  // VNPT gives each seller its own host, <seller tax code>.vnpt-invoice.com.vn.
  sellerHostSuffix?: string;
  // Set when the provider's own wording of the code names it, so a code with no link still names the provider.
  ownLabel?: string;
}

// Sources and how sure they are: docs/plan/einvoice-lookup.md section 2. Hosts of MISA and EasyInvoice come from the
// providers' own pages; the others from their help pages and accountancy blogs and are checked by hand later (#2270).
export const LOOKUP_PROVIDER_TABLE: readonly ProviderSpec[] = [
  { id: 'misa', name: 'MISA meInvoice', hosts: ['meinvoice.vn', 'www.meinvoice.vn'] },
  { id: 'viettel', name: 'Viettel S-Invoice', hosts: ['sinvoice.viettel.vn'], ownLabel: 'ma so bi mat' },
  { id: 'vnpt', name: 'VNPT Invoice', hosts: [], sellerHostSuffix: '.vnpt-invoice.com.vn' },
  { id: 'bkav', name: 'BKAV eHoadon', hosts: ['van.ehoadon.vn'] },
  { id: 'easyinvoice', name: 'EasyInvoice', hosts: ['tracuu.easyinvoice.vn'] },
  { id: 'fpt', name: 'FPT eInvoice', hosts: ['tracuuhoadon.fpt.com.vn'] },
];

// What a hint says. url is https, on a table host, without credentials, port or fragment, at most 400 characters; code is
// the lookup code as printed. Either may be null: a link with no code, or a code with no link.
export interface LookupHint {
  provider: LookupProvider | null;
  url: string | null;
  code: string | null;
}

export const LOOKUP_HINTS_MAX = 3;
const URL_MAX = 400;
// Text past this is not read: a hostile document must not make the reader slow.
const TEXT_MAX = 200_000;

// Labels (folded: no diacritics, lower case) that precede a lookup code. "Mã nhận hóa đơn" is what some providers call
// it (the lookup code is the "mã nhận hóa đơn" of an E-invoice mail).
const CODE_LABELS = ['ma tra cuu hoa don', 'ma so tra cuu', 'ma tra cuu', 'ma so bi mat', 'ma nhan hoa don'] as const;

// A code: letters and digits, 6 to 40 of them. A word that merely follows a label ("tại", "trên") is not a code, so a code
// needs a digit, or at least 8 characters that are not all lower case.
const CODE_TOKEN = /^[A-Za-z0-9]{6,40}$/;

function plausibleCode(token: string): boolean {
  if (!CODE_TOKEN.test(token)) return false;
  if (/[0-9]/.test(token)) return true;
  return token.length >= 8 && token !== token.toLowerCase();
}

// The text without diacritics and in lower case, and for each of its characters the position of its source character, so
// a label found in the folded text can be followed by the code in the original. Combining marks drop out.
function fold(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    for (const piece of ch.normalize('NFD')) {
      if (/\p{M}/u.test(piece)) continue;
      const mapped = piece === 'đ' || piece === 'Đ' ? 'd' : piece.toLowerCase();
      for (let k = 0; k < mapped.length; k++) at.push(i);
      folded += mapped;
    }
    i += ch.length;
  }
  at.push(i);
  return { folded, at };
}

function normalizeSeller(taxCode: string | null | undefined): string | null {
  if (!taxCode) return null;
  const digits = taxCode.replace(/\D/g, '');
  return /^\d{10}(?:\d{3})?$/.test(digits) ? digits : null;
}

// The provider that owns a host, or null. The VNPT host is `<10 or 13 digit tax code>.vnpt-invoice.com.vn`; when the
// invoice's seller tax code is known the host must carry it, so a link in a document cannot send the person to another
// seller's lookup page.
export function lookupProviderOfHost(host: string, sellerTaxCode?: string | null): LookupProvider | null {
  const h = host.toLowerCase();
  for (const spec of LOOKUP_PROVIDER_TABLE) {
    if (spec.hosts.includes(h)) return spec.id;
    if (spec.sellerHostSuffix && h.endsWith(spec.sellerHostSuffix)) {
      const label = h.slice(0, -spec.sellerHostSuffix.length);
      if (!/^\d{10}(?:-?\d{3})?$/.test(label)) return null;
      const seller = normalizeSeller(sellerTaxCode);
      if (seller !== null && label.replace(/\D/g, '') !== seller) return null;
      return spec.id;
    }
  }
  return null;
}

// A link as the person may open it: https on a table host, no credentials, no port, no fragment, no control or space
// characters, at most 400 characters. A link written with http is read as https. Anything else gives null.
export function safeLookupUrl(raw: string, sellerTaxCode?: string | null): { url: string; provider: LookupProvider } | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > URL_MAX || /[\u0000- \u007f-\u009f]/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  // The parser drops a default port ("host:443"); a port written at all is refused.
  const authority = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '').split(/[/?#]/)[0] ?? '';
  if (authority.includes(':') || authority.includes('@')) return null;
  const provider = lookupProviderOfHost(url.hostname, sellerTaxCode);
  if (provider === null) return null;
  const safe = `https://${url.hostname}${url.pathname}${url.search}`;
  if (safe.length > URL_MAX) return null;
  return { url: safe, provider };
}

// A candidate link is a run of characters that cannot end a URL in running text. Splitting this way (and not with one
// regular expression over the whole text) keeps the work linear however a hostile document is built.
const TOKEN = /[^\s<>"'()[\]{}|\\^`,;]+/g;
const TOKEN_MAX = 400;

interface Found {
  at: number;
  value: string;
}

function findLinks(text: string, sellerTaxCode: string | null | undefined): Array<Found & { provider: LookupProvider }> {
  const out: Array<Found & { provider: LookupProvider }> = [];
  for (const match of text.matchAll(TOKEN)) {
    let raw = match[0];
    if (raw.length > TOKEN_MAX || !raw.includes('.')) continue;
    // "Website:https://host/path" and "Website:host": cut the label that a missing space glued on.
    const scheme = raw.search(/https?:\/\//i);
    if (scheme > 0) raw = raw.slice(scheme);
    else if (scheme < 0 && /^[^:/]*:[^:/]/.test(raw)) raw = raw.slice(raw.indexOf(':') + 1);
    // Trailing sentence punctuation is not part of the link.
    raw = raw.replace(/[.,;:!?]+$/, '');
    const safe = safeLookupUrl(raw, sellerTaxCode);
    if (safe !== null && !out.some((f) => f.value === safe.url)) out.push({ at: match.index ?? 0, value: safe.url, provider: safe.provider });
  }
  return out;
}

function findCodes(text: string): Array<Found & { provider: LookupProvider | null }> {
  const { folded, at: sourceAt } = fold(text);
  const out: Array<Found & { provider: LookupProvider | null }> = [];
  for (const label of CODE_LABELS) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(label, from);
      if (at < 0) break;
      from = at + label.length;
      const after = sourceAt[from] ?? text.length;
      // After the label: separators (a colon, a dash, spaces, a line break), then the code.
      const rest = text.slice(after, after + 80);
      const m = /^[\s:：\-–=.]*([A-Za-z0-9]+)/.exec(rest);
      const token = m?.[1];
      if (token && plausibleCode(token) && !out.some((f) => f.value === token)) {
        const own = LOOKUP_PROVIDER_TABLE.find((spec) => spec.ownLabel === label);
        out.push({ at: sourceAt[at] ?? 0, value: token, provider: own?.id ?? null });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// The lookup hints in a text, at most LOOKUP_HINTS_MAX, in the order of the text. A link takes the code nearest to it; a
// code with no link on a table host is a hint with no link, named by its own label when the provider has one. Never
// throws and never follows a link.
export function readLookupHints(rawText: string, options: { sellerTaxCode?: string | null } = {}): LookupHint[] {
  // NFC first: text with separate accent marks folds to the same letters as the composed form.
  const text = (rawText.length > TEXT_MAX ? rawText.slice(0, TEXT_MAX) : rawText).normalize('NFC');
  const links = findLinks(text, options.sellerTaxCode);
  const codes = findCodes(text);
  const hints: LookupHint[] = [];
  const used = new Set<string>();
  for (const link of links) {
    let best: (typeof codes)[number] | null = null;
    for (const code of codes) {
      if (best === null || Math.abs(code.at - link.at) < Math.abs(best.at - link.at)) best = code;
    }
    if (best !== null) used.add(best.value);
    hints.push({ provider: link.provider, url: link.value, code: best?.value ?? null });
  }
  for (const code of codes) {
    if (!used.has(code.value)) hints.push({ provider: code.provider, url: null, code: code.value });
  }
  return hints.slice(0, LOOKUP_HINTS_MAX);
}
