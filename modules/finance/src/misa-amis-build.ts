// SPDX-License-Identifier: AGPL-3.0-only
// The vouchers of a period and kind as the MISA AMIS push writes them (#3902, S3b of #3854): ONE path for the preview (apps/kernel misa-amis-preview.ts), the push command that queues them and the
// worker's rebuild before it sends. It loads the vouchers the MISA SME export of the same kind loads (finance.vouchers.purchases, .sales or .cash), writes each as the AMIS voucher (misa-amis-vouchers.ts) and
// digests what a person saw. It reads only: nothing here writes a row or calls MISA.
//
// The digest binds an approval to what was shown: SHA-256 over every voucher part's own digest, which is the hash of the part as canonical JSON WITHOUT the AMIS branch (only the worker reads the branch from
// AMIS, so the preview and the push write the part with a placeholder and the worker with the real one; the rest of the part must be the same).
import { createHash } from 'node:crypto';
import { AmisNumber, type AmisVoucher } from '@crove/misa-amis';
import { accountParents, type MisaAmisKind, type MisaAmisPreviewAsk, type MisaGoodsCode } from '@crove/kernel-contract';
import type { MisaAmisPushSource } from '@crove/db';
import {
  cashAmisVouchers,
  purchaseGoodsAmisVouchers,
  purchaseServiceAmisVouchers,
  salesAmisVouchers,
  type AmisContext,
  type AmisMapping,
} from './misa-amis-vouchers.ts';
import { goodsPurchaseRows, salesRows, servicePurchaseRows, type CashVoucher, type PurchaseVoucher, type SalesVoucher } from './misa.ts';
import { normalizeTaxCode, type WantedName } from './misa-amis-matching.ts';

/** Stands where the AMIS branch will be, so the mapper does not report it missing; the digest leaves the branch out, and the worker writes the real one. */
export const AMIS_PLACEHOLDER_BRANCH = '00000000-0000-4000-8000-000000000000';

export type AmisQuery = <T>(name: string, input: unknown) => Promise<T>;

/** What a person chose for a batch: the kind, the period, the entity and the codes the mapper cannot know. Exactly the preview's ask. */
export type AmisBuildAsk = MisaAmisPreviewAsk;

export interface AmisEntry {
  sourceId: string;
  sourceType: MisaAmisPushSource;
  mapping: AmisMapping;
}

export const amisSourceType = (kind: MisaAmisKind): MisaAmisPushSource =>
  kind === 'purchase_services' || kind === 'purchase_goods' ? 'purchase_document' : kind === 'sales' ? 'sales_document' : 'cash_voucher';

/** What a check against the firm's catalogue found, as the mapper reads it (misa-amis-match.ts `finance.misa_amis_match.results`): null until a check is done. */
export interface AmisMatches {
  partyCodes: ReadonlyMap<string, string> | null;
  itemCodes: ReadonlySet<string> | null;
  /** The codes a person confirmed for parties with no tax code, by party id (S3b, #4124). */
  partyNameCodes?: ReadonlyMap<string, string> | null;
}

/**
 * The mapper's context for an ask: the placeholder branch (or the real one, for the worker) and, once a check against the catalogue is done, the party and item codes it matched (a party or item it did not
 * match is then a blocker). Without a check there are no codes and nothing is checked (AMIS matches a party by name and tax code: unconfirmed, see the docs).
 */
export const amisContextOf = (ask: AmisBuildAsk, branchId: string | null = AMIS_PLACEHOLDER_BRANCH, matches: AmisMatches | null = null): AmisContext => ({
  branchId,
  purchasePurpose: ask.purchasePurpose ?? '1',
  serviceItemCode: ask.serviceItemCode ?? null,
  salesItemCode: ask.salesItemCode ?? null,
  defaultUnitName: 'Lần',
  partyCodes: matches?.partyCodes ?? null,
  partyNameCodes: matches?.partyNameCodes ?? null,
  itemCodes: matches?.itemCodes ?? null,
});

/** What a check has to look up for the vouchers of an ask: the tax codes of their parties (digits only) and the item codes they are written with. */
export interface AmisWanted {
  taxCodes: string[];
  itemCodes: string[];
  /** The parties with no (usable) tax code, by id and name as Ludy has them: looked up by name (S3b, #4124). The names are for the worker's memory and the comparison, never stored. */
  names: WantedName[];
}

/**
 * Loads and maps the vouchers of the ask. `limit` is how many the loaders are asked for (the preview asks for one more than it lists, so it knows there are more); `loaded` is how many they returned, before
 * a kind drops the vouchers that have no line of it (a purchase with only stock lines has no services voucher).
 */
