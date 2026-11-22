// The CHECK-constraint unions of src/schema.ts against the database (issue #266). On a freshly migrated database it
// reads every CHECK constraint that restricts one column of a table crove_tenant may read to a fixed set of values
// (`col IN (...)`, which PostgreSQL stores as `col = ANY (ARRAY[...])`, or `col = '...'`) and compares the values with
// the const array schema.ts refines that column to; a set in a form it cannot read (an OR chain) fails the test
// instead of being skipped. A migration that widens or narrows such a constraint, or adds one, fails here until
// schema.ts follows. The type of UNIONS ties each array to the column's refined Kysely type, so `pnpm typecheck`
// fails when an array and the refinement drift apart.
//
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the test creates and drops its own database.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { SelectType } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.ts';
import {
  ACTOR_ORIGINS,
  ACTOR_TYPES,
  EVENT_TYPE_ASSIGNMENTS,
  EVENT_TYPE_LOCATION_KINDS,
  BOOKING_MANAGE_ACTIONS,
  BOOKING_MANAGE_OUTCOMES,
  BOOKING_MEETING_STATES,
  BOOKING_REFUSALS,
  BOOKING_STATUSES,
  AGENT_RISKS,
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_EVENT_KINDS,
  CALENDAR_LINK_STATES,
  CALENDAR_PROVIDERS,
  MEETING_PLATFORM_PROVIDERS,
  MEETING_PLATFORM_CONNECTION_STATUSES,
  MEETING_PLATFORM_RECORDING_STATUSES,
  MEETING_CHAT_KINDS,
  MEETING_CAPTURE_ENDED_REASONS,
  MEETING_CAPTURE_KINDS,
  MEETING_CHAT_POST_STATES,
  BOOKS_REGIMES,
  BANK_FEED_PULL_OUTCOMES,
  BANK_PARTY_RULE_KINDS,
  EINVOICE_BUYER_IDENTITY_KINDS,
  EINVOICE_CORRECTION_RATE_BASES,
  EINVOICE_BUYER_KINDS,
  EINVOICE_CONNECTION_STATES,
  EINVOICE_NOTICE_BUYER_STATES,
  EINVOICE_NOTICE_FIELDS,
  EINVOICE_NOTICE_FORM_STATES,
  SUPPLIER_BANK_ACCOUNT_CHANGE_KINDS,
  SUPPLIER_BANK_ACCOUNT_STATUSES,
  SUPPLIER_PAYMENT_CHANNELS,
  SUPPLIER_PAYMENT_HOLD_REASONS,
  SUPPLIER_PAYMENT_STATUSES,
  MARKETPLACE_AUTHORIZE_STATES,
  MARKETPLACE_POLL_STATES,
  MARKETPLACE_TEST_STATES,
  MARKETPLACE_COLUMN_CHECK_FAILURES,
  MARKETPLACE_COLUMN_CHECK_REFUSALS,
  MARKETPLACE_COLUMN_CHECK_STATES,
  MISA_AMIS_MATCH_CHECK_STATES,
  MISA_AMIS_MATCH_FAILURES,
  MISA_AMIS_MATCH_KINDS,
  MISA_AMIS_MATCH_STATES,
  MISA_AMIS_PUSH_SOURCES,
  MISA_AMIS_PUSH_STATES,
  MISA_AMIS_PRODUCTS,
  MISA_AMIS_TEST_STATES,
  CHANNEL_PLATFORMS,
  CHANNEL_STAGES,
  HOUSEHOLD_BOOKS,
  HOUSEHOLD_EXPENSE_GROUPS,
  HOUSEHOLD_PIT_METHODS,
  MARKETPLACE_VAT_METHODS,
  HOUSEHOLD_VAT_CUT_ANSWERS,
  HOUSEHOLD_RETURN_FORMS,
  HOUSEHOLD_REDUCTION_KINDS,
  HOUSEHOLD_RULE_STATUSES,
  STOCK_COUNT_STATUSES,
  STOCK_ITEM_KINDS,
  STOCK_MOVE_SOURCES,
  STOCK_ORDER_MOVES,
  STOCK_TRADES,
  EINVOICE_DRAFT_STATES,
  CATEGORIZATION_RULE_MATCH_KINDS,
  CALENDAR_EVENT_STATUSES,
  AGENT_KINDS,
  AGENT_STATUSES,
  MEMBER_PERMISSION_OVERRIDE_PERMISSIONS,
  MEMBER_VY_RESULT_STATUSES,
  MCP_MEMBER_TABLE_MODES,
  MCP_PROPOSAL_COMMAND_SCOPES,
  MEMBER_VY_TABLE_MODES,
  AGENT_WAKEUP_STATUSES,
  AI_RUN_STATUSES,
  AUDIT_OUTCOMES,
  CHANNEL_CONNECTION_STATUSES,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_STATES,
  DRAFT_SOURCES,
  DRAFT_STATES,
  CONVERSATION_INTENTS,
  CONVERSATION_KINDS,
  CONVERSATION_STATUSES,
  MESSAGE_AUTHOR_KINDS,
  MESSAGE_DIRECTIONS,
  MESSAGE_HIDE_REQUESTS,
  MESSAGE_SEND_STATES,
  CORRECTION_KINDS,
  DOCUMENT_DIRECTIONS,
  EXCHANGE_RATE_SOURCES,
  EXTERNAL_CALL_ERROR_KINDS,
  EXTERNAL_CALL_RETRY_SAFETIES,
  EXTERNAL_CALL_STATES,
  FIXED_ASSET_KINDS,
  INBOX_ITEM_KINDS,
  MAIL_STATUSES,
  USAGE_DEFERRAL_METRICS,
  USAGE_DEFERRAL_SUBJECTS,
  USAGE_METRICS,
  MAIL_STREAMS,
  MAIL_EVENT_KINDS,
  MAIL_SUPPRESSION_REASONS,
  MAIL_SUPPRESSION_SCOPES,
  SOCIAL_ACTOR_ORIGINS,
  SOCIAL_BANNED_WORD_LEVELS,
  SOCIAL_DECISIONS,
  SOCIAL_EDIT_STATES,
  SOCIAL_LINK_PREVIEW_ERRORS,
  SOCIAL_LINK_PREVIEW_STATUSES,
  SOCIAL_NOTIFICATION_KINDS,
  SOCIAL_CHANNEL_OPTION_ERRORS,
  SOCIAL_CHANNEL_OPTION_KINDS,
  SOCIAL_CHANNEL_OPTION_STATUSES,
  SOCIAL_LABEL_COLORS,
  SOCIAL_MEDIA_ATTRIBUTION_PROVIDERS,
  SOCIAL_IDEA_ORIGINS,
  SOCIAL_IDEA_STAGES,
  SOCIAL_WATERMARK_CORNERS,
  SOCIAL_CHAT_ALERT_TARGETS,
  SOCIAL_REPORT_CADENCES,
  SOCIAL_REPORT_PERIODS,
  SOCIAL_REPORT_RUN_KINDS,
  SOCIAL_ACCOUNT_SNAPSHOT_ERRORS,
  SOCIAL_REVIEW_LINK_KINDS,
  SOCIAL_REVIEW_VERDICTS,
  SOCIAL_SUGGEST_FIELDS,
  SOCIAL_SUGGEST_STATES,
  SOCIAL_ERROR_KINDS,
  SOCIAL_ORIGINS,
  SOCIAL_POST_STATUSES,
  SOCIAL_VARIANT_STATUSES,
  EXTRACTION_METHODS,
  EXTRACTION_STATUSES,
  FILE_SOURCES,
  FILE_UPLOAD_PURPOSES,
  INVITE_ROLES,
  LEGAL_ENTITY_KINDS,
  ROLE_SCOPES,
  INVITE_STATUSES,
  INPUT_VAT_CHECK_OUTCOMES,
  MEMBER_AVAILABILITY_STATUSES,
  MEMBER_ROLES,
  NOTE_LINK_TARGET_TYPES,
  AD_CAP_PERIODS,
  AD_DRAFT_ORIGINS,
  AD_DRAFT_STATUSES,
  HR_CANDIDATE_SOURCES,
  HR_CANDIDATE_STAGES,
  HR_CONTRACT_FORMS,
  HR_CONTRACT_TYPES,
  HR_JOB_OPENING_STATUSES,
  HR_PAY_BASES,
  HR_PAY_FUNCTIONS,
  HR_PROBATION_ROLE_TIERS,
  HR_EMPLOYEE_STATUSES,
  HR_LEAVE_ENTRY_KINDS,
  HR_LEAVE_REQUEST_KINDS,
  HR_LEAVE_REQUEST_STATUSES,
  HR_ATTENDANCE_METHODS,
  HR_ATTENDANCE_STATUSES,
  HR_ONBOARDING_STATUSES,
  HR_OVERTIME_DAY_TYPES,
  HR_OVERTIME_STATUSES,
  HR_PROBATION_DECISIONS,
  HR_LINE_KINDS,
  HR_LINE_STATUSES,
  HR_RUN_STATUSES,
  HR_REGIONS,
  AD_LAUNCH_STATES,
  AD_MANAGE_KINDS,
  AD_MANAGE_LEVELS,
  AD_MANAGE_STATES,
  AD_OBJECT_LEVELS,
  AD_OBJECT_STATUSES,
  AD_OBJECTIVES,
  AD_REQUEST_STATES,
  AD_CAP_SCOPES,
  AD_ERROR_KINDS,
  AD_LEVELS,
  AD_SYNC_RUN_STATUSES,
  AD_REVOKE_ERROR_KINDS,
  AD_REVOKE_GIVE_UPS,
  AD_REVOKE_HOWS,
  AD_REVOKE_STATES,
  AD_TOKEN_KINDS,
  NOTE_ATTACHMENT_EXTRACT_STATUSES,
  NOTE_VISIBILITIES,
  MEETING_VISIBILITIES,
  MEETING_LANGUAGES,
  TRANSLATION_TARGET_LANGUAGES,
  MEETING_STATUSES,
  MEETING_CONSENT_METHODS,
  MEETING_CONSENT_POLICIES,
  MEETING_RECORDING_STOP_REASONS,
  TRANSCRIPT_STAGES,
  TRANSCRIPTION_MAKERS,
  MEETING_RESULT_STAGES,
  MEETING_RESULT_FEATURES,
  MEETING_SUMMARY_TEMPLATES,
  ACTION_ITEM_STATUSES,
  TRANSLATION_KINDS,
  NUMBER_RESETS,
  PARTY_KINDS,
  IMPORT_BATCH_STATUSES,
  IMPORT_ON_DUPLICATE_CHOICES,
  IMPORT_ROW_COMPANY_STATES,
  IMPORT_ROW_OUTCOMES,
  PARTY_SOURCE_TRUSTS,
  PIPELINE_STAGE_KINDS,
  QUOTE_ACCEPTED_VIA,
  QUOTE_LINE_KINDS,
  QUOTE_SENT_VIA,
  QUOTE_STATUSES,
  SALES_ORDER_DELIVERY_KINDS,
  SALES_ORDER_STATUSES,
  DEAL_CURRENCIES,
  DEAL_NEXT_STEP_CLOSE_REASONS,
  DEAL_NEXT_STEP_REASONS,
  DEAL_NEXT_STEP_STATUSES,
  PIT_FILING_PERIODS,
  PORTAL_INVOICE_STATUSES,
  PORTAL_LIST_DIRECTIONS,
  PORTAL_LIST_STATUSES,
  POSITION_STATUSES,
  PROJECT_COLUMN_COLORS,
  PROJECT_COLUMN_STATUSES,
  PROJECT_CYCLE_STATUSES,
  PROJECT_STATUSES,
  PROJECT_VISIBILITIES,
  ROADMAP_ANNOUNCEMENT_STATUSES,
  ROADMAP_ITEM_SOURCES,
  ROADMAP_ITEM_MODERATION_STATUSES,
  ROADMAP_ITEM_STAGES,
  PROPOSAL_STATUSES,
  TASK_KINDS,
  TASK_SOURCES,
  TASK_STATUSES,
  TODAY_MAIL_LANGUAGES,
  TODO_STATUSES,
  RECORD_LE_TYPES,
  TAX_OBLIGATION_CODES,
  TENANT_STATUSES,
  VOUCHER_TYPES,
  VAT_FILING_PERIODS,
  VAT_RETURN_FILED_SOURCES,
  VAT_RETURN_FILED_STATUSES,
  SIGN_ENVELOPE_STATUSES,
  SIGN_ROUTING_MODES,
  SIGN_SOURCE_KINDS,
  SIGN_INSPECT_STATUSES,
  SIGN_SEAL_STATUSES,
  SIGN_SIGNER_ROLES,
  SIGN_DELIVERY_MODES,
  SIGN_SIGNER_STATUSES,
  SIGN_SIGNATURE_KINDS,
  SIGN_FIELD_TYPES,
  SIGN_ATTACHMENT_CONTENT_TYPES,
  SIGN_MEMBER_SIGNATURE_KINDS,
  SIGN_ORG_STAMP_KINDS,
  SIGN_ORG_STAMP_STATUSES,
  SIGN_AI_ANALYSIS_STATUSES,
  SIGN_ACTOR_TYPES,
  SIGN_TEMPLATE_STATUSES,
  SIGN_CA_PROVIDERS,
  SIGN_CA_REQUEST_STATUSES,
  SIGN_CA_RETRY_SAFETIES,
  SIGN_CA_SUBFILTERS,
  SIGN_OBLIGATION_STATUSES,
  type Database,
} from '../src/schema.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SCHEMAS = ['ludy_kernel', 'crove_finance', 'crove_social', 'crove_crm', 'crove_notes', 'crove_ads', 'crove_hr', 'crove_meetings', 'crove_projects', 'crove_sign'];
const suite = ADMIN ? describe : describe.skip;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// The values a column of the refined Database holds, null aside: 'ludy_kernel.task.status' -> TaskStatus.
type ColumnValues<K> = K extends `${infer S}.${infer T}.${infer C}`
  ? `${S}.${T}` extends keyof Database
    ? C extends keyof Database[`${S}.${T}`]
      ? NonNullable<SelectType<Database[`${S}.${T}`][C]>>
      : never
    : never
  : never;
