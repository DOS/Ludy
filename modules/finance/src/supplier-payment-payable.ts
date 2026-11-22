// SPDX-License-Identifier: AGPL-3.0-only
// The received invoices that can be asked for payment (#3113 S4b, #3701): `finance.supplier_payment.payable`, a read for owners and admins behind the "Ask to pay" list of the vendors page. An invoice
// is listed when it is a purchase of the org that is not voided, has an amount, has no payment that is approved or paid, and has no request waiting for approval: the conditions under which
// finance.supplier_payment.record is accepted (refuseDuplicate). Each row also says whether the supplier has exactly one active bank account (`ready`), none or several (the request would be refused for
// those, so the screen says what to do first), and the day of the supplier's latest account change when it is inside the last SUPPLIER_BANK_CHANGE_DAYS days, so a person sees a changed account
// before asking. Facts only: the supplier's name, the invoice's number, day and amount; never a bank, a number or a holder. Nothing is decided here: the request, its checks and its approval are the
// finance.supplier_payment.record proposal's, unchanged.
import { sql } from 'kysely';
import { SUPPLIER_BANK_CHANGE_DAYS, SUPPLIER_PAYABLE_MAX, SUPPLIER_PAYMENT_COMMAND, zSupplierPayableList, type SupplierPayableList } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { z } from 'zod';
import { defineQuery } from '@ludy/kernel-runtime';
import { money } from '@ludy/l10n-vn';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

type Row = {
  id: string;
  party_id: string;
  party_name: string | null;
  invoice_number: string | null;
  invoice_date: string;
  total: string;
  currency: string;
  accounts: number;
  changed_on: string | null;
};

export const supplierPaymentPayable = defineQuery({
  name: 'finance.supplier_payment.payable',
  input: z.strictObject({}),
  access: MANAGERS,
  handler: async (ctx): Promise<SupplierPayableList> => {
    // One more than the cap says that older invoices were left out.
    const { rows } = await sql<Row>`
      SELECT d.id, d.party_id, pa.name AS party_name, d.invoice_number, d.invoice_date::text AS invoice_date, d.total::text AS total, d.currency,
             (SELECT count(*)::int FROM crove_finance.supplier_bank_account a WHERE a.org_id = d.org_id AND a.party_id = d.party_id AND a.status = 'active') AS accounts,
             (SELECT to_char(max(c.changed_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
                FROM crove_finance.supplier_bank_account_change c
               WHERE c.org_id = d.org_id AND c.party_id = d.party_id AND c.changed_at >= pg_catalog.now() - (${SUPPLIER_BANK_CHANGE_DAYS}::int * interval '1 day')) AS changed_on
        FROM crove_finance.purchase_document d
        LEFT JOIN ludy_kernel.party pa ON pa.org_id = d.org_id AND pa.id = d.party_id
       WHERE d.org_id = ${ctx.orgId}::uuid AND d.direction = 'purchase' AND d.total > 0
         AND NOT EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id)
         AND NOT EXISTS (SELECT 1 FROM crove_finance.supplier_payment sp WHERE sp.org_id = d.org_id AND sp.purchase_document_id = d.id AND sp.status IN ('approved', 'paid'))
         AND NOT EXISTS (SELECT 1 FROM ludy_kernel.proposal q WHERE q.org_id = d.org_id AND q.command = ${SUPPLIER_PAYMENT_COMMAND} AND q.status = 'pending'
                           AND pg_catalog.lower(q.payload ->> 'purchaseDocumentId') = d.id::text)
       ORDER BY d.invoice_date, d.id
       LIMIT ${SUPPLIER_PAYABLE_MAX + 1}`.execute(ctx.trx);
    const shown = rows.slice(0, SUPPLIER_PAYABLE_MAX);
    return zSupplierPayableList.parse({
      items: shown.map((r) => ({
        purchaseDocumentId: r.id,
        partyId: r.party_id,
        partyName: (r.party_name ?? '').slice(0, 300),
        invoiceNumber: (r.invoice_number ?? '').slice(0, 100),
        invoiceDate: r.invoice_date,
        amount: money(r.total).toFixed(),
        currency: r.currency,
        account: r.accounts === 1 ? 'ready' : r.accounts === 0 ? 'none' : 'many',
        accountChangedOn: r.changed_on,
      })),
      more: rows.length > SUPPLIER_PAYABLE_MAX,
    });
  },
});

export const supplierPaymentPayableQueries = [supplierPaymentPayable];
