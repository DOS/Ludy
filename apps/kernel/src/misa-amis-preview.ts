// SPDX-License-Identifier: AGPL-3.0-only
// What would be sent to MISA AMIS Kế toán, on the API side (#3901, S3a of #3854). It loads the vouchers the MISA SME export of the same kind loads (finance.vouchers.purchases, .sales or .cash, the same range), writes each as
// the AMIS voucher the push would send (modules/finance misa-amis-build.ts, the push's own path) and lists them with their blockers and the digest a confirmation carries. A read: it writes nothing, calls nothing outside the database, and never sends. The branch is
// read from AMIS only by the push's worker, so a placeholder branch stands in. The party and item codes are those the last check against the firm's catalogue matched (S3a, #4112: a person asks for it, the worker
// reads the catalogue): without a check they are not checked and `checkedAgainstAmis` is false; with one, a party or item it did not match is a blocker, and the check's time is shown.
import { amisBatchDigest, amisContextOf, amisTotals, AMIS_PLACEHOLDER_BRANCH, loadAmisEntries, type AmisEntry, type AmisQuery, type MisaAmisMatchResults } from '@ludy/mod-finance';
import { MISA_AMIS_PREVIEW_BLOCKERS, MISA_AMIS_PREVIEW_LIMIT, type MisaAmisPreview, type MisaAmisPreviewAsk, type MisaAmisPreviewItem } from '@ludy/kernel-contract';

export type MisaAmisPreviewQuery = AmisQuery;

// What the push (finance.misa_amis.push) rebuilds and compares: the same path, so the digest below is the one a person's confirmation carries.
type Entry = AmisEntry;

function item(entry: Entry): MisaAmisPreviewItem {
  const { vouchers, blockers } = entry.mapping;
  const { lines, total } = amisTotals(vouchers);
  // The same code on the same line once, and at most MISA_AMIS_PREVIEW_BLOCKERS of them: a voucher of thousands of lines must not make the whole answer too large.
  const seen = new Set<string>();
  const unique = blockers.filter((b) => {
    const key = `${b.code}:${b.lineNo ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    sourceId: entry.sourceId,
    voucherNo: entry.mapping.voucherNo,
    amisType: entry.mapping.amisType,
    reftype: entry.mapping.reftype,
    reasonTypeId: entry.mapping.reasonTypeId,
    parts: Math.max(vouchers.length, 1),
    lines,
    total: unique.length === 0 ? total : '0',
    blockers: unique.slice(0, MISA_AMIS_PREVIEW_BLOCKERS).map((b) => ({ code: b.code, lineNo: b.lineNo })),
    blockersMore: Math.max(unique.length - MISA_AMIS_PREVIEW_BLOCKERS, 0),
  };
}

export async function misaAmisPreview(query: MisaAmisPreviewQuery, ask: MisaAmisPreviewAsk): Promise<MisaAmisPreview> {
  // The same read the push command makes, so what a person confirms is what was shown. The check is of the ask's entity (the caller's own when the ask names none).
  const matches = await query<MisaAmisMatchResults>('finance.misa_amis_match.results', ask.legalEntityId === undefined ? { ask } : { legalEntityId: ask.legalEntityId, ask });
  const ctx = amisContextOf(ask, AMIS_PLACEHOLDER_BRANCH, matches);
  // One more than the list holds, so `more` is known; the loaders' own limit is the export limit.
  const { entries, loaded } = await loadAmisEntries(query, ask, ctx, MISA_AMIS_PREVIEW_LIMIT + 1);
  const more = loaded > MISA_AMIS_PREVIEW_LIMIT;
  const listed = entries.slice(0, MISA_AMIS_PREVIEW_LIMIT);
  const items = listed.map(item);
  const blocked = items.filter((i) => i.blockers.length > 0).length;
  return { kind: ask.kind, vouchers: items.length, ready: items.length - blocked, blocked, checkedAgainstAmis: matches.status.state === 'done', matchCheck: matches.status, purchasePurpose: ctx.purchasePurpose, more, digest: amisBatchDigest(listed), items };
}
