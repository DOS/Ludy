-- SPDX-License-Identifier: AGPL-3.0-only
-- Issue #4777: restate ludy_kernel.org_purge from 20270324190100_ludy_kernel_org_purge_tracker_term
-- with ONE change: delete ludy_meetings.minutes_version (the recorder's published second-language version of a meeting's minutes) ahead of ludy_meetings.translation. The tracker_term entry stays.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION ludy_kernel.org_purge(p_min_days integer)
 RETURNS TABLE(outcome text, counts jsonb, blob_keys text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org uuid := ludy_kernel.ctx_org_id();
  v_refusal text;
  v_n bigint;
  v_t text;
  v_deleted jsonb := '{}'::jsonb;
  v_pinned jsonb := '{}'::jsonb;
  v_anonymized bigint;
  v_keep_proposal uuid[];
  v_keep_task uuid[];
  v_keep_position uuid[];
  v_keep_run uuid[];
  v_keep_agent uuid[];
  v_keep_variant uuid[];
  v_keep_post uuid[];
  v_keep_connection uuid[];
  v_keep_party uuid[];
  v_keep_file uuid[];
  v_keep_signed_file uuid[];
  v_keys text[];
  v_conversation_keys text[];
  v_note_attachment_keys text[];
  -- Rows of these tables are deleted whole, in this order (children before the rows they reference).
  v_kernel_first text[] := ARRAY[
    'ludy_sign.api_key',
    'ludy_sign.playbook_check', 'ludy_sign.playbook_rule',
    'ludy_sign.webhook_delivery', 'ludy_sign.webhook',
    'ludy_sign.member_signature', 'ludy_sign.org_stamp',
    'ludy_sign.kyc_check',
    'ludy_sign.envelope_obligation',
    'ludy_sign.ca_signing_request', 'ludy_sign.ca_connection',
    'ludy_sign.template_direct_link', 'ludy_sign.template_field', 'ludy_sign.template_role', 'ludy_sign.template',
    'ludy_sign.signing_otp', 'ludy_sign.signing_token', 'ludy_sign.ai_analysis', 'ludy_sign.field', 'ludy_sign.signer', 'ludy_sign.envelope_document', 'ludy_sign.envelope_deposit', 'ludy_sign.deposit_profile', 'ludy_sign.envelope',
    'ludy_kernel.member_vy_memory', 'ludy_kernel.member_vy_result',
    'ludy_hr.candidate', 'ludy_hr.job_opening',
    'ludy_hr.payroll_bank_template', 'ludy_hr.payroll_dependent', 'ludy_hr.attendance_log', 'ludy_hr.attendance_qr_config', 'ludy_hr.onboarding_submission', 'ludy_hr.overtime_request', 'ludy_hr.probation_review', 'ludy_hr.leave_request', 'ludy_hr.payroll_leave_entry', 'ludy_hr.employee_asset_handover', 'ludy_hr.okr_key_result', 'ludy_hr.okr_objective', 'ludy_hr.payroll_employee', 'ludy_hr.department',
    'ludy_meetings.tracker_term', 'ludy_meetings.glossary_term', 'ludy_meetings.minutes_template', 'ludy_meetings.chat_post_body', 'ludy_meetings.chat_post', 'ludy_meetings.chat_channel_target', 'ludy_meetings.chat_channel', 'ludy_meetings.morning_notice', 'ludy_meetings.calendar_agenda', 'ludy_meetings.capture_session', 'ludy_meetings.hook_delivery', 'ludy_meetings.member_hook', 'ludy_meetings.minutes_version', 'ludy_meetings.translation', 'ludy_meetings.meeting_note', 'ludy_meetings.media_key', 'ludy_meetings.action_item', 'ludy_meetings.meeting_result', 'ludy_meetings.transcript_segment', 'ludy_meetings.live_line', 'ludy_meetings.live_chunk', 'ludy_meetings.audio_segment', 'ludy_meetings.meeting_video', 'ludy_meetings.meeting_reader', 'ludy_meetings.meeting',
    'ludy_kernel.saved_reply', 'ludy_kernel.conversation_setting', 'ludy_kernel.member_availability', 'ludy_kernel.conversation_composing', 'ludy_kernel.conversation_draft', 'ludy_kernel.conversation_note', 'ludy_kernel.conversation_read', 'ludy_kernel.conversation_attachment', 'ludy_kernel.conversation_message', 'ludy_kernel.conversation', 'ludy_kernel.conversation_identity', 'ludy_kernel.channel_access',
    'ludy_ads.ad_flag_setting', 'ludy_ads.ad_campaign_request', 'ludy_ads.ad_campaign_draft', 'ludy_ads.ad_spend_cap', 'ludy_ads.ad_org_setting', 'ludy_ads.ad_sync_run', 'ludy_ads.ad_spend_day', 'ludy_ads.ad_account',
    'ludy_kernel.today_mail', 'ludy_kernel.saved_view', 'ludy_notes.link', 'ludy_notes.todo', 'ludy_notes.todo_list', 'ludy_notes.attachment', 'ludy_notes.note_version', 'ludy_notes.note', 'ludy_notes.notebook', 'ludy_notes.note_template',
    'ludy_projects.roadmap_signal', 'ludy_projects.roadmap_announcement', 'ludy_projects.roadmap_vote', 'ludy_projects.roadmap_subscriber', 'ludy_projects.roadmap_otp', 'ludy_projects.roadmap_item', 'ludy_projects.roadmap_board',
    'ludy_projects.project_cycle_snapshot', 'ludy_projects.project_cycle_task_history',
    'ludy_projects.project_triage_item', 'ludy_projects.time_entry', 'ludy_projects.task_dependency', 'ludy_projects.project_task', 'ludy_projects.project_column', 'ludy_projects.project_cycle', 'ludy_projects.project_member', 'ludy_projects.project',
    'ludy_kernel.activity', 'ludy_kernel.agent_wakeup', 'ludy_kernel.extraction',
    'ludy_kernel.inbound_message', 'ludy_kernel.push_subscription', 'ludy_kernel.notification', 'ludy_kernel.notification_mute', 'ludy_kernel.inbox_item',
    'ludy_kernel.mail_event', 'ludy_kernel.mail_suppression', 'ludy_kernel.mail_message',
    'ludy_kernel.member_invite', 'ludy_kernel.auth_session_org', 'ludy_kernel.inbound_drop',
    'ludy_kernel.idempotency_key', 'ludy_kernel.extension_token', 'ludy_kernel.extension_auth_code', 'ludy_kernel.agent_wake_delivery', 'ludy_kernel.agent_wake_signal_seen', 'ludy_kernel.agent_grant_wake', 'ludy_kernel.agent_grant', 'ludy_kernel.oauth_state', 'ludy_kernel.outbox_pending', 'ludy_kernel.outbox_held',
    'ludy_kernel.proposal_policy', 'ludy_kernel.refusal_tally', 'ludy_kernel.tax_obligation_done',
    'ludy_kernel.tax_profile', 'ludy_kernel.usage_deferral', 'ludy_kernel.file_upload', 'ludy_kernel.record_le',
    'ludy_kernel.budget_policy', 'ludy_kernel.kill_switch', 'ludy_kernel.credential', 'ludy_kernel.subject_key', 'ludy_kernel.calendar_credential',
    'ludy_finance.vendor_account_rule', 'ludy_finance.categorization_rule', 'ludy_finance.stock_alias', 'ludy_finance.marketplace_column_profile', 'ludy_finance.marketplace_party', 'ludy_finance.einvoice_connection', 'ludy_finance.marketplace_hook_notice', 'ludy_finance.marketplace_hook', 'ludy_finance.marketplace_connection_file', 'ludy_finance.marketplace_vat_rate', 'ludy_finance.marketplace_connection', 'ludy_finance.marketplace_column_check', 'ludy_finance.misa_amis_match', 'ludy_finance.misa_amis_match_check', 'ludy_finance.misa_amis_push', 'ludy_finance.misa_amis_connection', 'ludy_finance.einvoice_series', 'ludy_finance.bank_party_rule', 'ludy_finance.customer_collection', 'ludy_finance.collection_setting', 'ludy_finance.bank_account_number', 'ludy_finance.bank_feed_webhook_notice', 'ludy_finance.bank_feed_hook', 'ludy_finance.bank_feed_account', 'ludy_finance.bank_feed_listed_account', 'ludy_crm.booking_feed', 'ludy_crm.booking', 'ludy_kernel.availability_rule',
    'ludy_kernel.calendar_event_link', 'ludy_kernel.calendar_event', 'ludy_kernel.calendar_connection', 'ludy_kernel.meeting_platform_recording', 'ludy_kernel.meeting_platform_credential', 'ludy_kernel.meeting_platform_connection', 'ludy_crm.sales_order_delivery', 'ludy_crm.sales_order_line', 'ludy_crm.sales_order', 'ludy_crm.quote_link', 'ludy_crm.quote_line', 'ludy_crm.quote', 'ludy_crm.quote_setting', 'ludy_crm.deal_next_step', 'ludy_crm.deal_setting', 'ludy_crm.deal', 'ludy_crm.pipeline_stage', 'ludy_crm.import_row', 'ludy_crm.import_batch', 'ludy_crm.event_type'];
  v_social text[] := ARRAY[
    'ludy_social.account_snapshot', 'ludy_social.bio_click', 'ludy_social.bio_page', 'ludy_social.brand_voice',
    'ludy_social.calendar_feed', 'ludy_social.calendar_note', 'ludy_social.channel_policy',
    'ludy_social.channel_set', 'ludy_social.chat_alert_target', 'ludy_social.chat_alert',
    'ludy_social.feed_item', 'ludy_social.feed', 'ludy_social.idea_label', 'ludy_social.idea',
    'ludy_social.post_label', 'ludy_social.queue_slot', 'ludy_social.queue', 'ludy_social.label',
    'ludy_social.link_preview', 'ludy_social.media_tag', 'ludy_social.metric_snapshot',
    'ludy_social.notification', 'ludy_social.notification_mail_off', 'ludy_social.notification_mute',
    'ludy_social.post_comment', 'ludy_social.post_media', 'ludy_social.post_version', 'ludy_social.publish_hold', 'ludy_social.report_link',
    'ludy_social.report_schedule_run', 'ludy_social.report_schedule', 'ludy_social.review_feedback',
    'ludy_social.review_link_post', 'ludy_social.review_link', 'ludy_social.short_link_click',
    'ludy_social.short_link', 'ludy_social.snippet', 'ludy_social.watermark', 'ludy_social.report_branding', 'ludy_social.goal', 'ludy_social.banned_word', 'ludy_social.external_import', 'ludy_social.external_post', 'ludy_social.review_check', 'ludy_social.digest_week', 'ludy_social.channel_option', 'ludy_social.media_attribution', 'ludy_social.push_subscription', 'ludy_social.saved_view', 'ludy_social.media_archive'];
BEGIN
  IF NOT pg_catalog.pg_has_role(SESSION_USER, 'ludy_worker', 'MEMBER') THEN
    RAISE EXCEPTION 'ORG_PURGE_WORKER_ONLY' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL OR ludy_kernel.ctx_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'ORG_PURGE_SYSTEM_CONTEXT' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kernel.org.purge:' || v_org::text, 0));
  PERFORM 1 FROM ludy_kernel.tenant t WHERE t.org_id = v_org FOR UPDATE;
  v_refusal := ludy_kernel.org_purge_refusal(v_org, p_min_days);
  IF v_refusal IS NOT NULL THEN
    outcome := v_refusal;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM pg_catalog.set_config('ludy.org_purge', v_org::text, true);
  DELETE FROM ludy_kernel.task_comment c WHERE c.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.task_comment', v_n);
  DELETE FROM ludy_social.post_approval a WHERE a.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_social.post_approval', v_n);
  DELETE FROM ludy_sign.signing_event se WHERE se.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_sign.signing_event', v_n);
  v_keep_signed_file := ARRAY(SELECT d.signed_file_id FROM ludy_finance.einvoice_draft d WHERE d.org_id = v_org AND d.signed_file_id IS NOT NULL);
  DELETE FROM ludy_finance.einvoice_notice n WHERE n.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.einvoice_notice', v_n);
  DELETE FROM ludy_finance.supplier_payment sp WHERE sp.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.supplier_payment', v_n);
  DELETE FROM ludy_finance.supplier_bank_account_change h WHERE h.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.supplier_bank_account_change', v_n);
  DELETE FROM ludy_finance.supplier_bank_account b WHERE b.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.supplier_bank_account', v_n);
  DELETE FROM ludy_finance.einvoice_draft_line l WHERE l.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.einvoice_draft_line', v_n);
  DELETE FROM ludy_finance.einvoice_draft d WHERE d.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.einvoice_draft', v_n);
  DELETE FROM ludy_hr.salary_advance_request r WHERE r.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.salary_advance_request', v_n);
  DELETE FROM ludy_hr.payroll_adjustment_item a WHERE a.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.payroll_adjustment_item', v_n);
  DELETE FROM ludy_hr.business_trip_request b WHERE b.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.business_trip_request', v_n);
  DELETE FROM ludy_hr.payroll_line l WHERE l.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.payroll_line', v_n);
  DELETE FROM ludy_hr.payroll_run r WHERE r.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.payroll_run', v_n);
  DELETE FROM ludy_hr.contract_addendum ca WHERE ca.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.contract_addendum', v_n);
  DELETE FROM ludy_hr.payroll_employment e WHERE e.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_hr.payroll_employment', v_n);
  PERFORM pg_catalog.set_config('ludy.org_purge', '', true);

  v_keep_proposal := ARRAY(
    SELECT d.proposal_id FROM ludy_finance.purchase_document d WHERE d.org_id = v_org AND d.proposal_id IS NOT NULL
    UNION
    SELECT c.proposal_id FROM ludy_finance.cash_voucher c WHERE c.org_id = v_org AND c.proposal_id IS NOT NULL
    UNION
    SELECT j.proposal_id FROM ludy_finance.journal_voucher j WHERE j.org_id = v_org AND j.proposal_id IS NOT NULL
    UNION
    SELECT e.source_id FROM ludy_finance.journal_entry e
    WHERE e.org_id = v_org AND e.source_type = 'kernel.proposal' AND e.source_id IS NOT NULL);

  v_keep_task := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT c.task_id FROM ludy_kernel.task_comment c WHERE c.org_id = v_org
      UNION
      SELECT r.source_task_id FROM ludy_kernel.proposal r
      WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.source_task_id IS NOT NULL
      UNION
      SELECT t.parent_task_id FROM ludy_kernel.task t JOIN k ON t.org_id = v_org AND t.id = k.id WHERE t.parent_task_id IS NOT NULL
    ) SELECT id FROM k);
  v_keep_run := ARRAY(
    SELECT t.checkout_run_id FROM ludy_kernel.task t
    WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.checkout_run_id IS NOT NULL
    UNION
    SELECT r.requested_by_run FROM ludy_kernel.proposal r
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND r.requested_by_run IS NOT NULL);
  v_keep_position := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT t.assignee_position_id FROM ludy_kernel.task t
      WHERE t.org_id = v_org AND t.id = ANY (v_keep_task) AND t.assignee_position_id IS NOT NULL
      UNION
      SELECT p.reports_to FROM ludy_kernel.position p JOIN k ON p.org_id = v_org AND p.id = k.id WHERE p.reports_to IS NOT NULL
    ) SELECT id FROM k);
  v_keep_agent := ARRAY(
    SELECT p.holder_agent_id FROM ludy_kernel.position p
    WHERE p.org_id = v_org AND p.id = ANY (v_keep_position) AND p.holder_agent_id IS NOT NULL
    UNION
    SELECT r.agent_id FROM ludy_kernel.ai_run r WHERE r.org_id = v_org AND r.id = ANY (v_keep_run) AND r.agent_id IS NOT NULL
    UNION
    SELECT a.agent FROM ludy_kernel.proposal r
    CROSS JOIN LATERAL (VALUES (r.requested_by_agent), (r.decided_by_agent)) a(agent)
    WHERE r.org_id = v_org AND r.id = ANY (v_keep_proposal) AND a.agent IS NOT NULL);
  v_keep_variant := ARRAY(SELECT DISTINCT a.variant_id FROM ludy_social.post_approval a WHERE a.org_id = v_org);
  v_keep_post := ARRAY(
    WITH RECURSIVE k(id) AS (
      SELECT a.post_id FROM ludy_social.post_approval a WHERE a.org_id = v_org
      UNION
      SELECT s.src FROM ludy_social.post p JOIN k ON p.org_id = v_org AND p.id = k.id
      CROSS JOIN LATERAL (VALUES (p.repost_of), (p.recurrence_source_id)) s(src) WHERE s.src IS NOT NULL
    ) SELECT id FROM k);
  v_keep_connection := ARRAY(
    SELECT DISTINCT v.channel_connection_id FROM ludy_social.post_variant v
    WHERE v.org_id = v_org AND v.id = ANY (v_keep_variant) AND v.channel_connection_id IS NOT NULL);
  v_keep_party := ARRAY(
    SELECT d.party_id FROM ludy_finance.purchase_document d WHERE d.org_id = v_org AND d.party_id IS NOT NULL
    UNION
    SELECT c.party_id FROM ludy_finance.cash_voucher c WHERE c.org_id = v_org AND c.party_id IS NOT NULL
    UNION
    SELECT l.party_id FROM ludy_finance.journal_line l WHERE l.org_id = v_org AND l.party_id IS NOT NULL);
  v_keep_file := ARRAY(
    SELECT d.source_file_id FROM ludy_finance.purchase_document d WHERE d.org_id = v_org AND d.source_file_id IS NOT NULL
    UNION
    SELECT l.file_id FROM ludy_finance.portal_invoice_list l WHERE l.org_id = v_org AND l.file_id IS NOT NULL);
  v_keep_file := v_keep_file || v_keep_signed_file;

  DELETE FROM ludy_kernel.proposal r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_proposal);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.proposal', v_n);

  v_conversation_keys := ARRAY(
    SELECT a.storage_key FROM ludy_kernel.conversation_attachment a
    WHERE a.org_id = v_org AND a.state = 'stored' AND a.storage_key LIKE 'conversation/' || v_org::text || '/%' ORDER BY 1);
  v_note_attachment_keys := ARRAY(
    SELECT a.storage_key FROM ludy_notes.attachment a
    WHERE a.org_id = v_org AND a.storage_key LIKE 'notes/' || v_org::text || '/%' ORDER BY 1);

  FOREACH v_t IN ARRAY v_kernel_first || v_social LOOP
    EXECUTE pg_catalog.format('DELETE FROM %s WHERE org_id = $1', v_t::regclass) USING v_org;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || pg_catalog.jsonb_build_object(v_t, v_n);
  END LOOP;

  DELETE FROM ludy_finance.stock_item i
  WHERE i.org_id = v_org AND NOT EXISTS (SELECT 1 FROM ludy_finance.stock_move m WHERE m.org_id = v_org AND m.item_id = i.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_finance.stock_item', v_n);

  DELETE FROM ludy_social.post_variant v WHERE v.org_id = v_org AND v.id <> ALL (v_keep_variant);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_social.post_variant', v_n);
  DELETE FROM ludy_social.post p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_post);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_social.post', v_n);
  DELETE FROM ludy_kernel.channel_connection c WHERE c.org_id = v_org AND c.id <> ALL (v_keep_connection);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.channel_connection', v_n);

  DELETE FROM ludy_ads.ad_token_seal s WHERE s.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_ads.ad_token_seal', v_n);
  DELETE FROM ludy_ads.ad_token_revoke r WHERE r.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_ads.ad_token_revoke', v_n);

  DELETE FROM ludy_kernel.task t WHERE t.org_id = v_org AND t.id <> ALL (v_keep_task);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.task', v_n);
  DELETE FROM ludy_kernel.ai_run r WHERE r.org_id = v_org AND r.id <> ALL (v_keep_run);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.ai_run', v_n);
  DELETE FROM ludy_kernel.position p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_position);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.position', v_n);
  DELETE FROM ludy_kernel.agent a WHERE a.org_id = v_org AND a.id <> ALL (v_keep_agent);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.agent', v_n);

  DELETE FROM ludy_kernel.tenant_member m WHERE m.org_id = v_org;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.tenant_member', v_n);

  UPDATE ludy_kernel.party p SET duplicate_of = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party) AND p.duplicate_of IS NOT NULL;
  UPDATE ludy_kernel.party p SET address = NULL, email = NULL, phone = NULL, verified_by = NULL
  WHERE p.org_id = v_org AND p.id = ANY (v_keep_party)
    AND (p.address IS NOT NULL OR p.email IS NOT NULL OR p.phone IS NOT NULL OR p.verified_by IS NOT NULL);
  GET DIAGNOSTICS v_anonymized = ROW_COUNT;
  DELETE FROM ludy_kernel.party p WHERE p.org_id = v_org AND p.id <> ALL (v_keep_party);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.party', v_n);

  WITH gone AS (
    DELETE FROM ludy_kernel.file f WHERE f.org_id = v_org AND f.id <> ALL (v_keep_file) RETURNING f.storage_key
  )
  SELECT pg_catalog.count(*), ARRAY(
    SELECT DISTINCT g.storage_key FROM gone g
    WHERE g.storage_key LIKE 'org/' || v_org::text || '/%'
      AND NOT EXISTS (SELECT 1 FROM ludy_kernel.file k WHERE k.org_id = v_org AND k.id = ANY (v_keep_file) AND k.storage_key = g.storage_key)
    ORDER BY 1)
  INTO v_n, v_keys FROM gone;
  v_deleted := v_deleted || pg_catalog.jsonb_build_object('ludy_kernel.file', v_n);
  v_keys := COALESCE(v_keys, ARRAY[]::text[]) || v_conversation_keys || v_note_attachment_keys;

  v_pinned := pg_catalog.jsonb_build_object(
    'ludy_kernel.task_comment', (SELECT pg_catalog.count(*) FROM ludy_kernel.task_comment c WHERE c.org_id = v_org),
    'ludy_kernel.task', pg_catalog.cardinality(v_keep_task),
    'ludy_kernel.ai_run', pg_catalog.cardinality(v_keep_run),
    'ludy_kernel.position', pg_catalog.cardinality(v_keep_position),
    'ludy_kernel.agent', pg_catalog.cardinality(v_keep_agent),
    'ludy_social.post_approval', (SELECT pg_catalog.count(*) FROM ludy_social.post_approval a WHERE a.org_id = v_org),
    'ludy_social.post_variant', pg_catalog.cardinality(v_keep_variant),
    'ludy_social.post', pg_catalog.cardinality(v_keep_post),
    'ludy_kernel.channel_connection', pg_catalog.cardinality(v_keep_connection),
    'ludy_finance.stock_item', (SELECT pg_catalog.count(*) FROM ludy_finance.stock_item i WHERE i.org_id = v_org));

  UPDATE ludy_kernel.tenant t SET status = 'closed' WHERE t.org_id = v_org;

  outcome := 'ok';
  counts := pg_catalog.jsonb_build_object(
    'deleted', v_deleted,
    'pinned', v_pinned,
    'anonymized', pg_catalog.jsonb_build_object('ludy_kernel.party', v_anonymized),
    'keptFiles', pg_catalog.cardinality(v_keep_file),
    'keptParties', pg_catalog.cardinality(v_keep_party),
    'keptProposals', pg_catalog.cardinality(v_keep_proposal));
  blob_keys := v_keys;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION ludy_kernel.org_purge(integer) FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant;
GRANT EXECUTE ON FUNCTION ludy_kernel.org_purge(integer) TO ludy_worker;
