// SPDX-License-Identifier: AGPL-3.0-only
// The company a person may work at (#2438, CRM-Q5 of docs/plan/crm.md, PR 3): what the org already knows that points a person to a company, read for the
// sales coworker's suggestion on the person's panel. Three rules, in this order, each deterministic and each reading the org's own rows as the member
// (row-level security applies):
//   1. a company tax code the person wrote in a message of their conversations (a customer who says "MST 0123456780" names the company they buy for): the newest
//      forty inbound messages of the conversations linked to them, as far as the member may read them (row-level security: a private message is read by owners,
//      admins and holders of the direct-message permission, a comment thread by the members of its channel);
//   2. a company that writes from the same email domain (the company's own address on its party, the person's on theirs); a free mail address says nothing;
//   3. a company whose name carries the word at the heart of the person's email domain ("acme" of nam@acme.com.vn finds "Công ty TNHH Acme Việt Nam").
// The model only orders the third group when it has two or more names (apps/kernel/src/contact-company-ai.ts); it adds no candidate. Nothing is linked here:
// the link is a person's click on kernel.party.set_company. A person who already has a company and a company have no candidate; a merged party, or one the member
// cannot read, is not found (PARTY_NOT_FOUND). Twelve digits is a citizen ID, not a company's tax code, and is never looked for.
import { sql } from 'kysely';
import { normalizeTaxCode, zCompanySuggest, type CompanyCandidates } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// Domains that belong to everyone: an address there says nothing about a company.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.vn', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'gmx.com', 'mail.com', 'mail.ru', 'yandex.com', 'qq.com', '163.com', 'naver.com', 'vnn.vn', 'fastmail.com',
  'outlook.com.vn', 'hotmail.co.uk', 'yahoo.co.uk', 'yahoo.co.jp', 'live.com.vn', 'icloud.com.vn',
]);
// Public suffixes of two labels that Vietnamese businesses write from: the word at the heart of "acme.com.vn" is "acme", not "com".
const TWO_LABEL_SUFFIX = new Set(['com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn', 'info.vn', 'biz.vn', 'ac.vn', 'co.uk', 'com.au', 'co.jp', 'com.sg', 'co.kr', 'com.cn', 'com.hk', 'co.th', 'com.my', 'co.id']);
// A label that names the kind of the suffix, not a business: "com" of acme.com.cn would find every company with "com" in its name.
const GENERIC_LABEL = new Set(['com', 'net', 'org', 'edu', 'gov', 'info', 'biz']);

export function emailDomainOf(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && !FREE_MAIL.has(domain) ? domain : null;
}

// The word at the heart of a domain: the label before the public suffix, when it is at least three letters or digits.
export function domainLabelOf(domain: string): string | null {
  const parts = domain.split('.');
  const suffix = parts.slice(-2).join('.');
  const label = parts.length >= 3 && TWO_LABEL_SUFFIX.has(suffix) ? parts[parts.length - 3] : parts[parts.length - 2];
  return label !== undefined && /^[a-z0-9]{3,}$/.test(label) && !GENERIC_LABEL.has(label) ? label : null;
}

// The company tax codes (ten digits, with a branch suffix or not) written in a text, each once, normalized.
export function taxCodesIn(text: string): string[] {
  const found: string[] = [];
  // A full stop after the code ends a sentence, a full stop and a digit is a decimal: "MST 0123456780." counts, "1234567890.5" does not.
  for (const match of text.matchAll(/(?<![\w.-])\d{10}(?:-\d{3})?(?!\w|\.\d)/g)) {
    const code = normalizeTaxCode(match[0]);
    if (code !== null && !found.includes(code)) found.push(code);
  }
  return found;
}

const TAX_CODES_MAX = 5;
const NAMES_MAX = 8;
const GROUP_MAX = 5;

