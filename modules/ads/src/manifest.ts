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
      // finds the account by (plan section 9); never the platform's id of the person.
      ad_account: columns(
        [
          'org_id', 'id', 'legal_entity_id', 'channel_connection_id', 'provider', 'external_account_id', 'name', 'currency', 'time_zone', 'expense_account_code', 'result_kind',
          'backfill_from', 'settled_through', 'synced_through', 'last_requested_at', 'last_run_at', 'last_error_kind', 'next_run_at', 'created_by', 'created_at', 'updated_at', 'write_enabled',
        ],
        { granted_by_hash: 'pii' },
      ),
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
      // Meta's data deletion requests (plan section 9): a global machinery table, no org_id and nothing about an org; only the
      // definers touch it. user_hash is the keyed hash of the Meta user who asked, never the id.
      deletion_request: columns(['code', 'requested_at', 'completed_at', 'accounts', 'next_attempt_at'], { user_hash: 'pii' }),
    },
  },
  // It owns no permission: access comes from the base role (owners and admins connect and configure, members refresh,
  // everyone who reads an entity reads its accounts).
  permissions: [],
  // Its entity (#1656): the ad account, which every command that changes it names as its audit target.
  entities: [{ type: 'ads.ad_account', table: 'ad_account', legalEntityScoped: true, audit: 'command' }],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.ads,
});
