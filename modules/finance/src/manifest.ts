// The finance module's manifest (plan §5.2, #1588, #1599, #1630): the tables it owns, the class of every column, and the
// permissions it owns. A migration that adds or drops a table or column of these schemas, or a role_permission row,
// changes this list in the same PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is
// internal unless the second argument of columns() classifies it.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const financeManifest = defineModule({
  id: 'finance',
  dependsOn: ['kernel'],
  tables: {
    crove_finance: {
      account: columns(['code', 'name', 'parent_code', 'standard']),
      bank_account_number: columns(['org_id', 'id', 'legal_entity_id', 'created_by', 'created_at'], { bank_account: 'payment', account_number: 'payment' }),
      bank_feed_account: columns(['org_id', 'id', 'legal_entity_id', 'channel_connection_id', 'cursor', 'last_synced_at', 'created_by', 'created_at'], { bank_account: 'payment', external_account_id: 'payment' }),
      bank_feed_listed_account: columns(['org_id', 'id', 'channel_connection_id', 'listed_at'], { external_account_id: 'payment', display_name: 'pii' }),
      bank_feed_notice_pending: columns(['seq', 'provider', 'received_at'], { external_account_id: 'payment' }),
      bank_line: columns(['org_id', 'id', 'import_id', 'position', 'value_date', 'amount', 'running_balance', 'bank_ref', 'dedupe_key', 'ambiguous', 'created_by', 'created_at', 'legal_entity_id'], { bank_account: 'payment', counterparty_account: 'payment', description: 'pii' }),
      bank_party_rule: columns(['org_id', 'id', 'legal_entity_id', 'kind', 'party_id', 'confirmed_by', 'confirmed_at', 'source_voucher_id', 'created_at'], { key_hash: 'pii' }),
      cash_voucher: columns(['org_id', 'id', 'voucher_type', 'number', 'voucher_date', 'cash_account', 'party_id', 'amount', 'proposal_id', 'created_by', 'created_at', 'bank_line_id', 'legal_entity_id', 'number_period', 'number_allocation_id'], { person_name: 'pii', description: 'pii' }),
      categorization_rule: columns(['org_id', 'id', 'vendor_party_id', 'match_kind', 'match_text', 'label', 'debit_account', 'confirmed_by', 'confirmed_at', 'source_document_id', 'created_at', 'legal_entity_id']),
      channel_order: columns(['org_id', 'id', 'legal_entity_id', 'platform', 'order_no', 'ordered_at', 'created_at']),
      channel_order_line: columns(['org_id', 'id', 'legal_entity_id', 'order_id', 'line_key', 'sku', 'item_name', 'quantity', 'unit_price', 'amount', 'stage', 'shipped_at', 'attempt', 'source_sha256', 'source_row', 'created_at', 'updated_at']),
      channel_settlement: columns(['org_id', 'id', 'legal_entity_id', 'platform', 'period_start', 'period_end', 'payout_ref', 'report_net', 'source_sha256', 'created_at']),
      channel_settlement_line: columns(['org_id', 'id', 'legal_entity_id', 'settlement_id', 'order_id', 'line_key', 'sales', 'seller_discount', 'commission', 'service_fee', 'payment_fee', 'shipping', 'tax_withheld', 'refund', 'other', 'net', 'source_row', 'created_at']),
      chart: columns(['regime', 'version', 'name']),
      chart_account: columns(['regime', 'version', 'code', 'name', 'parent_code']),
      collection_setting: columns(['org_id', 'id', 'terms_days', 'weekly_item', 'set_by', 'created_at', 'updated_at']),
      customer_collection: columns(['org_id', 'id', 'party_id', 'terms_days', 'paused_until', 'set_by', 'created_at', 'updated_at']),
      depreciation_line: columns(['org_id', 'id', 'asset_id', 'month', 'amount', 'entry_id', 'created_at', 'legal_entity_id']),
      einvoice_connection: columns(['org_id', 'id', 'legal_entity_id', 'channel_connection_id', 'provider', 'last_test_state', 'last_tested_at', 'created_by', 'created_at'], { seller_tax_code: 'national_id_if_individual' }),
      einvoice_draft: columns(['org_id', 'id', 'legal_entity_id', 'state', 'series_id', 'invoice_date', 'currency', 'buyer_kind', 'buyer_party_id', 'subtotal', 'vat_amount', 'total', 'idempotency_key', 'provider_ref', 'issued_number', 'issued_at', 'authority_code', 'signed_file_id', 'pdf_file_id', 'error_code', 'submitted_at', 'next_check_at', 'check_attempts', 'channel_connection_id', 'created_by', 'created_at', 'updated_at'], { buyer_tax_code: 'national_id_if_individual', buyer_name: 'pii', buyer_address: 'contact', buyer_email: 'contact' }),
      einvoice_draft_line: columns(['org_id', 'id', 'legal_entity_id', 'draft_id', 'line_no', 'description', 'unit', 'quantity', 'unit_price', 'amount', 'vat_rate', 'vat_amount']),
      einvoice_series: columns(['org_id', 'id', 'legal_entity_id', 'provider', 'template_no', 'symbol', 'description', 'is_default', 'created_by', 'created_at']),
      fixed_asset: columns(['org_id', 'id', 'kind', 'name', 'cost', 'asset_account', 'accumulated_account', 'expense_account', 'start_month', 'months', 'source_document_id', 'source_line_no', 'ended_month', 'end_reason', 'ended_by', 'created_by', 'created_at', 'legal_entity_id']),
      input_vat_check: columns(['org_id', 'id', 'document_id', 'outcome', 'voucher_id', 'note', 'marked_by', 'created_at', 'legal_entity_id']),
      journal_entry: columns(['org_id', 'id', 'entry_date', 'source_type', 'source_id', 'created_by', 'created_at', 'created_xact_id', 'created_xact_start', 'reverses_entry_id', 'search', 'source_revision', 'payload_sha256', 'legal_entity_id'], { description: 'pii' }),
      journal_line: columns(['org_id', 'entry_id', 'line_no', 'account_code', 'debit', 'credit', 'party_id', 'legal_entity_id'], { memo: 'pii' }),
      journal_voucher: columns(['org_id', 'id', 'number', 'voucher_date', 'proposal_id', 'created_by', 'created_at', 'closing_year', 'stock_closing_month', 'stock_count_id', 'legal_entity_id', 'number_period', 'number_allocation_id'], { description: 'pii' }),
      legal_entity_books: columns(['org_id', 'id', 'legal_entity_id', 'regime', 'chart_version', 'effective_from', 'created_by', 'created_at']),
      misa_goods_code: columns(['org_id', 'id', 'account_code', 'item_code', 'warehouse_code', 'updated_by', 'updated_at']),
      org_account: columns(['org_id', 'id', 'code', 'name', 'parent_code', 'root_code', 'active', 'created_by', 'created_at', 'updated_by', 'updated_at']),
      period_balance_delta: columns(['org_id', 'id', 'entry_id', 'account_code', 'period_month', 'debit', 'credit', 'line_count', 'legal_entity_id']),
      period_lock: columns(['org_id', 'id', 'locked_from', 'locked_through', 'updated_by', 'updated_at', 'legal_entity_id']),
      portal_invoice_list: columns(['org_id', 'id', 'period', 'file_id', 'filename', 'status', 'error', 'row_count', 'list_from', 'list_to', 'skipped_count', 'created_by', 'created_at', 'recorded_at', 'removed_at', 'removed_by', 'own_sales_count', 'other_buyer_count', 'legal_entity_id', 'direction'], { buyer_tax_code: 'national_id_if_individual', skipped: 'pii' }),
      portal_invoice_row: columns(['org_id', 'list_id', 'row_no', 'template', 'series', 'number', 'issue_date', 'currency', 'subtotal', 'vat_amount', 'total', 'status', 'status_label', 'check_result', 'legal_entity_id'], { seller_tax_code: 'national_id_if_individual', buyer_tax_code: 'national_id_if_individual', seller_name: 'pii' }),
      purchase_document: columns(['org_id', 'id', 'party_id', 'invoice_series', 'invoice_number', 'invoice_date', 'currency', 'subtotal', 'vat_amount', 'total', 'payment_method', 'tax_authority_code', 'source_file_id', 'proposal_id', 'created_by', 'created_at', 'replaces_document_id', 'direction', 'correction_kind', 'corrects_document_id', 'corrected_series', 'corrected_number', 'corrected_date', 'exchange_rate', 'exchange_rate_source', 'foreign_subtotal', 'foreign_vat_amount', 'foreign_total', 'legal_entity_id'], { search: 'pii' }),
      purchase_document_void: columns(['org_id', 'document_id', 'reversal_entry_id', 'reason', 'voided_by', 'created_at', 'legal_entity_id']),
      purchase_line: columns(['org_id', 'document_id', 'line_no', 'description', 'unit', 'quantity', 'unit_price', 'amount', 'vat_rate', 'vat_amount', 'debit_account', 'credit_account', 'legal_entity_id']),
      purchase_tax_rate: columns(['org_id', 'document_id', 'row_no', 'vat_rate', 'taxable_amount', 'vat_amount', 'legal_entity_id']),
      stock_alias: columns(['org_id', 'id', 'legal_entity_id', 'item_id', 'source', 'alias_key', 'factor', 'source_unit', 'created_by', 'created_at']),
      stock_count: columns(['org_id', 'id', 'legal_entity_id', 'count_date', 'status', 'note', 'loss_norm_percent', 'created_by', 'created_at', 'confirmed_by', 'confirmed_at', 'voucher_id']),
      stock_count_line: columns(['org_id', 'id', 'legal_entity_id', 'count_id', 'item_id', 'counted_quantity', 'unit_cost']),
      stock_item: columns(['org_id', 'id', 'legal_entity_id', 'code', 'name', 'unit', 'kind', 'stock_account', 'trade', 'active', 'created_by', 'created_at', 'updated_at']),
      stock_move: columns(['org_id', 'id', 'legal_entity_id', 'item_id', 'move_date', 'quantity', 'source_type', 'document_id', 'line_no', 'line_attempt', 'order_line_id', 'order_move', 'order_attempt', 'count_line_id', 'amount', 'reverses_move_id', 'created_by', 'created_at']),
      stock_period: columns(['org_id', 'id', 'legal_entity_id', 'period_month', 'voucher_id', 'total_cost', 'closed_by', 'closed_at']),
      stock_period_item: columns(['org_id', 'id', 'legal_entity_id', 'period_id', 'item_id', 'opening_quantity', 'opening_value', 'in_quantity', 'in_value', 'out_quantity', 'out_value', 'closing_quantity', 'closing_value', 'unit_cost']),
      vat_return_filed: columns(['org_id', 'id', 'period', 'status', 'source', 'carried_in_amount', 'deductible_amount', 'carried_out_amount', 'marked_by', 'created_at', 'legal_entity_id']),
      vendor_account_rule: columns(['org_id', 'party_id', 'debit_account', 'confirmed_by', 'updated_at']),
    },
  },
  permissions: [
    // ADR-0021 section 3: a chief accountant reopens a locked month (finance.period.unlock, and unlock_period() again).
    // #1507: also for the months of one legal entity, through finance.entity_chief_accountant.
    { key: 'finance.period.unlock', risk: 'R3', defaultRoles: ['finance.chief_accountant', 'finance.entity_chief_accountant'] },
    // P12 (#1279): a chief accountant approves the ledger's proposals (kernel.proposal.approve and its bulk form, the
    // approval policy's LEDGER_APPROVE_PERMISSION, and the accountant preset's guard on the last chief accountant).
    { key: 'finance.proposal.approve', risk: 'R3', defaultRoles: ['finance.chief_accountant'] },
    // #1508: a chief accountant marks the VAT return filed (finance.vat.return_mark), every entity's for the org-wide
    // role, its own entities' for the entity role (#1507); vat_return_filed_guard checks the same again.
    { key: 'finance.vat.file', risk: 'R1', defaultRoles: ['finance.chief_accountant', 'finance.entity_chief_accountant'] },
  ],
  // Its entities (#1656), each with its table: every type its commands name as their audit target, the records the
  // kernel numbers, and the records other code names by type; apps/kernel/test/manifest.db.test.ts checks them.
  entities: [
    { type: 'finance.bank_party_rule', table: 'bank_party_rule', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.cash_voucher', table: 'cash_voucher', legalEntityScoped: true, numbering: { docType: 'finance.cash_voucher.<voucher_type>' }, audit: 'append_only' },
    { type: 'finance.categorization_rule', table: 'categorization_rule', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.customer_collection', table: 'customer_collection', legalEntityScoped: false, audit: 'command' },
    { type: 'finance.einvoice_connection', table: 'einvoice_connection', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.einvoice_draft', table: 'einvoice_draft', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.einvoice_series', table: 'einvoice_series', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.fixed_asset', table: 'fixed_asset', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.journal_entry', table: 'journal_entry', legalEntityScoped: true, audit: 'append_only' },
    { type: 'finance.journal_voucher', table: 'journal_voucher', legalEntityScoped: true, numbering: { docType: 'finance.journal_voucher' }, audit: 'append_only' },
    { type: 'finance.purchase_document', table: 'purchase_document', legalEntityScoped: true, audit: 'append_only' },
    { type: 'finance.stock_item', table: 'stock_item', legalEntityScoped: true, audit: 'command' },
    { type: 'finance.stock_move', table: 'stock_move', legalEntityScoped: true, audit: 'append_only' },
    { type: 'finance.stock_period', table: 'stock_period', legalEntityScoped: true, audit: 'append_only' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.finance,
});