type Unions<M> = {
  [K in keyof M]: M[K] extends readonly (infer E)[]
    ? Equal<E, ColumnValues<K>> extends true
      ? M[K]
      : 'the array does not match the type schema.ts refines this column to'
    : 'not a const array';
};
const unions = <const M extends Unions<M> & Readonly<Record<string, readonly string[]>>>(map: M): Readonly<Record<string, readonly string[]>> =>
  map;

// schema.table.column -> the const array of schema.ts the column is refined to.
const UNIONS = unions({
  'crove_hr.candidate.source': HR_CANDIDATE_SOURCES,
  'crove_hr.candidate.stage': HR_CANDIDATE_STAGES,
  'crove_hr.department.pay_function': HR_PAY_FUNCTIONS,
  'crove_hr.job_opening.contract_type': HR_CONTRACT_TYPES,
  'crove_hr.job_opening.pay_function': HR_PAY_FUNCTIONS,
  'crove_hr.job_opening.region': HR_REGIONS,
  'crove_hr.job_opening.status': HR_JOB_OPENING_STATUSES,
  'crove_hr.payroll_employee.status': HR_EMPLOYEE_STATUSES,
  'crove_hr.payroll_employment.contract_type': HR_CONTRACT_TYPES,
  'crove_hr.payroll_employment.contract_form': HR_CONTRACT_FORMS,
  'crove_hr.payroll_leave_entry.kind': HR_LEAVE_ENTRY_KINDS,
  'crove_hr.leave_request.kind': HR_LEAVE_REQUEST_KINDS,
  'crove_hr.leave_request.status': HR_LEAVE_REQUEST_STATUSES,
  'crove_hr.attendance_log.check_in_method': HR_ATTENDANCE_METHODS,
  'crove_hr.attendance_log.status': HR_ATTENDANCE_STATUSES,
  'crove_hr.onboarding_submission.status': HR_ONBOARDING_STATUSES,
  'crove_hr.overtime_request.day_type': HR_OVERTIME_DAY_TYPES,
  'crove_hr.overtime_request.status': HR_OVERTIME_STATUSES,
  'crove_hr.probation_review.decision': HR_PROBATION_DECISIONS,
  'crove_hr.payroll_line.kind': HR_LINE_KINDS,
  'crove_hr.payroll_line.status': HR_LINE_STATUSES,
  'crove_hr.payroll_run.status': HR_RUN_STATUSES,
  'crove_hr.payroll_employment.pay_basis': HR_PAY_BASES,
  'crove_hr.payroll_employment.pay_function': HR_PAY_FUNCTIONS,
  'crove_hr.payroll_employment.probation_role_tier': HR_PROBATION_ROLE_TIERS,
  'crove_hr.payroll_employment.region': HR_REGIONS,
  'crove_ads.ad_account.last_error_kind': AD_ERROR_KINDS,
  'crove_ads.ad_campaign_draft.objective': AD_OBJECTIVES,
  'crove_ads.ad_campaign_draft.origin': AD_DRAFT_ORIGINS,
  'crove_ads.ad_campaign_draft.status': AD_DRAFT_STATUSES,
  'crove_ads.ad_campaign_request.objective': AD_OBJECTIVES,
  'crove_ads.ad_campaign_request.state': AD_REQUEST_STATES,
  'crove_ads.ad_launch.state': AD_LAUNCH_STATES,
  'crove_ads.ad_manage_change.kind': AD_MANAGE_KINDS,
  'crove_ads.ad_manage_change.level': AD_MANAGE_LEVELS,
  'crove_ads.ad_manage_change.state': AD_MANAGE_STATES,
  'crove_ads.ad_object.configured_status': AD_OBJECT_STATUSES,
  'crove_ads.ad_object.level': AD_OBJECT_LEVELS,
  'crove_ads.ad_spend_cap.period': AD_CAP_PERIODS,
  'crove_ads.ad_spend_cap.scope': AD_CAP_SCOPES,
  'crove_ads.ad_spend_day.level': AD_LEVELS,
  'crove_ads.ad_sync_run.error_kind': AD_ERROR_KINDS,
  'crove_ads.ad_sync_run.status': AD_SYNC_RUN_STATUSES,
  'crove_ads.ad_token_revoke.give_up': AD_REVOKE_GIVE_UPS,
  'crove_ads.ad_token_revoke.how_done': AD_REVOKE_HOWS,
  'crove_ads.ad_token_revoke.kind': AD_TOKEN_KINDS,
  'crove_ads.ad_token_revoke.last_error_kind': AD_REVOKE_ERROR_KINDS,
  'crove_ads.ad_token_revoke.state': AD_REVOKE_STATES,
  'crove_crm.booking.manage_action': BOOKING_MANAGE_ACTIONS,
  'crove_crm.booking.manage_outcome': BOOKING_MANAGE_OUTCOMES,
  'crove_crm.booking.meeting_state': BOOKING_MEETING_STATES,
  'crove_crm.booking.refusal': BOOKING_REFUSALS,
  'crove_crm.booking.status': BOOKING_STATUSES,
  'crove_crm.deal.currency': DEAL_CURRENCIES,
  'crove_crm.deal_next_step.closed_reason': DEAL_NEXT_STEP_CLOSE_REASONS,
  'crove_crm.deal_next_step.reason': DEAL_NEXT_STEP_REASONS,
  'crove_crm.deal_next_step.status': DEAL_NEXT_STEP_STATUSES,
  'crove_crm.event_type.assignment': EVENT_TYPE_ASSIGNMENTS,
  'crove_crm.event_type.location_kind': EVENT_TYPE_LOCATION_KINDS,
  'crove_crm.import_batch.on_duplicate': IMPORT_ON_DUPLICATE_CHOICES,
  'crove_crm.import_batch.status': IMPORT_BATCH_STATUSES,
  'crove_crm.import_row.kind': PARTY_KINDS,
  'crove_crm.import_row.outcome': IMPORT_ROW_OUTCOMES,
  'crove_crm.import_row.company_state': IMPORT_ROW_COMPANY_STATES,
  'crove_crm.pipeline_stage.kind': PIPELINE_STAGE_KINDS,
  'crove_crm.quote.sent_via': QUOTE_SENT_VIA,
  'crove_crm.quote.status': QUOTE_STATUSES,
  'crove_crm.quote_line.kind': QUOTE_LINE_KINDS,
  'crove_crm.sales_order.accepted_via': QUOTE_ACCEPTED_VIA,
  'crove_crm.sales_order.status': SALES_ORDER_STATUSES,
  'crove_crm.sales_order_delivery.kind': SALES_ORDER_DELIVERY_KINDS,
  'crove_crm.sales_order_line.kind': QUOTE_LINE_KINDS,
  'crove_meetings.meeting.visibility': MEETING_VISIBILITIES,
  'crove_meetings.meeting.language': MEETING_LANGUAGES,
  'crove_meetings.meeting.status': MEETING_STATUSES,
  'crove_meetings.meeting.consent_method': MEETING_CONSENT_METHODS,
  'crove_meetings.meeting.recording_stop_reason': MEETING_RECORDING_STOP_REASONS,
  'crove_meetings.meeting.summary_template': MEETING_SUMMARY_TEMPLATES,
  'crove_meetings.capture_session.kind': MEETING_CAPTURE_KINDS,
  'crove_meetings.capture_session.ended_reason': MEETING_CAPTURE_ENDED_REASONS,
  'crove_meetings.chat_channel.kind': MEETING_CHAT_KINDS,
  'crove_meetings.chat_post.state': MEETING_CHAT_POST_STATES,
  'crove_meetings.action_item.stage': MEETING_RESULT_STAGES,
  'crove_meetings.action_item.status': ACTION_ITEM_STATUSES,
  'crove_meetings.meeting_chapter.stage': MEETING_RESULT_STAGES,
  'crove_meetings.meeting_result.feature': MEETING_RESULT_FEATURES,
  'crove_meetings.meeting_result.stage': MEETING_RESULT_STAGES,
  'crove_meetings.transcript_segment.stage': TRANSCRIPT_STAGES,
  'crove_meetings.transcript_segment.source': TRANSCRIPTION_MAKERS,
  'crove_meetings.translation.kind': TRANSLATION_KINDS,
  'crove_meetings.translation.source_stage': MEETING_RESULT_STAGES,
  'crove_meetings.translation.target_language': TRANSLATION_TARGET_LANGUAGES,
  'crove_notes.attachment.extract_status': NOTE_ATTACHMENT_EXTRACT_STATUSES,
  'crove_notes.link.target_type': NOTE_LINK_TARGET_TYPES,
  'crove_notes.note.visibility': NOTE_VISIBILITIES,
  'crove_notes.note_template.visibility': NOTE_VISIBILITIES,
  'crove_notes.notebook.visibility': NOTE_VISIBILITIES,
  'crove_notes.todo.status': TODO_STATUSES,
  'crove_projects.project.status': PROJECT_STATUSES,
  'crove_projects.project.visibility': PROJECT_VISIBILITIES,
  'crove_projects.project_column.task_status': PROJECT_COLUMN_STATUSES,
  'crove_projects.project_column.color': PROJECT_COLUMN_COLORS,
  'crove_projects.project_cycle.status': PROJECT_CYCLE_STATUSES,
  'crove_projects.roadmap_announcement.status': ROADMAP_ANNOUNCEMENT_STATUSES,
  'crove_projects.roadmap_item.source': ROADMAP_ITEM_SOURCES,
  'crove_projects.roadmap_item.moderation_status': ROADMAP_ITEM_MODERATION_STATUSES,
  'crove_projects.roadmap_item.stage': ROADMAP_ITEM_STAGES,
  'crove_sign.envelope.status': SIGN_ENVELOPE_STATUSES,
  'crove_sign.envelope.routing_mode': SIGN_ROUTING_MODES,
  'crove_sign.envelope.source_kind': SIGN_SOURCE_KINDS,
  'crove_sign.envelope.inspect_status': SIGN_INSPECT_STATUSES,
  'crove_sign.envelope.seal_status': SIGN_SEAL_STATUSES,
  'crove_sign.signer.signer_role': SIGN_SIGNER_ROLES,
  'crove_sign.signer.delivery_mode': SIGN_DELIVERY_MODES,
  'crove_sign.signer.status': SIGN_SIGNER_STATUSES,
  'crove_sign.signer.signature_kind': SIGN_SIGNATURE_KINDS,
  'crove_sign.field.field_type': SIGN_FIELD_TYPES,
  'crove_sign.field.attachment_content_type': SIGN_ATTACHMENT_CONTENT_TYPES,
  'crove_sign.ai_analysis.status': SIGN_AI_ANALYSIS_STATUSES,
  'crove_sign.signing_event.actor_type': SIGN_ACTOR_TYPES,
  'crove_sign.template.status': SIGN_TEMPLATE_STATUSES,
  'crove_sign.template.routing_mode': SIGN_ROUTING_MODES,
  'crove_sign.template.inspect_status': SIGN_INSPECT_STATUSES,
  'crove_sign.template_role.signer_role': SIGN_SIGNER_ROLES,
  'crove_sign.template_role.delivery_mode': SIGN_DELIVERY_MODES,
  'crove_sign.template_field.field_type': SIGN_FIELD_TYPES,
  'crove_sign.ca_signing_request.provider': SIGN_CA_PROVIDERS,
  'crove_sign.ca_signing_request.status': SIGN_CA_REQUEST_STATUSES,
  'crove_sign.ca_signing_request.retry_safety': SIGN_CA_RETRY_SAFETIES,
  'crove_sign.ca_signing_request.sub_filter': SIGN_CA_SUBFILTERS,
  'crove_sign.envelope_obligation.status': SIGN_OBLIGATION_STATUSES,
  'crove_sign.member_signature.kind': SIGN_MEMBER_SIGNATURE_KINDS,
  'crove_sign.member_signature.signature_kind': SIGN_SIGNATURE_KINDS,
  'crove_sign.org_stamp.stamp_kind': SIGN_ORG_STAMP_KINDS,
  'crove_sign.org_stamp.status': SIGN_ORG_STAMP_STATUSES,
  'ludy_kernel.activity.actor_origin': ACTOR_ORIGINS,
  'ludy_kernel.agent.max_risk': AGENT_RISKS,
  'ludy_kernel.agent.runtime': AGENT_RUNTIMES,
  'ludy_kernel.agent.kind': AGENT_KINDS,
  'ludy_kernel.agent.status': AGENT_STATUSES,
  'ludy_kernel.member_permission_override.permission': MEMBER_PERMISSION_OVERRIDE_PERMISSIONS,
  'ludy_kernel.member_vy_result.status': MEMBER_VY_RESULT_STATUSES,
  'ludy_kernel.member_vy_table.mode': MEMBER_VY_TABLE_MODES,
  'ludy_kernel.mcp_member_table.mode': MCP_MEMBER_TABLE_MODES,
  'ludy_kernel.mcp_proposal_command.scope': MCP_PROPOSAL_COMMAND_SCOPES,
  'ludy_kernel.mcp_wake_event_type.scope': MCP_PROPOSAL_COMMAND_SCOPES,
  'ludy_kernel.permission_default.base_role': MEMBER_ROLES,
  'ludy_kernel.agent_template.max_risk': AGENT_RISKS,
  'ludy_kernel.agent_wakeup.status': AGENT_WAKEUP_STATUSES,
  'ludy_kernel.ai_run.status': AI_RUN_STATUSES,
  'ludy_kernel.audit_event.actor_type': ACTOR_TYPES,
  'ludy_kernel.audit_event.outcome': AUDIT_OUTCOMES,
  'ludy_kernel.budget_policy.scope': AGENT_SCOPES,
  'ludy_kernel.calendar_connection.provider': CALENDAR_PROVIDERS,
  'ludy_kernel.calendar_connection.status': CALENDAR_CONNECTION_STATUSES,
  'ludy_kernel.meeting_platform_connection.provider': MEETING_PLATFORM_PROVIDERS,
  'ludy_kernel.meeting_platform_connection.status': MEETING_PLATFORM_CONNECTION_STATUSES,
  'ludy_kernel.meeting_platform_recording.status': MEETING_PLATFORM_RECORDING_STATUSES,
  'ludy_kernel.calendar_event.kind': CALENDAR_EVENT_KINDS,
  'ludy_kernel.calendar_event_link.state': CALENDAR_LINK_STATES,
  'ludy_kernel.calendar_event.status': CALENDAR_EVENT_STATUSES,
  'ludy_kernel.channel_connection.status': CHANNEL_CONNECTION_STATUSES,
  'ludy_kernel.conversation.intent': CONVERSATION_INTENTS,
  'ludy_kernel.conversation.kind': CONVERSATION_KINDS,
  'ludy_kernel.conversation.status': CONVERSATION_STATUSES,
  'ludy_kernel.conversation_attachment.content_type': ATTACHMENT_CONTENT_TYPES,
  'ludy_kernel.conversation_attachment.kind': CONVERSATION_KINDS,
  'ludy_kernel.conversation_attachment.state': ATTACHMENT_STATES,
  'ludy_kernel.conversation_composing.kind': CONVERSATION_KINDS,
  'ludy_kernel.conversation_draft.kind': CONVERSATION_KINDS,
  'ludy_kernel.conversation_draft.source': DRAFT_SOURCES,
  'ludy_kernel.conversation_draft.state': DRAFT_STATES,
  'ludy_kernel.conversation_message.author_kind': MESSAGE_AUTHOR_KINDS,
  'ludy_kernel.conversation_message.direction': MESSAGE_DIRECTIONS,
  'ludy_kernel.conversation_message.hide_request': MESSAGE_HIDE_REQUESTS,
  'ludy_kernel.conversation_message.kind': CONVERSATION_KINDS,
  'ludy_kernel.conversation_message.send_state': MESSAGE_SEND_STATES,
  'ludy_kernel.external_call.state': EXTERNAL_CALL_STATES,
  'ludy_kernel.external_call.retry_safety': EXTERNAL_CALL_RETRY_SAFETIES,
  'ludy_kernel.external_call.error_kind': EXTERNAL_CALL_ERROR_KINDS,
  'ludy_kernel.mail_message.status': MAIL_STATUSES,
  'ludy_kernel.org_usage.metric': USAGE_METRICS,
  'ludy_kernel.usage_deferral.metric': USAGE_DEFERRAL_METRICS,
  'ludy_kernel.usage_deferral.subject_type': USAGE_DEFERRAL_SUBJECTS,
  'ludy_kernel.mail_message.stream': MAIL_STREAMS,
  'ludy_kernel.mail_event.kind': MAIL_EVENT_KINDS,
  'ludy_kernel.mail_suppression.reason': MAIL_SUPPRESSION_REASONS,
  'ludy_kernel.mail_suppression.scope': MAIL_SUPPRESSION_SCOPES,
  'ludy_kernel.extraction.method': EXTRACTION_METHODS,
  'ludy_kernel.extraction.status': EXTRACTION_STATUSES,
  'ludy_kernel.file.source': FILE_SOURCES,
  'ludy_kernel.file_upload.purpose': FILE_UPLOAD_PURPOSES,
  'ludy_kernel.inbox_item.kind': INBOX_ITEM_KINDS,
  'ludy_kernel.kill_switch.scope': AGENT_SCOPES,
  'ludy_kernel.legal_entity.kind': LEGAL_ENTITY_KINDS,
  'ludy_kernel.member_availability.status': MEMBER_AVAILABILITY_STATUSES,
  'ludy_kernel.member_invite.role': INVITE_ROLES,
  'ludy_kernel.member_invite.status': INVITE_STATUSES,
  'ludy_kernel.number_series_policy.reset': NUMBER_RESETS,
  'ludy_kernel.party.kind': PARTY_KINDS,
  'ludy_kernel.party.source_trust': PARTY_SOURCE_TRUSTS,
  'ludy_kernel.position.status': POSITION_STATUSES,
  'ludy_kernel.proposal.status': PROPOSAL_STATUSES,
  'ludy_kernel.record_le.record_type': RECORD_LE_TYPES,
  'ludy_kernel.role.scope': ROLE_SCOPES,
  'ludy_kernel.task.created_by_type': ACTOR_TYPES,
  'ludy_kernel.task.kind': TASK_KINDS,
  'ludy_kernel.task.source': TASK_SOURCES,
  'ludy_kernel.task.status': TASK_STATUSES,
  'ludy_kernel.task_comment.author_type': ACTOR_TYPES,
  'ludy_kernel.tax_obligation_done.obligation': TAX_OBLIGATION_CODES,
  'ludy_kernel.tax_profile.pit_filing_period': PIT_FILING_PERIODS,
  'ludy_kernel.tenant.status': TENANT_STATUSES,
  'ludy_kernel.tenant.vat_filing_period': VAT_FILING_PERIODS,
  'ludy_kernel.tenant.meeting_consent_policy': MEETING_CONSENT_POLICIES,
  'ludy_kernel.tenant_member.role': MEMBER_ROLES,
  'ludy_kernel.today_mail.language': TODAY_MAIL_LANGUAGES,
  'crove_finance.einvoice_connection.last_test_state': EINVOICE_CONNECTION_STATES,
  'crove_finance.einvoice_notice.field': EINVOICE_NOTICE_FIELDS,
  'crove_finance.einvoice_notice.buyer_notice_state': EINVOICE_NOTICE_BUYER_STATES,
  'crove_finance.einvoice_notice.form_state': EINVOICE_NOTICE_FORM_STATES,
  'crove_finance.supplier_bank_account.status': SUPPLIER_BANK_ACCOUNT_STATUSES,
  'crove_finance.supplier_bank_account_change.kind': SUPPLIER_BANK_ACCOUNT_CHANGE_KINDS,
  'crove_finance.supplier_payment.status': SUPPLIER_PAYMENT_STATUSES,
  'crove_finance.supplier_payment.hold_reason': SUPPLIER_PAYMENT_HOLD_REASONS,
  'crove_finance.supplier_payment.confirmed_channel': SUPPLIER_PAYMENT_CHANNELS,
  'crove_finance.marketplace_connection.last_test_state': MARKETPLACE_TEST_STATES,
  'crove_finance.misa_amis_connection.last_test_state': MISA_AMIS_TEST_STATES,
  'crove_finance.marketplace_column_check.platform': CHANNEL_PLATFORMS,
  'crove_finance.marketplace_column_check.state': MARKETPLACE_COLUMN_CHECK_STATES,
  'crove_finance.marketplace_column_check.failure': MARKETPLACE_COLUMN_CHECK_FAILURES,
  'crove_finance.marketplace_column_check.refusal': MARKETPLACE_COLUMN_CHECK_REFUSALS,
  'crove_finance.misa_amis_match_check.state': MISA_AMIS_MATCH_CHECK_STATES,
  'crove_finance.misa_amis_match_check.failure': MISA_AMIS_MATCH_FAILURES,
  'crove_finance.misa_amis_match.kind': MISA_AMIS_MATCH_KINDS,
  'crove_finance.misa_amis_match.state': MISA_AMIS_MATCH_STATES,
  'crove_finance.misa_amis_connection.product': MISA_AMIS_PRODUCTS,
  'crove_finance.misa_amis_push.state': MISA_AMIS_PUSH_STATES,
  'crove_finance.misa_amis_push.source_type': MISA_AMIS_PUSH_SOURCES,
  'crove_finance.marketplace_connection.last_poll_state': MARKETPLACE_POLL_STATES,
  'crove_finance.marketplace_connection.authorize_state': MARKETPLACE_AUTHORIZE_STATES,
  'crove_finance.marketplace_connection.platform': CHANNEL_PLATFORMS,
  'crove_finance.marketplace_column_profile.platform': CHANNEL_PLATFORMS,
  'crove_finance.channel_order.platform': CHANNEL_PLATFORMS,
  'crove_finance.channel_order_line.stage': CHANNEL_STAGES,
  'crove_finance.channel_settlement.platform': CHANNEL_PLATFORMS,
  'crove_finance.household_expense_group_map.expense_group': HOUSEHOLD_EXPENSE_GROUPS,
  'crove_finance.household_expense_group_map.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_form_version.book': HOUSEHOLD_BOOKS,
  'crove_finance.household_form_version.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_profile.pit_method': HOUSEHOLD_PIT_METHODS,
  'crove_finance.household_profile.vat_cut_eligible': HOUSEHOLD_VAT_CUT_ANSWERS,
  'crove_finance.marketplace_vat_rate.method': MARKETPLACE_VAT_METHODS,
  'crove_finance.household_return_form_version.form': HOUSEHOLD_RETURN_FORMS,
  'crove_finance.household_return_form_version.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_tax_reduction.kind': HOUSEHOLD_REDUCTION_KINDS,
  'crove_finance.household_tax_reduction.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_threshold.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_trade_rate.status': HOUSEHOLD_RULE_STATUSES,
  'crove_finance.household_trade_rate.trade': STOCK_TRADES,
  'crove_finance.stock_count.status': STOCK_COUNT_STATUSES,
  'crove_finance.stock_item.kind': STOCK_ITEM_KINDS,
  'crove_finance.stock_item.trade': STOCK_TRADES,
  'crove_finance.stock_move.order_move': STOCK_ORDER_MOVES,
  'crove_finance.stock_move.source_type': STOCK_MOVE_SOURCES,
  'crove_finance.einvoice_draft.buyer_identity_kind': EINVOICE_BUYER_IDENTITY_KINDS,
  'crove_finance.einvoice_draft.buyer_kind': EINVOICE_BUYER_KINDS,
  'crove_finance.einvoice_draft.correction_rate_basis': EINVOICE_CORRECTION_RATE_BASES,
  'crove_finance.einvoice_draft.state': EINVOICE_DRAFT_STATES,
  'crove_finance.purchase_document.direction': DOCUMENT_DIRECTIONS,
  'crove_finance.purchase_document.correction_kind': CORRECTION_KINDS,
  'crove_finance.purchase_document.exchange_rate_source': EXCHANGE_RATE_SOURCES,
  'crove_finance.cash_voucher.voucher_type': VOUCHER_TYPES,
  'crove_finance.input_vat_check.outcome': INPUT_VAT_CHECK_OUTCOMES,
  'crove_finance.vat_return_filed.status': VAT_RETURN_FILED_STATUSES,
  'crove_finance.vat_return_filed.source': VAT_RETURN_FILED_SOURCES,
  'crove_finance.fixed_asset.kind': FIXED_ASSET_KINDS,
  'crove_finance.categorization_rule.match_kind': CATEGORIZATION_RULE_MATCH_KINDS,
  'crove_finance.bank_party_rule.kind': BANK_PARTY_RULE_KINDS,
  'crove_finance.bank_feed_account.last_pull_outcome': BANK_FEED_PULL_OUTCOMES,
  'crove_finance.chart.regime': BOOKS_REGIMES,
  'crove_finance.portal_invoice_list.status': PORTAL_LIST_STATUSES,
  'crove_finance.portal_invoice_list.direction': PORTAL_LIST_DIRECTIONS,
  'crove_finance.portal_invoice_row.status': PORTAL_INVOICE_STATUSES,
  'crove_social.banned_word.level': SOCIAL_BANNED_WORD_LEVELS,
  'crove_social.idea.origin': SOCIAL_IDEA_ORIGINS,
  'crove_social.idea.stage': SOCIAL_IDEA_STAGES,
  'crove_social.report_schedule.cadence': SOCIAL_REPORT_CADENCES,
  'crove_social.report_schedule.period': SOCIAL_REPORT_PERIODS,
  'crove_social.report_schedule_run.kind': SOCIAL_REPORT_RUN_KINDS,
  'crove_social.calendar_note.color': SOCIAL_LABEL_COLORS,
  'crove_social.watermark.corner': SOCIAL_WATERMARK_CORNERS,
  'crove_social.chat_alert.kind': SOCIAL_CHAT_ALERT_TARGETS,
  'crove_social.channel_option.error': SOCIAL_CHANNEL_OPTION_ERRORS,
  'crove_social.channel_option.kind': SOCIAL_CHANNEL_OPTION_KINDS,
  'crove_social.channel_option.status': SOCIAL_CHANNEL_OPTION_STATUSES,
  'crove_social.label.color': SOCIAL_LABEL_COLORS,
  'crove_social.media_attribution.provider': SOCIAL_MEDIA_ATTRIBUTION_PROVIDERS,
  'crove_social.post.actor_origin': SOCIAL_ACTOR_ORIGINS,
  'crove_social.post.origin': SOCIAL_ORIGINS,
  'crove_social.post.status': SOCIAL_POST_STATUSES,
  'crove_social.post_approval.actor_origin': SOCIAL_ACTOR_ORIGINS,
  'crove_social.post_approval.decision': SOCIAL_DECISIONS,
  'crove_social.post_comment.suggest_field': SOCIAL_SUGGEST_FIELDS,
  'crove_social.post_comment.suggest_state': SOCIAL_SUGGEST_STATES,
  'crove_social.review_feedback.verdict': SOCIAL_REVIEW_VERDICTS,
  'crove_social.review_link.kind': SOCIAL_REVIEW_LINK_KINDS,
  'crove_social.account_snapshot.error': SOCIAL_ACCOUNT_SNAPSHOT_ERRORS,
  'crove_social.external_import.error': SOCIAL_ACCOUNT_SNAPSHOT_ERRORS,
  'crove_social.link_preview.status': SOCIAL_LINK_PREVIEW_STATUSES,
  'crove_social.link_preview.error': SOCIAL_LINK_PREVIEW_ERRORS,
  'crove_social.notification.kind': SOCIAL_NOTIFICATION_KINDS,
  'crove_social.notification_mute.kind': SOCIAL_NOTIFICATION_KINDS,
  'crove_social.post_variant.edit_state': SOCIAL_EDIT_STATES,
  'crove_social.post_variant.error_kind': SOCIAL_ERROR_KINDS,
  'crove_social.post_variant.status': SOCIAL_VARIANT_STATUSES,
});