export const companyCandidates = defineQuery({
  name: 'crm.contact.company_candidates',
  input: zCompanySuggest,
  access: WRITERS,
  handler: async (ctx, input): Promise<CompanyCandidates> => {
    const { rows } = await sql<{ kind: string; name: string; email: string | null; company_id: string | null }>`
      SELECT p.kind, p.name, p.email, p.company_id FROM crove_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ${input.partyId}::uuid AND p.duplicate_of IS NULL`.execute(ctx.trx);
    const person = rows[0];
    if (!person) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy đối tác');
    const none: CompanyCandidates = { personName: person.name, label: null, taxCode: [], emailDomain: [], names: [] };
    if (person.kind !== 'person' || person.company_id !== null) return none;

    // 1. Tax codes the person wrote in their conversations (what the customer sent, the newest messages first), as they are, or the same enterprise by its branch.
    const written = await sql<{ body: string }>`
      SELECT pg_catalog.left(m.body, 2000) AS body
      FROM crove_kernel.conversation_message m
      JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.party_id = ${input.partyId}::uuid AND m.direction = 'in' AND m.platform_removed_at IS NULL
      ORDER BY m.id DESC LIMIT 40`.execute(ctx.trx);
    const codes: string[] = [];
    for (const { body } of written.rows) for (const code of taxCodesIn(body)) if (!codes.includes(code) && codes.length < TAX_CODES_MAX) codes.push(code);
    const bases = codes.map((code) => code.slice(0, 10));
    const byTax =
      codes.length === 0
        ? []
        : (
            await sql<{ id: string; name: string }>`
              SELECT p.id, p.name FROM crove_kernel.party p
              WHERE p.org_id = ${ctx.orgId}::uuid AND p.kind = 'organization' AND p.duplicate_of IS NULL AND p.id <> ${input.partyId}::uuid
                AND (p.tax_code = ANY(${codes}::text[]) OR pg_catalog.split_part(p.tax_code, '-', 1) = ANY(${bases}::text[]))
              ORDER BY p.name, p.id LIMIT ${GROUP_MAX}`.execute(ctx.trx)
          ).rows;

    // 2. Companies that write from the person's domain.
    const domain = emailDomainOf(person.email);
    const byDomain =
      domain === null
        ? []
        : (
            await sql<{ id: string; name: string }>`
              SELECT p.id, p.name FROM crove_kernel.party p
              WHERE p.org_id = ${ctx.orgId}::uuid AND p.kind = 'organization' AND p.duplicate_of IS NULL AND p.email IS NOT NULL
                AND pg_catalog.lower(pg_catalog.split_part(p.email, '@', 2)) = ${domain}
              ORDER BY p.name, p.id LIMIT ${GROUP_MAX}`.execute(ctx.trx)
          ).rows;

    // 3. Companies whose name has the word at the heart of the domain as a whole word (the stored search column narrows by the word first).
    const label = domain === null ? null : domainLabelOf(domain);
    const byName =
      label === null
        ? []
        : (
            await sql<{ id: string; name: string }>`
              SELECT p.id, p.name FROM crove_kernel.party p
              WHERE p.org_id = ${ctx.orgId}::uuid AND p.kind = 'organization' AND p.duplicate_of IS NULL AND p.search @@ pg_catalog.to_tsquery('pg_catalog.simple', ${label})
                AND pg_catalog.strpos(' ' || crove_kernel.search_fold(p.name) || ' ', ' ' || ${label} || ' ') > 0
              ORDER BY pg_catalog.array_length(pg_catalog.string_to_array(crove_kernel.search_fold(p.name), ' '), 1), p.name, p.id LIMIT ${NAMES_MAX + 4}`.execute(ctx.trx)
          ).rows;

    // Each company once, under the first rule that found it.
    const seen = new Set<string>();
    const fresh = (list: Array<{ id: string; name: string }>) =>
      list.flatMap((r) => {
        if (seen.has(r.id)) return [];
        seen.add(r.id);
        return [{ partyId: r.id, name: r.name }];
      });
    const taxCode = fresh(byTax);
    const emailDomain = fresh(byDomain);
    const names = fresh(byName).slice(0, NAMES_MAX);
    return { personName: person.name, label, taxCode, emailDomain, names };
  },
});

export const companySuggestQueries = [companyCandidates];
