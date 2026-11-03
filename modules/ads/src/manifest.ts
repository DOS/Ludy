// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's manifest (plan §5.2, #1588, #1599; ads plan docs/plan/ads.md section 7): the tables it owns and the
// class of every column. A migration that adds or drops a table or column of crove_ads changes this list in the same PR;
// apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is internal unless the second argument of
// columns() classifies it. The module stores no personal data (plan section 9): the figures are aggregates, and the names
// of accounts and campaigns are text the owner typed on the platform, so internal.
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const adsManifest = defineModule({
  id: 'ads',
  dependsOn: ['kernel'],
  tables: {
    crove_ads: {
      // granted_by_hash: a keyed hash of the platform user who granted the connection, which the platform's deletion callback
      // finds the account by (plan section 9); never the platform's id of the person. write_granted_by_hash is the same for the
      // write connection (W0b), kept apart because a read link overwrites the first and the write app may not be the read app.
      ad_account: columns(
        [
          'org_id', 'id', 'legal_entity_id', 'channel_connection_id', 'provider', 'external_account_id', 'name', 'currency', 'time_zone', 'expense_account_code', 'result_kind',
          'backfill_from', 'settled_through', 'synced_through', 'last_requested_at', 'last_run_at', 'last_error_kind', 'next_run_at', 'created_by', 'created_at', 'updated_at', 'write_enabled', 'write_connection_id',
        ],
        { granted_by_hash: 'pii', write_granted_by_hash: 'pii' },
      ),
      // A campaign draft (W1, #2295): one campaign with its ad set and ad, in the account's legal entity. The names and texts are business text the
      // owner or the AI coworker wrote for an ad, never a customer's, so internal.
      ad_campaign_draft: columns([
        'org_id', 'id', 'ad_account_id', 'legal_entity_id', 'name', 'objective', 'status', 'revision', 'daily_budget', 'start_on', 'end_on', 'targeting', 'link_url',
        'page_connection_id', 'source_post_id', 'media_file_id', 'variants', 'origin', 'ai_fields', 'max_spend', 'proposal_id', 'approved_at', 'created_by', 'updated_by',
        'created_at', 'updated_at',
      ]),
      // A member's request to the AI coworker for a campaign draft (W1b, #2295): the member's brief (their own words about what to promote, never a
      // customer's, so internal), the state and, when there is no draft, the code that says why.
      ad_campaign_request: columns(['org_id', 'id', 'ad_account_id', 'legal_entity_id', 'objective', 'brief', 'source_post_id', 'state', 'code', 'draft_id', 'requested_by', 'requested_at', 'settled_at']),
      // The org's thresholds of the spend flags (#2378): org-wide, no legal entity; a NULL threshold is the default.
      ad_flag_setting: columns(['org_id', 'id', 'pace_min_days', 'day_factor', 'cpr_factor', 'cpr_min_results', 'cpr_min_history_days', 'set_by', 'updated_at']),
      // The launch ledger (W2-2, #2296): an approved plan's commitment against the caps and where its launch stands. Ids, amounts, dates and codes only,
      // never the plan's text (that stays in the draft and the proposal); in the account's legal entity.
      ad_launch: columns([
        'org_id', 'id', 'ad_account_id', 'legal_entity_id', 'draft_id', 'proposal_id', 'plan_hash', 'tag', 'state', 'attempt', 'step', 'currency', 'daily_budget',
        'start_on', 'end_on', 'amount', 'commit_until', 'stop_reason', 'created_by', 'updated_by', 'created_at', 'updated_at', 'started_at', 'finished_at',
      ]),
      // The org's switches of running ads (ADR-0043, #2294): org-wide, no legal entity.
      ad_org_setting: columns(['org_id', 'id', 'write_enabled', 'launches_blocked', 'updated_by', 'updated_at']),
      // A spend cap of the org or of one ad account, a row per change (the history).
      ad_spend_cap: columns(['org_id', 'id', 'scope', 'ad_account_id', 'period', 'amount', 'currency', 'set_by', 'set_at']),
      ad_spend_day: columns([
        'org_id', 'id', 'ad_account_id', 'legal_entity_id', 'level', 'external_object_id', 'object_name', 'day', 'currency', 'spend', 'impressions', 'clicks', 'reach', 'results',
        'fetched_at', 'settled_at',
      ]),
      ad_sync_run: columns([
        'org_id', 'id', 'ad_account_id', 'legal_entity_id', 'status', 'window_from', 'window_to', 'rows_written', 'error_kind', 'error_code', 'retry_at', 'started_at', 'finished_at',
      ]),
      // The revoke at the platform of the token of a closed ads connection (W2-1, #2296): ids, states, counts and error codes, org-wide, no legal entity.
      // grantor_hash: a keyed hash of the platform user who granted the connection, as in ad_account, which the revoke checks before it cuts a grant another live
      // connection of the same person needs; never the platform's id of the person.
      ad_token_revoke: columns(
        [
          'org_id', 'id', 'connection_id', 'ad_account_id', 'provider', 'external_account_id', 'kind', 'reason', 'connected_by', 'state', 'how_done', 'give_up', 'attempts', 'next_attempt_at',
          'last_error_kind', 'last_error_code', 'created_at', 'settled_at',
        ],
        { grantor_hash: 'pii' },
      ),
      // The sealed copy of that token, kept at most 7 days and opened by the revoke worker alone: definer-only machinery, no grant to any role.
      ad_token_seal: columns(['org_id', 'revoke_id', 'key_id', 'sealed_at', 'lease_until', 'lease_token'], { envelope: 'sensitive' }),
      // Meta's data deletion requests (plan section 9): a global machinery table, no org_id and nothing about an org; only the
      // definers touch it. user_hash is the keyed hash of the Meta user who asked, never the id.
      deletion_request: columns(['code', 'requested_at', 'completed_at', 'accounts', 'next_attempt_at'], { user_hash: 'pii' }),
    },
  },
  // It owns no permission: access comes from the base role (owners and admins connect and configure, members refresh,
  // everyone who reads an entity reads its accounts).
  permissions: [],
  // Its entities (#1656): the ad account, which every command that changes it names as its audit target, and the request to the AI coworker for a
  // campaign draft (W1b), which the job's answer names.
  entities: [
    { type: 'ads.ad_account', table: 'ad_account', legalEntityScoped: true, audit: 'command' },
    { type: 'ads.ad_campaign_request', table: 'ad_campaign_request', legalEntityScoped: true, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.ads,
});