interface Constraint {
  table: string;
  column: string;
  name: string;
  definition: string;
}

const LITERAL = /'((?:[^']|'')*)'::text/g;
const literals = (list: string): string[] | null => {
  const values = [...list.matchAll(LITERAL)].map((m) => (m[1] as string).replaceAll("''", "'"));
  // The list must be nothing but those literals, so a cast or an expression in it is not silently dropped.
  return list === values.map((v) => `'${v.replaceAll("'", "''")}'::text`).join(', ') ? values : null;
};

// The fixed set a single-column CHECK restricts its column to, or null when it is not of that form. Returns
// 'unreadable' for one that looks like a set (= ANY, IN) but has a shape this parser does not know, so the test fails
// instead of skipping it.
function allowedValues(column: string, definition: string): string[] | null | 'unreadable' {
  const col = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shapes = [
    new RegExp(`^CHECK \\(\\(${col} = ANY \\(ARRAY\\[(.*)\\]\\)\\)\\)$`),
    new RegExp(`^CHECK \\(\\(\\(${col} IS NULL\\) OR \\(${col} = ANY \\(ARRAY\\[(.*)\\]\\)\\)\\)\\)$`),
    new RegExp(`^CHECK \\(\\(${col} = ('(?:[^']|'')*'::text)\\)\\)$`),
  ];
  for (const shape of shapes) {
    const list = shape.exec(definition)?.[1];
    if (list !== undefined) return literals(list) ?? 'unreadable';
  }
  // A set written another way (an OR chain of equalities, IN) still compares the column with a literal.
  // The column itself (`s = '`, `(s)::text = '`), not a function of it (`jsonb_typeof(s) = '`).
  const literalCompare = new RegExp(`(?<!\\w)(?:${col}|\\(${col}\\)::[\\w ]+) = '`);
  return /= ANY \(|\bIN \(/.test(definition) || literalCompare.test(definition) ? 'unreadable' : null;
}

// The origin set of the mark's compound CHECK, or null when the definition is not that shape: `actor_origin` is one of a fixed set, and `mcp` only on a tainted row.
const MARK_CHECK = /^CHECK \(\(\(actor_origin = ANY \(ARRAY\[(.*)\]\)\) AND \(\(actor_origin <> 'mcp'::text\) OR tainted\)\)\)$/;
function markOrigins(definition: string): string[] | null {
  const list = MARK_CHECK.exec(definition)?.[1];
  return list === undefined ? null : literals(list);
}

suite('CHECK-constraint unions of schema.ts against the database', () => {
  const dbName = `crove_test_check_unions_${Date.now()}_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let created = false;
  let constraints: Constraint[] = [];
  // The mark's compound CHECK (`mcp_origin_ck`: the origin is a fixed set, and `mcp` only with `tainted`) of the tables that carry both columns; it reads two columns, so the query above, which keeps single-column CHECKs, does not see it.
  let marks: { table: string; definition: string }[] = [];

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    await migrate({ adminUrl: url.toString(), dir: MIGRATIONS });
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // Single-column CHECK constraints of the tables in the generated Database (those ludy_tenant may read).
      const { rows } = await client.query<Constraint>(
        `SELECT n.nspname || '.' || c.relname AS table, a.attname AS column, con.conname AS name,
                pg_catalog.pg_get_constraintdef(con.oid) AS definition
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
          WHERE con.contype = 'c' AND pg_catalog.cardinality(con.conkey) = 1 AND n.nspname = ANY($1)
            AND pg_catalog.has_table_privilege('ludy_tenant', c.oid, 'SELECT')
          ORDER BY 1, 2, 3`,
        [SCHEMAS],
      );
      constraints = rows;
      const compound = await client.query<{ table: string; definition: string }>(
        `SELECT n.nspname || '.' || c.relname AS table, pg_catalog.pg_get_constraintdef(con.oid) AS definition
           FROM pg_catalog.pg_constraint con
           JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE con.contype = 'c' AND con.conname = 'mcp_origin_ck' AND pg_catalog.cardinality(con.conkey) = 2 AND n.nspname = ANY($1)
          ORDER BY 1`,
        [SCHEMAS],
      );
      marks = compound.rows;
    } finally {
      await client.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('reads the fixed sets the migrations declare', () => {
    // A guard against a query or parser that finds nothing and so compares nothing.
    const sets = constraints.filter((c) => Array.isArray(allowedValues(c.column, c.definition)));
    expect(sets.length).toBeGreaterThanOrEqual(Object.keys(UNIONS).length);
  });

  it('every fixed set matches the union schema.ts refines its column to', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const c of constraints) {
      const values = allowedValues(c.column, c.definition);
      if (values === null) continue;
      const key = `${c.table}.${c.column}`;
      if (values === 'unreadable') {
        problems.push(`${key}: cannot read the allowed values of ${c.name} (${c.definition}); teach allowedValues() its shape`);
        continue;
      }
      seen.add(key);
      const union = UNIONS[key];
      if (!union) {
        problems.push(
          `${key}: ${c.name} allows [${values.join(', ')}] but schema.ts refines no union for the column ` +
            '(add a const array, refine the column with it and list it in UNIONS)',
        );
        continue;
      }
      const db = [...values].sort();
      const ts = [...union].sort();
      if (db.join('\u0000') !== ts.join('\u0000')) {
        problems.push(`${key}: the database (${c.name}) allows [${db.join(', ')}], schema.ts has [${ts.join(', ')}]`);
      }
    }
    for (const key of Object.keys(UNIONS)) {
      if (!seen.has(key)) problems.push(`${key}: listed in UNIONS but the database has no CHECK constraint with a fixed set on it`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  // The tables schema.ts refines `actor_origin` on beside the activity row (whose CHECK has the origin alone and is compared above): their CHECK also ties `mcp` to a tainted row.
  it('the mark\'s compound CHECK is on each of the five tables, and its origins are the ACTOR_ORIGINS schema.ts refines the column to', () => {
    const problems: string[] = [];
    for (const table of ['crove_crm.deal', 'crove_crm.quote', 'crove_crm.quote_line', 'ludy_kernel.conversation_note', 'ludy_kernel.party']) {
      const found = marks.find((m) => m.table === table);
      if (!found) {
        problems.push(`${table}: no two-column mcp_origin_ck CHECK (the migration of the mark adds it)`);
        continue;
      }
      const origins = markOrigins(found.definition);
      if (origins === null) problems.push(`${table}: cannot read mcp_origin_ck (${found.definition}); teach markOrigins() its shape`);
      else if ([...origins].sort().join('\u0000') !== [...ACTOR_ORIGINS].sort().join('\u0000')) problems.push(`${table}: the database allows [${origins.join(', ')}], schema.ts has [${ACTOR_ORIGINS.join(', ')}]`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

});

describe('the mark\'s compound CHECK (actor_origin, tainted)', () => {
  it('reads the shape PostgreSQL stores and refuses the ones it does not know', () => {
    expect(markOrigins("CHECK (((actor_origin = ANY (ARRAY['ui'::text, 'mcp'::text])) AND ((actor_origin <> 'mcp'::text) OR tainted)))")).toEqual(['ui', 'mcp']);
    expect(markOrigins("CHECK (((actor_origin = ANY (ARRAY['ui'::text, 'mcp'::text])) AND (actor_origin <> 'x'::text)))")).toBeNull();
    expect(markOrigins("CHECK ((actor_origin = ANY (ARRAY['ui'::text, 'mcp'::text])))")).toBeNull();
  });
});

describe('allowedValues', () => {
  it('reads the shapes PostgreSQL stores and refuses the ones it does not know', () => {
    expect(allowedValues('status', "CHECK ((status = ANY (ARRAY['a'::text, 'b''c'::text])))")).toEqual(['a', "b'c"]);
    expect(allowedValues('method', "CHECK (((method IS NULL) OR (method = ANY (ARRAY['x'::text]))))")).toEqual(['x']);
    expect(allowedValues('kind', "CHECK ((kind = 'only'::text))")).toEqual(['only']);
    expect(allowedValues('line_no', 'CHECK ((line_no > 0))')).toBeNull();
    expect(allowedValues('s', "CHECK (((s)::text = ANY ((ARRAY['a'::character varying])::text[])))")).toBe('unreadable');
    expect(allowedValues('s', "CHECK ((s = ANY (ARRAY['a'::text, lower('B'::text)])))")).toBe('unreadable');
    expect(allowedValues('s', "CHECK (((s = 'a'::text) OR (s = 'b'::text)))")).toBe('unreadable');
    expect(allowedValues('reasons', "CHECK ((jsonb_typeof(reasons) = 'array'::text))")).toBeNull();
  });
});
