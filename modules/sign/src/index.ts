// SPDX-License-Identifier: AGPL-3.0-only
// Public entrypoint of @ludy/mod-sign (#3323).
export {
  DEFAULT_OTP_RETENTION_HOURS,
  DEFAULT_RETENTION_DAYS,
  signCommands,
  type IssuedSigningLink,
} from './commands.ts';
export {
  SIGN_EVENT_TYPES,
  appendSigningEvent,
  canonicalJson,
  computeSigningEventHash,
  parseEventPayload,
  sha256Hex,
  verifyEventChain,
  type AppendSigningEventInput,
  type AppendedSigningEvent,
  type SignEventType,
  type SigningEventChainRow,
  type SigningEventHashInput,
  type VerifyEventChainResult,
} from './events.ts';
export { signManifest } from './manifest.ts';
export {
  applyEnvelopeVisibilityFilter,
  assertCanAccessEnvelopeRow,
  assertCanCreateEnvelopeForSource,
  canAccessEnvelopeRow,
  isHrPrivilegedRole,
  type HrEnvelopeVisibilityCtx,
  type HrEnvelopeVisibilityRow,
} from './hr-visibility.ts';
export {
  applyMeetingMinutesVisibilityFilter,
  assertCanAccessMeetingMinutesEnvelopeRow,
  assertCanCreateMeetingMinutesEnvelope,
  canAccessMeetingMinutesEnvelopeRow,
  type MeetingEnvelopeVisibilityCtx,
  type MeetingEnvelopeVisibilityRow,
} from './meeting-visibility.ts';
export { validateSignaturePngBase64, type ValidatedSignaturePng } from './png.ts';
export { signDirectPublicCommands } from './direct-public.ts';
export {
  cleanUserAgent as sanitizeSignUserAgent,
  normalizePageDimensions as normalizeSignPageDimensions,
} from './public-commands.ts';
export {
  signAcceptanceAiStatus,
  signAcceptanceQueries,
  signAcceptanceSource,
  type SignAcceptanceAiStatus,
  type SignAcceptanceSource,
  type SignAcceptanceSourceTask,
} from './acceptance.ts';
export { parseSharedSummary, sanitizeSharedSummaryForWrite } from './shared.ts';
export { signQueries, type SignDiffSourceResult, type SignInspectJobData, type SignSealJobData } from './queries.ts';
export {
  computeSignVersionDiff,
  splitPageIntoClauses,
  type SignDiffPageText,
} from './version-diff.ts';
export {
  STARTER_CONTRACT_TEMPLATES,
  buildStarterContractClauses,
  buildStarterContractFilename,
  buildStarterContractTitle,
  formatContractDecimalAmount,
  neutralizeContractInputText,
  renderStarterContractPdf,
  type RenderedStarterContractPdf,
  type StarterTemplateMeta,
} from './contract-drafter.ts';
export {
  assertSignCaProviderAllowed,
  isSignCaBrokerAvailable,
  isSignLiveCaEnabled,
  setSignCaBrokerAvailable,
  setSignLiveCaEnabled,
  signCaCommands,
  signCaQueries,
  type SealedCaConnectionSecret,
  type SignCaJobBeginResult,
  type SignCaJobRecordResult,
} from './ca.ts';
export {
  signProfileCommands,
  signProfileQueries,
} from './profiles.ts';
export {
  foldVaultSearchText,
  parseSignVaultQuery,
  scoreSignVaultCandidates,
  signVaultQueries,
  vaultSearch,
  type ParsedVaultQuery,
  type SignVaultCandidateInput,
} from './vault.ts';
export {
  signTemplateCommands,
  signTemplateQueries,
  type SignTemplateInspectJobData,
} from './templates.ts';
export { signInPersonCommands, signerStartInPerson } from './in-person.ts';
export {
  OBLIGATION_DUE_SOON_DAYS,
  RENEWAL_NOTICE_ALERT_WINDOW_DAYS,
  addDaysIso,
  dayEpochDays,
  parseContractValueDecimal,
  signObligationCommands,
  signObligationQueries,
  signObligationsToday,
  signObligationsTodayItemsOf,
  summarizeObligationUrgency,
  validateIsoCalendarDate,
  type SignObligationSource,
  type SignObligationTodayRow,
} from './obligations.ts';
export {
  clampAiBox,
  sanitizeSignAiProposals,
  signAiCommands,
  signAiQueries,
  signerRoleKeyOf,
  type SanitizedAiAnalysisInput,
  type SignAiAnalysisRecord,
  type SignAiClauseSeverity,
  type SignAiDeclaredSigner,
  type SignAiExtractedPage,
  type SignAiProposedField,
  type SignAiRiskClause,
  type SignAiSource,
} from './ai.ts';
export {
  SIGN_COMPLETED_MAIL_SOURCE,
  SIGN_COMPLETED_MAIL_TEMPLATE,
  SIGN_CORRECT_INVITE_MAIL_SOURCE,
  SIGN_DELEGATED_MAIL_TEMPLATE,
  SIGN_DELEGATE_MAIL_SOURCE,
  SIGN_DIRECT_OTP_MAIL_SOURCE,
  SIGN_DIRECT_OTP_MAIL_TEMPLATE,
  SIGN_INVITE_MAIL_SOURCE,
  SIGN_INVITE_MAIL_TEMPLATE,
  SIGN_OTP_MAIL_SOURCE,
  SIGN_OTP_MAIL_TEMPLATE,
  SIGN_PRE_EXPIRY_REMIND_MAIL_SOURCE,
  SIGN_REMIND_MAIL_SOURCE,
  SIGN_REMIND_MAIL_TEMPLATE,
  renderSignCompletedMail,
  renderSignDelegatedMail,
  renderSignDirectOtpMail,
  renderSignInviteMail,
  renderSignOtpMail,
  zSignCompletedMailPayload,
  zSignDelegatedMailPayload,
  zSignDirectOtpMailPayload,
  zSignInviteMailPayload,
  zSignOtpMailPayload,
  type RenderedSignMail,
} from './sign-mail.ts';
export {
  buildCanonicalCertificateArtifact,
  buildPdfSealCertificate,
  buildPdfSealFields,
  buildPdfSealInputBytes,
  buildPdfSealSigners,
  generateCertificateCode,
  generateRawSigningToken,
  hashSigningToken,
  maskEmail,
  type CanonicalCertificateArtifactInput,
  type CanonicalCertificateEvent,
  type SignFieldForSeal,
  type SignSignerForSeal,
} from './sealing.ts';
export {
  SIGN_ACTIVE_VIEW_GRACE_MINUTES,
  SIGN_PRE_EXPIRY_REMIND_HOURS,
  SIGN_TODAY_DECLINED_DAYS,
  SIGN_TODAY_EXPIRING_HOURS,
  selectPreExpiryEligibleSigners,
  signTodayItemsOf,
  type SignPreExpirySignerCandidate,
  type SignPreExpirySweepResult,
  type SignTodayEnvelopeRow,
} from './today-and-reminders.ts';
export {
  WEBHOOK_DELIVERY_ENQUEUE_WRITE,
  enqueueSignWebhookEvent,
  isSignWebhookBrokerAvailable,
  setSignWebhookBrokerAvailable,
  signWebhookCommands,
  signWebhookQueries,
} from './webhooks.ts';
export {
  DEFAULT_VIETNAM_SME_PLAYBOOK_RULES,
  SIGN_MAX_PLAYBOOK_RULES,
  computePlaybookCheckRevision,
  computePlaybookRuleRevision,
  defaultSlotForRuleId,
  deterministicPlaybookRuleId,
  evaluatePlaybookDeterministically,
  signPlaybookCommands,
  signPlaybookQueries,
  zPlaybookRecordCheckInput,
  type DefaultPlaybookRuleSlot,
  type DefaultVietnamSmePlaybookRuleSpec,
  type SignPlaybookExtractedPage,
  type SignPlaybookRuleEffective,
  type SignPlaybookSource,
  type SignPlaybookSourceRule,
} from './playbook.ts';
export {
  detectKycDocumentKind,
  evaluateDeterministicKycAttachment,
  extractVietnamNationalIds,
  extractVietnamTaxCodes,
  normalizeFoldedVi,
  signKycCommands,
  signKycConfirm,
  signKycInspectComplete,
  signKycInspectJobData,
  signKycList,
  signKycProposeAi,
  signKycQueries,
  signKycRunDeterministic,
  signKycSource,
  type DeterministicKycEvalInput,
  type DeterministicKycEvalResult,
  type SignKycInspectJobData,
  type SignKycSource,
} from './kyc.ts';
