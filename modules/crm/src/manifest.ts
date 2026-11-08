// The crm module's manifest (plan §5.2, #1588, #1599): the tables it owns and the class of every column. A migration
// that adds or drops a table or column of these schemas changes this list in the same PR; apps/kernel/test/manifest.db.test.ts
// checks it against the catalog. A column is internal unless the second argument of columns() classifies it.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const crmManifest = defineModule({
  id: 'crm',
  dependsOn: ['kernel'],
  tables: {
    crove_crm: {
      booking: columns(['org_id', 'id', 'event_type_id', 'starts_at', 'ends_at', 'status', 'refusal', 'calendar_event_id', 'party_id', 'time_zone', 'request_token_sha256', 'created_at', 'decided_at', 'revision', 'manage_request_id', 'manage_action', 'manage_starts_at', 'manage_requested_at', 'manage_outcome', 'cancelled_at', 'hold_event_ids', 'meeting_state', 'meeting_url'], { visitor_name: 'pii', email: 'contact', phone: 'contact', note: 'pii' }),
      booking_feed: columns(['org_id', 'id', 'user_id', 'token_sha256', 'created_at', 'revoked_at']),
      deal: columns(['org_id', 'id', 'party_id', 'amount', 'currency', 'stage_id', 'sort_key', 'expected_close', 'owner_user_id', 'closed_at', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at'], { title: 'pii', lost_reason: 'pii' }),
      // A reason code, a state and dates: no text, so every column is internal (the deal's own title stays in crove_crm.deal).
      deal_next_step: columns(['org_id', 'id', 'deal_id', 'reason', 'assignee_user_id', 'since_on', 'raised_at', 'status', 'snoozed_until', 'resolved_at', 'resolved_by', 'closed_reason']),
      deal_setting: columns(['org_id', 'id', 'stale_days', 'set_by', 'created_at', 'updated_at']),
      event_type: columns(['org_id', 'id', 'slug', 'title', 'description', 'duration_min', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'horizon_days', 'daily_limit', 'location_kind', 'location_value', 'host_user_id', 'active', 'created_by', 'created_at', 'updated_by', 'updated_at', 'assignment', 'co_host_user_ids']),
      import_batch: columns(['org_id', 'id', 'filename', 'status', 'on_duplicate', 'total_rows', 'new_rows', 'duplicate_rows', 'conflict_rows', 'invalid_rows', 'created_rows', 'updated_rows', 'new_companies', 'created_companies', 'linked_rows', 'created_by', 'created_at', 'decided_at']),
      import_row: columns(['org_id', 'id', 'batch_id', 'row_no', 'kind', 'outcome', 'reason', 'match_party_id', 'company_state', 'company_party_id'], { name: 'pii', company_name: 'pii', tax_code: 'national_id_if_individual', address: 'contact', email: 'contact', phone: 'contact' }),
      pipeline_stage: columns(['org_id', 'id', 'name', 'kind', 'position', 'created_at', 'updated_at']),
      // The quote's free text is `remarks` (the API and the screens say notes): a column named `notes` is a personal-data fact of its own. Every text column is free text a
      // person typed and may name someone, so it is pii; the number, the status and the amounts are internal.
      quote: columns(['org_id', 'id', 'deal_id', 'party_id', 'number', 'revision', 'revises_id', 'status', 'valid_until', 'subtotal', 'vat_amount', 'total', 'sent_at', 'sent_via', 'first_viewed_at', 'decided_at', 'issuer_entity_id', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at'], { remarks: 'pii', terms: 'pii', decline_reason: 'pii', buyer_name: 'pii', buyer_tax_code: 'national_id_if_individual', buyer_address: 'contact', buyer_email: 'contact', seller_name: 'pii', seller_tax_code: 'national_id_if_individual', seller_address: 'contact', seller_phone: 'contact', seller_email: 'contact', seller_bank_note: 'payment' }),
      quote_line: columns(['org_id', 'id', 'quote_id', 'line_no', 'kind', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'], { description: 'pii' }),
      // The hash of a public link's token, its expiry, who made and who revoked it, and how often it was opened: no text.
      quote_link: columns(['org_id', 'id', 'quote_id', 'token_sha256', 'expires_at', 'created_by', 'created_at', 'revoked_at', 'revoked_by', 'first_viewed_at', 'views']),
      quote_setting: columns(['org_id', 'id', 'valid_days', 'default_vat', 'set_by', 'created_at', 'updated_at'], { default_terms: 'pii', phone: 'contact', email: 'contact', bank_note: 'payment' }),
      // The sales order of an accepted quote (#2696, ADR-0050): the buyer snapshot is frozen from the quote and classed as the quote's is; the cancel reason is free text.
      sales_order: columns(['org_id', 'id', 'quote_id', 'deal_id', 'party_id', 'issuer_entity_id', 'number', 'order_date', 'status', 'subtotal', 'vat_amount', 'total', 'accepted_via', 'confirmed_at', 'cancelled_at', 'version', 'created_by', 'created_at', 'updated_by', 'updated_at'], { buyer_name: 'pii', buyer_tax_code: 'national_id_if_individual', buyer_address: 'contact', buyer_email: 'contact', cancel_reason: 'pii' }),
      // The delivery of a sales order line or its reversal (#2697, ADR-0050 point 4): ids, a line number, a kind and a day; no text.
      sales_order_delivery: columns(['org_id', 'id', 'order_id', 'line_no', 'kind', 'delivered_on', 'reverses_id', 'reverses_kind', 'created_by', 'created_at']),
      sales_order_line: columns(['org_id', 'id', 'order_id', 'line_no', 'kind', 'unit', 'quantity', 'unit_price', 'discount_percent', 'vat_rate', 'amount', 'vat_amount', 'stock_item_id'], { description: 'pii' }),
    },
  },
  // It owns no permission: no command of the module declares one and no role grants one.
  permissions: [],
  // Its entities (#1656), each with its table: every type its commands name as their audit target, the records the
  // kernel numbers, and the records other code names by type; apps/kernel/test/manifest.db.test.ts checks them.
  entities: [
    { type: 'crm.booking', table: 'booking', legalEntityScoped: false, audit: 'command' },
    { type: 'crm.deal', table: 'deal', legalEntityScoped: false, audit: 'command' },
    { type: 'crm.import', table: 'import_batch', legalEntityScoped: false, audit: 'command' },
    { type: 'crm.quote', table: 'quote', legalEntityScoped: false, audit: 'command' },
    { type: 'crm.sales_order', table: 'sales_order', legalEntityScoped: false, audit: 'command' },
    { type: 'crm.stage', table: 'pipeline_stage', legalEntityScoped: false, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.crm,
});
