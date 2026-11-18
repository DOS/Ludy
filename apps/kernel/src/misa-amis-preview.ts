// SPDX-License-Identifier: AGPL-3.0-only
// What would be sent to MISA AMIS Kế toán, on the API side (#3901, S3a of #3854). It loads the vouchers the MISA SME export of the same kind loads (finance.vouchers.purchases, .sales or .cash, the same range), writes each as
// the AMIS voucher the push would send (modules/finance misa-amis-vouchers.ts) and lists them with their blockers. A read: it writes nothing, calls nothing outside the database, and never sends. The AMIS-side
// references (the branch, the party codes of get_dictionary) are not read yet (#3885), so a placeholder branch stands in, party codes are not checked, and `checkedAgainstAmis` is false.
import {
  amisTotals,
  cashAmisVouchers,
  goodsPurchaseRows,
  purchaseGoodsAmisVouchers,
  purchaseServiceAmisVouchers,
  salesAmisVouchers,
  salesRows,
  servicePurchaseRows,
  type AmisContext,
  type AmisMapping,
  type CashVoucher,
  type PurchaseVoucher,
  type SalesVoucher,
} from '@crove/mod-finance';
import {
  MISA_AMIS_PREVIEW_LIMIT,
  accountParents,
  type MisaAmisPreview,
  type MisaAmisPreviewAsk,
  type MisaAmisPreviewItem,
  type MisaGoodsCode,
} from '@crove/kernel-contract';

export type MisaAmisPreviewQuery = <T>(name: string, input: unknown) => Promise<T>;

// Stands where the AMIS branch will be, so the mapper does not report it missing; nothing here is ever sent.
const PLACEHOLDER_BRANCH = '00000000-0000-4000-8000-000000000000';

interface Entry {
  sourceId: string;
  mapping: AmisMapping;
}

function item(entry: Entry): MisaAmisPreviewItem {
  const { vouchers, blockers } = entry.mapping;
  const { lines, total } = amisTotals(vouchers);
  return {
    sourceId: entry.sourceId,
    voucherNo: entry.mapping.voucherNo,
    amisType: entry.mapping.amisType,
    reftype: entry.mapping.reftype,
    reasonTypeId: entry.mapping.reasonTypeId,
    parts: Math.max(vouchers.length, 1),
    lines,
    total: blockers.length === 0 ? total : '0',
    blockers: blockers.map((b) => ({ code: b.code, lineNo: b.lineNo })),
  };
}

export async function misaAmisPreview(query: MisaAmisPreviewQuery, ask: MisaAmisPreviewAsk): Promise<MisaAmisPreview> {
  // One more than the list holds, so `more` is known; the loaders' own limit is the export limit.
  const range = { from: ask.from, to: ask.to, limit: MISA_AMIS_PREVIEW_LIMIT + 1, ...(ask.legalEntityId === undefined ? {} : { legalEntityId: ask.legalEntityId }) };
  const ctx: AmisContext = {
    branchId: PLACEHOLDER_BRANCH,
    purchasePurpose: ask.purchasePurpose ?? '1',
    serviceItemCode: ask.serviceItemCode ?? null,
    salesItemCode: ask.salesItemCode ?? null,
    defaultUnitName: 'Lần',
    partyCodes: null,
  };
  const entries: Entry[] = [];
  // The loaders are asked for one more than the list holds; a full answer means the period holds more, whatever the kind then keeps.
  let loaded = 0;
  if (ask.kind === 'purchase_services' || ask.kind === 'purchase_goods') {
    const vouchers = await query<PurchaseVoucher[]>('finance.vouchers.purchases', range);
    loaded = vouchers.length;
    if (ask.kind === 'purchase_services') {
      for (const v of vouchers) {
        // A purchase with only stock lines has no services voucher.
        if (servicePurchaseRows(v).length === 0) continue;
        entries.push({ sourceId: v.sourceId, mapping: purchaseServiceAmisVouchers(v, ctx) });
      }
    } else {
      const chart = await query<Array<{ code: string; parentCode: string | null }>>('finance.accounts.list', {});
      const goodsCodes = await query<MisaGoodsCode[]>('finance.misa_goods_codes.list', {});
      const parents = accountParents(chart);
      for (const v of vouchers) {
        if (goodsPurchaseRows(v, goodsCodes, parents).length === 0) continue;
        entries.push({ sourceId: v.sourceId, mapping: purchaseGoodsAmisVouchers(v, goodsCodes, parents, ctx) });
      }
    }
  } else if (ask.kind === 'sales') {
    const vouchers = await query<SalesVoucher[]>('finance.vouchers.sales', range);
    loaded = vouchers.length;
    for (const v of vouchers) {
      if (salesRows(v).length === 0) continue;
      entries.push({ sourceId: v.sourceId, mapping: salesAmisVouchers(v, ctx) });
    }
  } else {
    const vouchers = await query<CashVoucher[]>('finance.vouchers.cash', { ...range, type: ask.kind });
    loaded = vouchers.length;
    for (const v of vouchers) entries.push({ sourceId: v.sourceId, mapping: cashAmisVouchers(v, ctx) });
  }
  const more = loaded > MISA_AMIS_PREVIEW_LIMIT;
  const items = entries.slice(0, MISA_AMIS_PREVIEW_LIMIT).map(item);
  const blocked = items.filter((i) => i.blockers.length > 0).length;
  return { kind: ask.kind, vouchers: items.length, ready: items.length - blocked, blocked, checkedAgainstAmis: false, purchasePurpose: ctx.purchasePurpose, more, items };
}