export async function loadAmisEntries(query: AmisQuery, ask: AmisBuildAsk, ctx: AmisContext, limit: number): Promise<{ entries: AmisEntry[]; loaded: number; wanted: AmisWanted }> {
  const range = { from: ask.from, to: ask.to, limit, ...(ask.legalEntityId === undefined ? {} : { legalEntityId: ask.legalEntityId }) };
  const sourceType = amisSourceType(ask.kind);
  const entries: AmisEntry[] = [];
  let loaded = 0;
  const taxCodes = new Set<string>();
  const itemCodes = new Set<string>();
  const names = new Map<string, string>();
  const wantParty = (party: { id?: string | null; name?: string; taxCode: string | null } | null | undefined) => {
    const key = normalizeTaxCode(party?.taxCode);
    if (key !== null) taxCodes.add(key);
    else if (party?.id && party.name) names.set(party.id, party.name);
  };
  if (ask.kind === 'purchase_services' || ask.kind === 'purchase_goods') {
    const vouchers = await query<PurchaseVoucher[]>('finance.vouchers.purchases', range);
    loaded = vouchers.length;
    if (ask.kind === 'purchase_services') {
      for (const v of vouchers) {
        // A purchase with only stock lines has no services voucher.
        if (servicePurchaseRows(v).length === 0) continue;
        wantParty(v.vendor);
        if (ctx.serviceItemCode !== null) itemCodes.add(ctx.serviceItemCode);
        entries.push({ sourceId: v.sourceId, sourceType, mapping: purchaseServiceAmisVouchers(v, ctx) });
      }
    } else {
      const chart = await query<Array<{ code: string; parentCode: string | null }>>('finance.accounts.list', {});
      const goodsCodes = await query<MisaGoodsCode[]>('finance.misa_goods_codes.list', {});
      const parents = accountParents(chart);
      for (const v of vouchers) {
        const goodsRows = goodsPurchaseRows(v, goodsCodes, parents);
        if (goodsRows.length === 0) continue;
        wantParty(v.vendor);
        for (const row of goodsRows) if (row.goods.itemCode !== null) itemCodes.add(row.goods.itemCode);
        entries.push({ sourceId: v.sourceId, sourceType, mapping: purchaseGoodsAmisVouchers(v, goodsCodes, parents, ctx) });
      }
    }
  } else if (ask.kind === 'sales') {
    const vouchers = await query<SalesVoucher[]>('finance.vouchers.sales', range);
    loaded = vouchers.length;
    for (const v of vouchers) {
      if (salesRows(v).length === 0) continue;
      wantParty(v.customer);
      if (ctx.salesItemCode !== null) itemCodes.add(ctx.salesItemCode);
      entries.push({ sourceId: v.sourceId, sourceType, mapping: salesAmisVouchers(v, ctx) });
    }
  } else {
    const vouchers = await query<CashVoucher[]>('finance.vouchers.cash', { ...range, type: ask.kind });
    loaded = vouchers.length;
    for (const v of vouchers) {
      wantParty(v.party);
      entries.push({ sourceId: v.sourceId, sourceType, mapping: cashAmisVouchers(v, ctx) });
    }
  }
  return { entries, loaded, wanted: { taxCodes: [...taxCodes].sort(), itemCodes: [...itemCodes].sort(), names: [...names].map(([partyId, name]) => ({ partyId, name })).sort((a, b) => a.partyId.localeCompare(b.partyId)) } };
}

// Canonical JSON: keys sorted, an exact number written as its own text, nothing else that JSON.stringify would leave to chance. Only plain data goes in (the mapper's output).
function canonical(value: unknown): string {
  if (value instanceof AmisNumber) return value.text;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(',')}}`;
  }
  return 'null';
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The digest of one voucher part as the person saw it: the canonical JSON of the part without `branch_id`. */
export function amisPartDigest(voucher: AmisVoucher): string {
  const { branch_id: _branch, ...rest } = voucher;
  return sha256(canonical(rest));
}

/** The digest of a whole batch: every part's `org_refid` and own digest, in `org_refid` order, so the order the loaders happen to return them in does not matter. */
export function amisBatchDigest(entries: readonly AmisEntry[]): string {
  const lines = entries.flatMap((e) => e.mapping.vouchers.map((v) => `${v.org_refid}:${amisPartDigest(v)}`)).sort();
  return sha256(lines.join('\n'));
}

export interface AmisPartRow {
  sourceType: MisaAmisPushSource;
  sourceId: string;
  voucherType: number;
  part: number;
  orgRefid: string;
  orgRefno: string;
  digest: string;
  voucher: AmisVoucher;
}

/** The rows a push would queue: one per voucher part, with its digest. A blocked entry has none. */
export function amisPartRows(entries: readonly AmisEntry[]): AmisPartRow[] {
  return entries.flatMap((e) =>
    e.mapping.vouchers.map((voucher, i) => ({
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      voucherType: voucher.voucher_type,
      part: i + 1,
      orgRefid: voucher.org_refid.toLowerCase(),
      orgRefno: String(voucher.org_refno),
      digest: amisPartDigest(voucher),
      voucher,
    })),
  );
}
