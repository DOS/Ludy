import { oc } from '@orpc/contract';
import { zMinutesLinkCreate, zMinutesLinkCreated, zMinutesLinkItems, zMinutesLinkList, zMinutesLinkRevoke, zMinutesLinkRevoked, zMinutesLinkSwitch, zMinutesLinkSwitchGet } from './meeting-minutes-link.ts';
import { z } from 'zod';
import { zSpeakingStyle, zSpeakingStyleInput } from './meeting-speaking-style.ts';
import { zTranscriptExport, zTranscriptExportInput } from './meeting-transcript-export.ts';
import { zSalesInsightAnswer, zSalesInsightStatus } from './meeting-sales-insight.ts';
import { ORG_KINDS } from './apps.ts';
import { zChapters, zChaptersCopied, zChaptersCopy, zChaptersSave, zChaptersSaved } from './meeting-chapters.ts';
import {
  zBulkApproveItems,
  SOCIAL_REVIEW_CHECKS_MAX,
  zAccount,
  zBankPartyRule,
  zCategorizationRule,
  zAgentBudget,
  zAiMeter,
  zAiUsageReport,
  zAgentRisk,
  zAgentRoleKey,
  zAgentScope,
  zAgentStatus,
  zAgentTemplate,
  zAiAmount,
  zChart,
  zClientOverviews,
  zOrgOverview,
  zJobDescription,
  zPositionLeScope,
  zModuleId,
  zPositionStatus,
  zTask,
  zTaskChecklist,
  zTaskDetail,
  zTaskStatus,
  zAccountCode,
  zChannelConnection,
  zOAuthProvider,
  zOAuthState,
  zSocialBulkAddChannel,
  zSocialBulkArchive,
  zSocialPostArchive,
  zSocialPostArchived,
  zSocialBulkAddChannelResult,
  zSocialBulkAssign,
  zSocialBulkLabels,
  zSocialBulkReplace,
  zSocialBulkReplacePreview,
  zSocialBulkResult,
  channelsOrSet,
  zSocialDraftsFromMediaFields,
  zSocialDraftsFromMediaResult,
  zSocialPostDuplicate,
  zSocialPostDuplicateResult,
  zSocialDecide,
  zSocialPost,
  zSocialRecurrence,
  zSocialTextVariations,
  zSocialReviewDiff,
  zSocialPreReview,
  zSocialPostVersions,
  zSocialPostCreate,
  zSocialPostUpdate,
  zSocialQueue,
  zSocialQueueOpenSlots,
  zSocialQueueOpenSlotsInput,
  zSocialMetricsRow,
  zSocialExternalPost,
  zSocialPlanRow,
  zSocialMediaResolve,
  zSocialMediaInput,
  zSocialMediaResolved,
  zSocialMediaFetchUrls,
  zSocialMediaFetched,
  zSocialTeamReport,
  zSocialWindowTotals,
  zSocialChannelInsights,
  zSocialBioPage,
  zSocialBioSave,
  zSocialFeed,
  zSocialIdea,
  zSocialIdeaCreate,
  zSocialIdeaUpdate,
  zSocialLibraryItem,
  zSocialLibraryUse,
  zSocialMediaArchive,
  zSocialMediaTagCount,
  zSocialStockResults,
  zSocialStockSave,
  zSocialStockSaved,
  zSocialStockSearch,
  zSocialReportLink,
  zSocialReportSchedule,
  zSocialReportScheduleSave,
  zSocialReportLinkCreate,
  zSocialGoals,
  zSocialGoalSet,
  zSocialLinkPreview,
  zSocialChannelOptions,
  zSocialNotificationKind,
  zSocialNotifications,
  zSocialAccountTrend,
  zSocialSnippet,
  zSocialSnippetCreate,
  zSocialBannedWord,
  zSocialBannedWordAdd,
  zSocialReviewCheck,
  zSocialReviewChecklistSet,
  zSocialChannelAccess,
  zSocialChannelAccessSet,
  zSocialSnippetUpdate,
  zSocialReportBrand,
  zSocialReportBrandingSave,
  zSocialLabel,
  zSocialLabelCreate,
  zSocialLabelUpdate,
  zSocialReviewLinks,
  zSocialReviewReply,
  zSocialReviewReplyInput,
  zSocialReviewPlanCreate,
  zSocialReviewPlanLink,
  zSocialActivityItem,
  zSocialCommentResolved,
  zSocialCommentPin,
  zSocialSuggestion,
  zSocialSuggestionDecided,
  zSocialQueueSet,
  zSocialQueueShuffle,
  zSocialQueueMoveToFront,
  zSocialQueueReorder,
  zSocialSchedule,
  zSocialVariantUpdate,
  zSocialChannelInput,
  SOCIAL_LABEL_COLORS,
  SOCIAL_WATERMARK_CORNERS,
  SOCIAL_CHAT_ALERT_KINDS,
  SOCIAL_CHAT_ALERT_TARGETS,
  SOCIAL_POST_STATUSES,
  SOCIAL_VARIANT_STATUSES,
  MAX_BATCH_FILES,
  zBatchFile,
  zFileStatus,
  zId,
  zInboxDetail,
  zInboxItem,
  zInvite,
  zInviteCreated,
  zInvitePreview,
  zInviteRole,
  zInviteLegalEntityIds,
  zInviteToken,
  zJournalEntry,
  zJournalReversal,
  zLocalDate,
  zMe,
  zOrgAppSet,
  zOrgAppSetResult,
  zOrgApps,
  zOrgDetail,
  zOrgExport,
  zOrgSummary,
  zParty,
  zCustomerCursor,
  zCustomerPage,
  zDuplicateHint,
  zProposalStatus,
  zPurchaseDocument,
  zDocumentExport,
  zSearchResult,
  zNotificationKind,
  zNotifications,
  zPushStatus,
  zPushSubscribe,
  zRaisedInboxItems,
  zOriginalNeededItems,
  zRole,
  zSession,
  zSessionRevoke,
  zVatPeriod,
  zVatFilingPeriod,
  zVatReport,
  zSalesNumberGaps,
  zExchangeRate,
  zInputVatCheckOutcome,
  zVatReturnMark,
  zAccountLedger,
  zFinancialStatements,
  zLedgerPeriod,
  zLedgerReport,
  zLegalEntityChoice,
  zPeriodLockInput,
  zPeriodLockState,
  zArchiveYear,
  zYearArchive,
  zYearArchives,
  zPeriodUnlockInput,
  zTaxRegistryEntry,
  zVoucherType,
  zSocialMemberFilter,
  zSocialSavedView,
  zSocialSavedViewSave,
} from './schemas.ts';
import { zMarketplaceVatRateSet, zMarketplaceVatRates, zMarketplaceVatRatesGet } from './marketplace-vat-rate.ts';
import { zMarketplaceAuthorizeReturn, zMarketplaceAuthorizeStarted, zMarketplaceConnect, zMarketplaceConnection, zMarketplaceConnectionTestAnswer, zMarketplaceProviders, zMarketplacePushHookCreated, zMarketplacePushHookSet, zMarketplacePushHookStatus } from './marketplace-connections.ts';
import { zMisaAmisConnect, zMisaAmisConnection, zMisaAmisDefaultItem, zMisaAmisStatus, zMisaAmisUnitAlias, zMisaAmisUnitRow, zMisaAmisUnitsAsk } from './misa-amis-connections.ts';
import { zMisaAmisMatchCheckQueued, zMisaAmisNameDecided, zMisaAmisNameDecision, zMisaAmisNameProposal, zMisaAmisNameProposalsAsk } from './misa-amis-match.ts';
import { zMisaAmisPushConfirm, zMisaAmisPushConfirmed, zMisaAmisPushListAsk, zMisaAmisPushResolveAsk, zMisaAmisPushRow } from './misa-amis-push.ts';
import { zMisaCheck, zMisaCheckAsk, zMisaCheckLine, zMisaCheckLineAsk } from './misa-check.ts';
import { zMisaAmisPreview, zMisaAmisBlockerNotes, zMisaAmisBlockerNotesAsk, zMisaAmisPreviewAsk } from './misa-amis-preview.ts';
import { zMarketplaceColumnsCheckAsk, zMarketplaceColumnsCheckQueued, zMarketplaceColumnsFile, zMarketplaceColumnsProposal, zMarketplaceColumnsProposalAsk, zMarketplaceColumnsStatus } from './marketplace-columns.ts';
import { zMarketplaceColumnProfile, zMarketplaceColumnProfileQuery, zMarketplaceColumnsConfirm, zMarketplaceColumnsConfirmed } from './marketplace-column-profile.ts';
import { zMarketplaceBalance, zMarketplaceBalanceInput, zMarketplaceFacts, zMarketplaceFeeNotes, zMarketplaceFeeNotesAsk, zMarketplaceProposalNoteAsk, zMarketplaceProposalNote, zMarketplaceLine, zMarketplaceLineAsk, zMarketplaceWorklist } from './marketplace-balance.ts';
import { zMarketplaceAssign, zMarketplaceConfirmResult, zMarketplaceReturnDecide, zMarketplaceReturnDecided, zMarketplaceFeeClearingRequest, zMarketplaceIncomeConfirmResult, zMarketplaceIncomePreview, zMarketplaceIncomeStaged, zMarketplaceOrder, zMarketplaceOrdersInput, zMarketplacePayoutRequest, zMarketplacePreview, zMarketplaceSettlementRequest, zMarketplaceStaged, zMarketplaceSuggested, zMarketplaceSuggestInput, zMarketplaceUnassign, zMarketplaceUnassignedInput, zMarketplaceUnassignedLine } from './marketplace.ts';
import { zStockAliasTeach, zStockAssign, zStockCard, zStockCardInput, zStockCloseCheck, zStockCloseEmptyResult, zStockCloseRequest, zStockCount, zStockCountCreate, zStockCountIdInput, zStockCountListInput, zStockCountPreviewInput, zStockCountPreviewRow, zStockItem, zStockItemInput, zStockLowInput, zStockLowItem, zStockMove, zStockMoveReturn, zStockPeriod, zStockPeriodsInput, zStockReorderAsk, zStockReorderDraft, zStockReportInput, zStockReportRow, zStockSuggested, zStockSuggestInput, zStockSurplusNote, zStockSurplusNoteInput, zStockUnassignedInput, zStockUnassignedLine } from './stock.ts';
import { zSupplierBankAccount, zSupplierBankAccountAdd, zSupplierBankAccountErase, zSupplierBankAccountErased, zSupplierBankAccountList, zSupplierBankAccountListInput, zSupplierBankAccountReplace, zSupplierBankAccountRetire } from './supplier-bank.ts';
import { zBankSupplierMatch, zSupplierPayableLine, zSupplierPayableLineAsk, zSupplierPayableList, zSupplierPayment, zSupplierPaymentCancel, zSupplierPaymentConfirm, zSupplierPaymentList, zSupplierPaymentListInput, zSupplierPaymentPrepare, zSupplierPaymentSettlePrepare } from './supplier-payment.ts';
import { zEInvoiceNotice, zEInvoiceNoticeList, zEInvoiceNoticeListInput, zEInvoiceNoticeOpen, zEInvoiceNoticeStep } from './einvoice-notice.ts';
import { zEInvoiceConnect, zEInvoiceConnection, zEInvoiceConnectionTested, zEInvoiceCorrectionOptions, zEInvoiceCorrectionRateExplained, zEInvoiceCorrectionRateInput, zEInvoiceReasonInput, zEInvoiceReasonSuggested, zEInvoiceDraft, zEInvoiceDraftCheck, zEInvoiceDraftCheckInput, zEInvoiceDraftSave, zEInvoiceDraftSummary, zEInvoiceIssueView, zEInvoicePrevious, zEInvoicePreviousInput, zEInvoiceProviderInfo, zEInvoiceSeries, zEInvoiceSeriesSetDefault, zEInvoiceSeriesSync, zEInvoiceSeriesSynced, zEInvoiceStartCorrection, zEInvoiceStatus, zEInvoiceSuggested, zEInvoiceSuggestInput } from './einvoice.ts';
import { zCollectionSetting, zCustomerCollection, zCustomerCollectionSet, zPaymentReminderDraft, zPaymentReminderList, zPaymentReminderSend, zPaymentReminderSent, zPaymentReminderWording, zPaymentReminderWordingAsk } from './payment-reminder.ts';
import { zContactList, zContactPage, zPartyCreate, zPartyKind } from './contacts.ts';
import { zCompanySuggest, zCompanySuggested } from './contact-company.ts';
import { zVatLateExplainAsk, zVatLateExplanation } from './vat-late.ts';
import { zCashForecast, zCashForecastExplanation, zFinanceCashForecastExplainAsk, zFinanceCashForecastInput } from './finance-cash-forecast.ts';
import { zFinanceOverview, zFinanceOverviewExplainAsk, zFinanceOverviewInput, zOverviewExplanation } from './finance-overview.ts';
import { zFinanceMonthCloseExplainAsk, zFinanceMonthCloseInput, zMonthClose, zMonthCloseNote } from './finance-month-close.ts';
import { zExpenseVarianceExplanation, zFinanceExpenseVariance, zFinanceExpenseVarianceExplainAsk, zFinanceExpenseVarianceInput } from './finance-expense-variance.ts';
import { zImportBatch, zImportCommit, zImportCommitted, zImportPreview, zImportPreviewQuery, zImportRef, zImportStage } from './contact-import.ts';
import { zFilterAstShape, zSavedView, zSavedViewDelete, zSavedViewList, zSavedViewRename, zSavedViewSaveShape, zSavedViewSetShared, zSavedViewSortShape } from './saved-view.ts';
import {
  zConversationAssign,
  zConversationCounted,
  zConversationCounts,
  zConversationPostCounted,
  zConversationPostCounts,
  zConversationDetail,
  zConversationGet,
  zConversationHide,
  zConversationId,
  zConversationLinkContact,
  zConversationIntent,
  zConversationSetIntent,
  zConversationIntentSuggest,
  zConversationIntentSuggested,
  zConversationContactMatches,
  zConversationContactMatched,
  zConversationList,
  zConversationListed,
  zConversationMarkRead,
  zConversationComposing,
  zConversationComposed,
  zAvailability,
  zAvailabilityEntry,
  zAvailabilitySet,
  zConversationNoteAdd,
  zConversationFollowUp,
  zConversationFollowedUp,
  zConversationTaskList,
  zConversationPrivateReplied,
  zConversationPrivateReply,
  zConversationReplied,
  zConversationReply,
  zConversationRetention,
  zConversationRetentionSet,
  zConversationEraseContact,
  zConversationEraseChannel,
  zConversationChannelErased,
  zConversationChannelCounts,
  zConversationErased,
  zConversationSandboxComment,
  zConversationSandboxQueued,
  zConversationSettle,
  zConversationAutoDraft,
  zConversationAutoDraftSet,
  zYoutubeCommentsSet,
  zYoutubeCommentsStatusList,
  zConversationDraftDiscard,
  zConversationDraftRequest,
  zConversationOther,
  zSavedReplyId,
  zSavedReplyInput,
  zSavedReplyList,
  zSavedReplyListed,
  zSavedReplyUpdate,
  zConversationAddress,
} from './conversations.ts';
import { zEngageWakeRules, zEngageWakeRulesView } from './engage-wake.ts';
import { zCashVoucherPage, zCashVoucherRequest, zVoucherCursor } from './cash-voucher.ts';
import { zDepreciationRequest, zJournalVoucherRequest, zSurplusResolutionRequest, zYearClosingRequest } from './journal-voucher.ts';
import { zFixedAsset, zFixedAssetCreate, zFixedAssetEnd } from './fixed-asset.ts';
import { zStatementsHtkkCheck, zStatementsHtkkYear } from './statements-htkk.ts';
import { zTaxObligationMark, zTaxProfile } from './tax-calendar.ts';
import { zSinceYesterday, zTodayBrief, zTodayBriefInput, zTodayList, zTodayMailSet, zTodayMailSetting, zTodayWeekly, zTodayWeeklyInput } from './today.ts';
import { zHomeLayoutSaveInput, zHomeLayoutView } from './home-layout.ts';
import { zBookEntity, zLegalEntity, zLegalEntityInput } from './legal-entity.ts';
import { zBuiltinRoleKey, zMemberRoles, zRoleAssignInput } from './roles.ts';
import { zMeetingPlatformConnectProvider, zMeetingPlatformConnectionRef, zMeetingPlatformConnectionView, zMeetingPlatformRecordingPick, zMeetingPlatformRecordingRef, zMeetingPlatformRecordingView } from './meeting-platform.ts';
import { zCalendarConnectionView, zCalendarEventAdd, zCalendarEventCancel, zCalendarEventView, zCalendarRange, zCalendarSlot, zCalendarSlotsQuery, zCalendarOAuthProvider, zMyCalendar, zWorkingHours } from './calendar.ts';
import { zEInvoiceDraftFromOrder, zOrderLineInvoiceStates, zOrderLineInvoiceStatesInput, zStockMoveFromOrderLine, zStockMoveFromOrderLineResult } from './finance-orders.ts';
import { zQuoteAccept, zQuoteDecided, zQuoteDecline, zSalesOrder, zSalesOrderCancel, zSalesOrderDeliver, zSalesOrderDeliveryChanged, zSalesOrderHandoff, zSalesOrderListQuery, zSalesOrderPage, zSalesOrderRef, zSalesOrderSummary, zSalesOrderUndeliver } from './crm-sales-orders.ts';
import { zFollowupDraftInput, zFollowupDrafted } from './crm-followup.ts';
import { zMeetingBrief, zMeetingBriefInput } from './crm-meeting-brief.ts';
import { zDealQuotesQuery, zQuote, zQuoteDefaults, zQuoteDefaultsQuery, zQuoteDeleted, zQuoteReport, zQuoteReportQuery, zQuoteLinkCreated, zQuoteLinkRevoke, zQuoteLinkRevoked, zQuoteListQuery, zQuotePage, zQuoteRef, zQuoteSave, zQuoteSend, zQuoteSent, zQuoteLogoSet, zQuoteSetting, zQuoteSettingSet, zQuoteSuggestInput, zQuoteSuggested, zQuoteSummary } from './crm-quotes.ts';
import { zBoard, zBoardQuery, zDeal, zDealCreate, zDealDeleted, zDealListQuery, zDealMove, zDealPage, zDealRef, zDealSetting, zDealSettingSet, zDealUpdate, zNextStepChanged, zNextStepDone, zNextStepListQuery, zNextStepPage, zNextStepSnooze, zPartyChoice, zPartyDealsQuery, zPartySearchQuery, zPipelineStage, zStageAdd, zStageRemove, zStageRename, zStageReorder } from './crm-deals.ts';
import { zBookingCancel, zBookingDealChanged, zBookingDealLink, zBookingDealUnlink, zBookingItem, zBookingListQuery, zBookingMove, zBookingSuggestInput, zBookingSuggestion, zEventType, zEventTypeInput, zEventTypeSetActive, zEventTypeUpdate, zDealBookings, zDealBookingsQuery } from './crm.ts';
import {
  zHrDepartmentAdd,
  zHrDepartmentEdit,
  zHrDepartmentList,
  zHrDepartmentRef,
  zHrDepartmentSetManager,
  zHrDepartmentView,
  zHrDepartmentWritten,
  zHrDependentAdd,
  zHrDependentEnd,
  zHrEmployee,
  zHrEmployeeAdd,
  zHrEmployeeContractPdf,
  zHrEmployeeContractPdfAsk,
  zHrEmployeeEdit,
  zHrFinalizationSet,
  zHrEmployeeEnd,
  zHrEmployeeErased,
  zHrEmployeeJobLossAsk,
  zHrEmployeeJobLossResult,
  zHrEmployeeLinkMember,
  zHrEmployeeList,
  zHrEmployeeRef,
  zHrEmployeeSeveranceAsk,
  zHrEmployeeSeveranceResult,
  zHrEmployeeSummary,
  zHrEmploymentAdd,
  zHrWritten,
} from './hr.ts';
import { zPayrollSettlement, zPayrollSettlementRef, zHrCoworkerAsk, zHrCoworkerExplained, zHrCoworkerFlagged, zHrCoworkerPayslipAsk, zHrCoworkerPrepared, zHrLineAdjust, zHrLineInputsSet, zHrPayrollDiffExplainAsk, zHrPayrollDiffExplained, zHrPayrollPreviewDiff, zHrPayrollPreviewDiffAsk, zHrPayslip, zHrPaymentRequest, zHrPostingRequest, zHrPayslipRef, zHrRunApplyThirteenthMonth, zHrRunApprove, zHrRunImportTimekeeping, zHrRunList, zHrRunOpen, zHrRunRecalculate, zHrRunRef, zHrRunSheet, zHrRunSummary, zHrRunSyncStage6b, zHrRunThirteenthMonthPreview, zHrRunWritten, zHrThirteenthMonthPreviewResult } from './hr-payroll.ts';
import { zHrBankTemplate, zHrBankTemplateCreate, zHrBankTemplateEdit, zHrBankTemplateList, zHrBankTemplateRef, zHrBankTemplateWritten } from './hr-bank-template.ts';
import {
  zHrLeaveBalanceAsk,
  zHrLeaveBalanceResult,
  zHrLeaveDelete,
  zHrLeaveRequestActionResult,
  zHrLeaveRequestDecide,
  zHrLeaveRequestList,
  zHrLeaveRequestRef,
  zHrLeaveRequestView,
  zHrLeaveSet,
  zHrLeaveWritten,
  zHrSelfLeaveBalanceAsk,
  zHrSelfLeaveBalanceResult,
  zHrSelfLeaveRequestList,
  zHrSelfLeaveRequestSubmit,
  zHrSelfLeaveSubmitResult,
  zHrSelfPayslipSummary,
  zHrSelfPayslipsList,
  zHrSelfProfile,
  zHrSelfProfileAsk,
} from './hr-leave.ts';
import {
  zHrAdminAttendanceRow,
  zHrAttendanceAdjust,
  zHrAttendanceAnomaliesAsk,
  zHrAttendanceAnomaliesBrief,
  zHrAttendanceList,
  zHrAttendanceListResult,
  zHrAttendanceLogView,
  zHrAttendanceQrRotate,
  zHrAttendanceQrRotateResult,
  zHrAttendanceRollupResult,
  zHrAttendanceRollupToPayroll,
  zHrSelfAttendanceCheckIn,
  zHrSelfAttendanceCheckOut,
  zHrSelfAttendanceList,
  zHrSelfAttendanceListResult,
} from './hr-attendance.ts';
import {
  zHrOnboardingApproveResult,
  zHrOnboardingCancelResult,
  zHrOnboardingDecide,
  zHrOnboardingList,
  zHrOnboardingRejectResult,
  zHrOnboardingSubmissionRef,
  zHrOnboardingSubmissionView,
  zHrSelfOnboardingState,
  zHrSelfOnboardingSubmit,
  zHrSelfOnboardingSubmitResult,
} from './hr-onboarding.ts';
import {
  zHrOvertimeActionResult,
  zHrOvertimeDecide,
  zHrOvertimeList,
  zHrOvertimeRef,
  zHrOvertimeRequestView,
  zHrOvertimeSettings,
  zHrOvertimeSettingsGet,
  zHrOvertimeSettingsSet,
  zHrSelfOvertimeList,
  zHrSelfOvertimeListResult,
  zHrSelfOvertimeSubmit,
  zHrSelfOvertimeSubmitResult,
} from './hr-overtime.ts';
import {
  zHrProbationDecide,
  zHrProbationDecideResult,
  zHrProbationDraftAsk,
  zHrProbationDraftResult,
  zHrProbationList,
  zHrProbationPreviewAsk,
  zHrProbationPreviewResult,
  zHrProbationReviewView,
} from './hr-probation.ts';
import {
  zHrAdjustmentActionResult,
  zHrAdjustmentCreate,
  zHrAdjustmentDecide,
  zHrAdjustmentItemView,
  zHrAdjustmentList,
  zHrAdjustmentRef,
  zHrAdvanceActionResult,
  zHrAdvanceDecide,
  zHrAdvanceList,
  zHrAdvanceRef,
  zHrAdvanceRequestView,
  zHrSelfAdvanceList,
  zHrSelfAdvanceListResult,
  zHrSelfAdvanceSubmit,
  zHrSelfAdvanceSubmitResult,
  zHrSelfTripList,
  zHrSelfTripListResult,
  zHrSelfTripSubmit,
  zHrSelfTripSubmitResult,
  zHrTripActionResult,
  zHrTripDecide,
  zHrTripList,
  zHrTripRef,
  zHrTripRequestView,
} from './hr-stage6b.ts';
import {
  zHrSelfPolicyQaAsk,
  zHrSelfPolicyQaResult,
  zHrSelfRequestDraftAsk,
  zHrSelfRequestDraftResult,
} from './hr-self-coworker.ts';
import {
  zHrAddendumCheckAsk,
  zHrAddendumCheckResult,
  zHrAddendumCreate,
  zHrAddendumIssue,
  zHrAddendumList,
  zHrAddendumPdfAsk,
  zHrAddendumPdfResult,
  zHrAddendumUpdate,
  zHrAddendumView,
  zHrAddendumVoid,
  zHrAddendumWriteResult,
  zHrAssetAssign,
  zHrAssetList,
  zHrAssetUpdateStatus,
  zHrAssetView,
  zHrAssetWriteResult,
  zHrSelfAssetView,
  zHrTimelineAsk,
  zHrTimelineResult,
} from './hr-addendum-assets.ts';
import {
  zHrOkrDraftCheckinAsk,
  zHrOkrDraftCheckinResult,
  zHrOkrKeyResultAdd,
  zHrOkrKeyResultCheckin,
  zHrOkrKeyResultMutationResult,
  zHrOkrKeyResultRemove,
  zHrOkrKeyResultRemoveResult,
  zHrOkrKeyResultSyncProjects,
  zHrOkrKeyResultUpdate,
  zHrOkrObjectiveCreate,
  zHrOkrObjectiveMutationResult,
  zHrOkrObjectiveSetStatus,
  zHrOkrObjectiveUpdate,
  zHrOkrProjectOptionsAsk,
  zHrOkrProjectOptionsResult,
  zHrOkrProjectTasksAsk,
  zHrOkrProjectTasksResult,
  zHrOkrTreeAsk,
  zHrOkrTreeResult,
} from './hr-okr.ts';
import { zHrLaborCheckAsk, zHrLaborCheckResult } from './hr-declarations.ts';
import {
  zHrCandidateAdd,
  zHrCandidateEdit,
  zHrCandidateEraseResult,
  zHrCandidateHire,
  zHrCandidateHireResult,
  zHrCandidateInterviewCancelled,
  zHrCandidateInterviewScheduled,
  zHrCandidateList,
  zHrCandidateMoveStage,
  zHrCandidateRef,
  zHrCandidateScheduleInterview,
  zHrCandidateView,
  zHrCandidateWritten,
  zHrInterviewerOption,
  zHrInterviewSlotsAsk,
  zHrInterviewSlotsResult,
  zHrInviteDraftAsk,
  zHrInviteDraftResult,
  zHrOpeningAdd,
  zHrOpeningClose,
  zHrOpeningEdit,
  zHrOpeningList,
  zHrOpeningView,
  zHrOpeningWritten,
  zHrRecruitingAnalyticsQuery,
  zHrRecruitingAnalyticsResult,
  zHrRecruitingBriefAsk,
  zHrRecruitingBriefResult,
} from './hr-recruiting.ts';
import {
  zNote,
  zNoteAcceptSummary,
  zNoteAttachment,
  zNoteAttachmentDeleted,
  zNoteAttachmentRef,
  zNoteBacklinksInput,
  zNoteClip,
  zNoteCreate,
  zNoteFromMeetingSummary,
  zNoteLinkAdd,
  zNoteLinkRemove,
  zNoteLinkTarget,
  zNoteLinkWritten,
  zNoteList,
  zNotePrivateCount,
  zNoteRecordPanelView,
  zNoteRef,
  zNoteRestoreVersion,
  zNoteSearch,
  zNoteSetVisibility,
  zNoteOrganizeInput,
  zNoteOrganizeResult,
  zNoteSuggestTodosInput,
  zNoteSuggestTodosResult,
  zNoteSummarizeInput,
  zNoteSummarizeResult,
  zTodoPlanInput,
  zTodoPlanResult,
  zNoteSummary,
  zNoteTemplate,
  zNoteTemplateCreate,
  zNoteTemplateDeleted,
  zNoteTemplateRef,
  zNoteTemplateUpdate,
  zNoteTemplateWritten,
  zNoteUpdate,
  zNoteVersion,
  zNoteVyResults,
  zNoteVyStatus,
  zNoteWritten,
  zNotebookCreate,
  zNotebookDeleted,
  zNotebookRef,
  zNotebookUpdate,
  zNotebookWritten,
  zNotebooksResponse,
  zNotesExport,
  zMyWork,
  zMyWorkInput,
  zTodo,
  zTodoAcceptSuggestions,
  zTodoAcceptSuggestionsResult,
  zTodoComplete,
  zTodoCompleteResult,
  zTodoCount,
  zTodoCreate,
  zTodoQuickCapture,
  zTodoHandOver,
  zTodoHandedOver,
  zTodoLinkAdd,
  zTodoLinkRemove,
  zTodoLinkWritten,
  zTodoList,
  zTodoListCreate,
  zTodoListRef,
  zTodoListUpdate,
  zTodoListWritten,
  zTodoListsResponse,
  zTodoRef,
  zTodoReopen,
  zTodoReorder,
  zTodoReschedule,
  zTodoRescheduled,
  zTodoSummary,
  zTodoUpdate,
  zTodoWritten,
} from './notes.ts';
import {
  zMeetingCreate,
  zMeetingCreated,
  zMeetingImportDiscarded,
  zMeetingImportDiscardEmpty,
  zMeetingImportStart,
  zMeetingDeleted,
  zMeetingOwnerList,
  zMeetingLink,
  zMeetingLinkAdd,
  zMeetingLinkRemove,
  zMeetingLinkRemoved,
  zMeetingOfTarget,
  zMeetingOwnerListInput,
  zMeetingsOfTargetInput,
  zMeetingLinkSuggested,
  zMeetingDetail,
  zMeetingListInput,
  zMeetingReaderAdd,
  zMeetingReaderRemove,
  zMeetingReaderResult,
  zMeetingRef,
  zMeetingSettings,
  zLiveNotesAsk,
  zLiveNotesDone,
  zLiveRef,
  zLiveStart,
  zLiveStarted,
  zLiveStatus,
  zLiveStopped,
  zLiveTick,
  zLiveTicked,
  zMeetingConsentPolicy,
  zMeetingConsentPolicyGet,
  zMeetingExtensionStatus,
  zMeetingMinutesEsign,
  zMeetingMinutesEsignGet,
  zMeetingRecordingStopped,
  zMeetingRecordingStoppedDone,
  zMeetingRecordingNow,
  zMeetingRecordingNowInput,
  zMeetingSettingsGet,
  zMeetingSearchInput,
  zMeetingSearchResult,
  zMeetingSettingsSet,
  zMeetingListItem,
  zTranscript,
  zTranscriptCorrect,
  zTranscriptCorrected,
  zTranscriptDraftStore,
  zTranscriptDraftStored,
  zTranscriptRedact,
  zTranscriptRedacted,
  zTranscriptRedactCandidates,
  zTranscribeRunRef,
  zTranscribeCancel,
  zTranscribeCancelled,
  zTranscribeStart,
  zTranscribeStarted,
  zTranscribeStatus,
  zTranscriptCopy,
  zActionItemAccept,
  zActionItemAccepted,
  zActionItemAcceptClean,
  zActionItemCreate,
  zActionItemCreated,
  zActionItemDeleted,
  zActionItemEdit,
  zActionItemRef,
  zActionItemSource,
  zActionItemsAccepted,
  zMeetingResultSave,
  zMeetingTemplateSet,
  zMeetingTemplateSetDone,
  zNotes,
  zNotesPreview,
  zNotesPreviewInput,
  zSeriesOpenItems,
  zSeriesOpenItemsInput,
  zSeriesSet,
  zSeriesSetResult,
  zSpeakerName,
  zSpeakerNamed,
  zSpeakerSuggestions,
  zSpeakerSuggestionsInput,
  zNotesSave,
  zNotesSaved,
  zMeetingResultSaved,
  zMeetingResults,
  zResultPublish,
  zResultPublished,
  zDraftReview,
  zDraftReviewed,
  zSummarized,
  zTranslated,
  zTranscriptTranslated,
  zTranscriptTranslateStopped,
  zTranscriptTranslationStatus,
  zTranscriptTranslationView,
  zTranslationRef,
  zTranslationSource,
  zTranscriptTranslationRef,
  zTranslationStatus,
  zTranslations,
  zSummaryRef,
  zSummaryStatus,
  zSummaryCopied,
  zSummaryCopy,
} from './meetings.ts';
import { zGlossaryAdd, zGlossaryDone, zGlossaryList, zGlossaryRemove, zGlossaryTerms, zGlossaryUpdate } from './meeting-glossary.ts';
import {
  zMinutesTemplateArchive,
  zMinutesTemplateCreate,
  zMinutesTemplateDone,
  zMinutesTemplateList,
  zMinutesTemplateUpdate,
  zMinutesTemplates,
} from './meeting-minutes-templates.ts';
import { zMinutesVersionPublish, zMinutesVersionPublished, zMinutesVersionUnpublish, zMinutesVersionUnpublished, zMinutesVersions } from './meeting-minutes-version.ts';
import { zMinutesDocx, zMinutesDocxInput } from './meeting-minutes-docx.ts';
import { zAskAnswer, zAskEmpty, zAskInput, zAskLines, zAskMeetingLinesInput, zAskStatus } from './meeting-ask.ts';
import { zBriefAnswer, zBriefEmpty, zBriefFacts, zBriefStatus, zBriefTarget } from './meeting-brief.ts';
import { zMeetingRename, zMeetingRenamed, zTitleAnswer } from './meeting-title.ts';
import { zCommitmentsAnswer } from './meeting-commitments.ts';
import { zTemplateSuggestion, zTemplateVyAnswer } from './meeting-template-suggest.ts';
import { zVoiceCueDraft, zVoiceCueDrafted } from './meeting-voice-cue.ts';
import { zOpenPointsAnswer } from './meeting-open-points.ts';
import { zDigestAnswer, zDigestAsk, zDigestFacts, zDigestStatus } from './meeting-digest.ts';
import { zLoadWeek, zLoadWeekInput } from './meeting-load.ts';
import { zTrackerAdd, zTrackerDone, zTrackerHits, zTrackerList, zTrackerMeetingInput, zTrackerRemove, zTrackerTerms, zTrackerWeek, zTrackerWeekInput } from './meeting-trackers.ts';
import { zHighlightAdd, zHighlightAdded, zHighlightRemove, zHighlightRemoved, zHighlights } from './meeting-highlights.ts';
import { zLabelAdd, zLabelAdded, zLabelRemove, zLabelRemoved, zMeetingLabels } from './meeting-labels.ts';
import { zMeetingsTodayFacts } from './meeting-today.ts';
import { zMorningEmpty, zMorningSet, zMorningState } from './meeting-morning.ts';
import { zAssigneeAnswer, zAssigneeAsk, zAssigneeStatus } from './meeting-assignee.ts';
import { zAdherenceAgenda, zAdherenceAnswer, zAdherenceAsk, zAdherenceRef, zAdherenceStatus } from './meeting-adherence.ts';
import { zCaptureHeartbeat, zCaptureHeartbeatDone } from './meeting-capture.ts';
import { zAgendaLink, zAgendaLinked, zAgendaList, zAgendaListInput, zAgendaNext, zAgendaNextInput, zAgendaReadEventsSet, zAgendaSetReadEvents, zAgendaSuggestInput, zAgendaSuggestion } from './meeting-agenda.ts';
import {
  zMeetingHookCleared,
  zMeetingHookNone,
  zMeetingHookSet,
  zMeetingHookState,
  zMeetingHookTested,
  zMeetingHookWithSecret,
  zMeetingHooksSwitch,
} from './meeting-hook.ts';
import {
  COLUMN_CREATE_PLACEMENT_ISSUE,
  DELETE_SAME_FALLBACK_COLUMN_ISSUE,
  REORDER_SAME_COLUMN_ISSUE,
  TASK_MOVE_COLUMN_PLACEMENT_ISSUE,
  distinctDeleteFallbackColumn,
  distinctColumnReorderTargets,
  validColumnCreatePlacement,
  validTaskMoveColumnPlacement,
  zProjectArchive,
  zProjectBoard,
  zProjectBoardInput,
  zProjectCandidateTask,
  zProjectColumnCreateFields,
  zProjectColumnDeleteFields,
  zProjectColumnDeleteResult,
  zProjectColumnInitDefaultsInput,
  zProjectColumnInitDefaultsResult,
  zProjectColumnMutateResult,
  zProjectColumnReorderFields,
  zProjectColumnReorderResult,
  zProjectColumnUpdateInput,
  zProjectCreate,
  zProjectCreateFromTemplateFields,
  zProjectCreateFromTemplateResult,
  zProjectDetail,
  zProjectListInput,
  zProjectListResult,
  zProjectMemberMutate,
  zProjectSetOwner,
  zProjectSetStatus,
  zProjectStatus,
  zProjectTaskCreate,
  zProjectTaskMoveColumnFields,
  zProjectTaskMoveColumnResult,
  zProjectTaskMutate,
  zProjectTaskProjectEntry,
  zProjectTaskProjectsInput,
  zProjectTaskRecurrenceClearInput,
  zProjectTaskRecurrenceClearResult,
  zProjectTaskRecurrenceGetInput,
  zProjectTaskRecurrenceSetInput,
  zProjectTaskRecurrenceView,
  zProjectTaskSetDatesInput,
  zProjectTaskSetDatesResult,
  zProjectTimeline,
  zProjectTimelineInput,
  zProjectDependencyAddInput,
  zProjectDependencyAddResult,
  zProjectDependencyListInput,
  zProjectDependencyListResult,
  zProjectDependencyRemoveInput,
  zProjectDependencyRemoveResult,
  zProjectTaskReorderFields,
  zProjectTaskReorderResult,
  zProjectCycleCompleteInput,
  zProjectCycleCompleteResult,
  zProjectCycleCreateInput,
  zProjectCycleDeleteInput,
  zProjectCycleDeleteResult,
  zProjectCycleListInput,
  zProjectCycleListResult,
  zProjectCycleMetrics,
  zProjectCycleMetricsInput,
  zProjectCycleMutateResult,
  zProjectCycleStartInput,
  zProjectCycleSummary,
  zProjectCycleSummaryInput,
  zProjectCycleUpdateInput,
  zProjectTaskSetCycleInput,
  zProjectTaskSetCycleResult,
  zProjectTaskSetPointsInput,
  zProjectTaskSetPointsResult,
  distinctReorderTargets,
  REORDER_SAME_TASK_ISSUE,
  validTemplateCreateFromSource,
  validTemplateCreateSource,
  TEMPLATE_CREATE_FROM_SOURCE_ISSUE,
  TEMPLATE_CREATE_SOURCE_ISSUE,
  zProjectTasksFromNoteConfirmInput,
  zProjectTasksFromNoteConfirmResult,
  zProjectTasksFromNoteInput,
  zProjectTasksFromSourceConfirmInput,
  zProjectTasksFromSourceConfirmResult,
  zProjectTasksFromSourceInput,
  zProjectTasksFromSourceResult,
  zProjectTasksFromNoteResult,
  zProjectTasksFromNoteStatus,
  zProjectTemplateArchiveInput,
  zProjectTemplateArchiveResult,
  zProjectTemplateCreateFields,
  zProjectTemplateCreateResult,
  zProjectTemplateListInput,
  zProjectTemplateListResult,
  zProjectTimeDeleteInput,
  zProjectTimeDeleteResult,
  zProjectTimeExportCsvInput,
  zProjectTimeExportCsvResult,
  zProjectTimeLogFields,
  zProjectTimeMutateResult,
  zProjectTimeStartInput,
  zProjectTimeStartResult,
  zProjectTimeStopInput,
  zProjectTimeStopResult,
  zProjectTimeSummaryInput,
  zProjectTimeSummaryResult,
  zProjectTimeUpdateFields,
  validTimeLogRange,
  validTimeUpdateRange,
  PROJECT_TIME_LOG_RANGE_ISSUE,
  PROJECT_TIME_UPDATE_RANGE_ISSUE,
  zProjectUpdate,
  zProjectWeeklyStatus,
  zProjectWeeklyStatusInput,
  zProjectWeeklyStatusSendMailInput,
  zProjectWeeklyStatusSendMailResult,
  zProjectWeeklyStatusShareNoteInput,
} from './projects.ts';
import {
  zRoadmapAdminItem,
  zRoadmapAnnouncement,
  zRoadmapAnnouncementCreateInput,
  zRoadmapAnnouncementDeleteInput,
  zRoadmapAnnouncementPublishInput,
  zRoadmapAnnouncementSendNotificationsInput,
  zRoadmapAnnouncementSendNotificationsResult,
  zRoadmapAnnouncementUpdateInput,
  zRoadmapBoardCreateInput,
  zRoadmapBoardDetailInput,
  zRoadmapBoardDetailResult,
  zRoadmapBoardListResult,
  zRoadmapBoardSummary,
  zRoadmapBoardUpdateInput,
  zRoadmapChangelogDraftInput,
  zRoadmapChangelogDraftResult,
  zRoadmapDedupeInput,
  zRoadmapDedupeResult,
  zRoadmapItemConvertToTaskInput,
  zRoadmapItemCreateInput,
  zRoadmapItemMergeInput,
  zRoadmapItemModerateInput,
  zRoadmapItemSyncStageInput,
  zRoadmapSignalCreateInput,
  zRoadmapSignalCreateResult,
  zRoadmapSignalDeleteInput,
  zRoadmapSignalDeleteResult,
  zRoadmapSignalListInput,
  zRoadmapSignalListResult,
  zRoadmapSignalMatchInput,
  zRoadmapSignalMatchResult,
  zRoadmapSignalRollupInput,
  zRoadmapSignalRollupResult,
} from './projects-roadmap.ts';
import {
  PROJECT_TRIAGE_SOURCE_PAIR_ISSUE,
  validProjectTriageSourcePair,
  zProjectTriageAcceptInput,
  zProjectTriageAcceptResult,
  zProjectTriageAssistInput,
  zProjectTriageAssistResult,
  zProjectTriageCreateFields,
  zProjectTriageDeclineInput,
  zProjectTriageListInput,
  zProjectTriageListResult,
  zProjectTriageMergeInput,
  zProjectTriageMutateResult,
  zProjectTriageReopenInput,
  zProjectTriageSnoozeInput,
} from './projects-triage.ts';
import { zDealUpdateAnswer, zDealUpdateAsk, zDealUpdateConfirmCall, zDealUpdateConfirmed, zDealUpdateStatus } from './meeting-deal-update.ts';
import { zFollowupDraft, zFollowupDraftAsk, zFollowupNoteAnswer, zFollowupNoteAsk, zFollowupNoteStatus, zFollowupSendCall, zFollowupSent, zFollowupWording, zFollowupWordingAsk } from './meeting-followup.ts';
import { zChatChannelList, zChatChannelRemove, zChatChannelRemoved, zChatChannelSaveCall, zChatChannelSaved, zChatEmpty, zChatPostCall, zChatPosted, zChatPreview, zChatStatus, zChatStatusInput } from './meeting-chat.ts';
import { zExtensionOrgToken, zExtensionToken, zExtensionTokenRevoke, zExtensionTokenRevoked, zExtensionTokenRevokedMember } from './extension.ts';
import { zMcpGrantRevoke, zMcpGrantRevoked, zMcpPairingIssue, zMcpPairingIssued, zMcpGrantView, zMcpMemberGrantsSet, zMcpMemberGrantsView, zMcpWakeCleared, zMcpWakeTested, zMcpWakeGetInput, zMcpWakeGrantRef, zMcpWakeSet, zMcpWakeView, zMcpWakeWithSecret } from './mcp.ts';
import { zOpeningBalanceImport, zOpeningBalancePreview } from './opening-balance.ts';
import { MISSING_INVOICE_REMINDER_DAY_MAX, PORTAL_LIST_DIRECTIONS, zMissingInvoiceStatus, zPortalReconciliation } from './portal-list.ts';
import { zPortalCaptcha, zPortalListResult, zPortalLoginInput, zPortalSession, zPortalXmlResult } from './portal-sync.ts';
import { ADS_SANDBOX_CURRENCIES, zAdAccountView, zAdsFlag, zAdsAccountConfigure, zAdsAccountDeleteHistory, zAdsCapLowerCall, zAdsCommitted, zAdsCommittedInput, zAdsChangeRequest, zAdsFlagSettingCall, zAdsFlagSettings, zAdsProposalView, zAdsSummary, zAdsSummaryInput, zAdsSyncRunView, zAdsWeeklyNote, zAdsWriteState } from './ads.ts';
import { zAdsBoostDraftCall, zAdsBoostDrafted, zAdsBoostOptions, zAdsBoostStatesInput, zAdsBoostStateView } from './ads-boost.ts';
import { zAdsBudgetLowerCall, zAdsManageCancelCall, zAdsManageChanged, zAdsManageStateView, zAdsManageSuggestion, zAdsObjectCall, zAdsScheduleShortenCall } from './ads-manage.ts';
import { zAdsCampaignDraftDiscardCall, zAdsCampaignDraftSaveCall, zAdsCampaignDraftView, zAdsCampaignRequestAsked, zAdsCampaignRequestCall, zAdsCampaignRequestView, zAdsLaunchCancelCall, zAdsLaunchRetryCall, zAdsLaunchStopCall } from './ads-campaign.ts';
import { zHouseholdCnkd, zHouseholdCnkdGet, zHouseholdProfileGet, zHouseholdS1a, zHouseholdS1aGet, zHouseholdS2a, zHouseholdS2aGet, zHouseholdS2b, zHouseholdS2bGet, zHouseholdS2c, zHouseholdS2cGet, zHouseholdS2d, zHouseholdS2dGet, zHouseholdS2e, zHouseholdS2eGet, zHouseholdProfileSet, zHouseholdProfileView, zHouseholdRules, zHouseholdRulesGet } from './household.ts';
import { zBankCandidatesLine, zBankCandidatesLineAsk, zBankAccountNumberSet, zBankAccountNumberView, zBankFeedAccountView, zBankFeedConnectTingee, zBankFeedConnectionView, zBankFeedHookCreated, zBankFeedHookSet, zBankFeedHookStatus, zBankFeedMap, zBankImportPreview, zBankImportResult, zBankLineVoucher, zBankLines, zBankMatchGroups, zBankMatched, zBankOpenLines, zBankPayrollExplainAsk, zBankPayrollExplanation, zBankPayrollMatch, zBankPlatformLines, zBankSignDepositExplainAsk, zBankSignDepositExplanation, zBankSignDepositMatch, zBankSignDepositMatches, zBankSignDepositMatchesInput, zBankStatementImport, zStatementLines } from './bank-statement.ts';
import { zTimeline } from './timeline.ts';
import { zMisaCode, zMisaGoodsCode } from './misa-goods.ts';
import { zAuditCursor, zAuditExport, zAuditFilter, zAuditPage } from './audit.ts';
import { zPersonalDataErasure, zPersonalDataNotice, zPersonalDataQuery, zPersonalDataResult } from './personal-data.ts';
import {
  zSignAcceptanceDraftInput,
  zSignAcceptanceDraftResult,
  zSignAiAnalysisRecord,
  zSignAiAnalyzeInput,
  zSignAiAnalyzeResult,
  zSignCaConnectionDisableInput,
  zSignCaConnectionRecord,
  zSignCaConnectionSaveInput,
  zSignCaConnectionTestInput,
  zSignCaRequestInitiateInput,
  zSignCaRequestListResult,
  zSignCaSettingsResult,
  zSignCaSigningRequestRecord,
  zSignDepositProfile,
  zSignDepositProfileClearInput,
  zSignDepositProfileClearResult,
  zSignDepositProfileGetResult,
  zSignDepositProfileUpsertInput,
  zSignDiffCompareInput,
  zSignEnvelopeDepositClearInput,
  zSignEnvelopeDepositClearResult,
  zSignEnvelopeDepositRecord,
  zSignEnvelopeDepositSetInput,
  zSignDiffCompareResult,
  zSignDrafterProposeInput,
  zSignDrafterProposeResult,
  zSignDrafterRenderPdfInput,
  zSignDrafterRenderPdfResult,
  zSignEnvelopeBySourceInput,
  zSignEnvelopeBySourceResult,
  zSignEnvelopeAcknowledgeDeclineInput,
  zSignEnvelopeAcknowledgeDeclineResult,
  zSignEnvelopeCreateInput,
  zSignEnvelopeCreateResult,
  zSignEnvelopeDetail,
  zSignEnvelopeEventsResult,
  zSignEnvelopeListInput,
  zSignEnvelopeListResult,
  zSignEnvelopeRemindInput,
  zSignEnvelopeRemindResult,
  zSignEnvelopeSendInput,
  zSignEnvelopeSendResult,
  zSignEnvelopeSharedSummarySetInput,
  zSignEnvelopeSharedSummarySetResult,
  zSignEnvelopeUpdateInput,
  zSignEnvelopeUpdateResult,
  zSignEnvelopeVerifyResult,
  zSignEnvelopeVoidInput,
  zSignEnvelopeVoidResult,
  zSignFieldSetInput,
  zSignFieldSetResult,
  zSignMemberSignatureDeleteInput,
  zSignMemberSignatureDeleteResult,
  zSignMemberSignatureListInput,
  zSignMemberSignatureListResult,
  zSignMemberSignatureUpsertInput,
  zSignMemberSignatureUpsertResult,
  zSignOrgStampArchiveInput,
  zSignOrgStampArchiveResult,
  zSignOrgStampCreateInput,
  zSignOrgStampCreateResult,
  zSignOrgStampListInput,
  zSignOrgStampListResult,
  zSignWebhookCreateInput,
  zSignWebhookDeleteInput,
  zSignWebhookDeleteResult,
  zSignWebhookDeliveriesInput,
  zSignWebhookDeliveriesResult,
  zSignWebhookListInput,
  zSignWebhookListResult,
  zSignWebhookPingInput,
  zSignWebhookPingResult,
  zSignWebhookRecord,
  zSignWebhookRotateSecretInput,
  zSignWebhookUpdateInput,
  zSignWebhookWithSecretResult,
  zSignEnvelopePlaybookCheckRecord,
  zSignPlaybookEvaluateInput,
  zSignPlaybookEvaluateResult,
  zSignPlaybookGetResult,
  zSignPlaybookOverrideFindingInput,
  zSignPlaybookRuleDeleteInput,
  zSignPlaybookRuleDeleteResult,
  zSignPlaybookRuleRecord,
  zSignPlaybookRulesListInput,
  zSignPlaybookRulesListResult,
  zSignPlaybookRuleUpsertInput,
  zSignPlaybookSeedDefaultsInput,
  zSignSignerAddInput,
  zSignSignerAddResult,
  zSignSignerCorrectRecipientInput,
  zSignSignerCorrectRecipientResult,
  zSignSignerCreateLinkInput,
  zSignSignerCreateLinkResult,
  zSignSignerStartInPersonInput,
  zSignSignerStartInPersonResult,
  zSignSignerRemoveInput,
  zSignSignerRemoveResult,
  zSignSignerReorderInput,
  zSignSignerReorderResult,
  zSignTemplateArchiveInput,
  zSignTemplateArchiveResult,
  zSignTemplateCreateInput,
  zSignTemplateCreateResult,
  zSignTemplateDetail,
  zSignTemplateDirectLinkResult,
  zSignTemplateDirectLinkRotateInput,
  zSignTemplateDirectLinkSetInput,
  zSignTemplateFieldsSetInput,
  zSignTemplateFieldsSetResult,
  zSignTemplateInstantiateInput,
  zSignTemplateInstantiateResult,
  zSignTemplateListInput,
  zSignTemplateListResult,
  zSignTemplateRolesSetInput,
  zSignTemplateRolesSetResult,
  zSignTemplateSharedSummarySetInput,
  zSignTemplateSharedSummarySetResult,
  zSignTemplateUpdateInput,
  zSignTemplateUpdateResult,
  zSignEnvelopeObligationRecord,
  zSignObligationCompleteItemInput,
  zSignObligationDismissInput,
  zSignObligationDismissResult,
  zSignObligationExtractInput,
  zSignObligationExtractResult,
  zSignObligationGetResult,
  zSignObligationRenewalsListInput,
  zSignObligationRenewalsListResult,
  zSignObligationUpsertInput,
  zSignKycAnalyzeInput,
  zSignKycAnalyzeResult,
  zSignKycCheckRecord,
  zSignKycConfirmInput,
  zSignKycListResult,
  zSignKycRunDeterministicInput,
  zSignVaultAskInput,
  zSignVaultAskResult,
  zSignVaultSearchInput,
  zSignVaultSearchResult,
  zSignApiKeyCreateInput,
  zSignApiKeyCreateResult,
  zSignApiKeyListInput,
  zSignApiKeyListResult,
  zSignApiKeyRecord,
  zSignApiKeyRevokeInput,
  zSignEnvelopeDocumentAddInput,
  zSignEnvelopeDocumentAddResult,
  zSignEnvelopeDocumentRemoveInput,
  zSignEnvelopeDocumentRemoveResult,
  zSignEnvelopeDocumentReorderInput,
  zSignEnvelopeDocumentReorderResult,
  zSignPacketConsistencyCheckInput,
  zSignPacketConsistencyCheckResult,
} from './sign.ts';

// Proposal reminders (issue #676): days before the approvers are reminded and before the owners are told; and expiry
// (#876): days after which a proposal still pending expires. Expiry needs the escalation and comes after it.
export const zProposalPolicy = z.object({
  remindAfterDays: z.number().int().min(1).max(30).nullable(),
  escalateAfterDays: z.number().int().min(1).max(60).nullable(),
  expireAfterDays: z.number().int().min(2).max(90).nullable(),
});

// An AI draft from the post's photos (#1191): 1 to AI_DRAFT_IMAGES_MAX of the org's Social images (SOCIAL_PHOTO_TYPES), each
// of at most AI_IMAGE_MAX_BYTES, as the writer in @ludy/agent takes them (DRAFT_IMAGES_MAX, ALT_TEXT_IMAGE_MAX_BYTES).
export const AI_DRAFT_IMAGES_MAX = 4;
export const AI_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// The org for org-scoped procedures comes from the `x-ludy-org` header (slug), never from input.
export const contract = {
  me: {
    get: oc.output(zMe),
    // The multi-client home screen (issue #318): the orgs of me.get (at most 200) with their figures, each read in its
    // own org, and how many orgs the user has (#495). One at a time per user: a second while the first runs is
    // refused with OVERLOADED (503).
    clients: oc.output(zClientOverviews),
  },
  // "Hôm nay cần bạn" on Home (issue #2383): what needs the member today across the apps, merged from each line's own
  // today read and ordered flags first. Every role; each line shows only what the member could open there. Reads only.
  today: {
    list: oc.output(zTodayList),
    // What each AI coworker prepared over the last day, counts only, for the rows the member can open (#3256). Every role; no model.
    sinceYesterday: oc.output(zSinceYesterday),
    // Vy's brief of the same list: a few checked sentences, or the plain template, or none (#2383). One model call at most, counted
    // against the AI budget; every role.
    brief: oc.input(zTodayBriefInput).output(zTodayBrief),
    // "Tuần này" (#3257): the last 7 days in figures computed by code from the lines' reads in the member's own context, with Vy's checked sentences or the template. One model call at most, counted
    // against the AI budget (`today.weekly`); every role; nothing is stored.
    weekly: oc.input(zTodayWeeklyInput).output(zTodayWeekly),
    // The caller's own opt-in to the daily brief by email (#2406); every role, only their own setting.
    mail: {
      get: oc.output(zTodayMailSetting),
      set: oc.input(zTodayMailSet).output(zTodayMailSetting),
    },
  },
  // Global Home customizable block layout (#4923 Phase 1, #4925); every member role reads/writes only their own.
  overview: {
    homeLayout: {
      get: oc.output(zHomeLayoutView),
      save: oc.input(zHomeLayoutSaveInput).output(zHomeLayoutView),
    },
  },
  org: {
    // A retry with the same idempotencyKey returns the org the first request created. `kind` (ORG_KINDS): 'solo' starts the org with only Tài chính, Cộng tác and Ludy AI on,
    // 'team' (and no kind) with every app on (ADR-0053 amendment, #4802); the apps stay one switch each in Settings afterwards.
    create: oc.input(z.object({ name: z.string().trim().min(1).max(200), idempotencyKey: zId, kind: z.enum(ORG_KINDS).optional() })).output(zOrgSummary),
    get: oc.output(zOrgDetail),
    // Every role (ADR-0053, #3313): the apps the org may switch, and for each whether the deployment runs it, the org holds
    // it and its owner or admin left it on. Owners and admins switch one with setApp (R2, audited); every app is on by default.
    apps: oc.output(zOrgApps),
    setApp: oc.input(zOrgAppSet).output(zOrgAppSetResult),
    // The org's overview (#1249): its figures, the same as the multi-client home screen reads for it. Every role.
    overview: oc.output(zOrgOverview),
    // Owners and admins (issue #313): the org's own tax code (MST), or null to clear it. Stored normalized; a value
    // that is not a Vietnamese tax code is refused. Invoices read from then on whose seller has it become sales.
    setTaxCode: oc.input(z.object({ taxCode: z.string().trim().max(20).nullable() })).output(z.object({ taxCode: z.string().nullable() })),
    // Owners and admins (issue #318): how often the org files its VAT return, or null to clear it.
    setVatFilingPeriod: oc
      .input(z.object({ vatFilingPeriod: zVatFilingPeriod.nullable() }))
      .output(z.object({ vatFilingPeriod: zVatFilingPeriod.nullable() })),
    // Owners only, R3 (issue #1402): the org's approval policy preset (founder or accountant). Switching to accountant
    // is refused while no member holds the chief accountant role.
    setApprovalPreset: oc
      .input(z.object({ preset: z.string().regex(/^[a-z][a-z0-9_]*$/).max(50) }))
      .output(z.object({ preset: z.string(), version: z.number().int().positive() })),
    // Owners and admins (issue #324): the org's address, or null to clear it. Stored on one line, at most 500
    // characters; a value with control characters is refused.
    setAddress: oc.input(z.object({ address: z.string().max(2000).nullable() })).output(z.object({ address: z.string().nullable() })),
    // Owners and admins (issue #669): the org's contact email, where its own mail goes (a request for missing invoices),
    // or null to clear it.
    setContactEmail: oc.input(z.object({ email: z.email().max(320).nullable() })).output(z.object({ contactEmail: z.string().nullable() })),
    // Everyone reads, owners and admins set (issue #676): after how many days a pending proposal reminds the people who
    // may approve it, and after how many its owners are told; null turns either off. Escalation must come later.
    proposalPolicy: oc.output(zProposalPolicy),
    setProposalPolicy: oc.input(zProposalPolicy).output(zProposalPolicy),
    // The tax calendar (issue #921): everyone reads which obligations apply, owners and admins set them; owners, admins
    // and members mark an obligation done for a period (or take the mark back), which removes it from the home screen.
    taxProfile: oc.output(zTaxProfile.extend({ since: zLocalDate.nullable() })),
    setTaxProfile: oc.input(zTaxProfile).output(zTaxProfile.extend({ since: zLocalDate.nullable() })),
    markTaxObligation: oc.input(zTaxObligationMark.extend({ done: z.boolean() })).output(zTaxObligationMark.extend({ done: z.boolean() })),
    // Owners and admins (issue #672): the org's audit log, newest first, filtered and paged; the commands it holds, for
    // the filter; and the filtered list as a CSV file (the export leaves its own audit row).
    audit: oc.input(zAuditFilter.extend({ before: zAuditCursor.optional() })).output(zAuditPage),
    auditCommands: oc.output(z.array(z.string())),
    auditExport: oc.input(zAuditFilter).output(zAuditExport),
    // Owners and admins (issue #923, PDPL): every row of the org that holds a person's email, phone, or tax code or
    // national ID, with what an erasure would do to each, for the person's request to see or export their data.
    personalData: oc.input(zPersonalDataQuery).output(zPersonalDataResult),
    // Owners only (issue #923). R3: needs fresh MFA. Erases the person's data the finder shows as "erase" and lists
    // what it kept and why. A retry with the same idempotencyKey returns the first result.
    personalDataErase: oc.input(zPersonalDataQuery.extend({ idempotencyKey: zId })).output(zPersonalDataErasure),
    // Owners only (issue #1678, ADR-0037 section 5): tells the authors of private notes and to-dos that mention the value
    // how many of theirs do, before an erasure, which deletes only what a notice named.
    personalDataNotify: oc.input(zPersonalDataQuery.extend({ idempotencyKey: zId })).output(zPersonalDataNotice),
    // Owners and admins (admins cannot invite admins). R3: needs fresh MFA. Nobody becomes a member until the
    // invitee accepts (invites.accept). The answer is the same whether or not the email has an account.
    // An owner may scope the invite to legal entities (#1281): the invitee joins as a member or viewer holding the
    // external_accountant role for those entities only. An owner may also send one department role (#2611, a catalog role
    // of scope org), granted when the invite is accepted; it never goes with legalEntityIds.
    invite: oc
      .input(z.object({ email: z.email().max(320), role: zInviteRole, legalEntityIds: zInviteLegalEntityIds.optional(), roleKey: zBuiltinRoleKey.optional() }))
      .output(zInviteCreated),
    // Owners and admins: the org's invites that are still pending or expired, newest first.
    listInvites: oc.output(z.array(zInvite)),
    revokeInvite: oc.input(z.object({ inviteId: zId })).output(z.object({ ok: z.literal(true) })),
    // Owner only. Retires the org's inbound email address for good and returns the new one (null when the server
    // has no inbound domain). A retry with the same idempotencyKey does not rotate again.
    rotateInbound: oc.input(z.object({ idempotencyKey: zId })).output(z.object({ inboundAddress: z.string().nullable() })),
    // Owners and admins (#2439): the Inbox's own email address, made the first time it is asked for and the same one after; null when the server has no
    // inbound domain.
    issueConversationAddress: oc.input(z.object({})).output(zConversationAddress),
    // Owner only (R3): retires the Inbox's email address for good and returns the new one. A retry with the same idempotencyKey does not rotate again.
    rotateConversationAddress: oc.input(z.object({ idempotencyKey: zId })).output(zConversationAddress),
    // Owners only (R3). A retry with the same idempotencyKey returns the first result.
    changeMemberRole: oc
      .input(z.object({ userId: zId, role: zRole, idempotencyKey: zId }))
      .output(z.object({ userId: zId, role: zRole, previousRole: zRole })),
    removeMember: oc.input(z.object({ userId: zId, idempotencyKey: zId })).output(z.object({ userId: zId, previousRole: zRole })),
    // Role assignments (issue #1279): owners and admins read the roles the deployment offers and who holds which; owners
    // grant and revoke (R3: fresh MFA). A retry with the same idempotencyKey returns the first result.
    memberRoles: oc.output(zMemberRoles),
    assignRole: oc.input(zRoleAssignInput.extend({ idempotencyKey: zId })).output(z.object({ assignmentId: zId, created: z.boolean() })),
    revokeRole: oc.input(z.object({ assignmentId: zId, idempotencyKey: zId })).output(z.object({ assignmentId: zId })),
    // Owner only (R3, issue #38): the owner types the org's slug to confirm. The org moves to 'offboarding', where only
    // owners can enter it, and the worker exports its data. Run again while offboarding, it asks for a new export.
    offboard: oc
      .input(z.object({ confirmSlug: z.string().max(48), idempotencyKey: zId }))
      .output(z.object({ status: z.literal('offboarding'), exportRequested: z.literal(true) })),
    // Owner only: the offboarding state and the newest finished export.
    export: oc.output(zOrgExport),
  },
  // Org-less (issue #324): the public tax registry's name and address for a tax code, to prefill a new org. Answers
  // TAX_LOOKUP_DISABLED (404) when the server has no lookup configured (TAX_CODE_LOOKUP_URL), INVALID_TAX_CODE (422),
  // TAX_CODE_NOT_FOUND (404) when the registry does not know the code, and TAX_LOOKUP_UNAVAILABLE (503).
  // The org's legal entities (issue #1278): owners and admins list them, add one, and change one (the whole entity).
  // The default entity is the org's own, created with it; changing its tax code changes the org's (org.setTaxCode).
  legalEntities: {
    list: oc.output(z.array(zLegalEntity)),
    create: oc.input(zLegalEntityInput).output(zLegalEntity),
    update: oc.input(zLegalEntityInput.extend({ legalEntityId: zId })).output(zLegalEntity),
  },
  // The member's own calendar (issue #1313): working hours, events and days off in a range, and the free slots a
  // booking page of theirs would offer. Viewers read; owners, admins and members change their own.
  calendar: {
    get: oc.input(zCalendarRange).output(zMyCalendar),
    slots: oc.input(zCalendarSlotsQuery).output(z.array(zCalendarSlot)),
    saveHours: oc.input(zWorkingHours).output(z.strictObject({ hours: zWorkingHours, saved: z.boolean() })),
    addEvent: oc.input(zCalendarEventAdd).output(zCalendarEventView),
    cancelEvent: oc.input(zCalendarEventCancel).output(z.strictObject({ eventId: zId, cancelled: z.literal(true) })),
    // Outside calendars (#2123): the OAuth providers this server offers (empty without the app credentials), the
    // member's own connections, and connect and disconnect. Start returns where to send the browser; the provider
    // sends it back to /calendar/oauth/:provider/callback, whose screen finishes the attempt with the code and state.
    providers: oc.output(z.array(zCalendarOAuthProvider)),
    connections: oc.output(z.array(zCalendarConnectionView)),
    connectStart: oc
      .input(z.strictObject({ provider: zCalendarOAuthProvider, writeBack: z.boolean().optional(), readEvents: z.boolean().optional() }))
      .output(z.strictObject({ authorizeUrl: z.url({ protocol: /^https$/ }), state: zOAuthState, expiresAt: z.iso.datetime({ offset: true }) })),
    connectFinish: oc
      .input(z.strictObject({ provider: zCalendarOAuthProvider, state: zOAuthState, code: z.string().min(1).max(2048) }))
      .output(z.strictObject({ connectionId: zId, displayName: z.string(), reconnected: z.boolean() })),
    disconnect: oc.input(z.strictObject({ connectionId: zId })).output(z.strictObject({ connectionId: zId, disconnected: z.literal(true) })),
    // Whether bookings are written to this connection's calendar (#2124); on only for a grant with the events scope.
    setWriteBack: oc.input(z.strictObject({ connectionId: zId, enabled: z.boolean() })).output(z.strictObject({ connectionId: zId, writeBack: z.boolean() })),
  },
  // Meeting platforms a member connects (meetings integrations C1, #3173): their own connections and the recordings the platform finished, to import with a click. The OAuth steps of the real
  // providers are C2 to C4; the offline sandbox connects here when the deployment enables it.
  meetingPlatform: {
    connections: oc.output(z.array(zMeetingPlatformConnectionView)),
    recordings: oc.output(z.array(zMeetingPlatformRecordingView)),
    // Lists the member's connections again at the sweep's next pass (nothing is fetched by the request).
    refresh: oc.input(z.strictObject({ connectionId: zId.optional() })).output(z.strictObject({ refreshed: z.number().int() })),
    dismiss: oc.input(zMeetingPlatformRecordingRef).output(z.strictObject({ recordingId: zId, dismissed: z.literal(true) })),
    // Google Meet's Picker route (#3174): the member picked the recording's file in Google Picker and sends the Drive file id (never a token); the worker's import job checks it against the id Meet gave.
    pick: oc.input(zMeetingPlatformRecordingPick).output(z.strictObject({ recordingId: zId, picked: z.literal(true) })),
    disconnect: oc.input(zMeetingPlatformConnectionRef).output(z.strictObject({ connectionId: zId, disconnected: z.literal(true) })),
    connectSandbox: oc.input(z.strictObject({})).output(z.strictObject({ connectionId: zId, reconnected: z.boolean() })),
    // The platforms this deployment lets a member connect through the platform's own dialog (Zoom, C3): empty without the app credentials and a credential key, so the screen shows no connect button the
    // server could not finish. Start returns where to send the browser; the platform sends it back to /meetings/oauth/<platform>/callback, whose screen finishes the attempt with the code and state.
    providers: oc.output(z.array(zMeetingPlatformConnectProvider)),
    connectStart: oc
      .input(z.strictObject({ provider: zMeetingPlatformConnectProvider }))
      .output(z.strictObject({ authorizeUrl: z.url({ protocol: /^https$/ }), state: zOAuthState, expiresAt: z.iso.datetime({ offset: true }) })),
    connectFinish: oc
      .input(z.strictObject({ provider: zMeetingPlatformConnectProvider, state: zOAuthState, code: z.string().min(1).max(2048) }))
      .output(z.strictObject({ connectionId: zId, displayName: z.string(), reconnected: z.boolean() })),
  },
  taxRegistry: {
    lookup: oc.input(z.object({ taxCode: z.string().trim().max(20) })).output(zTaxRegistryEntry),
  },
  // Org-less: the signed-in invitee previews and accepts an invite by its token. Only the invited email may.
  invites: {
    peek: oc.input(z.object({ token: zInviteToken })).output(zInvitePreview),
    accept: oc.input(z.object({ token: zInviteToken })).output(zOrgSummary),
  },
  // Sessions (devices) of a member of the org in the header. API only; the screen is a follow-up.
  sessions: {
    list: oc.input(z.object({ userId: zId })).output(z.array(zSession)),
    revoke: oc.input(zSessionRevoke).output(z.object({ revoked: z.array(zId) })),
  },
  // The member's connected extension devices in the org of the request (issue #2582, ADR-0047 point 10): their tokens'
  // standing, never a hash, and a revoke of one. Only the member's own; the extension itself cannot reach either.
  // The grants an owner or admin gave MCP clients (ADR-0051, #2975): the org's list (never a token) and the revoke of one. The consent itself is an
  // HTTP route of the authorization server, not a procedure.
  mcp: {
    grant: {
      list: oc.input(z.strictObject({})).output(z.array(zMcpGrantView)),
      revoke: oc.input(zMcpGrantRevoke).output(zMcpGrantRevoked),
    },
    // The pairing-code fallback for an AI app without OAuth (#4591): the code is made by the API and returned once.
    pairing: {
      issue: oc.input(zMcpPairingIssue).output(zMcpPairingIssued),
    },
    // Whether members may connect their own AI app (an owner turns it on; off by default).
    memberGrants: {
      get: oc.input(z.strictObject({})).output(zMcpMemberGrantsView),
      set: oc.input(zMcpMemberGrantsSet).output(zMcpMemberGrantsView),
    },
    // The wake-up webhook of a grant (ADR-0051 decision 4, #3024): the receiver and schedule an owner or admin sets, and a secret shown once.
    wake: {
      get: oc.input(zMcpWakeGetInput).output(z.array(zMcpWakeView)),
      set: oc.input(zMcpWakeSet).output(zMcpWakeWithSecret),
      rotateSecret: oc.input(zMcpWakeGrantRef).output(zMcpWakeWithSecret),
      clear: oc.input(zMcpWakeGrantRef).output(zMcpWakeCleared),
      // A `ping` to the receiver, to see it arrive: at most one a minute per grant.
      test: oc.input(zMcpWakeGrantRef).output(zMcpWakeTested),
    },
  },
  extension: {
    tokens: {
      list: oc.input(z.strictObject({})).output(z.array(zExtensionToken)),
      revoke: oc.input(zExtensionTokenRevoke).output(zExtensionTokenRevoked),
      // Owners and admins: every member's devices in the org, and a revoke of one (issue #2740).
      listOrg: oc.input(z.strictObject({})).output(z.array(zExtensionOrgToken)),
      revokeMember: oc.input(zExtensionTokenRevoke).output(zExtensionTokenRevokedMember),
    },
  },
  // Connected channel accounts (ADR-0025). Every member lists them; owners and admins connect and disconnect.
  channels: {
    // includeEmail: every channel a member may read, email and the messaging-only ones included. includeMessaging: the messaging-only channels (WhatsApp, #3131), which
    // never publish, so the composer and every Social picker leave them out unless they ask.
    list: oc.input(z.object({ includeRevoked: z.boolean().optional(), includeEmail: z.boolean().optional(), includeMessaging: z.boolean().optional() })).output(z.array(zChannelConnection)),
    // The offline sandbox channel, when the deployment enables it. Connecting again with the same key reconnects the
    // same sandbox account.
    connectSandbox: oc
      .input(z.object({ displayName: z.string().trim().min(1).max(200), key: zId }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    disconnect: oc.input(z.object({ connectionId: zId, idempotencyKey: zId })).output(z.object({ connectionId: zId, status: z.literal('revoked') })),
    // Bluesky with an app password (S9): checked once by opening a session, then sealed; the account password is refused.
    connectBluesky: oc
      // The format of an app password is checked by the server, which says so in words rather than as a validation error.
      .input(z.object({ handle: z.string().trim().min(3).max(260), appPassword: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A Telegram channel (#747): a bot token from @BotFather and the channel's @username, t.me link or numeric id. The
    // server checks the bot may post there, then seals the token; the formats are checked by the server, in words.
    // A Mastodon account (#748): the instance's address and an access token made in its settings. The server checks the
    // token with the instance through the egress guard, then seals it.
    connectMastodon: oc
      .input(z.object({ instance: z.string().trim().min(1).max(260), accessToken: z.string().trim().min(1).max(300) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A WordPress site (#833): its address (https, with the path WordPress lives under, if any), a user name and an
    // application password from that user's profile. The server checks the user may publish, through the egress guard,
    // then seals the password; the formats are checked by the server, in words.
    connectWordPress: oc
      .input(z.object({ site: z.string().trim().min(1).max(300), username: z.string().trim().min(1).max(100), appPassword: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    connectTelegram: oc
      .input(z.object({ botToken: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A WhatsApp Business number, Cloud API (#3131): a system user token, the phone number id and the WABA id, pasted by an owner or admin. The server checks the
    // token against the phone number once, then seals it with the phone number id and drops it; the formats are checked by the server, in words.
    connectWhatsApp: oc
      .input(z.object({ accessToken: z.string().trim().min(1).max(700), phoneNumberId: z.string().trim().min(1).max(40), wabaId: z.string().trim().min(1).max(40) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // Turns the bot's private chats on or off for a Telegram connection (#3132): on points the bot's webhook at this deployment, off takes it
    // away. The call to Telegram is a job's; the answer is the state the connection is in now (enabling or disabling until the job is done).
    setTelegramChats: oc
      .input(z.object({ connectionId: zId, on: z.boolean() }))
      .output(z.object({ chatState: z.enum(['off', 'enabling', 'on', 'disabling']) })),
    // Allows a Telegram Business account's chats in, or stops them (#3191): any Premium user can connect a bot that has Business Mode on, so an owner or
    // admin chooses which accounts count. The account is named by the `ref` the connection list gave.
    setTelegramBusiness: oc
      .input(z.object({ connectionId: zId, ref: z.string().regex(/^[0-9a-f]{12}$/), allow: z.boolean(), dismiss: z.boolean().optional() }))
      .output(z.object({ approved: z.boolean() })),
    // A Discord channel (#832): the URL of a webhook a server admin made in the channel's settings. The server checks the
    // webhook with Discord, then seals its token; the format is checked by the server, in words.
    connectDiscord: oc
      .input(z.object({ webhookUrl: z.string().trim().min(1).max(300) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // Connecting through a provider's OAuth dialog (Social plan S6). Start returns where to send the browser; the
    // provider sends it back to /channels/oauth/:provider/callback, and that screen finishes the attempt with the code
    // and state. Finish connects every account the grant covers (for Facebook, the Pages picked in Meta's dialog).
    oauthStart: oc
      .input(z.object({ provider: zOAuthProvider, comments: z.boolean().optional() }))
      .output(z.object({ authorizeUrl: z.url({ protocol: /^https$/ }), state: zOAuthState, expiresAt: z.iso.datetime({ offset: true }) })),
    oauthFinish: oc
      .input(z.object({ provider: zOAuthProvider, state: zOAuthState, code: z.string().min(1).max(2048) }))
      .output(
        z.object({
          connections: z.array(z.object({ connectionId: zId, displayName: z.string(), reconnected: z.boolean() })),
          // Accounts of the grant that did not connect, with the error code; the others stay connected.
          failed: z.array(z.object({ displayName: z.string(), code: z.string() })),
          // Accounts of the grant beyond what one request connects.
          skipped: z.number().int().min(0),
        }),
      ),
  },
  // Ludy CRM's booking slice (issue #1314), when the deployment runs the crm module: the org's event types, which
  // everyone reads; owners and admins manage them all, a member those they host.
  crm: {
    eventTypes: {
      list: oc.output(z.array(zEventType)),
      create: oc.input(zEventTypeInput).output(zEventType),
      update: oc.input(zEventTypeUpdate).output(zEventType),
      setActive: oc.input(zEventTypeSetActive).output(zEventType),
    },
    // Bookings of the public booking page (#1320): a member lists those they host (owners and admins the org's), and
    // the host cancels or moves one; the visitor is mailed.
    bookings: {
      list: oc.input(zBookingListQuery).output(z.array(zBookingItem)),
      cancel: oc.input(zBookingCancel).output(z.object({ bookingId: z.string(), status: z.literal('cancelled') })),
      move: oc.input(zBookingMove).output(z.object({ bookingId: z.string(), startsAt: z.string() })),
      // Link a booking to a deal and take the link off (#3103); a person confirms Dy's suggestion with `linkDeal`. Neither mails anyone.
      linkDeal: oc.input(zBookingDealLink).output(zBookingDealChanged),
      unlinkDeal: oc.input(zBookingDealUnlink).output(zBookingDealChanged),
      // Times to offer a client (#1440): read-only; the model, when the deployment has one, reads the pasted message.
      suggest: oc.input(zBookingSuggestInput).output(zBookingSuggestion),
      // Dy's brief before a confirmed, upcoming booking linked to a deal (#3115): the facts by code and, when the model is on, a summary and 2 to 3 points; computed when read, nothing stored or sent.
      meetingBrief: oc.input(zMeetingBriefInput).output(zMeetingBrief),
    },
    // The contacts of the CRM (K4, #2228): the org's parties, searched without Vietnamese marks, filtered and sorted by a
    // Filter AST of the `crm.party` scope (a saved view stores the same), a page at a time. Every role reads.
    contacts: {
      list: oc.input(zContactList).output(zContactPage),
      // The companies a person may work at (#2438): the sales coworker's suggestion, read only; a person links one with a click.
      companySuggestions: oc.input(zCompanySuggest).output(zCompanySuggested),
      // The conversations linked to the contact (#2333; for a company, its people's too), newest activity first, with no message body.
      conversations: oc.input(zPartyDealsQuery).output(z.array(zConversationOther)),
    },
    // Contact import (K5, #2229): rows read from a CSV in the browser are staged and classified without writing a party; the
    // person reads the preview, then commits (creating the new parties) or cancels. Owners, admins and members; every
    // role may read a preview.
    contactImport: {
      stage: oc.input(zImportStage).output(zImportPreview),
      preview: oc.input(zImportPreviewQuery).output(zImportPreview),
      commit: oc.input(zImportCommit).output(zImportCommitted),
      cancel: oc.input(zImportRef).output(zImportBatch),
    },
    // The org's one pipeline and its deals (#2225, docs/plan/crm.md): everyone reads; owners, admins and members write.
    pipeline: {
      stages: oc.input(z.strictObject({})).output(z.array(zPipelineStage)),
      // Creates the default stages when the org has none; answers the stages either way.
      setup: oc.input(z.strictObject({})).output(z.array(zPipelineStage)),
      // Owners and admins edit the open stages; each answers the stages afterwards.
      addStage: oc.input(zStageAdd).output(z.array(zPipelineStage)),
      renameStage: oc.input(zStageRename).output(z.array(zPipelineStage)),
      reorderStages: oc.input(zStageReorder).output(z.array(zPipelineStage)),
      removeStage: oc.input(zStageRemove).output(z.array(zPipelineStage)),
    },
    parties: { search: oc.input(zPartySearchQuery).output(z.array(zPartyChoice)) },
    deals: {
      board: oc.input(zBoardQuery).output(zBoard),
      list: oc.input(zDealListQuery).output(zDealPage),
      get: oc.input(zDealRef).output(zDeal),
      byParty: oc.input(zPartyDealsQuery).output(z.array(zDeal)),
      // The deal's bookings the caller may read, upcoming and past (#3103); owners, admins and members only, since a booking shows its guest.
      bookings: oc.input(zDealBookingsQuery).output(zDealBookings),
      // The conversations of the deal's contact since the deal opened (#2333), newest activity first, with no message body.
      conversations: oc.input(zDealRef).output(z.array(zConversationOther)),
      create: oc.input(zDealCreate).output(zDeal),
      update: oc.input(zDealUpdate).output(zDeal),
      move: oc.input(zDealMove).output(zDeal),
      delete: oc.input(zDealRef).output(zDealDeleted),
    },
    // The next steps the stale-deal rule raises for open deals (#2381, docs/plan/crm.md): everyone reads, owners, admins and members mark them done
    // or snooze them (up to 20 at once); the rule itself runs in the worker.
    nextSteps: {
      list: oc.input(zNextStepListQuery).output(zNextStepPage),
      done: oc.input(zNextStepDone).output(zNextStepChanged),
      snooze: oc.input(zNextStepSnooze).output(zNextStepChanged),
      // Dy's draft of the follow-up message for one step (#3101): a read for owners, admins and members; it sends nothing and stores no text.
      draft: oc.input(zFollowupDraftInput).output(zFollowupDrafted),
    },
    // After how many days without a change an open deal raises a next step: everyone reads, owners and admins set it.
    dealSetting: {
      get: oc.input(z.strictObject({})).output(zDealSetting),
      set: oc.input(zDealSettingSet).output(zDealSetting),
    },
    // Quotes of a deal (#2693, docs/plan/crm-quotes.md): everyone reads; owners, admins and members write a draft, delete it, or revise a quote that has left
    // `draft`; owners and admins set the org's defaults. Nothing here sends a quote (a later step).
    quotes: {
      list: oc.input(zQuoteListQuery).output(zQuotePage),
      get: oc.input(zQuoteRef).output(zQuote),
      byDeal: oc.input(zDealQuotesQuery).output(z.array(zQuoteSummary)),
      defaults: oc.input(zQuoteDefaultsQuery).output(zQuoteDefaults),
      // Dy's proposal for the lines (#2698): a read that never stores; a person applies or drops each line, and saves with `save`.
      suggest: oc.input(zQuoteSuggestInput).output(zQuoteSuggested),
      // The "Báo giá" tab of the Reports screen (#2699): counts and totals by status.
      report: oc.input(zQuoteReportQuery).output(zQuoteReport),
      save: oc.input(zQuoteSave).output(zQuote),
      deleteDraft: oc.input(zQuoteRef).output(zQuoteDeleted),
      send: oc.input(zQuoteSend).output(zQuoteSent),
      createLink: oc.input(zQuoteRef).output(zQuoteLinkCreated),
      revokeLink: oc.input(zQuoteLinkRevoke).output(zQuoteLinkRevoked),
      setting: oc.input(z.strictObject({})).output(zQuoteSetting),
      revise: oc.input(zQuoteRef).output(zQuote),
      // A person records that the customer accepted (one frozen sales order is made) or declined a sent quote (#2696, ADR-0050).
      accept: oc.input(zQuoteAccept).output(zQuoteDecided),
      decline: oc.input(zQuoteDecline).output(zQuoteDecided),
      setSetting: oc.input(zQuoteSettingSet).output(zQuoteSetting),
      setLogo: oc.input(zQuoteLogoSet).output(zQuoteSetting),
      removeLogo: oc.input(z.strictObject({})).output(zQuoteSetting),
    },
    // Sales orders of accepted quotes (#2696, ADR-0050): everyone reads; owners, admins and members cancel one that nothing was invoiced or delivered for. `handoff` is
    // the facts Kế toán takes to make an e-invoice draft (it refuses a cancelled order).
    salesOrders: {
      list: oc.input(zSalesOrderListQuery).output(zSalesOrderPage),
      get: oc.input(zSalesOrderRef).output(zSalesOrder),
      byDeal: oc.input(z.strictObject({ dealId: z.uuid() })).output(z.array(zSalesOrderSummary)),
      handoff: oc.input(zSalesOrderRef).output(zSalesOrderHandoff),
      cancel: oc.input(zSalesOrderCancel).output(zSalesOrderSummary),
      // A person marks a goods line delivered, or takes the mark back (#2697, ADR-0050 point 4); the stock move is Kế toán's own command, run by the screen.
      deliver: oc.input(zSalesOrderDeliver).output(zSalesOrderDeliveryChanged),
      undeliver: oc.input(zSalesOrderUndeliver).output(zSalesOrderDeliveryChanged),
    },
    // A member's bookings as a feed for Google Calendar or Outlook (#1382): each host makes, replaces and revokes their
    // own address; the token is in the create answer only.
    bookingFeed: {
      get: oc.input(z.object({})).output(z.object({ createdAt: z.string() }).nullable()),
      create: oc.input(z.strictObject({})).output(z.object({ token: z.string() })),
      revoke: oc.input(z.strictObject({})).output(z.object({ revoked: z.boolean() })),
    },
  },
  // HR (#2530, payroll plan 6.1), when the deployment runs the hr module: owners and admins only. Every read is a sensitive query (its audit row is written before it reads), and the
  // identity number and the bank account number come back only from `get`, opened from their sealed form for the one employee asked for.
  hr: {
    departments: {
      list: oc.input(zHrDepartmentList).output(z.array(zHrDepartmentView)),
      add: oc.input(zHrDepartmentAdd).output(zHrDepartmentWritten),
      edit: oc.input(zHrDepartmentEdit).output(zHrDepartmentWritten),
      setManager: oc.input(zHrDepartmentSetManager).output(zHrDepartmentWritten),
      archive: oc.input(zHrDepartmentRef).output(zHrDepartmentWritten),
    },
    employee: {
      contractPdf: oc.input(zHrEmployeeContractPdfAsk).output(zHrEmployeeContractPdf),
    },
    self: {
      profile: { get: oc.input(zHrSelfProfileAsk).output(zHrSelfProfile) },
      leave: {
        balance: oc.input(zHrSelfLeaveBalanceAsk).output(zHrSelfLeaveBalanceResult),
        requests: oc.input(zHrSelfLeaveRequestList).output(z.array(zHrLeaveRequestView)),
        submit: oc.input(zHrSelfLeaveRequestSubmit).output(zHrSelfLeaveSubmitResult),
        cancel: oc.input(zHrLeaveRequestRef).output(zHrLeaveRequestActionResult),
      },
      payslips: {
        list: oc.input(zHrSelfPayslipsList).output(z.array(zHrSelfPayslipSummary)),
        get: oc.input(zHrPayslipRef).output(zHrPayslip),
      },
      attendance: {
        checkIn: oc.input(zHrSelfAttendanceCheckIn).output(zHrAttendanceLogView),
        checkOut: oc.input(zHrSelfAttendanceCheckOut).output(zHrAttendanceLogView),
        list: oc.input(zHrSelfAttendanceList).output(zHrSelfAttendanceListResult),
      },
      onboarding: {
        get: oc.input(z.strictObject({})).output(zHrSelfOnboardingState),
        submit: oc.input(zHrSelfOnboardingSubmit).output(zHrSelfOnboardingSubmitResult),
        cancel: oc.input(zHrOnboardingSubmissionRef).output(zHrOnboardingCancelResult),
      },
      overtime: {
        list: oc.input(zHrSelfOvertimeList).output(zHrSelfOvertimeListResult),
        submit: oc.input(zHrSelfOvertimeSubmit).output(zHrSelfOvertimeSubmitResult),
        cancel: oc.input(zHrOvertimeRef).output(zHrOvertimeActionResult),
      },
      salaryAdvance: {
        list: oc.input(zHrSelfAdvanceList).output(zHrSelfAdvanceListResult),
        submit: oc.input(zHrSelfAdvanceSubmit).output(zHrSelfAdvanceSubmitResult),
        cancel: oc.input(zHrAdvanceRef).output(zHrAdvanceActionResult),
      },
      businessTrips: {
        list: oc.input(zHrSelfTripList).output(zHrSelfTripListResult),
        submit: oc.input(zHrSelfTripSubmit).output(zHrSelfTripSubmitResult),
        cancel: oc.input(zHrTripRef).output(zHrTripActionResult),
      },
      requestDraft: oc.input(zHrSelfRequestDraftAsk).output(zHrSelfRequestDraftResult),
      policyQa: oc.input(zHrSelfPolicyQaAsk).output(zHrSelfPolicyQaResult),
      assets: {
        list: oc.input(z.strictObject({})).output(z.array(zHrSelfAssetView)),
      },
    },
    attendance: {
      list: oc.input(zHrAttendanceList).output(zHrAttendanceListResult),
      adjust: oc.input(zHrAttendanceAdjust).output(zHrAdminAttendanceRow),
      qr: {
        rotate: oc.input(zHrAttendanceQrRotate).output(zHrAttendanceQrRotateResult),
      },
      anomaliesBrief: oc.input(zHrAttendanceAnomaliesAsk).output(zHrAttendanceAnomaliesBrief),
      rollupToPayroll: oc.input(zHrAttendanceRollupToPayroll).output(zHrAttendanceRollupResult),
    },
    onboarding: {
      list: oc.input(zHrOnboardingList).output(z.array(zHrOnboardingSubmissionView)),
      approve: oc.input(zHrOnboardingDecide).output(zHrOnboardingApproveResult),
      reject: oc.input(zHrOnboardingDecide).output(zHrOnboardingRejectResult),
    },
    overtimeRequests: {
      list: oc.input(zHrOvertimeList).output(z.array(zHrOvertimeRequestView)),
      approveL1: oc.input(zHrOvertimeDecide).output(zHrOvertimeActionResult),
      approveFinal: oc.input(zHrOvertimeDecide).output(zHrOvertimeActionResult),
      reject: oc.input(zHrOvertimeDecide).output(zHrOvertimeActionResult),
      settings: {
        get: oc.input(zHrOvertimeSettingsGet).output(zHrOvertimeSettings),
        set: oc.input(zHrOvertimeSettingsSet).output(zHrOvertimeSettings),
      },
    },
    salaryAdvances: {
      list: oc.input(zHrAdvanceList).output(z.array(zHrAdvanceRequestView)),
      approveL1: oc.input(zHrAdvanceDecide).output(zHrAdvanceActionResult),
      approveFinal: oc.input(zHrAdvanceDecide).output(zHrAdvanceActionResult),
      reject: oc.input(zHrAdvanceDecide).output(zHrAdvanceActionResult),
    },
    businessTrips: {
      list: oc.input(zHrTripList).output(z.array(zHrTripRequestView)),
      approveL1: oc.input(zHrTripDecide).output(zHrTripActionResult),
      approveFinal: oc.input(zHrTripDecide).output(zHrTripActionResult),
      reject: oc.input(zHrTripDecide).output(zHrTripActionResult),
    },
    probation: {
      preview: oc.input(zHrProbationPreviewAsk).output(zHrProbationPreviewResult),
      draftSummary: oc.input(zHrProbationDraftAsk).output(zHrProbationDraftResult),
      decide: oc.input(zHrProbationDecide).output(zHrProbationDecideResult),
      list: oc.input(zHrProbationList).output(z.array(zHrProbationReviewView)),
    },
    addendum: {
      list: oc.input(zHrAddendumList).output(z.array(zHrAddendumView)),
      create: oc.input(zHrAddendumCreate).output(zHrAddendumWriteResult),
      update: oc.input(zHrAddendumUpdate).output(zHrAddendumWriteResult),
      issue: oc.input(zHrAddendumIssue).output(zHrAddendumWriteResult),
      void: oc.input(zHrAddendumVoid).output(zHrAddendumWriteResult),
      pdf: oc.input(zHrAddendumPdfAsk).output(zHrAddendumPdfResult),
      check: oc.input(zHrAddendumCheckAsk).output(zHrAddendumCheckResult),
    },
    timeline: {
      get: oc.input(zHrTimelineAsk).output(zHrTimelineResult),
    },
    assets: {
      list: oc.input(zHrAssetList).output(z.array(zHrAssetView)),
      assign: oc.input(zHrAssetAssign).output(zHrAssetWriteResult),
      updateStatus: oc.input(zHrAssetUpdateStatus).output(zHrAssetWriteResult),
    },
    okr: {
      tree: oc.input(zHrOkrTreeAsk).output(zHrOkrTreeResult),
      projectOptions: oc.input(zHrOkrProjectOptionsAsk).output(zHrOkrProjectOptionsResult),
      projectTasks: oc.input(zHrOkrProjectTasksAsk).output(zHrOkrProjectTasksResult),
      draftCheckin: oc.input(zHrOkrDraftCheckinAsk).output(zHrOkrDraftCheckinResult),
      objective: {
        create: oc.input(zHrOkrObjectiveCreate).output(zHrOkrObjectiveMutationResult),
        update: oc.input(zHrOkrObjectiveUpdate).output(zHrOkrObjectiveMutationResult),
        updateStatus: oc.input(zHrOkrObjectiveSetStatus).output(zHrOkrObjectiveMutationResult),
      },
      kr: {
        add: oc.input(zHrOkrKeyResultAdd).output(zHrOkrKeyResultMutationResult),
        update: oc.input(zHrOkrKeyResultUpdate).output(zHrOkrKeyResultMutationResult),
        remove: oc.input(zHrOkrKeyResultRemove).output(zHrOkrKeyResultRemoveResult),
        checkin: oc.input(zHrOkrKeyResultCheckin).output(zHrOkrKeyResultMutationResult),
        syncProjects: oc.input(zHrOkrKeyResultSyncProjects).output(zHrOkrKeyResultMutationResult),
      },
    },
    leaveRequests: {
      list: oc.input(zHrLeaveRequestList).output(z.array(zHrLeaveRequestView)),
      approveL1: oc.input(zHrLeaveRequestDecide).output(zHrLeaveRequestActionResult),
      approveFinal: oc.input(zHrLeaveRequestDecide).output(zHrLeaveRequestActionResult),
      reject: oc.input(zHrLeaveRequestDecide).output(zHrLeaveRequestActionResult),
    },
    payroll: {
      employees: {
        list: oc.input(zHrEmployeeList).output(z.array(zHrEmployeeSummary)),
        get: oc.input(zHrEmployeeRef).output(zHrEmployee),
        add: oc.input(zHrEmployeeAdd).output(zHrWritten),
        edit: oc.input(zHrEmployeeEdit).output(zHrWritten),
        linkMember: oc.input(zHrEmployeeLinkMember).output(zHrWritten),
        finalization: oc.input(zHrFinalizationSet).output(zHrWritten),
        end: oc.input(zHrEmployeeEnd).output(zHrWritten),
        // An owner's erasure of an ended employee after the retention: shreds the person's key (R3).
        erase: oc.input(zHrEmployeeRef).output(zHrEmployeeErased),
        severance: oc.input(zHrEmployeeSeveranceAsk).output(zHrEmployeeSeveranceResult),
        job_loss: oc.input(zHrEmployeeJobLossAsk).output(zHrEmployeeJobLossResult),
      },
      // The saved layouts of the banks' bulk-salary files (#2893), owners and admins: list, create, edit and delete; the export applies one.
      bankTemplates: {
        list: oc.input(zHrBankTemplateList).output(z.array(zHrBankTemplate)),
        create: oc.input(zHrBankTemplateCreate).output(zHrBankTemplateWritten),
        edit: oc.input(zHrBankTemplateEdit).output(zHrBankTemplateWritten),
        delete: oc.input(zHrBankTemplateRef).output(zHrBankTemplateWritten),
      },
      // Pre-export readiness and Labor Code contract compliance review for labor_register and 01/PLI (#3372).
      laborCheck: oc.input(zHrLaborCheckAsk).output(zHrLaborCheckResult),
      employments: { add: oc.input(zHrEmploymentAdd).output(zHrWritten) },
      dependents: { add: oc.input(zHrDependentAdd).output(zHrWritten), end: oc.input(zHrDependentEnd).output(zHrWritten) },
      // The monthly pay run (#2531): open a month, type its inputs, read the sheet, approve it (R3, a fresh second factor), and correct an approved month by an adjustment line in a later run.
      // Every read is a sensitive query. The payslip is a view of a stored line.
      runs: {
        list: oc.input(zHrRunList).output(z.array(zHrRunSummary)),
        sheet: oc.input(zHrRunRef).output(zHrRunSheet),
        open: oc.input(zHrRunOpen).output(zHrRunWritten),
        recalculate: oc.input(zHrRunRecalculate).output(zHrRunWritten),
        importTimekeeping: oc.input(zHrRunImportTimekeeping).output(zHrRunWritten),
        thirteenthMonthPreview: oc.input(zHrRunThirteenthMonthPreview).output(zHrThirteenthMonthPreviewResult),
        applyThirteenthMonth: oc.input(zHrRunApplyThirteenthMonth).output(zHrRunWritten),
        syncLeave: oc.input(zHrRunRef).output(zHrRunWritten),
        syncOvertime: oc.input(zHrRunRef).output(zHrRunWritten),
        syncStage6b: oc.input(zHrRunSyncStage6b).output(zHrRunWritten),
        approve: oc.input(zHrRunApprove).output(zHrRunWritten),
      },
      adjustments: {
        list: oc.input(zHrAdjustmentList).output(z.array(zHrAdjustmentItemView)),
        create: oc.input(zHrAdjustmentCreate).output(zHrAdjustmentActionResult),
        approve: oc.input(zHrAdjustmentDecide).output(zHrAdjustmentActionResult),
        reject: oc.input(zHrAdjustmentDecide).output(zHrAdjustmentActionResult),
        cancel: oc.input(zHrAdjustmentRef).output(zHrAdjustmentActionResult),
      },
      // Annual leave ledger and statutory leave balance (#3394, #2540 slice 1c-2): owners and admins only, sensitive query for balance.
      leave: {
        balance: oc.input(zHrLeaveBalanceAsk).output(zHrLeaveBalanceResult),
        set: oc.input(zHrLeaveSet).output(zHrLeaveWritten),
        delete: oc.input(zHrLeaveDelete).output(zHrLeaveWritten),
      },
      // Where the posting and the payments of an approved month stand, for its card (#2532): from the books and the open proposals, no person and no amount; owners and admins.
      settlement: oc.input(zPayrollSettlementRef).output(zPayrollSettlement),
      // Continuous payroll fluctuation preview and What-Changed diff (#4445, Stage 5E): read-only, owners and admins, compares draft or projected month against prior finalized run.
      previewDiff: oc.input(zHrPayrollPreviewDiffAsk).output(zHrPayrollPreviewDiff),
      lines: {
        setInputs: oc.input(zHrLineInputsSet).output(zHrRunWritten),
        adjust: oc.input(zHrLineAdjust).output(zHrRunWritten),
        payslip: oc.input(zHrPayslipRef).output(zHrPayslip),
      },
      // The finance coworker's part (#2534, #4445): prepare the month, flag anomalies, explain a payslip, narrate a What-Changed diff, on pseudonymized sheets. Read-only, owners and admins, AI off or spent: `ai` says so.
      coworker: {
        prepare: oc.input(zHrCoworkerAsk).output(zHrCoworkerPrepared),
        flag: oc.input(zHrCoworkerAsk).output(zHrCoworkerFlagged),
        explain: oc.input(zHrCoworkerPayslipAsk).output(zHrCoworkerExplained),
        explainDiff: oc.input(zHrPayrollDiffExplainAsk).output(zHrPayrollDiffExplained),
      },
    },
    // Lightweight recruiting (#3425, Stage 3 slice 3b-2): openings, candidate pipeline, calendar interviews,
    // 1-click hire to payroll employee + initial employment, and Ly pseudonymized screening brief.
    recruiting: {
      openings: {
        list: oc.input(zHrOpeningList).output(z.array(zHrOpeningView)),
        add: oc.input(zHrOpeningAdd).output(zHrOpeningWritten),
        edit: oc.input(zHrOpeningEdit).output(zHrOpeningWritten),
        close: oc.input(zHrOpeningClose).output(zHrOpeningWritten),
      },
      candidates: {
        list: oc.input(zHrCandidateList).output(z.array(zHrCandidateView)),
        get: oc.input(zHrCandidateRef).output(zHrCandidateView),
        add: oc.input(zHrCandidateAdd).output(zHrCandidateWritten),
        edit: oc.input(zHrCandidateEdit).output(zHrCandidateWritten),
        moveStage: oc.input(zHrCandidateMoveStage).output(zHrCandidateWritten),
        scheduleInterview: oc.input(zHrCandidateScheduleInterview).output(zHrCandidateInterviewScheduled),
        cancelInterview: oc.input(zHrCandidateRef).output(zHrCandidateInterviewCancelled),
        hire: oc.input(zHrCandidateHire).output(zHrCandidateHireResult),
        erase: oc.input(zHrCandidateRef).output(zHrCandidateEraseResult),
      },
      interviewers: {
        list: oc.output(z.array(zHrInterviewerOption)),
      },
      interviewSlots: oc.input(zHrInterviewSlotsAsk).output(zHrInterviewSlotsResult),
      brief: oc.input(zHrRecruitingBriefAsk).output(zHrRecruitingBriefResult),
      analytics: oc.input(zHrRecruitingAnalyticsQuery).output(zHrRecruitingAnalyticsResult),
      inviteDraft: oc.input(zHrInviteDraftAsk).output(zHrInviteDraftResult),
    },
  },
  // Members' notes (#1671, ADR-0037), when the deployment runs the notes module: private to their author or shared with
  // the org; the database's row policies decide what each caller reads. Viewers read none.
  notes: {
    list: oc.input(zNoteList).output(z.array(zNoteSummary)),
    get: oc.input(zNoteRef).output(zNote),
    backlinks: oc.input(zNoteBacklinksInput).output(z.array(zNoteSummary)),
    search: oc.input(zNoteSearch).output(z.array(zNoteSummary)),
    panel: oc.input(zNoteLinkTarget).output(zNoteRecordPanelView),
    create: oc.input(zNoteCreate).output(zNoteWritten),
    clip: oc.input(zNoteClip).output(zNoteWritten),
    fromMeetingSummary: oc.input(zNoteFromMeetingSummary).output(zNoteWritten),
    update: oc.input(zNoteUpdate).output(zNoteWritten),
    setVisibility: oc.input(zNoteSetVisibility).output(zNoteWritten),
    pin: oc.input(zNoteRef).output(zNoteWritten),
    unpin: oc.input(zNoteRef).output(zNoteWritten),
    archive: oc.input(zNoteRef).output(zNoteWritten),
    restore: oc.input(zNoteRef).output(zNoteWritten),
    delete: oc.input(zNoteRef).output(zNoteWritten),
    linkAdd: oc.input(zNoteLinkAdd).output(zNoteLinkWritten),
    linkRemove: oc.input(zNoteLinkRemove).output(zNoteLinkWritten),
    attachments: {
      list: oc.input(zNoteRef).output(z.array(zNoteAttachment)),
      delete: oc.input(zNoteAttachmentRef).output(zNoteAttachmentDeleted),
    },
    // Notebooks and 2-level stacks (#3559): private to their author or shared with the org.
    notebooks: {
      list: oc.input(z.strictObject({})).output(zNotebooksResponse),
      create: oc.input(zNotebookCreate).output(zNotebookWritten),
      update: oc.input(zNotebookUpdate).output(zNotebookWritten),
      delete: oc.input(zNotebookRef).output(zNotebookDeleted),
    },
    // Rolling 20-snapshot version history and custom templates (#3562, Notes v2 E3).
    versions: oc.input(zNoteRef).output(z.array(zNoteVersion)),
    restoreVersion: oc.input(zNoteRestoreVersion).output(zNoteWritten),
    templates: {
      list: oc.input(z.strictObject({})).output(z.array(zNoteTemplate)),
      create: oc.input(zNoteTemplateCreate).output(zNoteTemplateWritten),
      update: oc.input(zNoteTemplateUpdate).output(zNoteTemplateWritten),
      delete: oc.input(zNoteTemplateRef).output(zNoteTemplateDeleted),
    },
    // How many private notes each member has, for an owner or admin before removing one; no text.
    privateCounts: oc.input(z.strictObject({})).output(z.array(zNotePrivateCount)),
    // The caller's own notes and to-dos, whole, for their download (#1678): never anyone else's.
    exportMine: oc.input(z.strictObject({})).output(zNotesExport),
    // Member-scoped Vy for Notes (N8, #1677, ADR-0049): status, interactive summary & to-do suggestion, latest private results, author summary acceptance.
    vyStatus: oc.input(z.strictObject({})).output(zNoteVyStatus),
    summarize: oc.input(zNoteSummarizeInput).output(zNoteSummarizeResult),
    suggestTodos: oc.input(zNoteSuggestTodosInput).output(zNoteSuggestTodosResult),
    // Notes v2 (T4b & E5b, #3563, ADR-0049): member-scoped Vy daily focus planner and unfiled inbox organizer.
    todoPlan: oc.input(zTodoPlanInput).output(zTodoPlanResult),
    organize: oc.input(zNoteOrganizeInput).output(zNoteOrganizeResult),
    vyResults: oc.input(zNoteRef).output(zNoteVyResults),
    acceptSummary: oc.input(zNoteAcceptSummary).output(zNoteWritten),
    // The caller's own to-dos (#1673), which nobody else reads: not another member, an owner or an admin.
    todos: {
      list: oc.input(zTodoList).output(z.array(zTodoSummary)),
      get: oc.input(zTodoRef).output(zTodo),
      create: oc.input(zTodoCreate).output(zTodoWritten),
      quickCapture: oc.input(zTodoQuickCapture).output(zTodoWritten),
      acceptSuggestions: oc.input(zTodoAcceptSuggestions).output(zTodoAcceptSuggestionsResult),
      update: oc.input(zTodoUpdate).output(zTodoWritten),
      complete: oc.input(zTodoComplete).output(zTodoCompleteResult),
      reopen: oc.input(zTodoReopen).output(zTodoWritten),
      reorder: oc.input(zTodoReorder).output(zTodoWritten),
      reschedule: oc.input(zTodoReschedule).output(zTodoRescheduled),
      delete: oc.input(zTodoRef).output(zTodoWritten),
      restore: oc.input(zTodoRef).output(zTodoWritten),
      linkAdd: oc.input(zTodoLinkAdd).output(zTodoLinkWritten),
      linkRemove: oc.input(zTodoLinkRemove).output(zTodoLinkWritten),
      // Hands an open to-do over to a position as a team task (#1674), with the text the member confirmed.
      handOver: oc.input(zTodoHandOver).output(zTodoHandedOver),
      // My work: my open to-dos and the open tasks of the positions I hold (#1674).
      myWork: oc.input(zMyWorkInput).output(zMyWork),
      // How many to-dos each member has, for an owner or admin before removing one; no text.
      counts: oc.input(z.strictObject({})).output(z.array(zTodoCount)),
      // Personal to-do lists and inline sections (#3558).
      lists: {
        list: oc.input(z.strictObject({})).output(zTodoListsResponse),
        create: oc.input(zTodoListCreate).output(zTodoListWritten),
        update: oc.input(zTodoListUpdate).output(zTodoListWritten),
        delete: oc.input(zTodoListRef).output(zTodoListWritten),
      },
    },
  },
  // AI Meeting Notes (issue #2576, ADR-0047, meetings plan M2).
  meetings: {
    list: oc.input(zMeetingListInput).output(z.array(zMeetingListItem)),
    get: oc.input(zMeetingRef).output(zMeetingDetail),
    create: oc.input(zMeetingCreate).output(zMeetingCreated),
    // The click on "Nhập" for a recording a meeting platform finished (C1, #3173): makes the meeting with its consent record and starts the download. The app then claims the staged bytes through the media route.
    importStart: oc.input(zMeetingImportStart).output(zMeetingCreated),
    // The app calls it after a failed import is dismissed and before its platform connection is disconnected: the empty meeting of the failed try goes (#3587).
    importDiscardEmpty: oc.input(zMeetingImportDiscardEmpty).output(zMeetingImportDiscarded),
    // The recorder picks the minutes template of their meeting (A4, #3162).
    setTemplate: oc.input(zMeetingTemplateSet).output(zMeetingTemplateSetDone),
    // The status of a meeting the calling extension token created, and nothing of its content (issue #2582).
    extensionStatus: oc.input(zMeetingRef).output(zMeetingExtensionStatus),
    // The extension reports that a recording of its own token ended with no media reaching the server, so the app's recording chip lets go (#3196).
    recordingStopped: oc.input(zMeetingRecordingStopped).output(zMeetingRecordingStoppedDone),
    // The heartbeat of a running capture, from the extension and the app's recorder every 30 seconds, and its end when the person stops (ADR-0055 slice 1, #4123).
    captureHeartbeat: oc.input(zCaptureHeartbeat).output(zCaptureHeartbeatDone),
    // The calling member's meeting the extension is recording right now, for the app's recording chip (A1, #3159).
    recordingNow: oc.input(zMeetingRecordingNowInput).output(zMeetingRecordingNow),
    // The recorder's own new title for a meeting (#3947): a pick from Vy's suggestions or a title they typed; audited, ids only.
    rename: oc.input(zMeetingRename).output(zMeetingRenamed),
    delete: oc.input(zMeetingRef).output(zMeetingDeleted),
    ownerDelete: oc.input(zMeetingRef).output(zMeetingDeleted),
    // The owner's compliance list (#2703): every meeting of the org as metadata only, no title or text, a page at a time; audited per call.
    ownerList: oc.input(zMeetingOwnerListInput).output(zMeetingOwnerList),
    // Live notes of a meeting being recorded (L4a-2, #3110, ADR-0052): the recorder's own pane. `liveStatus` is the poll, `liveTick` copies a finished window
    // and starts the next one, and the pair of buttons starts and stops them. Only the recorder of a meeting that opted in at its consent step sees anything.
    liveStatus: oc.input(zLiveRef).output(zLiveStatus),
    liveStart: oc.input(zLiveStart).output(zLiveStarted),
    liveTick: oc.input(zLiveTick).output(zLiveTicked),
    liveStop: oc.input(zLiveRef).output(zLiveStopped),
    // The running notes, made by the recorder's Vy from the new preview lines and the previous notes only; the answer says how it went in fixed words.
    liveNotes: oc.input(zLiveNotesAsk).output(zLiveNotesDone),
    // Links to parties, a deal and the calendar event (L1, #2587): the recorder sets and removes them; a page reads only the meetings its viewer reads.
    links: {
      add: oc.input(zMeetingLinkAdd).output(zMeetingLink),
      remove: oc.input(zMeetingLinkRemove).output(zMeetingLinkRemoved),
      list: oc.input(zMeetingRef).output(z.array(zMeetingLink)),
      byTarget: oc.input(zMeetingsOfTargetInput).output(z.array(zMeetingOfTarget)),
      // Vy's tainted suggestion for the recorder (L1, #2587): contacts and deals the transcript names. Nothing is linked by it.
      suggest: oc.input(zMeetingRef).output(zMeetingLinkSuggested),
    },
    // The follow-up email after a meeting (L3, #2590, #4292): the recorder drafts it from the published summary (or, for the recorder alone, an unpublished draft), picks either structured
    // minutes or a personal note (optionally drafted by their own member-scoped Vy), edits it and sends it, one mail per address, checked recipients. Nothing is sent without `send`.
    followup: {
      draft: oc.input(zFollowupDraftAsk).output(zFollowupDraft),
      wording: oc.input(zFollowupWordingAsk).output(zFollowupWording),
      noteStatus: oc.input(zMeetingRef).output(zFollowupNoteStatus),
      note: oc.input(zFollowupNoteAsk).output(zFollowupNoteAnswer),
      send: oc.input(zFollowupSendCall).output(zFollowupSent),
    },
    // Vy proposing the update of the deal a meeting is linked to (#4766): the recorder of a meeting with published minutes asks their own Vy for the deal's next step and a short note, reads and
    // edits them, and confirms; nothing is written before `confirm` (R1: a task, a line of the contact's timeline, the stale-deal reminder closed).
    dealUpdate: {
      status: oc.input(zMeetingRef).output(zDealUpdateStatus),
      propose: oc.input(zDealUpdateAsk).output(zDealUpdateAnswer),
      confirm: oc.input(zDealUpdateConfirmCall).output(zDealUpdateConfirmed),
    },
    // Approved minutes posted to a Slack or Microsoft Teams channel (B4, #3168): an owner or admin pastes a webhook address (sealed, never shown again); the recorder of a meeting with a published result reads the
    // exact message (`preview`), picks a channel and presses "Gửi" (`post`, R2: queues the post, which the worker's job sends through the egress guard; no model).
    chat: {
      channels: oc.input(zChatEmpty).output(zChatChannelList),
      saveChannel: oc.input(zChatChannelSaveCall).output(zChatChannelSaved),
      removeChannel: oc.input(zChatChannelRemove).output(zChatChannelRemoved),
      preview: oc.input(zMeetingRef).output(zChatPreview),
      post: oc.input(zChatPostCall).output(zChatPosted),
      // How the recorder's newest post of the meeting to a channel stands (the dialog polls it after the click: the post is sent by the worker's job).
      status: oc.input(zChatStatusInput).output(zChatStatus),
    },
    // Minutes templates the org writes (#3578): every member reads the active ones, an owner or admin writes them (an archived one is read only, and only they see it). The meeting keeps
    // its own copy of the sections when the recorder picks one (setTemplate). MINUTES_TEMPLATE_NOT_FOUND (404), MINUTES_TEMPLATE_ARCHIVED and MINUTES_TEMPLATE_NAME_TAKEN (409), MINUTES_TEMPLATE_SECTIONS_INVALID and
    // MINUTES_TEMPLATES_MAX (422).
    template: {
      list: oc.input(zMinutesTemplateList).output(zMinutesTemplates),
      create: oc.input(zMinutesTemplateCreate).output(zMinutesTemplateDone),
      update: oc.input(zMinutesTemplateUpdate).output(zMinutesTemplateDone),
      archive: oc.input(zMinutesTemplateArchive).output(zMinutesTemplateDone),
    },
    // The org's glossary (#4043): terms Vy spells the way the org does. Owner and admin only, for the list too. GLOSSARY_TERM_TAKEN (409), GLOSSARY_TERM_NOT_FOUND (404), GLOSSARY_MAX (422).
    glossary: {
      list: oc.input(zGlossaryList).output(zGlossaryTerms),
      add: oc.input(zGlossaryAdd).output(zGlossaryDone),
      update: oc.input(zGlossaryUpdate).output(zGlossaryDone),
      remove: oc.input(zGlossaryRemove).output(zGlossaryDone),
    },
    // The org's three retention settings (#2579): anyone who reads meetings sees them, an owner or admin changes them.
    settings: {
      get: oc.input(zMeetingSettingsGet).output(zMeetingSettings),
      set: oc.input(zMeetingSettingsSet).output(zMeetingSettings),
    },
    // "Cần xác nhận trước khi ghi" (A2, #3160): standard or strict; every member reads it, an owner or admin changes it.
    consentPolicy: {
      get: oc.input(zMeetingConsentPolicyGet).output(zMeetingConsentPolicy),
      set: oc.input(zMeetingConsentPolicy).output(zMeetingConsentPolicy),
    },
    // "Ký biên bản họp" (#4703): whether minutes may be sent for eSign; off by default, every member reads it, an owner or admin changes it.
    minutesEsign: {
      get: oc.input(zMeetingMinutesEsignGet).output(zMeetingMinutesEsign),
      set: oc.input(zMeetingMinutesEsign).output(zMeetingMinutesEsign),
    },
    // The published biên bản as a Word file (#4774): built on the server from the published rows only, under the caller's own row security (the minutes page's reader rule); the file comes back in the answer.
    // MINUTES_NOT_PUBLISHED (409) when nothing is shared yet.
    minutesDocx: {
      download: oc.input(zMinutesDocxInput).output(zMinutesDocx),
    },
    // The link to the published minutes for people outside the org (#4822): the recorder makes it (the token comes back once), lists and revokes; an owner or admin switches the feature (off by default).
    minutesLink: {
      switch: {
        get: oc.input(zMinutesLinkSwitchGet).output(zMinutesLinkSwitch),
        set: oc.input(zMinutesLinkSwitch).output(zMinutesLinkSwitch),
      },
      create: oc.input(zMinutesLinkCreate).output(zMinutesLinkCreated),
      revoke: oc.input(zMinutesLinkRevoke).output(zMinutesLinkRevoked),
      list: oc.input(zMinutesLinkList).output(zMinutesLinkItems),
    },
    // A member's own webhook for the minutes they publish (A6, #3164): the card reads `get`, `set` makes or changes it (the secret comes back once, when it is made), `rotateSecret`, `clear` and
    // `test` (a `ping` with no meeting data). The owner's `switch` (off by default) gates all of it; nothing is sent while it is off.
    hook: {
      get: oc.input(zMeetingHookNone).output(zMeetingHookState),
      set: oc.input(zMeetingHookSet).output(zMeetingHookWithSecret),
      rotateSecret: oc.input(zMeetingHookNone).output(zMeetingHookWithSecret),
      clear: oc.input(zMeetingHookNone).output(zMeetingHookCleared),
      test: oc.input(zMeetingHookNone).output(zMeetingHookTested),
      switch: oc.input(zMeetingHooksSwitch).output(zMeetingHooksSwitch),
    },
    // Search across the transcript lines the caller reads (L2, #2589): plain folded text search, no model call.
    search: oc.input(zMeetingSearchInput).output(zMeetingSearchResult),
    // How each speaker spoke (#4919): pace, filler words and the longest stretch without a pause, counted by code from the lines the caller reads. Counts and words of a fixed list only.
    speakingStyle: { get: oc.input(zSpeakingStyleInput).output(zSpeakingStyle) },
    // Ask across meetings (A3, #3161): the member's own Vy answers a question from the lines the member's own search finds, each sentence with a citation to a transcript line; nothing is stored or sent.
    // `status` is the box (may Vy be asked now, the cost of one question), `ask` is the click.
    ask: {
      status: oc.input(zAskEmpty).output(zAskStatus),
      ask: oc.input(zAskInput).output(zAskAnswer),
      // The lines a question's search finds (with `meetingId`, in that meeting only): the plain list the box shows when Vy cannot be asked. No model.
      lines: oc.input(zAskMeetingLinesInput).output(zAskLines),
    },
    // Vy's brief before a meeting (#3543): `facts` are read by code as the member (the decisions of the previous meeting of the series if they read it, the open items, the linked customer's open deals) and work with AI
    // off; `status` is the button (may Vy be used now, the cost of one brief), `write` the click that has the member's own Vy write two or three sentences from those facts. Nothing is stored or sent.
    brief: {
      facts: oc.input(zBriefTarget).output(zBriefFacts),
      status: oc.input(zBriefEmpty).output(zBriefStatus),
      write: oc.input(zBriefTarget).output(zBriefAnswer),
    },
    // The recorder's Vy suggesting a title from the transcript (#3947): `status` is the button (the same answer as the chapters'), `suggest` the click that has the recorder's own Vy write up to three candidates.
    // The candidates go back to the browser and are stored nowhere; the recorder's pick is `meetings.rename`.
    title: {
      status: oc.input(zSummaryRef).output(zSummaryStatus),
      suggest: oc.input(zSummaryRef).output(zTitleAnswer),
    },
    // Spoken cues to Vy (#4807): the recorder's click finds "Vy ơi, ghi lại ..." in the transcript by code and drafts one marked action item for each, citing its line; nothing is published or made a task.
    voiceCue: {
      draft: oc.input(zVoiceCueDraft).output(zVoiceCueDrafted),
    },
    // What each speaker committed to or decided (#3954): `status` is the button (the same answer as the chapters'), `list` the click that has the recorder's own Vy list, from the transcript, each speaker's commitments
    // and decisions with the second of the line each rests on. The lines go back to the browser and are stored nowhere; nothing is published or made a task from here.
    commitments: {
      status: oc.input(zSummaryRef).output(zSummaryStatus),
      list: oc.input(zSummaryRef).output(zCommitmentsAnswer),
    },
    // Suggesting the minutes template from the meeting itself (#4772): `suggest` is code's answer (the series, a linked deal, words in the title, the number of people; no model), `status` is the button of Vy's fallback (the
    // same answer as the chapters') and `vy` the click that has the recorder's own Vy read the transcript when code cannot tell. Nothing is stored; the recorder accepts with the existing `setTemplate`.
    templateSuggest: {
      suggest: oc.input(zSummaryRef).output(zTemplateSuggestion),
      status: oc.input(zSummaryRef).output(zSummaryStatus),
      vy: oc.input(zSummaryRef).output(zTemplateVyAnswer),
    },
    // What a meeting left open (#4768): `status` is the button (the same answer as the chapters'), `list` the click that has the recorder's own Vy list, from the transcript, the questions asked and not answered and the
    // topics where a decision was raised and not taken, each with the second of the line it rests on. The lines go back to the browser and are stored nowhere; nothing is published or made a task from here.
    openPoints: {
      status: oc.input(zSummaryRef).output(zSummaryStatus),
      list: oc.input(zSummaryRef).output(zOpenPointsAnswer),
    },
    // Sales call insights for a meeting linked to an open deal (#4920, L26): `status` feeds the button (recorder + linked open deal + transcript), `analyze` runs the recorder's own Vy once to extract
    // customer concerns, buying signals and agreed next steps citing existing transcript line IDs, plus code-computed customer talk-time share from mapped speakers. Results stay tainted and ephemeral.
    salesInsight: {
      status: oc.input(zSummaryRef).output(zSalesInsightStatus),
      analyze: oc.input(zSummaryRef).output(zSalesInsightAnswer),
    },
    // This week's decisions and what is still open, across the meetings the member reads (#3949): `facts` are read by code as the member (published decisions and open action items of the meetings that started in the
    // last 7, 14 or 30 days) and work with AI off; `status` is the button (may Vy be used now, the cost of one recap), `recap` the click that has the member's own Vy write two or three sentences from those facts. Nothing
    // is stored or sent.
    digest: {
      facts: oc.input(zDigestAsk).output(zDigestFacts),
      status: oc.input(zBriefEmpty).output(zDigestStatus),
      recap: oc.input(zDigestAsk).output(zDigestAnswer),
    },
    // The week's meeting load (#4770), for an owner or an admin: per member the meetings and minutes of a week, and the recurring series that may be worth trimming, read by code from the meetings the caller reads (no
    // extra right to read, no text, no model call, nothing stored).
    load: {
      week: oc.input(zLoadWeekInput).output(zLoadWeek),
    },
    // Keyword trackers (#4818): `list` the org's tracked words for every member, `add` and `remove` for an owner or an admin, `hits` what one meeting says (counts and seconds, from the lines the caller reads)
    // and `week` the hits across the meetings the caller reads in a week. Counted by code, nothing stored, no model call.
    tracker: {
      list: oc.input(zTrackerList).output(zTrackerTerms),
      add: oc.input(zTrackerAdd).output(zTrackerDone),
      remove: oc.input(zTrackerRemove).output(zTrackerDone),
      hits: oc.input(zTrackerMeetingInput).output(zTrackerHits),
      week: oc.input(zTrackerWeekInput).output(zTrackerWeek),
    },
    // Highlights on a transcript line or range (#4819): `list` the marks of a meeting the caller may read, `add` and `remove` the caller's own (the recorder removes any mark of their meeting). A mark
    // is an anchor in seconds and who made it, no text: the lines are read from the transcript.
    highlight: {
      list: oc.input(zMeetingRef).output(zHighlights),
      add: oc.input(zHighlightAdd).output(zHighlightAdded),
      remove: oc.input(zHighlightRemove).output(zHighlightRemoved),
    },
    // Labels on a meeting (#4955): `list` the labels of one meeting the caller may read, and the recorder's `add` and `remove`. The labels of the meetings on the list come with the list itself (#4966).
    label: {
      list: oc.input(zMeetingRef).output(zMeetingLabels),
      add: oc.input(zLabelAdd).output(zLabelAdded),
      remove: oc.input(zLabelRemove).output(zLabelRemoved),
    },
    // The Today view (#3955): the member's own agenda for today with the facts of each event's brief, read by code as the member in one call and working with AI off. Vy's sentences stay the brief's own click.
    today: {
      facts: oc.input(zBriefEmpty).output(zMeetingsTodayFacts),
    },
    // The opt-in morning notice of the day's meetings (#3955, part B): the member's own setting (off until they turn it on, a time of day in their own zone); the worker sends one in-app notice and one mail a day with
    // the count of the day's meetings and a link, never a title.
    morning: {
      get: oc.input(zMorningEmpty).output(zMorningState),
      set: oc.input(zMorningSet).output(zMorningState),
    },
    // Who an action item belongs to, by Vy, when code found nobody (#3921, step 2): `status` is the button (may Vy be used now), `suggest` the click that has the member's own Vy pick one of the people they may give
    // the work to from the name said in the meeting, or nobody. The model sees names only; the answer is a number the route maps to a person; nothing is stored, and a person still picks the seat and makes the task.
    assignee: {
      status: oc.input(zBriefEmpty).output(zAssigneeStatus),
      suggest: oc.input(zAssigneeAsk).output(zAssigneeAnswer),
    },
    // Agenda adherence (#3959): after a meeting with a transcript the recorder may click once and have their own Vy compare the agenda (the series' open items and up to eight typed lines) with the transcript. `agenda` is the
    // list the recorder sees before clicking (with AI off too), `status` the button (may Vy be used now), `check` the click. Per agenda line: covered with the transcript lines it cites, or not heard; no score, nothing per
    // person, nothing stored.
    adherence: {
      agenda: oc.input(zAdherenceRef).output(zAdherenceAgenda),
      status: oc.input(zAdherenceRef).output(zAdherenceStatus),
      check: oc.input(zAdherenceAsk).output(zAdherenceAnswer),
    },
    // A member's own Google Calendar meetings, read to suggest "record this meeting" (B1, #3165): no model; code matches by time and a person confirms. `list` is today's meetings, `suggest` the event
    // a recording overlaps, `setReadEvents` the member's switch (the cache is deleted when it goes off), `link` the click that attaches a recorded meeting to its event.
    agenda: {
      list: oc.input(zAgendaListInput).output(zAgendaList),
      // The extension's "Sắp họp" card (B2, #3166, the `agenda` token scope): the next few events, title, time and join host only.
      next: oc.input(zAgendaNextInput).output(zAgendaNext),
      suggest: oc.input(zAgendaSuggestInput).output(zAgendaSuggestion),
      setReadEvents: oc.input(zAgendaSetReadEvents).output(zAgendaReadEventsSet),
      link: oc.input(zAgendaLink).output(zAgendaLinked),
    },
    // A series of meetings (#3542): `openItems` the previous meeting's items that are still open, for the "Việc còn dở từ buổi trước" block; `set` the recorder's click that says this meeting follows an earlier one.
    series: {
      openItems: oc.input(zSeriesOpenItemsInput).output(zSeriesOpenItems),
      set: oc.input(zSeriesSet).output(zSeriesSetResult),
    },
    // The transcript (#2578): the recorder's draft, read, replaced by a transcription run and corrected by hand.
    transcript: {
      get: oc.input(zMeetingRef).output(zTranscript),
      // The transcript the caller reads as a plain text or SRT file (#4817): built on the server under the transcript page's reader rule; the file comes back in the answer. TRANSCRIPT_EXPORT_EMPTY (409) with no line.
      download: oc.input(zTranscriptExportInput).output(zTranscriptExport),
      draftStore: oc.input(zTranscriptDraftStore).output(zTranscriptDraftStored),
      correct: oc.input(zTranscriptCorrect).output(zTranscriptCorrected),
      // The recorder's own Vy transcribes in the background; the recorder starts it, sees its state and copies the finished result into the draft (#2578, M4b).
      start: oc.input(zTranscribeStart).output(zTranscribeStarted),
      // The recorder stops their own run (#3033), so a lost job does not hold their slot until it expires.
      cancel: oc.input(zTranscribeCancel).output(zTranscribeCancelled),
      status: oc.input(zTranscribeRunRef).output(zTranscribeStatus),
      copyResult: oc.input(zTranscriptCopy).output(zTranscriptDraftStored),
      // Code-assisted draft redaction (#4001): proposes sensitive values across draft publish surfaces and hides only confirmed selections.
      redactCandidates: oc.input(zMeetingRef).output(zTranscriptRedactCandidates),
      redact: oc.input(zTranscriptRedact).output(zTranscriptRedacted),
    },
    // The summary, the decisions and the action items (#2580): the recorder's drafts, published by one click to the meeting's readers, and the tasks made from items.
    results: {
      get: oc.input(zMeetingRef).output(zMeetingResults),
      saveSummary: oc.input(zMeetingResultSave).output(zMeetingResultSaved),
      publish: oc.input(zResultPublish).output(zResultPublished),
      copySummary: oc.input(zSummaryCopy).output(zSummaryCopied),
      review: oc.input(zDraftReview).output(zDraftReviewed),
      summaryStatus: oc.input(zSummaryRef).output(zSummaryStatus),
      summarize: oc.input(zSummaryRef).output(zSummarized),
      // "Ghi chú của tôi" (A5, #3163): the recorder's own rough notes, theirs alone; `enhance` is the recorder's Vy expanding them with the transcript (the same run family and budget
      // as the summary), `enhancePreview` the finished expansion with their own lines and Vy's told apart, copied into the draft by `copySummary`.
      notesGet: oc.input(zMeetingRef).output(zNotes),
      notesSave: oc.input(zNotesSave).output(zNotesSaved),
      // The table of contents (#3844): `chaptersGet` the recorder's draft and published chapters, or a reader's published ones; `chaptersSave` the recorder's own set, replacing their draft.
      chaptersGet: oc.input(zMeetingRef).output(zChapters),
      chaptersSave: oc.input(zChaptersSave).output(zChaptersSaved),
      // The recorder's Vy writing the chapters (#3844, the same run family and budget lines as the summary but its own meter key): `chaptersStatus` feeds the button, `chaptersRun` makes the run,
      // `chaptersCopy` copies a finished run into the recorder's draft as the model's text, not yet read.
      chaptersStatus: oc.input(zSummaryRef).output(zSummaryStatus),
      chaptersRun: oc.input(zSummaryRef).output(zSummarized),
      chaptersCopy: oc.input(zChaptersCopy).output(zChaptersCopied),
      enhance: oc.input(zSummaryRef).output(zSummarized),
      enhancePreview: oc.input(zNotesPreviewInput).output(zNotesPreview),
      // Speaker names (#3502): the recorder's Vy may suggest which attendee a speaker label is; `speakerSuggestions` is what a finished summary run suggested and still applies,
      // `nameSpeaker` is the recorder's click that gives the draft lines of one label that attendee's name. Nothing is renamed without the click.
      speakerSuggestions: oc.input(zSpeakerSuggestionsInput).output(zSpeakerSuggestions),
      nameSpeaker: oc.input(zSpeakerName).output(zSpeakerNamed),
    },
    // The machine translation of the summary (meetings integrations E1, #3184): the member's own Vy translates what they read; the result is theirs alone, beside the original.
    // `status` is the button (enabled or why not, the target language, the expected cost), `translate` is the click, `get` the member's own translations.
    translation: {
      status: oc.input(zTranslationRef).output(zTranslationStatus),
      translate: oc.input(zTranslationRef).output(zTranslated),
      get: oc.input(zMeetingRef).output(zTranslations),
      // The original the recorder reviews a version against: the published segments and the hash that names them (what `minutesVersion.publish` is held to).
      source: oc.input(zTranslationRef).output(zTranslationSource),
      // The same for the transcript (E2, #3185): the member's own Vy translates the lines they read a few chunks at a time, in the request. `transcriptTranslate` is the click (the page asks
      // again while it is open), `transcriptStop` ends the member's own run, `transcriptStatus` is the button and the progress, and `transcriptGet` is the member's parts beside the lines.
      transcriptStatus: oc.input(zTranscriptTranslationRef).output(zTranscriptTranslationStatus),
      transcriptTranslate: oc.input(zTranscriptTranslationRef).output(zTranscriptTranslated),
      transcriptStop: oc.input(zMeetingRef).output(zTranscriptTranslateStopped),
      transcriptGet: oc.input(zTranscriptTranslationRef).output(zTranscriptTranslationView),
    },
    // The second-language version of the published minutes (#4777): the recorder's reviewed text, published beside the original by their click; every reader of the meeting reads it.
    // MINUTES_NOT_PUBLISHED and MINUTES_VERSION_STALE (409), MINUTES_VERSION_SEGMENTS_INVALID and MINUTES_VERSION_TEXT_REJECTED (422), TRANSLATION_LANGUAGE_OFF (422), FORBIDDEN (403, not the recorder).
    minutesVersion: {
      get: oc.input(zMeetingRef).output(zMinutesVersions),
      publish: oc.input(zMinutesVersionPublish).output(zMinutesVersionPublished),
      unpublish: oc.input(zMinutesVersionUnpublish).output(zMinutesVersionUnpublished),
    },
    actionItems: {
      create: oc.input(zActionItemCreate).output(zActionItemCreated),
      edit: oc.input(zActionItemEdit).output(zActionItemCreated),
      delete: oc.input(zActionItemRef).output(zActionItemDeleted),
      accept: oc.input(zActionItemAccept).output(zActionItemAccepted),
      acceptClean: oc.input(zActionItemAcceptClean).output(zActionItemsAccepted),
      source: oc.input(zActionItemRef).output(zActionItemSource),
    },
    readers: {
      add: oc.input(zMeetingReaderAdd).output(zMeetingReaderResult),
      remove: oc.input(zMeetingReaderRemove).output(zMeetingReaderResult),
    },
  },
  // Ludy Social (Social plan §3.3), when the deployment runs the social module.
  social: {
    posts: {
      list: oc
        .input(
          z.object({
            from: z.iso.datetime({ offset: true }).optional(),
            to: z.iso.datetime({ offset: true }).optional(),
            status: z.enum(SOCIAL_POST_STATUSES).optional(),
            // The Social home's lists: a channel in review; drafts with none in review; went out or stopped.
            stage: z.enum(['review', 'drafts', 'done', 'attention']).optional(),
            connectionId: zId.optional(),
            // Posts with this label (#639).
            labelId: zId.optional(),
            // Posts assigned to the viewer (#640) or to a member (#1300).
            assignee: zSocialMemberFilter.optional(),
            // Posts written by the viewer or a member (#1300).
            author: zSocialMemberFilter.optional(),
            // Drafts with no planned time and no channel time (#1145), for the calendar's side list.
            undated: z.literal(true).optional(),
            // Archived posts only (#1299); without it, the lists leave them out.
            archived: z.literal(true).optional(),
            search: z.string().trim().min(1).max(200).optional(),
            // The last post of the previous page (newest change first).
            before: z.strictObject({ updatedAt: z.iso.datetime({ offset: true }), postId: zId }).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(zSocialPost)),
      get: oc.input(z.object({ postId: zId })).output(zSocialPost),
      // Per channel, the content of its last review decision next to its content now (#944), for the review panel's diff.
      reviewDiff: oc.input(z.strictObject({ postId: zId })).output(zSocialReviewDiff),
      // What the automatic checks found on the channels waiting for review (#1193), as the content agent reads it.
      preReview: oc.input(z.strictObject({ postId: zId })).output(zSocialPreReview),
      // The post's saved versions, newest first (#1021), at most 50.
      versions: oc.input(z.strictObject({ postId: zId })).output(zSocialPostVersions),
      // Saves a version again as a new edit (#1021): changed channels go back to draft; channels that are history keep
      // their content (kept), and a post with no channel left to edit is refused.
      restoreVersion: oc
        .input(
          z.strictObject({
            postId: zId,
            versionId: zId,
            revision: z.number().int().positive(),
            // Each channel's revision as the page shows it; a channel edited since refuses the restore.
            variantRevisions: z.record(zId, z.number().int().positive()).optional(),
          }),
        )
        .output(z.object({ postId: zId, revision: z.number().int(), changedVariants: z.array(zId), kept: z.array(zId) })),
      // Who should move the post along and by when (#640): owners, admins and the author; null clears.
      assign: oc
        .input(z.strictObject({ postId: zId, assigneeUserId: zId.nullable(), dueAt: z.iso.datetime({ offset: true }).nullable() }))
        .output(z.object({ postId: zId, assigneeUserId: zId.nullable(), dueAt: z.string().nullable() })),
      // A retry with the same idempotencyKey returns the first result instead of a second post.
      create: oc
        .input(zSocialPostCreate.extend({ idempotencyKey: zId }))
        .output(z.object({ postId: zId, revision: z.number().int(), variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      update: oc.input(zSocialPostUpdate).output(z.object({ postId: zId, revision: z.number().int(), changedVariants: z.array(zId) })),
      addChannels: oc
        .input(z.strictObject({ postId: zId, channels: z.array(zSocialChannelInput).min(1).max(20) }))
        .output(z.object({ postId: zId, variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      submit: oc.input(z.strictObject({ postId: zId, variantIds: z.array(zId).min(1).max(20).optional() })).output(z.object({ postId: zId, submitted: z.array(zId) })),
      // A new post with the content of a published one, for the channels it went out on (S9); it is reviewed as usual.
      repost: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // Drafts from a sheet (#586), up to 200 rows; with submit, the channels that fit their rules go to review.
      import: oc
        .input(
          z.strictObject({
            posts: z
              .array(
                z.strictObject({
                  body: zSocialPostCreate.shape.body,
                  title: zSocialPostCreate.shape.title,
                  linkUrl: zSocialPostCreate.shape.linkUrl,
                  scheduledAt: zSocialPostCreate.shape.scheduledAt,
                  timeZone: zSocialPostCreate.shape.timeZone,
                  connectionIds: z.array(zId).min(1).max(20),
                  // Library files with their alt texts, labels by name and a first comment (#1258).
                  media: zSocialMediaInput.max(10).optional(),
                  labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
                  firstComment: z.string().trim().max(10_000).optional(),
                }),
              )
              .min(1)
              .max(200),
            submit: z.boolean().optional(),
            // One key per import: a retry after a lost answer returns the first result.
            idempotencyKey: zId,
          }),
        )
        .output(z.object({ posts: z.array(z.object({ postId: zId, submitted: z.number().int() })) })),
      // Internal comments (#582): never published; the author may fix one for 15 minutes.
      // pin (#1180): a spot on one of its images or a moment in one of its videos.
      comment: oc.input(z.strictObject({ postId: zId, variantId: zId.optional(), body: z.string().trim().min(1).max(4000), pin: zSocialCommentPin.optional() })).output(z.object({ commentId: zId })),
      editComment: oc.input(z.strictObject({ commentId: zId, body: z.string().trim().min(1).max(4000) })).output(z.object({ commentId: zId, postId: zId })),
      // Marks a comment as dealt with, or open again (#1168); the text stays.
      resolveComment: oc.input(z.strictObject({ commentId: zId })).output(zSocialCommentResolved),
      reopenComment: oc.input(z.strictObject({ commentId: zId })).output(zSocialCommentResolved),
      // Suggested edits (#1236): words of the post's text or a channel's own text and the words suggested instead, as a
      // comment with an optional note; accepted through the ordinary edit (revision: of the text the member saw) or
      // skipped.
      suggest: oc
        .input(z.strictObject({ postId: zId, variantId: zId.optional(), body: z.string().trim().max(4000).optional(), suggestion: zSocialSuggestion }))
        .output(z.object({ commentId: zId })),
      acceptSuggestion: oc.input(z.strictObject({ commentId: zId, revision: z.number().int().positive() })).output(zSocialSuggestionDecided),
      skipSuggestion: oc.input(z.strictObject({ commentId: zId })).output(zSocialSuggestionDecided),
      // The post's timeline, newest first: comments, decisions and what happened to it and its channels.
      activity: oc.input(z.object({ postId: zId })).output(z.object({ items: z.array(zSocialActivityItem), more: z.boolean() })),
      // The post's labels become exactly these (#639); its content and revision stay as they are.
      setLabels: oc
        .input(z.strictObject({ postId: zId, labelIds: z.array(zId).max(10) }))
        .output(z.object({ postId: zId, labelIds: z.array(zId) })),
      // Labels added to and taken off up to 100 posts at once (#1057); the answer names each post left out and why.
      bulkLabels: oc.input(zSocialBulkLabels).output(zSocialBulkResult),
      // The assignee, and optionally the due date, of up to 100 posts at once (#1057), with the same answer.
      bulkAssign: oc.input(zSocialBulkAssign).output(zSocialBulkResult),
      // Find and replace across up to 50 posts (#1144): the preview lists each post's matches and why a post would be
      // left out; the replace changes each post through its single edits and answers as the bulk edits do.
      bulkReplacePreview: oc.input(zSocialBulkReplace).output(zSocialBulkReplacePreview),
      bulkReplace: oc.input(zSocialBulkReplace).output(zSocialBulkResult),
      // One channel added to up to 100 posts (#1178), each through the single add; the answer names each post left out
      // and why, and what each added channel still lacks for its rules.
      bulkAddChannel: oc.input(zSocialBulkAddChannel).output(zSocialBulkAddChannelResult),
      // Archives a post, or brings an archived one back unchanged (#1299): members their own posts, owners and admins
      // any. Refused while a channel is scheduled, going out, paused, waiting for a person or being taken down.
      archive: oc.input(zSocialPostArchive).output(zSocialPostArchived),
      restore: oc.input(zSocialPostArchive).output(zSocialPostArchived),
      // The same for up to 100 posts at once; the answer names each post left out and why.
      bulkArchive: oc.input(zSocialBulkArchive).output(zSocialBulkResult),
      bulkRestore: oc.input(zSocialBulkArchive).output(zSocialBulkResult),
      // One draft per library file (#1080), all or none: every file is checked against every channel first, and a file
      // that does not fit one is reported with nothing saved. A retry with the same idempotencyKey returns the first answer.
      createFromMedia: oc.input(zSocialDraftsFromMediaFields.extend({ idempotencyKey: zId }).refine(channelsOrSet, 'channels or a channel set')).output(zSocialDraftsFromMediaResult),
      // A copy of any post as a new draft, for the channels still connected that the caller may use (#575, #1081),
      // with its labels; planned for scheduledAt when given (in the future), else undated (#1192). The bulk bar sends
      // one per post.
      duplicate: oc.input(zSocialPostDuplicate).output(zSocialPostDuplicateResult),
      // Repost a published post every N days (7 to 365), each repost sent to review; null stops it.
      setEvergreen: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(7).max(365).nullable() })).output(z.object({ postId: zId, evergreenDays: z.number().int().nullable() })),
      // Repeat a post on fixed weekdays at a local time (#979): after each publish the worker makes the next copy, planned
      // for its occurrence and sent to review. Setting it makes the post a series; clearing it ends the series.
      setRecurrence: oc.input(z.strictObject({ postId: zId, recurrence: zSocialRecurrence })).output(z.object({ postId: zId, recurrence: zSocialRecurrence })),
      clearRecurrence: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // The text variations of an evergreen or series post (#1260), replacing the list; the next copy's stays on the same
      // text when it is kept.
      setTextVariations: oc
        .input(z.strictObject({ postId: zId, variations: zSocialTextVariations }))
        .output(z.object({ postId: zId, variations: z.array(z.object({ text: z.string(), ai: z.boolean() })), next: z.number().int() })),
      // Whether this server writes AI drafts from photos (#1191, #1196): an AI model that takes images (AI_VISION).
      aiPhotos: oc.input(z.object({})).output(z.object({ enabled: z.boolean() })),
      // AI drafting (Social plan §3.7): the server asks the deployment's model for a draft from the brief and saves it as
      // a new post with origin 'ai' (tainted), one variant per channel. Each call drafts anew: a draft whose answer was
      // lost is only an extra draft, which publishes nothing until a person approves it. fileIds (#1191): photos of the
      // org's Social library the draft is written from, when the model takes images; the post carries them, in order,
      // and the brief may then be empty.
      draftWithAi: oc
        .input(
          z.strictObject({
            brief: z.string().trim().max(4000),
            connectionIds: z.array(zId).min(1).max(20),
            tone: z.string().trim().max(300).optional(),
            language: z.enum(['vi', 'en']).optional(),
            // A page to write about (#769): read through its link preview, and the post links to it.
            sourceUrl: z
              .url({ protocol: /^https?$/ })
              .max(2000)
              .refine((u) => !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(u), 'a link without a user name or password')
              .optional(),
            fileIds: z
              .array(zId)
              .min(1)
              .max(AI_DRAFT_IMAGES_MAX)
              .refine((ids) => new Set(ids).size === ids.length, 'each photo once')
              .optional(),
            // A mail forwarded to the org's inbound address (#779): its subject and text are read as tainted data.
            inboundMessageId: zId.optional(),
          })
          .refine((v) => v.brief.length > 0 || v.sourceUrl !== undefined || v.fileIds !== undefined || v.inboundMessageId !== undefined, {
            message: 'a brief, a source page, photos or a mail',
            path: ['brief'],
          }),
        )
        .output(z.object({ postId: zId })),
      // A rewrite of one text, as a proposal the member accepts or discards (#583); nothing is saved. With a channel,
      // the rewrite is told its limits. proofread (#1167): spelling, diacritics, spacing and punctuation only; the
      // text comes back unchanged when there is nothing to fix, and an answer that changed a link, hashtag, mention,
      // number or price, or emoji is refused with AI_PROOFREAD_CHANGED. variation (#1260): another wording of the text, for
      // the post's text variations; it only fills the form until a person saves it.
      rewriteWithAi: oc
        .input(
          z.strictObject({
            text: z.string().trim().min(1).max(20_000),
            title: z.string().trim().max(500).nullable().optional(),
            action: z.enum(['shorten', 'formal', 'casual', 'translate_en', 'translate_vi', 'proofread', 'variation']),
            connectionId: zId.optional(),
          }),
        )
        .output(z.object({ text: z.string(), title: z.string().nullable() })),
      // Hashtags the writer suggests for a text (#824), tainted like every AI text; the same budget as drafts.
      // An image's alt text the writer suggests (#817, #1121), when the model takes images; the same budget as drafts.
      // fileId: a Social upload of the org; connectionIds: the channels it goes to, whose strictest alt-text limit the
      // suggestion keeps within. Nothing is saved.
      describeImage: oc
        .input(z.strictObject({ fileId: zId, language: z.enum(['vi', 'en']), connectionIds: z.array(zId).max(20).optional() }))
        .output(z.object({ altText: z.string() })),
      suggestHashtags: oc
        .input(z.strictObject({ text: z.string().trim().min(1).max(20_000), connectionId: zId.optional(), language: z.enum(['vi', 'en']), exclude: z.array(z.string().max(100)).max(50) }))
        .output(z.object({ hashtags: z.array(z.string()) })),
    },
    // How published posts did (S8): the latest capture of each variant published in the last days days (30 by default).
    metrics: {
      // postId: that post's published channels, whenever they went out.
      // labelId: only posts with that label (#639).
      summary: oc.input(z.object({ days: z.number().int().min(1).max(365).optional(), postId: zId.optional(), labelId: zId.optional() })).output(z.array(zSocialMetricsRow)),
      // The window's totals over every published channel (#397), summed by the server, and per channel; previous: the
      // same for the window of the same length just before (#947).
      // includeExternal (#1054): with the posts each channel published outside Ludy (none under a label filter).
      totals: oc
        .input(z.object({ days: z.number().int().min(1).max(365).optional(), labelId: zId.optional(), includeExternal: z.boolean().optional() }))
        .output(zSocialWindowTotals.extend({ previous: zSocialWindowTotals })),
      // The posts the channels published outside Ludy in the window (#1054), newest first, with their latest counts.
      external: oc.input(z.object({ days: z.number().int().min(1).max(365).optional() })).output(z.array(zSocialExternalPost)),
      // What works (#705): each channel's posts against its own median, by label, format, weekday, hour and hashtag.
      insights: oc
        .input(z.object({ days: z.number().int().min(1).max(365), labelId: zId.optional(), timeZone: z.string().min(1).max(64) }))
        .output(z.object({ channels: z.array(zSocialChannelInsights), truncated: z.boolean() })),
      // An AI summary of a period (#1237) for the tab or a client report's note: the Metrics tab's window (days) or a
      // report's period (periodStart, periodEnd), on the chosen channels, a label or with outside posts as the totals
      // take them. Written from the period's figures only: a summary citing any other number is refused with
      // AI_SUMMARY_FIGURE_INVENTED. Members and above, the same budget as AI drafting; nothing is saved (the note is
      // saved with the report link).
      writeSummary: oc
        .input(
          z
            .strictObject({
              days: z.number().int().min(1).max(365).optional(),
              periodStart: z.iso.datetime({ offset: true }).optional(),
              periodEnd: z.iso.datetime({ offset: true }).optional(),
              connectionIds: z.array(zId).max(50).optional(),
              labelId: zId.optional(),
              includeExternal: z.boolean().optional(),
              timeZone: z.string().min(1).max(64).optional(),
              language: z.enum(['vi', 'en']).optional(),
            })
            .refine((i) => (i.days !== undefined) !== (i.periodStart !== undefined || i.periodEnd !== undefined) && (i.periodStart === undefined) === (i.periodEnd === undefined), 'days, or periodStart and periodEnd'),
        )
        .output(z.object({ text: z.string() })),
      // The window as a CSV file (UTF-8 with a byte order mark); every export is audited.
      export: oc
        .input(z.strictObject({ days: z.number().int().min(1).max(365), labelId: zId.optional() }))
        .output(z.object({ filename: z.string(), csv: z.string(), truncated: z.boolean() })),
    },
    // The content plan for a client (#978): the channel posts of [from, to), at most 92 days, as a CSV file whose first
    // columns re-import as drafts (format csv) or as rows for the print layout (format print), at most 500 of them.
    // Members and above; every export is audited.
    plan: {
      export: oc
        .input(
          z.strictObject({
            from: z.iso.datetime({ offset: true }),
            to: z.iso.datetime({ offset: true }),
            timeZone: z.string().min(1).max(64),
            connectionIds: z.array(zId).min(1).max(50).optional(),
            labelIds: z.array(zId).min(1).max(20).optional(),
            format: z.enum(['csv', 'print']).optional(),
          }),
        )
        .output(z.object({ filename: z.string(), csv: z.string().nullable(), rows: z.array(zSocialPlanRow).nullable(), truncated: z.boolean() })),
    },
    // The team report (#1058), owners and admins only, over [from, to) of at most 366 days: per member, posts created,
    // sent to review, approved, published, assigned with a due date and overdue, and review decisions with the median
    // time from submission to decision; for client review links, the median time to the client's answer.
    team: {
      report: oc.input(z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })).output(zSocialTeamReport),
    },
    // Labels for posts (#639): members create them and put them on posts; owners and admins rename and delete them.
    labels: {
      list: oc.input(z.object({})).output(z.array(zSocialLabel)),
      create: oc.input(zSocialLabelCreate).output(z.object({ labelId: zId })),
      update: oc.input(zSocialLabelUpdate).output(z.object({ labelId: zId })),
      remove: oc.input(z.strictObject({ labelId: zId })).output(z.object({ labelId: zId })),
    },
    // The ideas board (#701): members add, change and move ideas; a draft made from one names it (posts.create ideaId).
    ideas: {
      list: oc.input(z.object({ archived: z.boolean().optional(), labelId: zId.optional() })).output(z.object({ ideas: z.array(zSocialIdea), truncated: z.boolean() })),
      get: oc.input(z.object({ ideaId: zId })).output(zSocialIdea),
      create: oc.input(zSocialIdeaCreate).output(z.object({ ideaId: zId })),
      update: oc.input(zSocialIdeaUpdate).output(z.object({ ideaId: zId })),
      // Post ideas the writer suggests from a theme (#1181), in the brand voice (a channel's when connectionId names
      // one), for a label or occasion; the same role gate and budget as AI drafting. Nothing is saved: the member keeps
      // the ones they want with create and origin 'ai'.
      suggest: oc
        .input(
          z.strictObject({
            theme: z.string().trim().min(1).max(2000),
            occasion: z.string().trim().max(200).optional(),
            count: z.number().int().min(3).max(10),
            language: z.enum(['vi', 'en']).optional(),
            connectionId: zId.optional(),
          }),
        )
        .output(z.object({ ideas: z.array(z.object({ title: z.string(), note: z.string().nullable() })) })),
      move: oc.input(z.strictObject({ ideaId: zId, stage: z.enum(['new', 'planned', 'archived']) })).output(z.object({ ideaId: zId, stage: z.string() })),
    },
    // The org's link-in-bio page (#707): everyone reads it and its clicks; owners and admins save it.
    bio: {
      get: oc.input(z.object({})).output(zSocialBioPage.nullable()),
      save: oc.input(zSocialBioSave).output(z.object({ pageId: zId, slug: z.string() })),
    },
    // Blog feeds that become drafts (#708): owners and admins add, change, pause and remove them; everyone reads them.
    feeds: {
      list: oc.input(z.object({})).output(z.array(zSocialFeed)),
      add: oc.input(z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2000), connectionIds: z.array(zId).min(1).max(20) })).output(z.object({ feedId: zId })),
      update: oc.input(z.strictObject({ feedId: zId, connectionIds: z.array(zId).min(1).max(20).optional(), paused: z.boolean().optional() })).output(z.object({ feedId: zId })),
      remove: oc.input(z.strictObject({ feedId: zId })).output(z.object({ feedId: zId })),
    },
    // Saved views of the posts (#1300): named filters, private or shared with the org, at most 20 per member. Members
    // see their own and the shared ones; the owner changes and deletes a view, and owners and admins a shared one.
    savedViews: {
      list: oc.input(z.object({})).output(z.array(zSocialSavedView)),
      save: oc.input(zSocialSavedViewSave).output(z.object({ viewId: zId })),
      remove: oc.input(z.strictObject({ viewId: zId })).output(z.object({ viewId: zId })),
    },
    // Saved snippets (#584): members create them and change their own; owners and admins any.
    snippets: {
      list: oc.input(z.object({ provider: z.string().max(32).optional() })).output(z.array(zSocialSnippet)),
      create: oc.input(zSocialSnippetCreate).output(z.object({ snippetId: zId })),
      update: oc.input(zSocialSnippetUpdate).output(z.object({ snippetId: zId })),
      remove: oc.input(z.strictObject({ snippetId: zId })).output(z.object({ snippetId: zId })),
    },
    // Banned and sensitive words (#1055): every member reads the list; owners and admins add and remove words.
    bannedWords: {
      list: oc.input(z.object({})).output(z.array(zSocialBannedWord)),
      add: oc.input(zSocialBannedWordAdd).output(z.object({ wordId: zId })),
      remove: oc.input(z.strictObject({ wordId: zId })).output(z.object({ wordId: zId })),
    },
    // The review checklist (#1105): every member reads it (a limited member, the org-wide items and their channels');
    // owners and admins replace it whole.
    reviewChecklist: {
      list: oc.input(z.object({})).output(z.object({ items: z.array(zSocialReviewCheck) })),
      set: oc.input(zSocialReviewChecklistSet).output(z.object({ items: z.array(zSocialReviewCheck) })),
    },
    // Channels a member may use (#1081): owners and admins read every member's list and replace one (an empty list
    // lifts the limit; owners and admins are never limited); every member reads their own.
    channelAccess: {
      list: oc.input(z.object({})).output(z.array(zSocialChannelAccess)),
      mine: oc.input(z.object({})).output(z.object({ limited: z.boolean(), connectionIds: z.array(zId) })),
      set: oc.input(zSocialChannelAccessSet).output(z.object({ userId: zId, limited: z.boolean(), connectionIds: z.array(zId) })),
    },
    // Client report links (#643): owners and admins make and revoke them; the token is in the create answer only.
    // Monthly goals (#1056): every member sees the month's progress; owners and admins set and remove goals.
    goals: {
      progress: oc.input(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() })).output(zSocialGoals),
      set: oc.input(zSocialGoalSet).output(z.object({ goalId: zId.nullable() })),
      remove: oc.input(z.strictObject({ connectionId: zId.nullable() })).output(z.object({ goalId: zId })),
    },
    reportLinks: {
      list: oc.input(z.object({})).output(z.array(zSocialReportLink)),
      create: oc.input(zSocialReportLinkCreate).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string() })),
      revoke: oc.input(z.strictObject({ linkId: zId })).output(z.object({ linkId: zId })),
    },
    // Saved sets of channels for the composer (#774): owners and admins save and remove them; everyone reads.
    channelSets: {
      list: oc.input(z.object({})).output(z.array(z.object({ id: zId, name: z.string(), connectionIds: z.array(zId), updatedAt: z.string() }))),
      save: oc.input(z.strictObject({ setId: zId.optional(), name: z.string().trim().min(1).max(80), connectionIds: z.array(zId).min(1).max(20) })).output(z.object({ setId: zId })),
      remove: oc.input(z.strictObject({ setId: zId })).output(z.object({ setId: zId, removed: z.boolean() })),
    },
    // The posting calendar feed (#862): owners and admins make (replacing the live one) and revoke it; the token is in
    // the create answer only. Everyone sees whether there is one.
    calendarFeed: {
      get: oc.input(z.object({})).output(z.object({ createdAt: z.string(), createdBy: zId }).nullable()),
      create: oc.input(z.strictObject({})).output(z.object({ token: z.string() })),
      revoke: oc.input(z.strictObject({})).output(z.object({ revoked: z.boolean() })),
    },
    // Notes on calendar dates (#794): owners, admins and members save and remove them; everyone reads the ones that
    // overlap the days shown.
    calendarNotes: {
      list: oc
        .input(z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
        .output(z.array(z.object({ id: zId, startsOn: z.string(), endsOn: z.string(), title: z.string(), color: z.enum(SOCIAL_LABEL_COLORS), updatedBy: zId, updatedAt: z.string() }))),
      save: oc
        .input(
          z.strictObject({
            noteId: zId.optional(),
            startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            title: z.string().trim().min(1).max(120),
            color: z.enum(SOCIAL_LABEL_COLORS).optional(),
          }),
        )
        .output(z.object({ noteId: zId })),
      remove: oc.input(z.strictObject({ noteId: zId })).output(z.object({ noteId: zId, removed: z.boolean() })),
    },
    // The saved brand voice for AI drafts (#741): the org's and each channel's.
    brandVoices: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId.nullable(), description: z.string(), useWords: z.array(z.string()), avoidWords: z.array(z.string()), emoji: z.boolean(), updatedAt: z.string() }))),
      save: oc
        .input(z.strictObject({ connectionId: zId.nullable().optional(), description: z.string().trim().min(1).max(600), useWords: z.array(z.string().trim().min(1).max(40)).max(20), avoidWords: z.array(z.string().trim().min(1).max(40)).max(20), emoji: z.boolean() }))
        .output(z.object({ connectionId: zId.nullable() })),
      remove: oc.input(z.strictObject({ connectionId: zId.nullable().optional() })).output(z.object({ connectionId: zId.nullable(), removed: z.boolean() })),
    },
    // The org's logo watermark for post images (#834): the composer draws it on a copy of an image.
    watermark: {
      get: oc.input(z.object({})).output(z.object({ fileId: zId, mime: z.string(), corner: z.enum(SOCIAL_WATERMARK_CORNERS), scalePercent: z.number().int(), opacityPercent: z.number().int(), updatedAt: z.string() }).nullable()),
      save: oc
        .input(z.strictObject({ fileId: zId, corner: z.enum(SOCIAL_WATERMARK_CORNERS), scalePercent: z.number().int().min(5).max(50), opacityPercent: z.number().int().min(10).max(100) }))
        .output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
    },
    // White-label client reports (#1053): every member reads the org's report branding; owners and admins save and
    // remove it. The logo is a data URL the browser made; the command checks its type, magic number and size.
    reportBranding: {
      get: oc.input(z.object({})).output(zSocialReportBrand.extend({ updatedAt: z.string() }).nullable()),
      save: oc.input(zSocialReportBrandingSave).output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
    },
    // A hold on all of the org's publishing (#946), for a crisis or a mourning day: owners and admins put it on with a
    // reason and take it off; every member reads who put it on, when and why.
    publishing: {
      get: oc
        .input(z.object({}))
        .output(z.object({ held: z.boolean(), hold: z.object({ id: zId, reason: z.string(), heldBy: zId, heldByName: z.string().nullable(), heldAt: z.string() }).nullable() })),
      hold: oc.input(z.strictObject({ reason: z.string().trim().min(1).max(500) })).output(z.object({ holdId: zId, heldAt: z.string(), created: z.boolean() })),
      release: oc.input(z.strictObject({})).output(z.object({ released: z.boolean(), heldTooLong: z.number().int() })),
    },
    // The org's team chat for Social alerts (#863): a Telegram chat (bot token and chat) or a Discord webhook, and the
    // kinds of alert it gets. The server checks the target with the platform and seals it; no answer carries it back.
    chatAlert: {
      get: oc
        .input(z.object({}))
        .output(
          z
            .object({
              kind: z.enum(SOCIAL_CHAT_ALERT_TARGETS),
              events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)),
              label: z.string().nullable(),
              updatedAt: z.string(),
              // The last test line: when the worker tried it, and the code of why it did not go out (null: it did).
              lastTestAt: z.string().nullable(),
              lastTestCode: z.string().nullable(),
            })
            .nullable(),
        ),
      save: oc
        .input(
          z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('telegram'), botToken: z.string().trim().min(1).max(100), chatId: z.string().trim().min(1).max(100), events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)).min(1).max(4) }),
            z.strictObject({ kind: z.literal('discord'), webhookUrl: z.string().trim().min(1).max(300), events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)).min(1).max(4) }),
          ]),
        )
        .output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
      // Asks the worker for one test line to the saved chat now; its outcome shows in get (lastTestAt, lastTestCode).
      test: oc.input(z.strictObject({})).output(z.object({ queued: z.boolean() })),
    },
    // Scheduled client report mail (#704): owners and admins set, pause, test and remove schedules.
    reportSchedules: {
      list: oc.input(z.object({})).output(z.array(zSocialReportSchedule)),
      save: oc.input(zSocialReportScheduleSave).output(z.object({ scheduleId: zId, nextRunAt: z.string() })),
      remove: oc.input(z.strictObject({ scheduleId: zId })).output(z.object({ scheduleId: zId })),
      test: oc.input(z.strictObject({ scheduleId: zId })).output(z.object({ runId: zId, mails: z.number().int(), suppressed: z.number().int() })),
    },
    // Link preview cards (#641): what a link's page says, read by the worker; shown in Ludy only.
    linkPreviews: {
      request: oc.input(z.strictObject({ url: z.string().min(1).max(2048) })).output(zSocialLinkPreview),
      get: oc.input(z.object({ url: z.string().min(1).max(2048) })).output(zSocialLinkPreview.nullable()),
    },
    // A channel's options for the composer (#1120): a Pinterest board's sections, read by the worker with the
    // channel's token; shown in Ludy only.
    channelOptions: {
      request: oc.input(z.strictObject({ connectionId: zId })).output(zSocialChannelOptions),
      get: oc.input(z.strictObject({ connectionId: zId })).output(zSocialChannelOptions.nullable()),
    },
    // In-app notifications (#637): each member reads, marks and turns off only their own.
    notifications: {
      list: oc.input(z.object({})).output(zSocialNotifications),
      read: oc.input(z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })])).output(z.object({ read: z.number().int() })),
      mute: oc.input(z.strictObject({ kind: zSocialNotificationKind, muted: z.boolean() })).output(z.object({ kind: zSocialNotificationKind, muted: z.boolean() })),
      // The viewer's Social emails on or off (#579).
      mail: oc.input(z.strictObject({ enabled: z.boolean() })).output(z.object({ enabled: z.boolean() })),
    },
    // Account growth (#645): each channel's daily followers and reach over the last days.
    accounts: {
      trends: oc.input(z.object({ days: z.number().int().min(1).max(366) })).output(z.array(zSocialAccountTrend)),
    },
    // Posts waiting for the viewer's review (#749), for the kernel inbox: empty for members and viewers.
    reviewInbox: oc.input(z.object({})).output(
      z.object({
        items: z.array(
          z.object({
            postId: zId,
            title: z.string().nullable(),
            excerpt: z.string(),
            channels: z.array(z.object({ variantId: zId, provider: z.string(), displayName: z.string() })),
            at: z.string().nullable(),
            submittedAt: z.string(),
          }),
        ),
        total: z.number().int().min(0),
      }),
    ),
    // Channels and posts that need a person (#771), for the kernel inbox: empty for members and viewers.
    attentionInbox: oc.input(z.object({})).output(
      z.object({
        channels: z.array(z.object({ connectionId: zId, provider: z.string(), displayName: z.string(), status: z.enum(['expired', 'error']) })),
        posts: z.array(
          z.object({
            postId: zId,
            excerpt: z.string(),
            channels: z.array(z.object({ variantId: zId, provider: z.string(), displayName: z.string(), status: z.string(), errorCode: z.string().nullable() })),
            updatedAt: z.string(),
          }),
        ),
        total: z.number().int().min(0),
      }),
    ),
    // Client review links (#589): owners and admins make and revoke them; the token is in the create answer only.
    reviewLinks: {
      list: oc.input(z.object({ postId: zId })).output(zSocialReviewLinks),
      create: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(1).max(30).optional() })).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string() })),
      // A plan link (#902): one link for several posts, answered one by one; the token is in this answer only.
      createPlan: oc.input(zSocialReviewPlanCreate).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string(), posts: z.number().int().min(1) })),
      plans: oc.input(z.object({})).output(z.array(zSocialReviewPlanLink)),
      // postId is null for a plan link.
      revoke: oc.input(z.strictObject({ linkId: zId })).output(z.object({ linkId: zId, postId: zId.nullable() })),
      // The team's reply under a client's answer (#1301), members and above; null or empty text clears it.
      reply: oc.input(zSocialReviewReplyInput).output(z.object({ feedbackId: zId, postId: zId, reply: zSocialReviewReply.nullable() })),
    },
    // The media library (S9): the org's post images, newest first, and the posts that show one. Members tag files and
    // the list filters by one tag, whatever its case (#904); tags lists the org's tags for the filter.
    media: {
      list: oc
        .input(
          z.object({
            search: z.string().trim().max(200).optional(),
            tag: z.string().max(200).optional(),
            before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            // Only files the caller may use (#1196): a member limited to some channels gets no other channel's own media.
            // Never archived files (#1302).
            usable: z.boolean().optional(),
            // The archived files alone (#1302); without it the list leaves them out.
            archived: z.boolean().optional(),
          }),
        )
        .output(z.object({ items: z.array(zSocialLibraryItem), more: z.boolean() })),
      // The CSV import's media (#1258): files by name or id, and image URLs fetched into the library by the API (members
      // and above; the URLs within a per-member and per-org budget, never from the browser).
      resolve: oc.input(zSocialMediaResolve).output(zSocialMediaResolved),
      fetchUrls: oc.input(zSocialMediaFetchUrls).output(zSocialMediaFetched),
      usage: oc.input(z.object({ fileId: zId })).output(z.array(zSocialLibraryUse)),
      tags: oc.input(z.object({})).output(z.array(zSocialMediaTagCount)),
      tag: oc.input(z.strictObject({ fileId: zId, tags: z.array(z.string().max(200)).min(1).max(20) })).output(z.object({ fileId: zId, tags: z.array(z.string()) })),
      untag: oc.input(z.strictObject({ fileId: zId, tags: z.array(z.string().max(200)).min(1).max(20) })).output(z.object({ fileId: zId, tags: z.array(z.string()) })),
      // Take files out of the library and its pickers, or bring them back (#1302), members and above, on files they may
      // use; posts that already use an archived file keep it. Each lists the files it changed.
      archive: oc.input(zSocialMediaArchive).output(z.object({ archived: z.array(zId) })),
      restore: oc.input(zSocialMediaArchive).output(z.object({ restored: z.array(zId) })),
    },
    // Stock photos from Pexels (#1106), when the deployment set MEDIA_PEXELS_API_KEY: status says whether they are
    // offered; search and save are for members and above, and answer STOCK_PHOTOS_DISABLED without the key. The key
    // stays on the server, and so does every request to Pexels: thumbnails come back as data: URLs.
    stockPhotos: {
      status: oc.input(z.object({})).output(z.object({ enabled: z.boolean(), provider: z.literal('pexels') })),
      search: oc.input(zSocialStockSearch).output(zSocialStockResults),
      save: oc.input(zSocialStockSave).output(zSocialStockSaved),
    },
    variants: {
      update: oc.input(zSocialVariantUpdate).output(z.object({ variantId: zId, revision: z.number().int(), changed: z.boolean() })),
      // waiting: variants approved by this reviewer that still need another person's approval (their channel's policy).
      decide: oc.input(zSocialDecide).output(z.object({ postId: zId, decision: z.string(), variants: z.array(zId), waiting: z.array(zId) })),
      schedule: oc.input(zSocialSchedule).output(z.object({ postId: zId, scheduled: z.array(z.object({ variantId: zId, at: z.string() })) })),
      unschedule: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Post a published channel's first comment again (#587), after a failure or an unclear answer.
      retryComment: oc.input(z.strictObject({ variantId: zId })).output(z.object({ variantId: zId })),
      // Post the rest of a published channel's thread (#742), from the first part not out.
      retryThread: oc.input(z.strictObject({ variantId: zId })).output(z.object({ variantId: zId })),
      // A scheduled variant at another time, its approvals kept (#580).
      reschedule: oc.input(z.strictObject({ variantId: zId, at: z.iso.datetime({ offset: true }), expectedAt: z.iso.datetime({ offset: true }).optional() })).output(z.object({ postId: zId, variantId: zId, at: z.string() })),
      cancel: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Publish failed or needs_attention variants again now (a new attempt).
      retry: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Take a published channel down from its platform (#860), owners and admins, with an optional reason. The worker
      // makes the call; queued false: an earlier ask is still on its way, or it is removed already.
      remove: oc
        .input(z.strictObject({ variantId: zId, reason: z.string().trim().max(500).optional() }))
        .output(z.object({ postId: zId, variantId: zId, status: z.enum(SOCIAL_VARIANT_STATUSES), queued: z.boolean() })),
      // Correct a published channel's text on its platform (#1223), owners and admins: the channel's new own text (its
      // signature is appended as at publish), the revision they saw and the review checklist items they ticked. The
      // worker makes the call; the variant changes once the platform confirms it.
      editPublished: oc
        .input(z.strictObject({ variantId: zId, revision: z.number().int().positive(), body: z.string().max(100_000), checks: z.array(zId).max(SOCIAL_REVIEW_CHECKS_MAX).optional() }))
        .output(z.object({ postId: zId, variantId: zId, revision: z.number().int(), queued: z.boolean() })),
      // Settle needs_attention variants: on the platform after all, or dropped.
      resolve: oc
        .input(z.strictObject({ variantIds: z.array(zId).min(1).max(20), outcome: z.enum(['published', 'dropped']), url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional() }))
        .output(z.object({ postId: zId, variants: z.array(zId), outcome: z.enum(['published', 'dropped']) })),
    },
    // Review policy per channel (S9): how many different people approve a variant before it may be scheduled.
    policies: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, approvalsRequired: z.number().int(), reviewReminders: z.boolean(), shortLinks: z.boolean(), fourEyes: z.boolean(), clientApproval: z.boolean(), signature: z.string().nullable(), updatedBy: zId, updatedAt: z.string() }))),
      set: oc
        .input(z.strictObject({ connectionId: zId, approvalsRequired: z.number().int().min(1).max(3) }))
        .output(z.object({ connectionId: zId, approvalsRequired: z.number().int(), approved: z.array(zId) })),
      // Whether the channel's reviewers are reminded of posts waiting for review (#703).
      setReminders: oc.input(z.strictObject({ connectionId: zId, reviewReminders: z.boolean() })).output(z.object({ connectionId: zId, reviewReminders: z.boolean() })),
      // Whether the channel's links go through Ludy's short links, to count clicks (#706).
      setShortLinks: oc.input(z.strictObject({ connectionId: zId, shortLinks: z.boolean() })).output(z.object({ connectionId: zId, shortLinks: z.boolean() })),
      // Four-eyes (#740): owners only.
      setFourEyes: oc.input(z.strictObject({ connectionId: zId, fourEyes: z.boolean() })).output(z.object({ connectionId: zId, fourEyes: z.boolean() })),
      // The client's approval on a review link as a review step (#770): owners only.
      setClientApproval: oc.input(z.strictObject({ connectionId: zId, clientApproval: z.boolean() })).output(z.object({ connectionId: zId, clientApproval: z.boolean(), approved: z.array(zId) })),
      // The channel's signature (#1190), copied into the posts it is added to from now on; null clears it.
      setSignature: oc.input(z.strictObject({ connectionId: zId, signature: z.string().max(2000).nullable() })).output(z.object({ connectionId: zId, signature: z.string().nullable() })),
    },
    // Variants waiting paused on each channel (expired or disconnected), for the channels screen.
    channels: {
      waiting: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, paused: z.number().int() }))),
    },
    queues: {
      get: oc.input(z.object({ connectionId: zId })).output(zSocialQueue),
      // The open slots in a range, for the calendar (#1158).
      openSlots: oc.input(zSocialQueueOpenSlotsInput).output(zSocialQueueOpenSlots),
      set: oc.input(zSocialQueueSet).output(z.object({ queueId: zId, moved: z.array(z.object({ variantId: zId, at: z.string().nullable() })) })),
      // Reordering (#1020), owners and admins: only queued posts that may move trade their slot times.
      shuffle: oc.input(zSocialQueueShuffle).output(zSocialQueueReorder),
      moveToFront: oc.input(zSocialQueueMoveToFront).output(zSocialQueueReorder),
    },
  },
  inbox: {
    list: oc.input(z.object({ status: zProposalStatus.optional() })).output(z.array(zInboxItem)),
    // How many waiting things the list leaves out because their app is switched off for the org (ADR-0053, slice e).
    hidden: oc.input(z.object({})).output(z.object({ count: z.number().int().nonnegative() })),
    get: oc.input(z.object({ id: zId })).output(zInboxDetail),
    // Every member who can open the proposal (issue #672): what happened to it, its file and the records it touched.
    timeline: oc.input(z.object({ id: zId })).output(zTimeline),
    approve: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).optional(),
          note: z.string().max(500).optional(),
          acceptFailedChecks: z.boolean().optional(),
          // The approver confirmed this revision of an invoice whose digital signature is unverified (#674); required for one.
          acceptUnverifiedSignature: z.boolean().optional(),
          // A purchase invoice dated in a locked month (#478): the date its journal entry is posted on, in an open month,
          // chosen by the approver. Omitted, the entry is dated on the invoice date.
          postingDate: zLocalDate.optional(),
          idempotencyKey: zId,
        }),
      )
      // A purchase returns its document, and the posting date when it was posted later than its invoice date (#478); a
      // reversal (#138) returns the entry it reversed and, when that entry recorded a purchase, the document it voided
      // (#165); a cash or bank voucher (#327) returns the voucher; an ads proposal (#2294) posts nothing, so it returns none of these.
      .output(
        z.object({
          documentId: zId.optional(),
          postingDate: zLocalDate.optional(),
          journalEntryId: zId.optional(),
          reversedEntryId: zId.optional(),
          voidedDocumentId: zId.optional(),
          voucherId: zId.optional(),
        }),
      ),
    // Approves many pending proposals in one action (issue #315): owners and admins, R3 with one fresh step-up for the
    // whole batch (a stale one refuses all of it). Each item gets the same four-eyes (P10) and eligibility (P12)
    // decision and its own audit row as approving it alone; a refused item is reported with its code and the others
    // are still approved. revision: the one the caller saw in the list. At most 50 items, each once. A retry with the
    // same idempotencyKey returns the first result.
    approveMany: oc
      .input(
        z.object({
          items: zBulkApproveItems,
          idempotencyKey: zId,
        }),
      )
      .output(
        z.object({
          results: z.array(
            z.discriminatedUnion('outcome', [
              z.object({
                id: zId,
                outcome: z.literal('approved'),
                journalEntryId: zId.optional(),
                documentId: zId.optional(),
                reversedEntryId: zId.optional(),
                voidedDocumentId: zId.optional(),
                voucherId: zId.optional(),
              }),
              z.object({ id: zId, outcome: z.literal('refused'), code: z.string(), rule: z.string().nullable() }),
            ]),
          ),
        }),
      ),
    // Saves changed line accounts, or the exchange rate of a foreign-currency invoice read without one (#918), as a new
    // revision authored by the caller (who then cannot approve it, P10); it never approves. RATE_NOT_EDITABLE (422):
    // the invoice is in VND or already has its rate.
    edit: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000).optional(),
          exchangeRate: zExchangeRate.optional(),
          // The legal entity whose books a purchase or sale invoice is recorded in (#1280); approval then posts it there.
          legalEntityId: zId.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ revision: z.number().int(), changed: z.boolean() })),
    reject: oc.input(z.object({ id: zId, reason: z.string().max(500).optional() })).output(z.object({ ok: z.literal(true) })),
    // Asks again for a proposal that expired (#876; owners, admins and members who wrote it): a new pending proposal from
    // the same source, approved like any other. A retry with the same idempotencyKey returns the first one.
    resubmit: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ proposalId: zId })),
    // Owners and admins (#1720): the open items the system raised, a job that failed its last retry among them,
    // newest first (50 at most; total counts them all), and dismissing one. Members and viewers get an empty list.
    raised: oc.input(z.object({})).output(zRaisedInboxItems),
    dismiss: oc.input(z.strictObject({ id: zId })).output(z.object({ ok: z.literal(true) })),
    // Owners, admins and members whose scope is the whole org (#2286): the mails with no invoice attachment whose text held
    // the seller's lookup link or code, one item per hint, newest first (50 at most; total counts them all), and
    // dismissing one. Viewers and members limited to some legal entities get an empty list.
    originals: oc.input(z.object({})).output(zOriginalNeededItems),
    dismissOriginal: oc.input(z.strictObject({ id: zId })).output(z.object({ ok: z.literal(true) })),
    // Asks for a proposal that no file produced (kernel.proposal.request; owners, admins and members): reversing a
    // posted journal entry (#138, #165), or a cash or bank voucher entered by hand (#327). It posts nothing; the
    // proposal is approved like any other (R3, P10 four-eyes, P11 step-up). Reversing a purchase entry also voids
    // Ludy's record of the document on approval; approving a voucher numbers it and posts it. A retry with the same
    // idempotencyKey returns the first proposal.
    request: oc
      .input(
        z.discriminatedUnion('command', [
          z.object({ command: z.literal('finance.journal.reverse'), input: zJournalReversal, idempotencyKey: zId }),
          z.object({ command: z.literal('finance.voucher.record'), input: zCashVoucherRequest, idempotencyKey: zId }),
          // A general journal voucher (NVK, #888) entered by hand.
          // A voucher as entered, or the resolution of a count's surplus (#3712 slice 2a): a count and an account, the lines and the amount come from the books.
          z.object({ command: z.literal('finance.journal_voucher.record'), input: z.union([zJournalVoucherRequest, zSurplusResolutionRequest]), idempotencyKey: zId }),
          // The year-end closing (#889): the server builds the lines from the ledger.
          z.object({ command: z.literal('finance.closing.record'), input: zYearClosingRequest, idempotencyKey: zId }),
          // A month's depreciation and allocation (#919): the server builds the lines from the register.
          z.object({ command: z.literal('finance.depreciation.record'), input: zDepreciationRequest, idempotencyKey: zId }),
          // A sales e-invoice draft asked to be issued (#2502, ADR-0044 point 3): the server checks the draft and hashes what it is issued from; an owner or an admin approves.
          // EINVOICE_DRAFT_INVALID, EINVOICE_DRAFT_MISMATCH, EINVOICE_NOT_DRAFT (409/422), EINVOICE_ISSUE_PENDING (409) while a request for the same content is open.
          z.object({ command: z.literal('finance.einvoice.issue'), input: z.strictObject({ draftId: zId }), idempotencyKey: zId }),
          // The close of a month of stock (#2513): the server builds the cost of goods sold of the month from the stock moves; an owner or an admin approves.
          // STOCK_CLOSE_NOT_ENDED, STOCK_CLOSE_NEGATIVE, STOCK_CLOSE_UNPRICED, STOCK_CLOSE_NO_COST (422), STOCK_CLOSE_DONE, STOCK_CLOSE_ORDER, PERIOD_LOCKED (409).
          z.object({ command: z.literal('finance.stock.close_period'), input: zStockCloseRequest, idempotencyKey: zId }),
          // The confirmation of a count of stock (#2513): the server works out the differences from the books and builds the entry; an owner or an admin approves, and approving writes
          // the adjustment moves. STOCK_COUNT_NOT_DRAFT, STOCK_COUNT_CLOSED, PERIOD_LOCKED, STOCK_COUNT_STALE (409), STOCK_COUNT_UNPRICED, STOCK_COUNT_NO_DIFFERENCE (422).
          z.object({ command: z.literal('finance.stock.count_confirm'), input: zStockCountIdInput, idempotencyKey: zId }),
          // The posting of an approved pay run (#2532, ADR-0046): the server builds one line per account from the frozen run, with the account map of the entity's chart; an owner or an admin
          // approves it. HR_RUN_NOT_FOUND (404), HR_RUN_NOT_APPROVED, HR_POSTING_OPEN, HR_POSTING_DONE, PERIOD_LOCKED (409), HR_POSTING_ADJUSTMENTS, HR_POSTING_MISMATCH (422).
          z.object({ command: z.literal('finance.payroll_posting.record'), input: zHrPostingRequest, idempotencyKey: zId }),
          // The payment of a pay run's net pay or one remittance (#2532): the server builds the voucher from the frozen run; an owner or an admin approves. HR_RUN_NOT_FOUND (404),
          // HR_RUN_NOT_APPROVED, HR_PAYMENT_NOT_POSTED, HR_PAYMENT_POSTING_REVERSED, HR_PAYMENT_DONE, HR_PAYMENT_OPEN (409), HR_PAYMENT_NOTHING_DUE, HR_POSTING_MISMATCH, VOUCHER_INVALID (422).
          z.object({ command: z.literal('finance.payroll_payment.record'), input: zHrPaymentRequest, idempotencyKey: zId }),
          // The payment of a received invoice to its supplier's bank account (#3113 S4b): the server builds the request from the invoice and the supplier's one active account; an owner or an admin approves (four-eyes,
          // or a fresh second factor and a 24 hour hold on a new account). SUPPLIER_PAYMENT_INVOICE_NOT_FOUND (404), SUPPLIER_PAYMENT_NO_ACCOUNT, _ACCOUNT_AMBIGUOUS, _EXISTS, _PENDING (409).
          z.object({ command: z.literal('finance.supplier_payment.record'), input: zSupplierPaymentPrepare, idempotencyKey: zId }),
          // The settlement of an approved supplier payment by its bank line (#3700 S3c): the server builds the voucher (Dr 331 / Cr the bank) from the payment and the line; an owner or an admin (or the chief
          // accountant) approves. SUPPLIER_PAYMENT_NOT_FOUND (404), SUPPLIER_PAYMENT_NOT_APPROVED, _HELD, _ACCOUNT_CHANGED, _DOCUMENT, _NOT_EXPORTED, _ACCOUNT_MISMATCH, _SETTLE_PENDING (409), _CURRENCY, _LINE_MISMATCH, _LINE_BEFORE_FILE (422).
          z.object({ command: z.literal('finance.supplier_payment.settle.record'), input: zSupplierPaymentSettlePrepare, idempotencyKey: zId }),
          // The posting of a stored marketplace settlement (#2516): the server builds one journal voucher from its lines; an owner or an admin approves. Refused until the accountant has confirmed
          // the account map. MARKETPLACE_POSTING_MAP_UNCONFIRMED, MARKETPLACE_SETTLEMENT_POSTED, PERIOD_LOCKED (409), MARKETPLACE_SETTLEMENT_NOT_POSTABLE (422), MARKETPLACE_SETTLEMENT_NOT_FOUND (404).
          z.object({ command: z.literal('finance.marketplace_settlement.record'), input: zMarketplaceSettlementRequest, idempotencyKey: zId }),
          // The posting of a platform's payout (#2516): the server builds one journal voucher from the settlement's lines, and the bank line only has to match the net; an owner or an admin approves. Refused
          // until the accountant has confirmed the account map, and while the settlement is not posted. MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED, MARKETPLACE_PAYOUT_BANK_LINE, MARKETPLACE_PAYOUT_POSTED (409).
          z.object({ command: z.literal('finance.marketplace_payout.record'), input: zMarketplacePayoutRequest, idempotencyKey: zId }),
          // The clearing of the fees on 1388 by the platform's fee invoice (#2516): one journal voucher Dr 331 / Cr 1388 built from a posted purchase document; an owner or an admin approves. Refused until the
          // accountant has confirmed the account map. MARKETPLACE_FEE_DOCUMENT (422), MARKETPLACE_FEE_NOTHING_TO_CLEAR (409), PERIOD_LOCKED (409).
          z.object({ command: z.literal('finance.marketplace_fee_clearing.record'), input: zMarketplaceFeeClearingRequest, idempotencyKey: zId }),
        ]),
      )
      .output(z.object({ proposalId: zId })),
  },
  // Mails forwarded to the org's inbound address (#779), newest first, for the Inbox's *Soạn bài đăng từ thư này*:
  // owners, admins and members.
  inbound: {
    recent: oc.output(
      z.array(z.object({ id: zId, from: z.string().nullable(), subject: z.string().nullable(), attachmentCount: z.number().int().min(0), receivedAt: z.string(), hasText: z.boolean() })),
    ),
  },
  files: {
    recent: oc.output(z.array(zFileStatus)),
    // Every role: the bank statements read from files that wait for a member to import or skip them (#2142), newest first,
    // however many files came since (recent lists only the newest).
    staged: oc.output(z.array(zFileStatus)),
    // Every role: the status of the given files of the org, in the order asked (ids it cannot see are left out), and
    // for a ZIP archive the entries it was opened into, each with its own file's status (bulk intake, #314).
    batch: oc.input(z.object({ ids: z.array(zId).min(1).max(MAX_BATCH_FILES) })).output(z.array(zBatchFile)),
    // Owners, admins and members: reads the file again (issue #40). The result is a new extraction version and,
    // when it reads an invoice, a new revision of the file's pending proposal (or a new proposal after a rejected
    // one). Refused while a run is in flight and once the invoice is booked. A retry with the same idempotencyKey
    // returns the first result.
    reextract: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId, version: z.number().int() })),
  },
  parties: {
    // Vendors by default; all: true lists customers too (the party picker of vouchers, #327).
    list: oc.input(z.object({ q: z.string().max(100).optional(), all: z.boolean().optional() })).output(z.array(zParty)),
    // Owners and admins (R1, #319): the debit account proposed first for a vendor's invoices, a TT133 account or an
    // active sub-account; null clears it (the keyword rules apply again).
    setDefaultAccount: oc
      .input(z.object({ partyId: zId, accountCode: zAccountCode.nullable() }))
      .output(z.object({ partyId: zId, accountCode: zAccountCode.nullable() })),
    // Every role (#670): the customers, by name, a page at a time (after: the last customer shown; more: others
    // follow), each with its receivable on 131 and its last invoice date. q searches the name and the tax code.
    // The customers of one legal entity (#1534): legalEntityId as in zLegalEntityChoice.
    customers: oc.input(z.object({ q: z.string().max(100).optional(), after: zCustomerCursor.optional(), legalEntityId: zId.optional() })).output(zCustomerPage),
    // Owners, admins and members (R1, CRM K4 #2228): a person or a company by hand, validated as an edit is; a tax code
    // another party uses refuses (409) and names it.
    create: oc.input(zPartyCreate).output(z.object({ partyId: zId, version: z.number().int() })),
    // Owners, admins and members (R1, #887): the party's name and contact details, from the version the editor read.
    // A tax code can be added, never changed or removed.
    update: oc
      .input(
        z.object({
          partyId: zId,
          version: z.number().int().min(1),
          name: z.string().max(1000),
          taxCode: z.string().max(40).nullable(),
          address: z.string().max(2000).nullable(),
          email: z.string().max(1000).nullable(),
          phone: z.string().max(100).nullable(),
          // The kind, when it changes (#2438): only for a party nothing points at (PARTY_KIND_LOCKED), and a person with a company clears the link first.
          kind: zPartyKind.optional(),
        }),
      )
      .output(z.object({ partyId: zId, version: z.number().int() })),
    // Owners and admins (R1, #887): partyId becomes a duplicate of keepId, hidden from lists and search and reported
    // under it; nothing is deleted. unmarkDuplicate undoes it.
    markDuplicate: oc.input(z.object({ partyId: zId, keepId: zId })).output(z.object({ partyId: zId, keepId: zId })),
    unmarkDuplicate: oc.input(z.object({ partyId: zId })).output(z.object({ partyId: zId })),
    // Owners, admins and members (R1, #2438): the company a person works at, set, changed or cleared (companyId null), from the version the editor read. The company
    // is an organization of the org that is not merged into another; only a person has one.
    setCompany: oc.input(z.object({ partyId: zId, companyId: zId.nullable(), version: z.number().int().min(1) })).output(z.object({ partyId: zId, version: z.number().int() })),
    // Every role (K4, #2228): what happened to a contact, oldest first (fixed text, never a name or contact detail).
    timeline: oc.input(z.object({ partyId: zId })).output(zTimeline),
    // Owners, admins and members: pairs of parties that look like duplicates, strongest first.
    duplicateHints: oc.input(z.object({})).output(z.array(zDuplicateHint)),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional(), legalEntityId: zId.optional() })).output(z.array(zPurchaseDocument)),
    // Every role (issue #878): the exports a recorded document went out in, for its history.
    exports: oc.input(z.object({ documentId: zId })).output(z.array(zDocumentExport)),
  },
  // In-app notifications of the kernel and finance (#671): each member reads, marks and turns off only their own.
  notifications: {
    list: oc.input(z.object({})).output(zNotifications),
    read: oc.input(z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })])).output(z.object({ read: z.number().int() })),
    mute: oc.input(z.strictObject({ kind: zNotificationKind, muted: z.boolean() })).output(z.object({ kind: zNotificationKind, muted: z.boolean() })),
    // Browser push (#1238, the kernel's since #3736), per device: whether the deployment offers it (VAPID keys set) with the key browsers subscribe with, the viewer's devices and whether the asking browser
    // (its endpoint) is one; subscribe answers PUSH_DISABLED without the keys. Each member sees and changes only their own; no endpoint or key comes back. One subscription serves every app's notices.
    push: {
      status: oc.input(z.strictObject({ endpoint: z.string().max(2048).nullable() })).output(zPushStatus),
      subscribe: oc.input(zPushSubscribe).output(z.object({ id: zId })),
      unsubscribe: oc.input(z.union([z.strictObject({ endpoint: z.string().min(1).max(2048) }), z.strictObject({ id: zId })])).output(z.object({ removed: z.number().int() })),
    },
  },
  // Saved views of a list (CRM plan 4.3, #2227), the kernel's: named filters and a sort, private or shared with the org, at
  // most 30 per member per scope. Members see their own and the shared ones; the owner changes and deletes a view, and
  // owners and admins a shared one. The input is checked against the scope registry by the command (422).
  savedViews: {
    list: oc.input(zSavedViewList).output(z.array(zSavedView)),
    save: oc.input(zSavedViewSaveShape).output(z.object({ viewId: zId })),
    rename: oc.input(zSavedViewRename).output(z.object({ viewId: zId })),
    setShared: oc.input(zSavedViewSetShared).output(z.object({ viewId: zId })),
    remove: oc.input(zSavedViewDelete).output(z.object({ viewId: zId })),
  },
  // The conversation core (#2303): comments under the org's posts and private messages, one store. Every role reads what the
  // database lets it read (a comment thread of a channel it may use; a private message only owners, admins and holders of
  // kernel.conversation.direct.read); owners, admins and members answer, hide, assign, resolve and note; a viewer only reads. A reply
  // carries the last seq its sender saw (409 CONVERSATION_MOVED when a newer message exists).
  conversations: {
    list: oc.input(zConversationList).output(zConversationListed),
    counts: oc.input(zConversationCounts).output(zConversationCounted),
    // The comment threads still New under each of the posts a screen shows, in one read (#3298).
    postCounts: oc.input(zConversationPostCounts).output(zConversationPostCounted),
    get: oc.input(zConversationGet).output(zConversationDetail),
    reply: oc.input(zConversationReply).output(zConversationReplied),
    replyPrivately: oc.input(zConversationPrivateReply).output(zConversationPrivateReplied),
    // A refused or unclear reply: send it again as a new attempt, or record that it did go out.
    settle: oc.input(zConversationSettle).output(z.object({ messageId: zId, state: z.string() })),
    hide: oc.input(zConversationHide).output(z.object({ messageId: zId })),
    assign: oc.input(zConversationAssign).output(z.object({ conversationId: zId })),
    resolve: oc.input(zConversationId).output(z.object({ conversationId: zId })),
    reopen: oc.input(zConversationId).output(z.object({ conversationId: zId })),
    note: oc.input(zConversationNoteAdd).output(z.object({ noteId: zId })),
    linkContact: oc.input(zConversationLinkContact).output(z.object({ conversationId: zId })),
    // "Create task" (CV3, #3295): a person makes a kernel task that links back to the thread; the thread lists its open tasks. No agent, no model.
    followUp: oc.input(zConversationFollowUp.extend({ idempotencyKey: zId })).output(zConversationFollowedUp),
    tasks: oc.input(zConversationId).output(zConversationTaskList),
    // The intent (CV3, #2306): a person applies, changes or clears it (the only thing stored). The AI coworker's suggestion and the likely contacts of a
    // customer are read apart: a model call through the AI budget meter, never stored, and with the model off, spent or failing the answer is no suggestion.
    setIntent: oc.input(zConversationSetIntent).output(z.object({ conversationId: zId, intent: zConversationIntent.nullable() })),
    suggestIntents: oc.input(zConversationIntentSuggest).output(zConversationIntentSuggested),
    contactMatches: oc.input(zConversationContactMatches).output(zConversationContactMatched),
    markRead: oc.input(zConversationMarkRead).output(z.object({ conversationId: zId })),
    // The inbox (CV3, #2306): the "you are replying" marker (at most one write in 20 seconds per thread and member), and the member's availability
    // for new conversations (every staff member reads the team's, a member sets their own).
    composing: oc.input(zConversationComposing).output(zConversationComposed),
    availability: oc.input(z.strictObject({})).output(zAvailability),
    setAvailability: oc.input(zAvailabilitySet).output(zAvailabilityEntry),
    // A demo comment on a post of a sandbox connection (owners and admins): it goes through the same intake a platform's notice takes.
    sandboxComment: oc.input(zConversationSandboxComment).output(zConversationSandboxQueued),
    // The retention of the org's threads (every member reads it; owners and admins set it), and the erasure of one customer (owners and
    // admins, with a fresh second factor).
    retention: oc.input(z.strictObject({})).output(zConversationRetention),
    setRetention: oc.input(zConversationRetentionSet).output(zConversationRetention),
    // Engage's wake rules (#3862): the org's N for the three rules that have one (every member reads, owners and admins set; set in Settings, never on the inbox screen).
    wakeRules: oc.input(z.strictObject({})).output(zEngageWakeRulesView),
    setWakeRules: oc.input(zEngageWakeRules).output(zEngageWakeRulesView),
    eraseContact: oc.input(zConversationEraseContact.extend({ idempotencyKey: zId })).output(zConversationErased),
    // Deleting a disconnected channel's conversations too (#3299): the counts the confirmation names, then the erasure (owners and admins, a fresh
    // second factor; the channel must be disconnected first).
    channelCounts: oc.input(z.strictObject({ connectionId: zId })).output(zConversationChannelCounts),
    eraseChannel: oc.input(zConversationEraseChannel.extend({ idempotencyKey: zId })).output(zConversationChannelErased),
    // Vy's drafts (CV8, #2310): a member asks for one ("Vy soạn": the draft arrives in the thread's detail within seconds, written by the worker) or sets
    // one aside; owners and admins switch the drafting of new conversations on or off (a customer's message goes to the AI endpoint for it).
    draftRequest: oc.input(zConversationDraftRequest).output(z.object({ draftId: zId, queued: z.boolean() })),
    draftDiscard: oc.input(zConversationDraftDiscard).output(z.object({ discarded: z.boolean() })),
    autoDraft: oc.input(z.strictObject({})).output(zConversationAutoDraft),
    setAutoDraft: oc.input(zConversationAutoDraftSet).output(zConversationAutoDraft),
    // YouTube comments (#3134): the connections' opt-in and the day's quota units, and the owner or admin's switch (reading comments spends the project's quota).
    youtubeComments: oc.input(z.strictObject({})).output(zYoutubeCommentsStatusList),
    setYoutubeComments: oc.input(zYoutubeCommentsSet).output(z.object({ enabled: z.boolean() })),
    // The org's saved replies: every member reads them; owners, admins and members write them.
    savedReplies: oc.input(zSavedReplyList).output(zSavedReplyListed),
    createSavedReply: oc.input(zSavedReplyInput).output(z.object({ id: zId })),
    updateSavedReply: oc.input(zSavedReplyUpdate).output(z.object({ id: zId })),
    deleteSavedReply: oc.input(zSavedReplyId).output(z.object({ id: zId })),
  },
  // Every role (#673): parties by name or tax code, documents by series, number or party, journal entries by
  // description or amount. Vietnamese marks and case are ignored, and each word matches the start of a word.
  search: {
    query: oc.input(z.object({ q: z.string().trim().min(2).max(100), legalEntityId: zId.optional() })).output(zSearchResult),
  },
  journal: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional(), legalEntityId: zId.optional() })).output(z.array(zJournalEntry)),
    // One entry, for example the one a reversal proposal names.
    get: oc.input(z.object({ id: zId })).output(zJournalEntry),
  },
  // Cash and bank vouchers (#327): the posted vouchers of a date range, newest first, VOUCHER_PAGE_SIZE at a time
  // (before: the last voucher of the page shown; more: older ones follow). A voucher is entered with inbox.request
  // (command finance.voucher.record) and posted when its proposal is approved.
  vouchers: {
    list: oc
      .input(
        z.object({ from: zLocalDate.optional(), to: zLocalDate.optional(), type: zVoucherType.optional(), before: zVoucherCursor.optional(), legalEntityId: zId.optional() }),
      )
      .output(zCashVoucherPage),
    // What MISA's import will refuse or cut in one of the seven MISA SME voucher exports (#3848), found by code over the rows the file is built from, before the download. A read; the export is unchanged and never blocked.
    misaCheck: oc.input(zMisaCheckAsk).output(zMisaCheck),
    // The finance coworker's one line above that list (#3848 slice B): the check run again on the server and one metered sentence about its counts when there is a model. A read; it changes no voucher.
    misaCheckLine: oc.input(zMisaCheckLineAsk).output(zMisaCheckLine),
    // What would be sent to MISA AMIS Kế toán for a period and a voucher kind (#3901): the vouchers as the push would write them, with the blockers that keep one from being sent. A read; nothing is sent.
    misaAmisPreview: oc.input(zMisaAmisPreviewAsk).output(zMisaAmisPreview),
    // The accounting coworker's note on each kind of blocker on the AMIS preview (#3904): a read that runs the preview again on the server; the list decides, the notes only explain it.
    misaAmisBlockerNotes: oc.input(zMisaAmisBlockerNotesAsk).output(zMisaAmisBlockerNotes),
    // A person confirms a previewed batch for MISA AMIS (#3902, S3b): the requests are queued and the worker sends them. Owner or admin, never an agent. MISA_AMIS_PUSH_DISABLED (404) while the deployment has not
    // switched the push on, MISA_AMIS_NOT_TESTED, CHANNEL_NOT_ACTIVE, MISA_AMIS_CONNECTION_NOT_FOUND (404), MISA_AMIS_ENTITY_MISMATCH, MISA_AMIS_PUSH_TOO_MANY, MISA_AMIS_PUSH_EMPTY (422), MISA_AMIS_PUSH_BLOCKED and
    // MISA_AMIS_PUSH_STALE (409: the data changed since the preview; nothing is queued), MISA_AMIS_CHECK_REQUIRED (409: no check of this batch against the catalogue in the last 15 minutes, #4124), FORBIDDEN (403).
    misaAmisPush: oc.input(zMisaAmisPushConfirm).output(zMisaAmisPushConfirmed),
  },
  // Opening balances from Excel (#320), owners and admins. preview checks a trial balance read from the template and
  // writes nothing; post checks it again and posts it as the org's one opening entry (R3: fresh MFA). A retry with the
  // same idempotencyKey returns the first result. To replace an opening entry, reverse it first.
  openingBalance: {
    preview: oc.input(zOpeningBalanceImport).output(zOpeningBalancePreview),
    post: oc
      .input(zOpeningBalanceImport.extend({ idempotencyKey: zId }))
      .output(z.object({ journalEntryId: zId, lines: z.number().int().positive() })),
  },
  // The org's chart: the TT133 accounts and its own sub-accounts (#319), inactive ones included (pickers hide them).
  accounts: {
    list: oc.output(z.array(zAccount)),
    // Owners and admins (R1): a sub-account under a TT133 account or a digit sub-account (11211, 1121.VCB).
    create: oc
      .input(z.object({ parentCode: zAccountCode, code: zAccountCode, name: z.string().trim().min(1).max(200) }))
      .output(z.object({ id: zId, code: zAccountCode })),
    // Owners and admins (R1): renames, deactivates or reactivates a sub-account. TT133 accounts are read-only; an
    // account stays active while it is a vendor's default or has active sub-accounts.
    update: oc
      .input(z.object({ code: zAccountCode, name: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional() }))
      .output(z.object({ code: zAccountCode, name: z.string(), active: z.boolean() })),
  },
  // The org's MISA SME item and warehouse codes per stock account (#1398), for the goods purchase export
  // (GET /api/export/misa/goods-purchases.xlsx). Every member lists them; owners and admins (R1, audited) set one
  // account's codes (NOT_STOCK_ACCOUNT, UNKNOWN_ACCOUNT: 422) and remove them, so the account falls back to its
  // parent's codes or the defaults.
  misaGoodsCodes: {
    list: oc.output(z.array(zMisaGoodsCode)),
    set: oc.input(z.object({ accountCode: zAccountCode, itemCode: zMisaCode, warehouseCode: zMisaCode.nullable() })).output(zMisaGoodsCode),
    remove: oc.input(z.object({ accountCode: zAccountCode })).output(z.object({ removed: z.boolean() })),
  },
  // Learned account rules (#1399), shown in Settings. list: every role, newest first (at most 500). create: owners and
  // admins (R1), a keyword rule for every vendor or for one; RULE_TEXT_TOO_SHORT (422) when fewer than two letters or
  // digits are left once normalized, RULE_EXISTS (409) for the same keyword and vendor. remove: owners and admins (R1),
  // any rule, learned or added; RULE_NOT_FOUND (404). Approving an invoice writes the rules learned from it.
  // The learned rules that point a bank line's text at a party (#2402): list (every role) and remove (owners and admins,
  // R1, audited; RULE_NOT_FOUND 404). Approving the voucher of a bank line whose party a person chose writes the rule.
  bankPartyRules: {
    list: oc.input(zLegalEntityChoice.optional()).output(z.array(zBankPartyRule)),
    remove: oc.input(z.object({ id: zId })).output(z.object({ id: zId })),
  },
  // Customer payment reminders (#2488, "nhắc thu nợ"). list (every role): the customers with a sales invoice past its due date and an amount
  // left, in the entity the caller names or sees, longest overdue first. draft (every role): one customer's overdue invoices as the books
  // stand, the fixed words for its notice level and the bank accounts it may ask to be paid into; NOTHING_OVERDUE (409). send (owners,
  // admins, members; R2, a mail): queues the reminder the person approved, its facts rebuilt from the books; STALE_REMINDER (409) when the
  // level or total moved since the draft, CUSTOMER_EMAIL_REQUIRED (409), ALREADY_REMINDED (409) for a second one of the level within three days
  // unless confirm is true, PAY_TO_NOT_FOUND (422).
  // The household business kind (#2517, plan stock-and-marketplaces.md 8.5): the profile of a legal entity of kind household and the law as dated data. Every role reads;
  // owners and admins set a new row from a date (R1, audited). A row of the law that is still `commentary` is marked so in the answer.
  household: {
    profile: oc.input(zHouseholdProfileGet).output(zHouseholdProfileView),
    profileSet: oc.input(zHouseholdProfileSet).output(zHouseholdProfileView),
    rules: oc.input(zHouseholdRulesGet.optional()).output(zHouseholdRules),
    // S1a-HKD, the sales listing of a household of group 1, from the ledger's account 511; refused for an entity whose profile does not require it.
    s1a: oc.input(zHouseholdS1aGet).output(zHouseholdS1a),
    // The 01/CNKD return worksheet of a household that pays by a percentage of revenue, one quarter (#2518); a worksheet, never filed by Ludy.
    cnkd: oc.input(zHouseholdCnkdGet).output(zHouseholdCnkd),
    // S2a-HKD, the revenue book of a household that pays a percentage of revenue: S1a split by business line, with VAT and PIT per line (#2517 slice 2a); labelled provisional while its rows are unconfirmed.
    s2a: oc.input(zHouseholdS2aGet).output(zHouseholdS2a),
    // S2b-HKD, the revenue book of a household that pays PIT on income: the S2a split by business line with the VAT per line and no PIT column, labelled provisional while its rows are `commentary` (#2517 slice 2c).
    s2b: oc.input(zHouseholdS2bGet).output(zHouseholdS2b),
    // S2c-HKD, the revenue and expense detail of a household that pays PIT on income: expenses by the dated account-to-group map, unmapped ones apart (#2517 slice 2b); labelled provisional while its rows are unconfirmed.
    s2c: oc.input(zHouseholdS2cGet).output(zHouseholdS2c),
    // S2d-HKD, the goods book of a household that pays PIT on income: per item the quantity and value in, out and on hand for one month, from the stock data of #2513 (#2517 slice 2d); the cost is provisional until the month is closed.
    s2d: oc.input(zHouseholdS2dGet).output(zHouseholdS2d),
    // S2e-HKD, the cash and bank book of a household that pays PIT on income: per account of 111 and 112 the opening balance, the lines and the closing balance (#2517 slice 2e); labelled provisional while its layout row is unconfirmed.
    s2e: oc.input(zHouseholdS2eGet).output(zHouseholdS2e),
  },
  // A supplier's bank accounts and the history of their changes (#3113 S1). Owners and admins only; a change needs a fresh second factor (STEP_UP_REQUIRED otherwise). The full number is sealed
  // and never returned: an account is its bank and its last four digits. SUPPLIER_NOT_FOUND, SUPPLIER_BANK_ACCOUNT_NOT_FOUND (404), SUPPLIER_BANK_NUMBER_INVALID (422),
  // SUPPLIER_BANK_ACCOUNT_EXISTS, SUPPLIER_BANK_ACCOUNT_NOT_ACTIVE, SUPPLIER_BANK_ACCOUNT_SAME (409).
  supplierBank: {
    list: oc.input(zSupplierBankAccountListInput).output(zSupplierBankAccountList),
    add: oc.input(zSupplierBankAccountAdd).output(zSupplierBankAccount),
    replace: oc.input(zSupplierBankAccountReplace).output(zSupplierBankAccount),
    retire: oc.input(zSupplierBankAccountRetire).output(zSupplierBankAccount),
    // The supplier's key is shredded, so the sealed number and holder can never be opened again: owners only.
    erase: oc.input(zSupplierBankAccountErase).output(zSupplierBankAccountErased),
  },
  // The payments to a supplier approved in Ludy (#3113 S2). Owners and admins only; the request for approval is a proposal (kernel.proposal.request with command finance.supplier_payment.record and
  // `purchaseDocumentId`). Marking that the supplier confirmed the account needs a fresh second factor (STEP_UP_REQUIRED otherwise). SUPPLIER_PAYMENT_NOT_FOUND, SUPPLIER_PAYMENT_INVOICE_NOT_FOUND (404),
  // SUPPLIER_PAYMENT_NO_ACCOUNT, SUPPLIER_PAYMENT_ACCOUNT_AMBIGUOUS, SUPPLIER_PAYMENT_EXISTS, SUPPLIER_PAYMENT_PENDING, SUPPLIER_PAYMENT_CHANGED, SUPPLIER_PAYMENT_NOT_APPROVED,
  // SUPPLIER_PAYMENT_ALREADY_CONFIRMED (409).
  supplierPayment: {
    list: oc.input(zSupplierPaymentListInput).output(zSupplierPaymentList),
    // The received invoices that can be asked for payment (#3113 S4b), oldest first.
    payable: oc.input(z.strictObject({})).output(zSupplierPayableList),
    // The finance coworker's one line above that list (#3113 S4c): the facts by code, and one metered sentence when there is a model. A read; it asks for no payment.
    payableLine: oc.input(zSupplierPayableLineAsk).output(zSupplierPayableLine),
    confirmAccount: oc.input(zSupplierPaymentConfirm).output(zSupplierPayment),
    cancel: oc.input(zSupplierPaymentCancel).output(zSupplierPayment),
  },
  paymentReminders: {
    list: oc.input(z.object({ legalEntityId: zId.optional() }).optional()).output(zPaymentReminderList),
    draft: oc.input(z.object({ partyId: zId, legalEntityId: zId.optional() })).output(zPaymentReminderDraft),
    send: oc.input(zPaymentReminderSend).output(zPaymentReminderSent),
    // The finance coworker's wording of the lead-in and the closing (#2488, slice 2), read-only and stored nowhere: the model is told the notice level, the
    // language and the sender's name, never a fact of the books, and its text is refused when it holds a figure or a link. Any refusal leaves words null and the
    // screen on the fixed template words.
    wording: oc.input(zPaymentReminderWordingAsk).output(zPaymentReminderWording),
    // The org's terms and weekly switch (#2488, slice 3): get for every role, set for owners and admins (R1, audited). The terms date the invoices of every customer
    // that has none of its own; the weekly switch only adds a "Hôm nay cần bạn" item, it drafts and sends nothing.
    settings: {
      get: oc.output(zCollectionSetting),
      set: oc.input(zCollectionSetting).output(zCollectionSetting),
    },
    // One customer's own terms (null: the org's) and its pause (the last day with no reminder; null: not paused): get for every role, set for owners, admins and
    // members (R1, audited). The settings sit on the kept party of a duplicate group. PARTY_NOT_FOUND (404), PAUSE_DATE_INVALID and PAUSE_TOO_LONG (422).
    customer: {
      get: oc.input(z.object({ partyId: zId })).output(zCustomerCollection),
      set: oc.input(zCustomerCollectionSet).output(zCustomerCollection),
    },
  },
  // Sales e-invoice drafts and the series they are issued from (#2500, ADR-0044). Nothing issues an invoice and no provider is called: a draft is made, checked,
  // edited and deleted while it is a draft; the amounts are computed by the server from the lines. Every role reads; owners, admins and members write drafts;
  // owners and admins read a series from the provider (the offline sandbox, when EINVOICE_SANDBOX is on).
  einvoice: {
    status: oc.output(zEInvoiceStatus),
    series: {
      list: oc.output(z.array(zEInvoiceSeries)),
      // EINVOICE_DISABLED (404) when the sandbox is off; LEGAL_ENTITY_NOT_ALLOWED (403) for an entity the caller may not see.
      sync: oc.input(zEInvoiceSeriesSync).output(zEInvoiceSeriesSynced),
      // The entity's default series: owners and admins; EINVOICE_SERIES_NOT_FOUND (404).
      setDefault: oc.input(zEInvoiceSeriesSetDefault).output(z.object({ series: z.array(zEInvoiceSeries) })),
    },
    // The org's own account at a provider (#2501, ADR-0044 point 2). The credential is sealed in the kernel and never in an answer, a log or an audit row. Every member
    // reads the connections and their last test; owners and admins connect, test and disconnect.
    providers: oc.output(z.array(zEInvoiceProviderInfo)),
    connections: {
      list: oc.output(z.array(zEInvoiceConnection)),
      // EINVOICE_DISABLED (404) for a provider this deployment does not offer, EINVOICE_SIGNING_TOKEN (422) for a provider whose signature needs the seller's own token,
      // EINVOICE_FIELDS (422) when the fields are not the adapter's, EINVOICE_TAX_CODE_NEEDED and EINVOICE_TAX_CODE_MISMATCH (422), EINVOICE_CONNECTION_EXISTS (409),
      // FORBIDDEN (403) unless owner or admin.
      connect: oc.input(zEInvoiceConnect).output(z.object({ id: zId })),
      // Reads the provider's templates and series and records the state; the series it finds are added to the connection's entity. EINVOICE_PROVIDER_NOT_READY (503)
      // for a provider that is reached through the worker.
      test: oc.input(z.object({ id: zId })).output(zEInvoiceConnectionTested),
      disconnect: oc.input(z.object({ id: zId })).output(z.object({ removed: z.boolean() })),
    },
    drafts: {
      // The drafts of one legal entity, or of every entity the caller may see when none is named.
      list: oc.input(z.object({ legalEntityId: zId.optional() }).optional()).output(z.array(zEInvoiceDraftSummary)),
      get: oc.input(z.object({ draftId: zId })).output(zEInvoiceDraft),
      // The live check of the form as it stands: the computed lines, the totals and the issues, nothing stored.
      check: oc.input(zEInvoiceDraftCheckInput).output(zEInvoiceDraftCheck),
      // EINVOICE_DRAFT_NOT_FOUND (404), EINVOICE_NOT_DRAFT (409), EINVOICE_SERIES_NOT_FOUND (404), EINVOICE_SERIES_ENTITY (422), EINVOICE_ENTITY_FIXED (422),
      // EINVOICE_DRAFT_INVALID (422), PARTY_NOT_FOUND (404). A draft that fails a check is saved all the same, with its issues.
      save: oc.input(zEInvoiceDraftSave).output(zEInvoiceDraft),
      delete: oc.input(z.object({ draftId: zId })).output(z.object({ deleted: z.literal(true) })),
      // "Điều chỉnh" or "Thay thế" from an issued invoice (#2504): a correcting draft with a copy of the original's buyer and lines (the lines of an adjustment start empty, the difference per line is
      // typed with its sign). Owners, admins and members. It issues nothing: issuing is the same R3 approval as any invoice. See zEInvoiceStartCorrection for the refusals.
      startCorrection: oc.input(zEInvoiceStartCorrection).output(zEInvoiceDraft),
      // The reason codes a correction may carry (#2504); empty until Appendix XVII is entered. Owners, admins and members.
      correctionOptions: oc.input(z.object({})).output(zEInvoiceCorrectionOptions),
      // The VAT rate a correction proposes for the nature a person picked (#3709): the basis and the rate by code, the fixed reason and the Official Letter 2121/TCT-CS note, and the accounting
      // coworker's plain explanation when the model is on and the AI budget allows (`ai` says why not). Read only; the person confirms by starting the correction. Owners, admins and members.
      correctionRate: oc.input(zEInvoiceCorrectionRateInput).output(zEInvoiceCorrectionRateExplained),
      // The accounting coworker's proposal of the reason code of an adjusting or replacing invoice (#3690): a read that never stores; the code is one of the entered list, picked by number and checked in code,
      // and the person confirms by starting the correction (`ai` says why there is none). The note typed is never stored or logged. Owners, admins and members.
      suggestReason: oc.input(zEInvoiceReasonInput).output(zEInvoiceReasonSuggested),
      // An error only in the non-core content of an issued invoice (#2504): records it with the text that is right, and the two steps the seller does outside Ludy (tell the buyer; file the
      // form 04/SS-HĐĐT, a working answer of #2506 not confirmed by the accountant). Ludy sends nothing. Owners, admins and members.
      noticeOpen: oc.input(zEInvoiceNoticeOpen).output(zEInvoiceNotice),
      noticeStep: oc.input(zEInvoiceNoticeStep).output(zEInvoiceNotice),
      noticeList: oc.input(zEInvoiceNoticeListInput).output(zEInvoiceNoticeList),
      // The draft of a sales order (#2818, ADR-0050): the hand-off Engage's crm.salesOrders.handoff read, with the line numbers to invoice (none: every open item line); whole lines only. Owners, admins and members;
      // the idempotency key replays the same draft. ORDER_PAYLOAD_MISMATCH, ORDER_LINE_UNKNOWN, ORDER_LINE_NOT_INVOICEABLE, ORDER_LINE_DISCOUNTED, ORDER_TOO_MANY_LINES, EINVOICE_TOTAL_TOO_LARGE (422),
      // ORDER_LINE_ALREADY_INVOICED and ORDER_NOTHING_TO_INVOICE (409), LEGAL_ENTITY_NOT_ALLOWED (403). Nothing is issued: issuing needs finance's approval.
      fromOrder: oc.input(zEInvoiceDraftFromOrder.extend({ idempotencyKey: zId })).output(zEInvoiceDraft),
      // Which lines of these orders (1 to 50) a draft names, and whether it is issued (#3477): `draft` or `issued`, no other fact of the draft. Every role reads it, by the drafts' own row policy
      // (a member limited to some legal entities sees only the drafts of theirs). A line no draft names is not listed. The screen is a hint: ORDER_LINE_ALREADY_INVOICED stays the server's refusal.
      orderLines: oc.input(zOrderLineInvoiceStatesInput).output(zOrderLineInvoiceStates),
      // The request to issue a draft as the Inbox card shows it (#2502): the draft now, and whether it is still what was asked for. Owners, admins and members.
      issueRequest: oc.input(z.object({ proposalId: zId })).output(zEInvoiceIssueView),
      // The coworker's proposal for the form from a text a person typed (#2505): lines, the VAT rate the text states, and the buyer from the org's customers. Owners, admins and members. Read only;
      // the model is asked outside any transaction, and an answer with a figure or a rate the text or the date does not allow is refused (ai: refused).
      suggest: oc.input(zEInvoiceSuggestInput).output(zEInvoiceSuggested),
      // The previous issued invoice to a customer, to copy with no model (#2721): the buyer and the lines it held, each line marked with whether its VAT rate is still allowed on the date given.
      // `invoice: null` when the customer has none in the books the caller may see. Owners, admins and members.
      previousInvoice: oc.input(zEInvoicePreviousInput).output(zEInvoicePrevious),
    },
  },
  // Marketplace order reports (#2515, ADR-0045): a Shopee, TikTok Shop or Lazada report read from a file waits, staged, for a member; nothing is stored as an order until the member confirms.
  // staged lists the reports waiting; preview says how one stands against the org's orders and stock items now; confirm stores the orders once and moves stock for the lines that name an
  // item (MARKETPLACE_NOT_STAGED, 409, when it was already decided or read again); reject skips it, storing nothing. orders lists the confirmed orders. No buyer data of any kind.
  marketplace: {
    staged: oc.input(z.object({}).optional()).output(z.array(zMarketplaceStaged)),
    preview: oc.input(z.object({ fileId: zId })).output(zMarketplacePreview),
    confirm: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(zMarketplaceConfirmResult),
    reject: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId })),
    orders: oc.input(zMarketplaceOrdersInput.optional()).output(z.array(zMarketplaceOrder)),
    // The order lines that move stock and name no item yet, newest first, and the assignment of one: the shipment (and the return) move stock through the item, once.
    // MARKETPLACE_LINE_ASSIGNED, MARKETPLACE_LINE_NOT_SHIPPED (409), MARKETPLACE_LINE_NOT_FOUND (404), STOCK_ITEM_ENTITY_MISMATCH (422), STOCK_ITEM_INACTIVE (409).
    unassigned: oc.input(zMarketplaceUnassignedInput.optional()).output(z.array(zMarketplaceUnassignedLine)),
    assign: oc.input(zMarketplaceAssign.extend({ idempotencyKey: zId })).output(z.object({ moves: z.number().int() })),
    // The coworker's proposal of the item for unassigned lines (#2686): a read that never stores; it sees the product name and the SKU text of each line and the entity's items, nothing else of the order. A person
    // fills the picker and assigns. Owners, admins and members.
    suggest: oc.input(zMarketplaceSuggestInput).output(zMarketplaceSuggested),
    // Takes a line back from its item: its stock comes back and it waits to be assigned again (#2633). MARKETPLACE_LINE_NOT_ASSIGNED (409) for a line that names no item, MARKETPLACE_LINE_CANCELLED (409) for one cancelled after it shipped (its stock came back by itself). forgot: whether the taught name of that SKU went too (only the one that put the line on its item).
    unassign: oc.input(zMarketplaceUnassign.extend({ idempotencyKey: zId })).output(z.object({ moves: z.number().int(), forgot: z.boolean() })),
    // The income reports (#2516): the platform's own statement of what it paid for the orders of a period, staged from a file until a member confirms. incomeStaged lists the reports waiting,
    // incomePreview says how one stands against the org's orders and settlements now and what blocks it (MARKETPLACE_INCOME_NOT_STAGED, 409, when it was already decided or read again), incomeConfirm
    // stores the settlement and its lines in one transaction (MARKETPLACE_INCOME_PERIOD_UNKNOWN, MARKETPLACE_INCOME_TOTAL_MISMATCH, MARKETPLACE_INCOME_UNKNOWN_ORDERS 422; MARKETPLACE_INCOME_OVERLAP,
    // MARKETPLACE_INCOME_REPEATED_LINES, MARKETPLACE_INCOME_BUSY 409), incomeReject skips it, storing nothing. No buyer data of any kind.
    incomeStaged: oc.input(z.object({}).optional()).output(z.array(zMarketplaceIncomeStaged)),
    incomePreview: oc.input(z.object({ fileId: zId })).output(zMarketplaceIncomePreview),
    incomeConfirm: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(zMarketplaceIncomeConfirmResult),
    incomeReject: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId })),
    // The org's own seller account at a marketplace (#2519, ADR-0045 point 7): the adapters this deployment enabled and, for the platforms none serves, the file the org brings.
    // The credential is sealed in the kernel and never in an answer, a log or an audit row. Every member reads the connections; owners and admins connect, test, pull and disconnect.
    // A pull only stages what it reads, in the Inbox, for a member to confirm exactly as for an uploaded file; it never writes an order or moves stock by itself.
    providers: oc.output(zMarketplaceProviders),
    connections: {
      list: oc.output(z.array(zMarketplaceConnection)),
      // MARKETPLACE_DISABLED (404) for an adapter this deployment does not offer, MARKETPLACE_PLATFORM (422) for a platform the adapter does not serve, MARKETPLACE_FIELDS (422) when the
      // fields are not the adapter's, MARKETPLACE_CONNECTION_EXISTS (409), FORBIDDEN (403) unless owner or admin.
      connect: oc.input(zMarketplaceConnect).output(z.object({ id: zId })),
      // The offline adapter answers the state at once; an adapter that reaches the platform answers `{queued: true}` and the worker records the state (the list shows it). CHANNEL_NOT_ACTIVE (409), MARKETPLACE_DISABLED (404).
      test: oc.input(z.object({ id: zId })).output(zMarketplaceConnectionTestAnswer),
      // With `deleteStaged` the reports of this connection still waiting in the Inbox are rejected first (each is the member's own decision, nothing is posted; their originals follow the retention that
      // already exists), and `discarded` says how many. MARKETPLACE_TOO_MANY_STAGED (409) when there are more than can be discarded at once: nothing is done then.
      disconnect: oc.input(z.object({ id: zId, deleteStaged: z.boolean().optional() })).output(z.object({ removed: z.boolean(), discarded: z.number().int().min(0).optional() })),
      // Asks for the orders now: the offline adapter only (a real one is polled by the worker on its own schedule). The job is queued; the answer is whether it was. MARKETPLACE_DISABLED (404),
      // MARKETPLACE_PROVIDER_NOT_READY (503), CHANNEL_NOT_ACTIVE (409).
      pollNow: oc.input(z.object({ id: zId })).output(z.object({ queued: z.boolean() })),
      // The seller's authorization of a connection on the platform's own page (#4238, Lazada). Start: the address of that page, with a one-time state bound to this connection and this member (10 minutes).
      // MARKETPLACE_AUTHORIZE_UNSUPPORTED (422), MARKETPLACE_APP_KEY_MISSING (409), CHANNEL_NOT_ACTIVE (409), FORBIDDEN (403) unless owner or admin.
      authorizeStart: oc.input(z.object({ id: zId })).output(zMarketplaceAuthorizeStarted),
      // Finish: the page the platform returns the seller to calls this with the state and the one-time code. The code is sealed here and traded by the worker; the answer is only the connection. MARKETPLACE_AUTHORIZE_INVALID (400)
      // for a state that is wrong, used, ended, another member's or another org's.
      authorizeFinish: oc.input(zMarketplaceAuthorizeReturn).output(z.object({ id: zId })),
      // The push address of one connection (#4348, S3b of #4315): owners and admins make it or replace it (the old one stops at once) and see it ONCE; the status never carries it. MARKETPLACE_CONNECTION_NOT_FOUND (404),
      // MARKETPLACE_PUSH_UNSUPPORTED (422) for an adapter that takes no push or a deployment that does not run it, CHANNEL_NOT_ACTIVE (409), FORBIDDEN (403) unless owner or admin.
      pushHookSet: oc.input(zMarketplacePushHookSet).output(zMarketplacePushHookCreated),
      pushHook: oc.input(zMarketplacePushHookSet).output(zMarketplacePushHookStatus),
    },
    // The VAT method and rate of an entity's marketplace sales (#4303 S3a): dated entries, by effective date and, within a date, in the order entered (the last of a date is in force); every role reads, owners and admins add rows from a date
    // (R1, audited; append-only, a wrong row is corrected by a later entry for any date outside a locked period). The suggested schedule on the settings field applies only when a person picks the method and confirms it.
    // MARKETPLACE_VAT_RATE_LOCKED (409) inside a locked period, MARKETPLACE_VAT_RATE_DATE (422), FORBIDDEN (403) unless owner or admin.
    vatRates: {
      list: oc.input(zMarketplaceVatRatesGet).output(zMarketplaceVatRates),
      set: oc.input(zMarketplaceVatRateSet.extend({ idempotencyKey: zId })).output(zMarketplaceVatRates),
    },
    // The answer to "are the goods back?" for a marketplace line that came back (#4355, rule 8 of #2520): `back` writes the stock-in, `not_back` moves nothing; the work list offers the lines (`returns`). Owners, admins and
    // members, a person only (R1, audited). MARKETPLACE_RETURN_NOT_FOUND (404), MARKETPLACE_RETURN_NOT_OFFERED (422), MARKETPLACE_RETURN_DECIDED (409), MARKETPLACE_RETURN_COMPENSATED (409), FORBIDDEN (403) for an agent.
    returns: {
      decide: oc.input(zMarketplaceReturnDecide.extend({ idempotencyKey: zId })).output(zMarketplaceReturnDecided),
    },
    // Where each platform's money stands in the books (#2516, the Sàn screen): sales posted to 131, paid out, the difference and the fees awaiting an invoice (1388), per entity and platform,
    // read from the ledger by the platform's party. Every role reads; facts only, no model call, no order or buyer data.
    balance: oc.input(zMarketplaceBalanceInput.optional()).output(zMarketplaceBalance),
    // The facts the coworker's line is written from (#2516 slice E): stored settlements not yet posted, the platforms' balance and the fees awaiting an invoice. Every role reads; facts only.
    facts: oc.input(zMarketplaceBalanceInput.optional()).output(zMarketplaceFacts),
    // What the Sàn screen lets a person act on (#2516 slice F): the settlements to post, the posted settlements waiting for their payout with the bank lines it may be, the fee invoices that can clear, and
    // whether the account map is confirmed. A read: the actions themselves are inbox.request of the finance commands.
    worklist: oc.input(zMarketplaceBalanceInput.optional()).output(zMarketplaceWorklist),
    // The finance coworker's one line on the Sàn screen: the facts always, and one checked sentence when a model is on, within the AI budget. Read only: it stores nothing and posts nothing.
    line: oc.input(zMarketplaceLineAsk).output(zMarketplaceLine),
    // The finance coworker's note under the Sàn table for each platform with fees waiting on its 331 (#3711 slice 7): how old they are and what to do, from the books read again on the server. Read only: it posts nothing and changes no figure.
    feeNotes: oc.input(zMarketplaceFeeNotesAsk).output(zMarketplaceFeeNotes),
    // The finance coworker's note on a pending settlement or payout proposal (#4389): the figures and the Uncertain (#2520) points are chosen by code from the stored proposal; the model only words the figures. Read only: it changes no payload and has no action.
    proposalNote: oc.input(zMarketplaceProposalNoteAsk).output(zMarketplaceProposalNote.nullable()),
    // The columns of a report no platform profile fits (#4036, slice 1c of #3850). The file is read in the extract sandbox, which only the worker reaches, so `columnsCheck` files a request and queues the worker's
    // job (the sheet alone, or a mapping to check on the real file; a press while one waits returns it), `columns` reads what the worker found (the masked sheet, the check's refusal and a preview of at most 20
    // parsed lines), and `columnsProposal` asks Ly for a first mapping from the masked sheet alone, within the AI budget. Nothing is imported or saved. Owners, admins and members.
    // MARKETPLACE_COLUMNS_NOT_FOUND (404) for a file that is not a staged unrecognised report of the org, MARKETPLACE_COLUMNS_BUSY (409) when another request for the same file filed the row first.
    columnsCheck: oc.input(zMarketplaceColumnsCheckAsk.extend({ idempotencyKey: zId })).output(zMarketplaceColumnsCheckQueued),
    // The unrecognised spreadsheets of the org the screen offers a check for (newest first, at most 10), each with where its check stands.
    columnsFiles: oc.input(z.strictObject({})).output(z.array(zMarketplaceColumnsFile)),
    columns: oc.input(z.object({ fileId: zId })).output(zMarketplaceColumnsStatus),
    columnsProposal: oc.input(zMarketplaceColumnsProposalAsk).output(zMarketplaceColumnsProposal),
    // Saves the mapping of a passed check (#4037, slice 3 of #3850): the file whose check the person looked at and the platform and mapping they saw, which must be the file's last check (done, with parsed lines,
    // the same platform and mapping), or MARKETPLACE_COLUMNS_NOT_CHECKED / MARKETPLACE_COLUMNS_STALE (409); the profile's headers and digest come from what the worker recorded, and the check row is deleted in the
    // same transaction. Owners and admins; a person only. `columnsProfile` reads the org's latest saved mapping of a platform (every member).
    columnsConfirm: oc.input(zMarketplaceColumnsConfirm.extend({ idempotencyKey: zId })).output(zMarketplaceColumnsConfirmed),
    columnsProfile: oc.input(zMarketplaceColumnProfileQuery).output(zMarketplaceColumnProfile.nullable()),
  },
  // An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854). `status` says whether this deployment offers the connector (it does only when it holds the integrator's ClientID; the value is
  // never in any answer). The customer's access code is sealed in the kernel at the edge and never in an answer, a log or an audit row: the screen shows only "connected since". Every role reads the
  // connections; owners and admins connect and disconnect.
  misaAmis: {
    status: oc.output(zMisaAmisStatus),
    connections: {
      list: oc.output(z.array(zMisaAmisConnection)),
      // MISA_AMIS_DISABLED (404) when this deployment does not offer the connector, MISA_AMIS_CONNECTION_EXISTS (409), FORBIDDEN (403) unless owner or admin.
      connect: oc.input(zMisaAmisConnect).output(z.object({ id: zId })),
      disconnect: oc.input(z.object({ id: zId })).output(z.object({ removed: z.boolean() })),
      // Asks the worker to test the connection (S2b, #3885): it opens the sealed access code, asks AMIS for a token and the company's information, and records only a state (works, wrong_credentials,
      // unreachable) and a time, which the list then shows. Owner or admin. MISA_AMIS_DISABLED (404) when this deployment does not offer the connector, MISA_AMIS_CONNECTION_NOT_FOUND (404),
      // CHANNEL_NOT_ACTIVE (409), FORBIDDEN (403).
      test: oc.input(z.object({ id: zId })).output(z.object({ queued: z.boolean() })),
      // Keeps (or, with a null code, clears) the default item of the connection for service lines or sales lines (S3b, #4124): a code typed as the MISA catalogue spells it, which the next check validates against
      // the catalogue. Owner or admin. MISA_AMIS_CONNECTION_NOT_FOUND (404), FORBIDDEN (403); not gated by the connector's switch (nothing is sent).
      setDefaultItem: oc.input(zMisaAmisDefaultItem).output(z.object({ saved: z.boolean() })),
      // Keeps (or, with a null name, clears) the MISA name of one unit of Ludy on a MISA ASP connection (#4125): typed as the catalogue spells it, matched exactly by the next check. Owner or admin.
      // MISA_AMIS_CONNECTION_NOT_FOUND (404), MISA_AMIS_UNIT_NOT_ASP (422), MISA_AMIS_UNIT_INVALID (422), MISA_AMIS_UNIT_ALIASES_FULL (422), FORBIDDEN (403).
      setUnitAlias: oc.input(zMisaAmisUnitAlias).output(z.object({ saved: z.boolean() })),
    },
    // The check of a connection's vouchers against the firm's own MISA catalogue (S3a, #4112 of #4103): the worker opens the sealed access code, reads the catalogue pages in its memory, matches the parties
    // (by tax code) and items (by code) of the batch and records only what it found, which the preview then shows ("checked at"). Owner or admin; a second press while a check waits returns it. The ask is the
    // preview's own. MISA_AMIS_DISABLED (404), MISA_AMIS_CONNECTION_NOT_FOUND (404), CHANNEL_NOT_ACTIVE (409), MISA_AMIS_MATCH_ENTITY (422) when the ask names another entity, FORBIDDEN (403).
    matches: {
      check: oc.input(z.strictObject({ id: zId, ask: zMisaAmisPreviewAsk })).output(zMisaAmisMatchCheckQueued),
      // The proposals of the last check (S3b, #4124): a party with no tax code and the one active catalogue entry of its name. Owner or admin. Confirming makes the entry's code the party's code on the vouchers (the
      // preview then changes); rejecting deletes the proposal. MISA_AMIS_NAME_PROPOSAL_GONE (409) when a newer check replaced it, MISA_AMIS_CONNECTION_NOT_FOUND (404), FORBIDDEN (403).
      proposals: oc.input(zMisaAmisNameProposalsAsk).output(z.array(zMisaAmisNameProposal)),
      // The units of the last check of a MISA ASP connection that have no match (or a name typed) (#4125). Owner or admin.
      units: oc.input(zMisaAmisUnitsAsk).output(z.array(zMisaAmisUnitRow)),
      confirmName: oc.input(zMisaAmisNameDecision).output(zMisaAmisNameDecided),
      rejectName: oc.input(zMisaAmisNameDecision).output(zMisaAmisNameDecided),
    },
    // The vouchers pushed through a connection, with their state (#3902, S3b-2). Every role reads; a row's reason is MISA's own text (untrusted).
    pushes: {
      list: oc.input(zMisaAmisPushListAsk).output(z.array(zMisaAmisPushRow)),
      // An owner or admin settles a row MISA never answered for (a `sent` one after 24 hours, an `ambiguous` one after three days): nothing is sent. MISA_AMIS_PUSH_STATE (409) when the row cannot be settled now,
      // FORBIDDEN (403).
      resolve: oc.input(zMisaAmisPushResolveAsk).output(z.object({ resolved: z.boolean() })),
    },
  },
  // Stock (#2512, ADR-0045): the items of goods, the names a source uses for them, the append-only moves and the goods lines of posted documents not yet assigned to an item.
  // Every role reads; owners, admins and members write. A move is never edited or removed: a correction is a reversing move.
  stock: {
    items: {
      // The items of one legal entity, or of every entity the caller may see; the inactive ones only when asked. On hand is the sum of the item's moves.
      list: oc.input(z.object({ legalEntityId: zId.optional(), includeInactive: z.boolean().optional() }).optional()).output(z.array(zStockItem)),
      // STOCK_ITEM_CODE_EXISTS (409), STOCK_ITEM_CODE_FIXED, STOCK_ITEM_ENTITY_FIXED, STOCK_ITEM_IN_USE (the unit and the account stay once a move names the item),
      // STOCK_ACCOUNT_UNKNOWN, STOCK_ACCOUNT_INACTIVE, STOCK_ACCOUNT_KIND (422), STOCK_ITEM_NOT_FOUND (404).
      save: oc.input(zStockItemInput).output(z.object({ id: zId })),
      setActive: oc.input(z.object({ itemId: zId, active: z.boolean() })).output(z.object({ active: z.boolean() })),
    },
    aliases: {
      // STOCK_ALIAS_TAKEN and STOCK_ALIAS_FACTOR (409), STOCK_ALIAS_EMPTY (422), STOCK_ITEM_INACTIVE (409).
      teach: oc.input(zStockAliasTeach).output(z.object({ id: zId, existing: z.boolean() })),
      forget: oc.input(z.object({ aliasId: zId })).output(z.object({ removed: z.boolean() })),
    },
    moves: {
      list: oc.input(z.object({ itemId: zId, limit: z.number().int().min(1).max(500).optional() })).output(z.array(zStockMove)),
      // The correction of a move: a reversing move of the opposite quantity. STOCK_MOVE_NOT_FOUND (404), STOCK_MOVE_IS_REVERSAL and STOCK_MOVE_REVERSED (409).
      reverse: oc.input(z.object({ moveId: zId })).output(z.object({ id: zId })),
      // A partial return of the goods of a sale (#3712, a document line or a delivered CRM order line; not a marketplace order line): a stock-in of the same item naming the sale's stock-out, today's date, priced by the month close like any return in; no entry is posted.
      // STOCK_MOVE_NOT_FOUND (404), STOCK_RETURN_NOT_SALE, STOCK_RETURN_REVERSED, STOCK_RETURN_EXCEEDS (409).
      // The key is the identity of the return: a retry with the same key (a lost response) returns the first result and writes no second move.
      return: oc.input(zStockMoveReturn.extend({ idempotencyKey: zId })).output(z.object({ id: zId })),
    },
    // The stock of a delivered CRM order line (#2818, ADR-0050): the hand-off, the line number, the date and 'deliver' (default) or 'return' (a reversing move). Idempotent on (order, line): a retry answers
    // already_moved. A text line is a service and moves nothing. ORDER_PAYLOAD_MISMATCH, ORDER_DATE_FUTURE, STOCK_ORDER_LINE_NO_ITEM, STOCK_LINE_NO_QUANTITY, STOCK_ITEM_ENTITY_MISMATCH (422),
    // ORDER_LINE_UNKNOWN (404), ORDER_LINE_NOT_DELIVERED and ORDER_LINE_RETURNED (409).
    moveFromOrderLine: oc.input(zStockMoveFromOrderLine.extend({ idempotencyKey: zId })).output(zStockMoveFromOrderLineResult),
    // The goods lines of posted documents that moved no stock: they matched no item by code or by a taught name.
    unassigned: oc.input(zStockUnassignedInput.optional()).output(z.array(zStockUnassignedLine)),
    // Writes the move of a line and, unless told not to, teaches its name to the item. STOCK_LINE_NOT_FOUND (404), STOCK_LINE_ASSIGNED and STOCK_LINE_VOIDED (409),
    // STOCK_LINE_NOT_GOODS, STOCK_LINE_NO_QUANTITY and STOCK_ITEM_ENTITY_MISMATCH (422).
    assign: oc.input(zStockAssign).output(z.object({ moveId: zId, aliasId: zId.nullable() })),
    // Nhập xuất tồn of one month and the stock card of an item (#2513): read-only and provisional (the weighted average of the month); every role reads.
    report: oc.input(zStockReportInput).output(z.array(zStockReportRow)),
    card: oc.input(zStockCardInput).output(zStockCard),
    // The months a person has closed, newest first, with the cost posted for each (#2513).
    periods: oc.input(zStockPeriodsInput).output(z.array(zStockPeriod)),
    // Closes a month that has no cost to post, with no entry and so with no approval (owners and admins; R3, a closed month is not reopened). A month with cost goes through inbox.request
    // (finance.stock.close_period). STOCK_CLOSE_NOT_ENDED, STOCK_CLOSE_NEGATIVE, STOCK_CLOSE_UNPRICED (422), STOCK_CLOSE_DONE, STOCK_CLOSE_ORDER, STOCK_CLOSE_HAS_COST (409).
    closeEmpty: oc.input(zStockCloseRequest).output(zStockCloseEmptyResult),
    // What to know before closing a month (#3712 slice 3): the 1381 balance and whether Circular 99 asks it to be expensed at the reporting date. A read, a warning only; never blocks a close.
    closeCheck: oc.input(zStockCloseRequest).output(zStockCloseCheck),
    // The finance coworker on stock (#2514), all read-only. suggest: the item each unassigned line is most likely about (the model sees the line's description and unit and the
    // entity's item codes, names and units, nothing else; a person still assigns, which teaches the name); ai says why there is none. low: the items whose stock will not last the lead
    // days at the pace of the last eight weeks, with the supplier they were last bought from. reorderDraft: the message to that supplier (the model's, or the fixed template when there is
    // none), to copy or send from the person's own mail. STOCK_ITEM_NOT_FOUND and PARTY_NOT_FOUND (404), STOCK_ITEM_ENTITY_MISMATCH and STOCK_ITEM_INACTIVE (422/409).
    suggest: oc.input(zStockSuggestInput).output(zStockSuggested),
    low: oc.input(zStockLowInput.optional()).output(z.array(zStockLowItem)),
    reorderDraft: oc.input(zStockReorderAsk).output(zStockReorderDraft),
    // Counts of stock (#2513 part b), newest first (every role reads). create makes a draft with what was counted (owners, admins, members; STOCK_COUNT_FUTURE (422), STOCK_COUNT_CLOSED,
    // STOCK_COUNT_DUPLICATE_ITEM, STOCK_COUNT_ITEM_INACTIVE (409), STOCK_ITEM_NOT_FOUND (404), STOCK_COUNT_ITEM_ENTITY (422)); cancel drops a draft; confirmEmpty confirms a count that differs from the
    // books nowhere, with nothing to post. A count with differences is confirmed through inbox.request (finance.stock.count_confirm).
    counts: {
      list: oc.input(zStockCountListInput.optional()).output(z.array(zStockCount)),
      // Where the surplus of a confirmed count stands and the coworker's words about it (#3712 slice 2b).
      surplusNote: oc.input(zStockSurplusNoteInput).output(zStockSurplusNote),
      preview: oc.input(zStockCountPreviewInput).output(z.array(zStockCountPreviewRow)),
      create: oc.input(zStockCountCreate).output(z.object({ id: zId })),
      cancel: oc.input(zStockCountIdInput).output(z.object({ id: zId })),
      confirmEmpty: oc.input(zStockCountIdInput).output(z.object({ id: zId })),
    },
  },
  accountRules: {
    list: oc.input(zLegalEntityChoice.optional()).output(z.array(zCategorizationRule)),
    create: oc
      .input(
        z.object({ keyword: z.string().trim().min(1).max(500), accountCode: zAccountCode, vendorPartyId: zId.nullable().optional(), legalEntityId: zId.optional() }),
      )
      .output(z.object({ id: zId })),
    remove: oc.input(z.object({ id: zId })).output(z.object({ id: zId })),
  },
  // VAT working for one month or quarter (issue #316); the Excel file is GET /api/export/vat.xlsx?period=<period>.
  // markPayment (owners, admins, members; R1, audited; #917): the accountant's mark on an input invoice of the period
  // that needs proof of non-cash payment: paid_by_bank (optionally with the bank voucher, báo Nợ, that paid it),
  // not_deductible, or cleared. NOT_FLAGGED (409) when the invoice does not need the check; VOUCHER_NOT_BANK (422)
  // when the voucher is not a báo Nợ of the org.
  vat: {
    period: oc.input(z.object({ period: zVatPeriod, legalEntityId: zId.optional() })).output(zVatReport),
    // explain (#3540; finance roles, read-only): the coworker's sentence naming each late sales invoice and its original period, from the working's own lists. AI off, spent or refused: `ai` says so
    // and the screen shows the template sentence built from the same lists. Nothing is declared or posted.
    explain: oc.input(zVatLateExplainAsk).output(zVatLateExplanation),
    // salesNumberGaps (every role; #2140): the numbers missing in the org's own sales e-invoice series, per template,
    // series and year. With period, the runs that may fall in it (VAT working); with fromYear, the series of that year on
    // (Overview); alone, every year. Read-only.
    salesNumberGaps: oc
      .input(z.object({ period: zVatPeriod.optional(), fromYear: z.number().int().min(2000).max(2100).optional(), legalEntityId: zId.optional() }))
      .output(zSalesNumberGaps),
    markPayment: oc
      .input(
        z.object({
          documentId: zId,
          outcome: zInputVatCheckOutcome,
          voucherId: zId.nullable().optional(),
          note: z.string().trim().min(1).max(500).nullable().optional(),
        }),
      )
      .output(z.object({ documentId: zId, outcome: zInputVatCheckOutcome })),
    // markReturn (owners, admins, members; R1, audited; #1400): marks the period's VAT return filed with [22], [25] and
    // [43] as filed (figures; without them Ludy's own working is recorded) and the tax calendar's done mark with it,
    // or takes both back (done false). The next period's [22] is prefilled from this [43].
    markReturn: oc.input(zVatReturnMark).output(z.object({ period: zVatPeriod, done: z.boolean() })),
  },
  // The tax portal's invoice list (issue #465) for one VAT period. direction 'purchase' (the default) is the "mua vào"
  // export compared with Ludy's purchases; 'sale' (#2141) is the "bán ra" export compared with the recorded sales, so a
  // sale missing from the books or booked with another amount is flagged. reconcile: every role; the lists of the
  // period and how their invoices compare with Ludy's. import (owners, admins, members; R1): files an .xlsx
  // uploaded with purpose 'import' as a list of the period; the worker reads it (poll reconcile until no list is
  // pending). remove (owners, admins, members; R1): takes a list out of its period; it is kept.
  portalList: {
    reconcile: oc.input(z.object({ period: zVatPeriod, legalEntityId: zId.optional(), direction: z.enum(PORTAL_LIST_DIRECTIONS).optional() })).output(zPortalReconciliation),
    import: oc.input(z.object({ period: zVatPeriod, fileId: zId, legalEntityId: zId.optional(), direction: z.enum(PORTAL_LIST_DIRECTIONS).optional() })).output(z.object({ listId: zId })),
    remove: oc.input(z.object({ listId: zId })).output(z.object({ listId: zId })),
  },
  // The assisted sync from the tax portal (issue #325, ADR-0036), off unless the deployment sets TAX_PORTAL_SYNC=true
  // (PORTAL_SYNC_DISABLED, 404). Owners, admins and members of the client org; the steps in order: captcha, login (the
  // password goes to the portal and is dropped), fetchList, then fetchXml until done. Errors: PORTAL_SYNC_ERRORS.
  portalSync: {
    captcha: oc.input(z.object({ period: zVatPeriod })).output(zPortalCaptcha),
    login: oc.input(zPortalLoginInput).output(zPortalSession),
    fetchList: oc.input(z.object({ period: zVatPeriod, session: zPortalSession.shape.session })).output(zPortalListResult),
    fetchXml: oc.input(z.object({ period: zVatPeriod, session: zPortalSession.shape.session, listId: zId })).output(zPortalXmlResult),
  },
  // Asking the client company for the purchase invoices the portal lists and Ludy lacks (issue #669). status: every
  // role. request (owners, admins, members; R1): one mail listing a period's missing invoices to the org's contact email,
  // queued and sent by the worker; CONTACT_EMAIL_REQUIRED (409) without a contact email, NOTHING_MISSING (409),
  // REQUEST_TOO_SOON (409) within an hour of the last request for the period; status 'suppressed' when the org stopped
  // mail to the address. setReminder (owners, admins, members; R1): the day of the month of the reminder, or null.
  missingInvoices: {
    status: oc.output(zMissingInvoiceStatus),
    request: oc
      .input(z.object({ period: zVatPeriod, legalEntityId: zId.optional() }))
      .output(z.object({ messageId: zId, status: z.enum(['queued', 'suppressed']), count: z.number().int().positive() })),
    setReminder: oc
      .input(z.object({ day: z.number().int().min(1).max(MISSING_INVOICE_REMINDER_DAY_MAX).nullable() }))
      .output(z.object({ day: z.number().int().min(1).max(MISSING_INVOICE_REMINDER_DAY_MAX).nullable() })),
  },
  // The Tổng quan of the Kế toán app (#2631), every role: get answers the four cards (cash 111 + 112, profit before tax, receivables 131, payables 331) for a
  // period against the period before, the six months' results and the expense mix, all read from the books; explain is the finance coworker's sentence on the
  // biggest change, asked of the model outside any transaction from the aggregated figures only, and its text is dropped when it states a number the figures
  // do not hold (ai says why there is none).
  financeCashForecast: {
    get: oc.input(zFinanceCashForecastInput).output(zCashForecast),
    explain: oc.input(zFinanceCashForecastExplainAsk).output(zCashForecastExplanation),
  },
  financeOverview: {
    get: oc.input(zFinanceOverviewInput).output(zFinanceOverview),
    explain: oc.input(zFinanceOverviewExplainAsk).output(zOverviewExplanation),
  },
  // The month-close checklist on the Kế toán screen, every role and read only: get answers, for one legal entity and month, the items still open (pending proposals, portal
  // invoices not matched to a voucher, unbooked bank lines, marketplace settlements and payouts, the stock close, the VAT mark, the period lock), each counted by a read of the
  // books; explain is the finance coworker's short note ordering the open items, asked of the model outside any transaction from which items are open (no count, no date) and
  // refused when it states a number, a date, a link, a promise or a done step (ai says why there is none).
  financeMonthClose: {
    get: oc.input(zFinanceMonthCloseInput).output(zMonthClose),
    explain: oc.input(zFinanceMonthCloseExplainAsk).output(zMonthCloseNote),
  },
  // The expense variance card of the Tổng quan (#4392), every role, read only: get answers the flagged expense lines of one ended month against the month before and the average of the three
  // before it, with the suppliers or vouchers behind each; explain is the finance coworker's possible reason per flagged line, asked of the model outside any transaction, and a note that states a number,
  // a date or a name it was not given is dropped.
  financeExpenseVariance: {
    get: oc.input(zFinanceExpenseVarianceInput).output(zFinanceExpenseVariance),
    explain: oc.input(zFinanceExpenseVarianceExplainAsk).output(zExpenseVarianceExplanation),
  },
  // Ledger reports of a month, quarter or year (issue #321): the trial balance and the receivables and payables per
  // party, and the general ledger of one account. The Excel workbook is GET /api/export/ledger.xlsx?period=<period>.
  ledger: {
    period: oc.input(z.object({ period: zLedgerPeriod, legalEntityId: zId.optional() })).output(zLedgerReport),
    account: oc.input(z.object({ period: zLedgerPeriod, accountCode: zAccountCode, legalEntityId: zId.optional() })).output(zAccountLedger),
    // Issue #154: the DRAFT B01-DNN at the period's last day and B02-DNN for the period. The Excel workbook is
    // GET /api/export/statements.xlsx?period=<period>.
    statements: oc.input(z.object({ period: zLedgerPeriod, legalEntityId: zId.optional() })).output(zFinancialStatements),
    // Issue #920: what the HTKK XML of a year's statements (GET /api/export/statements-htkk.xml?year=<year>) would get
    // wrong or leave out, for the screen to say before the download.
    statementsHtkkCheck: oc.input(z.object({ year: zStatementsHtkkYear, legalEntityId: zId.optional() })).output(zStatementsHtkkCheck),
  },
  // Period lock (#329): every member reads it; owners and admins lock the next month once it has ended; only owners
  // unlock the last locked month (R3: fresh MFA), with a reason. A retry with the same idempotencyKey returns the first
  // result.
  // The legal entities whose books the caller may see (#1280), default first: the finance screens show an entity picker
  // only when there is more than one, and pass the chosen legalEntityId to the calls that take one.
  bookEntities: {
    list: oc.output(z.array(zBookEntity)),
  },
  // Each legal entity locks its own months (#1280): legalEntityId as in zLegalEntityChoice.
  periodLock: {
    state: oc.input(zLegalEntityChoice.optional()).output(zPeriodLockState),
    lock: oc.input(zPeriodLockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
    unlock: oc.input(zPeriodUnlockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
  },
  // The register of fixed assets and prepaid costs (#919): every member reads it with what each asset has posted and
  // what is left; owners, admins and members add an entry (from an approved purchase line or by hand) and stop one
  // early. A month's depreciation is asked for with inbox.request (finance.depreciation.record). The Excel workbook is
  // GET /api/export/fixed-assets.xlsx. A retry with the same idempotencyKey returns the first result.
  fixedAssets: {
    list: oc.input(zLegalEntityChoice.optional()).output(z.array(zFixedAsset)),
    create: oc.input(zFixedAssetCreate.extend({ idempotencyKey: zId })).output(z.object({ assetId: zId })),
    end: oc.input(zFixedAssetEnd.extend({ idempotencyKey: zId })).output(z.object({ assetId: zId })),
  },
  // Fiscal year archive packages (#922), owners only: list them, and ask for one (R3: fresh MFA) for a year whose
  // months are all locked. The package is GET /api/finance-archive/<year>/manifest and /api/finance-archive/<year>/<sha256>
  // (a part), and GET /api/finance-archive/<year>/verify checks it (zYearArchiveVerification).
  yearArchive: {
    list: oc.output(zYearArchives),
    build: oc.input(z.object({ year: zArchiveYear, idempotencyKey: zId })).output(zYearArchive),
  },
  // Bank statements (#326): owners, admins and members import a bank's export into an account's statement lines
  // (preview writes nothing; import stores the new and ambiguous lines); every member reads them, each with its state
  // (open, proposed as a voucher, settled by one). A retry with the same
  // idempotencyKey returns the first result.
  bank: {
    preview: oc.input(zBankStatementImport).output(zBankImportPreview),
    import: oc.input(zBankStatementImport.extend({ idempotencyKey: zId })).output(zBankImportResult),
    // A statement read from a file sent by email or dropped in the Inbox (#2142) waits, staged, for a member: statementConfirm
    // (owners, admins, members; R1, audited) stores its lines once, on the account its account number is mapped to, and
    // statementReject skips it, storing nothing. STATEMENT_NOT_STAGED (409) when it was already decided or read again;
    // STATEMENT_MAPPING_CHANGED (409) when its account is no longer mapped to the same bank account.
    statementConfirm: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(zBankImportResult),
    statementReject: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId })),
    // The staged statement's lines as they stand against the account now (#2191), conflicts first: each line with its
    // reference, and for a conflict the line the account already holds under that reference. Owners, admins, members;
    // STATEMENT_NOT_STAGED (409) once it was decided or read again.
    statementLines: oc.input(z.object({ fileId: zId })).output(zStatementLines),
    lines: oc.input(z.object({ bankAccount: zAccountCode, period: zLedgerPeriod, legalEntityId: zId.optional() })).output(zBankLines),
    // The statement lines of all of a legal entity's bank and card accounts in a range whose description holds one of `terms`
    // as whole words (marks and case set aside), newest first, at most BANK_PLATFORM_LINES_LIMIT (`truncated` says more
    // exist): what Ads shows beside a month's spend (slice D2). Read only; owners, admins, members and viewers, as `lines`.
    platformLines: oc
      .input(z.object({ from: zLocalDate, to: zLocalDate, terms: z.array(z.string().min(2).max(60)).min(1).max(8), legalEntityId: zId.optional() }))
      .output(zBankPlatformLines),
    // The báo Có or báo Nợ a line makes and the party it is probably about (#326, stage 2a), for the voucher form; the
    // voucher itself is asked for with inbox.request (finance.voucher.record, bankLineId set). Owners, admins and
    // members, who may ask for vouchers.
    lineVoucher: oc.input(z.object({ bankLineId: zId })).output(zBankLineVoucher),
    // The payroll payments a money-out line may be, by amount (#2532); owners and admins.
    payrollMatch: oc.input(z.object({ bankLineId: zId })).output(zBankPayrollMatch),
    // The approved supplier payments a money-out line may be, by amount and the rules of the payment (#3700 S3c); owners and admins. The settlement is asked for with inbox.request.
    supplierMatch: oc.input(z.object({ bankLineId: zId })).output(zBankSupplierMatch),
    // Completed non-confidential eSign envelopes whose frozen deposit amount and CK-<CODE> memo match an open money-in bank line (#4723). Read-only prefill hint, zero auto-posting.
    signDepositMatch: oc.input(z.object({ bankLineId: zId })).output(zBankSignDepositMatch),
    // Batched lookup of post-sign VietQR deposit matches across up to 50 open money-in bank lines (#4837).
    signDepositMatches: oc.input(zBankSignDepositMatchesInput).output(zBankSignDepositMatches),
    // The coworker's one line on why a line may be one of those payments (#2532): code decided, the model only words it; no text when AI is off, busy, over budget or refused.
    payrollExplain: oc.input(zBankPayrollExplainAsk).output(zBankPayrollExplanation),
    // The coworker's one sentence on why a money-in bank line matches a signed envelope deposit (#4723), from non-PII facts only.
    signDepositExplain: oc.input(zBankSignDepositExplainAsk).output(zBankSignDepositExplanation),
    // The coworker's one sentence on an open line the matcher could not settle: several candidates, or none stands out (#4219). Code listed the candidates, the model only words it; no text when AI is off, busy, over budget or refused.
    candidatesLine: oc.input(zBankCandidatesLineAsk).output(zBankCandidatesLine),
    // The open lines of an account and period whose party is named by its tax code or an invoice of the amount, with
    // the voucher each makes (stage 2b); the SPA asks for them one by one with inbox.request. Owners, admins and members.
    suggestions: oc.input(z.object({ bankAccount: zAccountCode, period: zLedgerPeriod, legalEntityId: zId.optional() })).output(z.array(zBankLineVoucher)),
    // The open lines of an account and period sorted into a clean group (one exact candidate, no warning: ask for and approve
    // together) and lines that need a look, each with why (#2385). Deterministic; the SPA asks for the clean lines' vouchers
    // with inbox.request and approves them with inbox.approveMany. Owners, admins and members.
    matchGroups: oc.input(z.object({ bankAccount: zAccountCode, period: zLedgerPeriod, legalEntityId: zId.optional() })).output(zBankMatchGroups),
    // The lines a voucher settles in a period (all accounts, or one), with the voucher, who approved it and how its party
    // was found (#2385). Every member.
    matched: oc.input(z.object({ bankAccount: zAccountCode.optional(), period: zLedgerPeriod, legalEntityId: zId.optional() })).output(zBankMatched),
    // The open lines per bank account, for the Inbox (stage 2b). Every member.
    openLines: oc.input(zLegalEntityChoice.optional()).output(zBankOpenLines),
  },
  // Bank feeds (ADR-0039, #2044): a connection's accounts mapped to the org's bank accounts. Every member lists the
  // mappings of the entities they read; owners and admins connect, map and unmap. Read-only feeds: nothing here moves
  // money.
  bankFeeds: {
    accounts: oc.output(z.array(zBankFeedAccountView)),
    // The org's live bank feed connections with their status, mapped accounts or not, for the Settings card (#2099).
    // Owners and admins.
    connections: oc.output(z.array(zBankFeedConnectionView)),
    // The offline sandbox feed, when the deployment enables it (BANK_FEED_SANDBOX): a login of its own each time. The
    // worker lists the accounts it reaches (listed), to map.
    connectSandbox: oc.input(z.object({ displayName: z.string().trim().min(1).max(200) })).output(z.object({ connectionId: zId })),
    // A Tingee account, when the deployment enables it (BANK_FEED_TINGEE): the org's own Client ID and Secret Token, tested with one read call, then sealed. Owners and admins. The worker lists the
    // accounts it reaches (listed), to map. Read-only: Tingee's payment endpoints are never called.
    connectTingee: oc.input(zBankFeedConnectTingee).output(z.object({ connectionId: zId })),
    // The accounts a connection reaches, as the worker last listed them.
    listed: oc
      .input(z.object({ connectionId: zId }))
      .output(z.array(z.object({ externalAccountId: z.string(), displayName: z.string(), listedAt: z.string() }))),
    // The webhook hook key of a connection whose provider signs notices with the customer's own secret (Tingee, #4203): makes the hook or replaces its key, and answers the key once (only its SHA-256 is kept; the old address stops at
    // once). No idempotency key: a replay would hand the secret out again. Owners and admins.
    hookSet: oc.input(zBankFeedHookSet).output(zBankFeedHookCreated),
    // The hook's status (made, rotated, last notice, notices refused in the hour, stopped), never its key. Owners and admins.
    hook: oc.input(zBankFeedHookSet).output(zBankFeedHookStatus),
    map: oc.input(zBankFeedMap.extend({ idempotencyKey: zId })).output(z.object({ feedAccountId: zId })),
    unmap: oc.input(z.object({ feedAccountId: zId, idempotencyKey: zId })).output(z.object({ feedAccountId: zId })),
  },
  // The numbers of the org's bank accounts (#2183): owners and admins record the digits a bank statement names on a bank
  // account of an entity (set), list them and remove one (clear), so a statement that arrives by email or in the Inbox
  // finds its account without a bank feed. A number belongs to one bank account of an org: BANK_ACCOUNT_NUMBER_TAKEN
  // (409) when it is on another one, here or as a bank feed mapping, whether or not the caller may read that row.
  bankAccountNumbers: {
    list: oc.output(z.array(zBankAccountNumberView)),
    set: oc.input(zBankAccountNumberSet.extend({ idempotencyKey: zId })).output(z.object({ id: zId })),
    clear: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ id: zId })),
  },
  // Ads (ADR-0040, #2217): the org's ad accounts and the daily spend and results their platforms report, read only. Every
  // member lists the accounts of the entities they read; owners and admins connect and configure. The sandbox ad platform
  // is the offline one (ADS_SANDBOX); the real platforms connect through the channel layer's OAuth later (A2).
  ads: {
    accounts: oc.output(z.array(zAdAccountView)),
    connectSandbox: oc
      .input(z.object({ displayName: z.string().trim().min(1).max(200), currency: z.enum(ADS_SANDBOX_CURRENCIES).optional(), legalEntityId: zId.optional(), idempotencyKey: zId }))
      .output(z.object({ connectionId: zId, adAccountId: zId })),
    // The offline write connection of a sandbox account (the owner, while the org's switch is on): its own sealed token, with the scope
    // that can change campaigns, attached to the account the read connection linked (W0b).
    connectSandboxWrite: oc.input(z.object({ adAccountId: zId, idempotencyKey: zId })).output(z.object({ connectionId: zId, adAccountId: zId })),
    // Closes the read connection of an account and its write connection, dropping both sealed tokens (owners and admins).
    disconnectAccount: oc.input(z.object({ adAccountId: zId, idempotencyKey: zId })).output(z.object({ adAccountId: zId, closed: z.number() })),
    configure: oc.input(zAdsAccountConfigure.extend({ idempotencyKey: zId })).output(z.object({ adAccountId: zId })),
    // Asks for a refresh of one account, at most one a minute.
    requestSync: oc.input(z.object({ adAccountId: zId, idempotencyKey: zId })).output(z.object({ adAccountId: zId })),
    // Deletes an account's stored figures and sync log (owners and admins): a connected account reads its 13 months again, one
    // whose connection is closed also loses its row (#2219).
    deleteHistory: oc.input(zAdsAccountDeleteHistory.extend({ idempotencyKey: zId })).output(z.object({ adAccountId: zId, days: z.number(), runs: z.number(), removed: z.boolean() })),
    // Running ads (ADR-0043, #2294): the switches, the spend caps, the stops and the requests. Owners and admins read the state
    // and stop everything with pauseAll; the owner switches writing off, an account's flag off and lowers a cap. What opens the
    // way to spend (the org switch, an account's flag, a cap set or raised, launches opened again) is asked for with
    // requestChange: a proposal approved in the Inbox (P10, P11), never a direct change. Nothing here calls a platform yet.
    writeState: oc.output(zAdsWriteState),
    // The committed spend of one account's month next to the caps and the room left (#3297): owners and admins, read only.
    committed: oc.input(zAdsCommittedInput).output(zAdsCommitted),
    // The deterministic spend-pace and cost-per-result flags (#2378): owners and admins, read only.
    flags: oc.output(z.array(zAdsFlag)),
    // The deterministic 7-day side-by-side comparison note across connected platforms (#2220): every member who reads Ads, read only.
    weeklyNote: oc.output(z.array(zAdsWeeklyNote)),
    // The thresholds of those flags: owners and admins read them and set them (nothing spends or changes by it).
    flagSettings: oc.output(zAdsFlagSettings),
    setFlagSettings: oc.input(zAdsFlagSettingCall).output(zAdsFlagSettings),
    requestChange: oc.input(zAdsChangeRequest).output(z.object({ proposalId: zId })),
    // Campaign drafts (W1, #2295): one campaign with its ad set and ad, built and checked here; nothing leaves Ludy. Owners, admins and members
    // draft (a member limited to some legal entities sees those entities' accounts only); submitting a draft for approval is requestChange
    // with change campaign_launch, owners and admins.
    campaignDrafts: oc.input(z.strictObject({ adAccountId: zId.optional() })).output(z.array(zAdsCampaignDraftView)),
    campaignDraft: oc.input(z.strictObject({ draftId: zId })).output(zAdsCampaignDraftView),
    saveCampaignDraft: oc.input(zAdsCampaignDraftSaveCall).output(zAdsCampaignDraftView),
    discardCampaignDraft: oc.input(zAdsCampaignDraftDiscardCall).output(z.object({ draftId: zId })),
    // Boost a published Social post (W3, #3834): the options (is it possible, with which accounts), the newest boost of each of some posts, and drafting one from a
    // post. Drafting makes the same draft W1 builds; asking for approval is requestChange (campaign_launch), the same approval and launch as any plan.
    boostOptions: oc.output(zAdsBoostOptions),
    boostStates: oc.input(zAdsBoostStatesInput).output(z.array(zAdsBoostStateView)),
    draftBoost: oc.input(zAdsBoostDraftCall).output(zAdsBoostDrafted),
    // Cancels a launch that has not started (W2-2): an approved plan's commitment against the caps is released. Owners and admins.
    cancelLaunch: oc.input(zAdsLaunchCancelCall).output(z.object({ launchId: zId, released: z.string() })),
    // Stops a launch that has started (W2-4a): owners and admins. It keeps the launch's commitment against the caps to at least today in the account's time zone (a person's
    // stop never releases spend that ran or is in flight), and the objects it made at the platform are paused from the queue after the commit.
    stopLaunch: oc.input(zAdsLaunchStopCall).output(z.object({ launchId: zId, state: z.literal('stopped'), commitUntil: z.string().nullable() })),
    // Runs a launch that needs attention again (W2-4b): owners and admins. The request is stamped and the launch job takes it, with the next attempt: it first looks at what the
    // earlier attempts left unsettled at the platform, then creates what is missing, then switches the objects on if the approved launch is still in force.
    retryLaunch: oc.input(zAdsLaunchRetryCall).output(z.object({ launchId: zId, requested: z.boolean() })),
    // Managing a running ad (W4, #3835): owners and admins. A pause, an archive, a lower budget and a shorter schedule only reduce spend, so they are their own commands; each is
    // queued and the platform is called afterwards, from the queue (never in this request). A resume, a raise and an extension are proposals (requestChange). Members read the state.
    pauseObject: oc.input(zAdsObjectCall).output(zAdsManageChanged),
    archiveObject: oc.input(zAdsObjectCall).output(zAdsManageChanged),
    lowerBudget: oc.input(zAdsBudgetLowerCall).output(zAdsManageChanged),
    shortenSchedule: oc.input(zAdsScheduleShortenCall).output(zAdsManageChanged),
    cancelChange: oc.input(zAdsManageCancelCall).output(z.object({ changeId: zId, cancelled: z.literal(true) })),
    manageState: oc.input(z.strictObject({ launchId: zId })).output(zAdsManageStateView),
    // What the AI coworker suggests for a campaign that spends with poor results: a pause or a lower budget for a person to apply, never a raise (owners and admins).
    manageSuggestions: oc.input(z.strictObject({ adAccountId: zId.optional() })).output(z.array(zAdsManageSuggestion)),
    // Asking the AI coworker for a draft (W1b, #2295): a request the worker answers with a draft or a visible reason why there is none; the model call
    // is rationed by the member's draft budget (RATE_LIMITED over it) and the org's AI budget (the job records AI_BUDGET), and the core works with AI off.
    campaignRequests: oc.input(z.strictObject({ adAccountId: zId.optional() })).output(z.array(zAdsCampaignRequestView)),
    requestCampaignDraft: oc.input(zAdsCampaignRequestCall).output(zAdsCampaignRequestAsked),
    // What an Inbox item of an ads kind changes (owners and admins), for the approval card.
    proposal: oc.input(z.object({ id: zId })).output(zAdsProposalView),
    lowerCap: oc.input(zAdsCapLowerCall).output(z.object({ capId: zId, previous: z.string() })),
    writeDisable: oc.input(z.object({ idempotencyKey: zId })).output(z.object({ writeEnabled: z.literal(false), accountsDisabled: z.number(), connectionsClosed: z.number(), readConnectionsClosed: z.number() })),
    disableAccountWrite: oc.input(z.object({ adAccountId: zId, idempotencyKey: zId })).output(z.object({ adAccountId: zId, writeEnabled: z.literal(false), connectionsClosed: z.number() })),
    pauseAll: oc.input(z.object({ idempotencyKey: zId })).output(z.object({ launchesBlocked: z.literal(true), paused: z.number() })),
    summary: oc.input(zAdsSummaryInput).output(zAdsSummary),
    syncRuns: oc.input(z.object({ adAccountId: zId })).output(z.array(zAdsSyncRunView)),
  },
  // The org chart (ADR-0029): positions shared by members and AI agents. Every member reads it; changing it is the
  // owner's (R3: role keys, holders and reporting lines decide what agents may do). A retry with the same
  // idempotencyKey returns the first result.
  chart: {
    get: oc.output(zChart),
    createPosition: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(200),
          module: zModuleId,
          roleKey: zAgentRoleKey,
          reportsTo: zId.nullable().optional(),
          jobDescription: zJobDescription.optional(),
          leScope: zPositionLeScope.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    updatePosition: oc
      .input(
        z.object({
          id: zId,
          title: z.string().trim().min(1).max(200).optional(),
          reportsTo: zId.nullable().optional(),
          status: zPositionStatus.optional(),
          leScope: zPositionLeScope.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // Gives the position to a member or an active agent of a matching template, or vacates it (holder null).
    assign: oc
      .input(
        z.object({
          id: zId,
          holder: z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: zId }), z.object({ type: z.literal('agent'), agentId: zId })]).nullable(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // The agent templates modules declare; moduleEnabled false means installing it answers MODULE_DISABLED.
    templates: oc.output(z.array(zAgentTemplate)),
    // Owner (R3): an agent and the position it holds, from a template. MODULE_DISABLED when the deployment does not
    // enable the template's module.
    installTemplate: oc
      .input(
        z.object({
          templateKey: z.string().min(1).max(100),
          reportsTo: zId.nullable().optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          leScope: zPositionLeScope.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId, positionId: zId })),
  },
  agents: {
    // Owner (R3): status (pausing or retiring stops its runs at once), max_risk, name and daily run cap.
    update: oc
      .input(
        z.object({
          id: zId,
          status: zAgentStatus.optional(),
          maxRisk: zAgentRisk.optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          dailyRunCap: z.number().int().min(1).max(10000).optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId })),
    // Owners and admins: the monthly budgets and this month's spend.
    budgets: oc.output(z.array(zAgentBudget)),
    // Owner (R3): sets the monthly budget of the org (target '*'), a module or an agent.
    setBudget: oc
      .input(
        z.object({
          scope: zAgentScope,
          target: z.string().min(1).max(100),
          monthlyLimit: zAiAmount,
          warnPercent: z.number().int().min(1).max(100).optional(),
          hardStop: z.boolean().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ budgetId: zId })),
    // "Stop AI": owners and admins, R1, so it never waits for a second factor. Engaging a switch that is already on
    // is a no-op that returns it.
    stop: oc
      .input(z.object({ scope: zAgentScope, target: z.string().min(1).max(100), reason: z.string().max(500).optional(), idempotencyKey: zId }))
      .output(z.object({ killSwitchId: zId, stoppedRuns: z.number().int() })),
    // Owner (R3, fresh MFA): turns a kill switch off again.
    release: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ ok: z.literal(true) })),
  },
  // The AI budget meter (#2382). Raising a budget is agents.setBudget: R3, owner only, a fresh second factor.
  ai: {
    // Every member: where the tightest org or module budget stands (the small meter beside Vy's panels).
    meter: oc.input(z.object({ module: z.string().max(40).optional() })).output(zAiMeter),
    // Owners and admins: this month's use by feature and by agent.
    usage: oc.output(zAiUsageReport),
  },
  // Work given to positions, held by members or agents (ADR-0029). Every member reads; owners, admins and members
  // create, comment and change status.
  tasks: {
    list: oc
      .input(
        z.object({
          positionId: zId.optional(),
          mine: z.boolean().optional(),
          status: z.array(zTaskStatus).max(6).optional(),
          filters: zFilterAstShape.optional(),
          sort: zSavedViewSortShape.nullable().optional(),
        }),
      )
      .output(z.array(zTask)),
    get: oc.input(z.object({ id: zId })).output(zTaskDetail),
    create: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(300),
          description: z.string().max(10000).optional(),
          assigneePositionId: zId.nullable(),
          due: z.iso.datetime().optional(),
          checklist: zTaskChecklist.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ taskId: zId })),
    update: oc
      .input(
        z.object({
          id: zId,
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(10000).nullable().optional(),
          assigneePositionId: zId.nullable().optional(),
          due: z.iso.datetime().nullable().optional(),
          checklist: zTaskChecklist.optional(),
          expectedRevision: z.number().int().positive().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ taskId: zId, revision: z.number().int().positive().optional() })),
    comment: oc.input(z.object({ id: zId, body: z.string().trim().min(1).max(10000), idempotencyKey: zId })).output(z.object({ commentId: zId })),
    setStatus: oc.input(z.object({ id: zId, status: zTaskStatus, idempotencyKey: zId })).output(z.object({ taskId: zId, status: zTaskStatus })),
  },
  // Projects and a task board on kernel tasks (#2591, ADR-0048). Off-switchable via LUDY_MODULES.
  projects: {
    list: oc.input(zProjectListInput).output(zProjectListResult),
    get: oc.input(z.strictObject({ id: zId })).output(zProjectDetail),
    board: oc.input(zProjectBoardInput).output(zProjectBoard),
    weeklyStatus: oc.input(zProjectWeeklyStatusInput).output(zProjectWeeklyStatus),
    weeklyStatusShareNote: oc.input(zProjectWeeklyStatusShareNoteInput.extend({ idempotencyKey: zId })).output(zNoteWritten),
    weeklyStatusSendMail: oc.input(zProjectWeeklyStatusSendMailInput.extend({ idempotencyKey: zId })).output(zProjectWeeklyStatusSendMailResult),
    unassignedTasks: oc.input(z.strictObject({})).output(z.array(zProjectCandidateTask)),
    taskProjects: oc.input(zProjectTaskProjectsInput).output(z.array(zProjectTaskProjectEntry)),
    create: oc.input(zProjectCreate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId })),
    update: oc.input(zProjectUpdate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId })),
    setStatus: oc.input(zProjectSetStatus.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, status: zProjectStatus })),
    archive: oc.input(zProjectArchive.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, status: z.literal('archived') })),
    setOwner: oc.input(zProjectSetOwner.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, ownerUserId: zId })),
    addMember: oc.input(zProjectMemberMutate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, userId: zId, added: z.boolean() })),
    removeMember: oc.input(zProjectMemberMutate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, userId: zId, removed: z.boolean() })),
    addTask: oc.input(zProjectTaskMutate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, taskId: zId, added: z.boolean() })),
    removeTask: oc.input(zProjectTaskMutate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, taskId: zId, removed: z.boolean() })),
    reorderTask: oc
      .input(zProjectTaskReorderFields.extend({ idempotencyKey: zId }).refine(distinctReorderTargets, REORDER_SAME_TASK_ISSUE))
      .output(zProjectTaskReorderResult),
    createTask: oc.input(zProjectTaskCreate.extend({ idempotencyKey: zId })).output(z.object({ projectId: zId, taskId: zId })),
    tasksFromNoteStatus: oc.input(z.strictObject({})).output(zProjectTasksFromNoteStatus),
    proposeTasksFromNote: oc.input(zProjectTasksFromNoteInput).output(zProjectTasksFromNoteResult),
    confirmTasksFromNote: oc
      .input(zProjectTasksFromNoteConfirmInput.extend({ idempotencyKey: zId }))
      .output(zProjectTasksFromNoteConfirmResult),
    tasksFromSourceStatus: oc.input(z.strictObject({})).output(zProjectTasksFromNoteStatus),
    proposeTasksFromSource: oc.input(zProjectTasksFromSourceInput).output(zProjectTasksFromSourceResult),
    confirmTasksFromSource: oc
      .input(zProjectTasksFromSourceConfirmInput.extend({ idempotencyKey: zId }))
      .output(zProjectTasksFromSourceConfirmResult),
    listTemplates: oc.input(zProjectTemplateListInput).output(zProjectTemplateListResult),
    createTemplate: oc
      .input(zProjectTemplateCreateFields.extend({ idempotencyKey: zId }).refine(validTemplateCreateSource, TEMPLATE_CREATE_SOURCE_ISSUE))
      .output(zProjectTemplateCreateResult),
    archiveTemplate: oc
      .input(zProjectTemplateArchiveInput.extend({ idempotencyKey: zId }))
      .output(zProjectTemplateArchiveResult),
    createFromTemplate: oc
      .input(
        zProjectCreateFromTemplateFields
          .extend({ idempotencyKey: zId })
          .refine(validTemplateCreateFromSource, TEMPLATE_CREATE_FROM_SOURCE_ISSUE),
      )
      .output(zProjectCreateFromTemplateResult),
    getTaskRecurrence: oc.input(zProjectTaskRecurrenceGetInput).output(zProjectTaskRecurrenceView.nullable()),
    setTaskRecurrence: oc
      .input(zProjectTaskRecurrenceSetInput.extend({ idempotencyKey: zId }))
      .output(zProjectTaskRecurrenceView),
    clearTaskRecurrence: oc
      .input(zProjectTaskRecurrenceClearInput.extend({ idempotencyKey: zId }))
      .output(zProjectTaskRecurrenceClearResult),
    listDependencies: oc.input(zProjectDependencyListInput).output(zProjectDependencyListResult),
    addDependency: oc
      .input(zProjectDependencyAddInput.extend({ idempotencyKey: zId }))
      .output(zProjectDependencyAddResult),
    removeDependency: oc
      .input(zProjectDependencyRemoveInput.extend({ idempotencyKey: zId }))
      .output(zProjectDependencyRemoveResult),
    initDefaultColumns: oc
      .input(zProjectColumnInitDefaultsInput.extend({ idempotencyKey: zId }))
      .output(zProjectColumnInitDefaultsResult),
    createColumn: oc
      .input(zProjectColumnCreateFields.extend({ idempotencyKey: zId }).refine(validColumnCreatePlacement, COLUMN_CREATE_PLACEMENT_ISSUE))
      .output(zProjectColumnMutateResult),
    updateColumn: oc
      .input(zProjectColumnUpdateInput.extend({ idempotencyKey: zId }))
      .output(zProjectColumnMutateResult),
    reorderColumn: oc
      .input(zProjectColumnReorderFields.extend({ idempotencyKey: zId }).refine(distinctColumnReorderTargets, REORDER_SAME_COLUMN_ISSUE))
      .output(zProjectColumnReorderResult),
    deleteColumn: oc
      .input(zProjectColumnDeleteFields.extend({ idempotencyKey: zId }).refine(distinctDeleteFallbackColumn, DELETE_SAME_FALLBACK_COLUMN_ISSUE))
      .output(zProjectColumnDeleteResult),
    moveTaskColumn: oc
      .input(zProjectTaskMoveColumnFields.extend({ idempotencyKey: zId }).refine(validTaskMoveColumnPlacement, TASK_MOVE_COLUMN_PLACEMENT_ISSUE))
      .output(zProjectTaskMoveColumnResult),
    timeline: oc.input(zProjectTimelineInput).output(zProjectTimeline),
    setTaskDates: oc
      .input(zProjectTaskSetDatesInput.extend({ idempotencyKey: zId }))
      .output(zProjectTaskSetDatesResult),
    listCycles: oc.input(zProjectCycleListInput).output(zProjectCycleListResult),
    cycleMetrics: oc.input(zProjectCycleMetricsInput).output(zProjectCycleMetrics),
    cycleSummary: oc.input(zProjectCycleSummaryInput).output(zProjectCycleSummary),
    createCycle: oc.input(zProjectCycleCreateInput.extend({ idempotencyKey: zId })).output(zProjectCycleMutateResult),
    updateCycle: oc.input(zProjectCycleUpdateInput.extend({ idempotencyKey: zId })).output(zProjectCycleMutateResult),
    deleteCycle: oc.input(zProjectCycleDeleteInput.extend({ idempotencyKey: zId })).output(zProjectCycleDeleteResult),
    startCycle: oc.input(zProjectCycleStartInput.extend({ idempotencyKey: zId })).output(zProjectCycleMutateResult),
    completeCycle: oc.input(zProjectCycleCompleteInput.extend({ idempotencyKey: zId })).output(zProjectCycleCompleteResult),
    setTaskCycle: oc.input(zProjectTaskSetCycleInput.extend({ idempotencyKey: zId })).output(zProjectTaskSetCycleResult),
    setTaskPoints: oc.input(zProjectTaskSetPointsInput.extend({ idempotencyKey: zId })).output(zProjectTaskSetPointsResult),
    roadmap: {
      boards: oc.input(z.strictObject({})).output(zRoadmapBoardListResult),
      boardDetail: oc.input(zRoadmapBoardDetailInput).output(zRoadmapBoardDetailResult),
      boardCreate: oc
        .input(zRoadmapBoardCreateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ board: zRoadmapBoardSummary })),
      boardUpdate: oc
        .input(zRoadmapBoardUpdateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ board: zRoadmapBoardSummary })),
      itemCreate: oc
        .input(zRoadmapItemCreateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ item: zRoadmapAdminItem })),
      itemModerate: oc
        .input(zRoadmapItemModerateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ item: zRoadmapAdminItem })),
      itemMerge: oc
        .input(zRoadmapItemMergeInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ sourceItem: zRoadmapAdminItem, targetItem: zRoadmapAdminItem })),
      itemConvertToTask: oc
        .input(zRoadmapItemConvertToTaskInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ item: zRoadmapAdminItem, projectId: zId, taskId: zId })),
      itemSyncStage: oc
        .input(zRoadmapItemSyncStageInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ item: zRoadmapAdminItem })),
      announcementCreate: oc
        .input(zRoadmapAnnouncementCreateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ announcement: zRoadmapAnnouncement })),
      announcementUpdate: oc
        .input(zRoadmapAnnouncementUpdateInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ announcement: zRoadmapAnnouncement })),
      announcementPublish: oc
        .input(zRoadmapAnnouncementPublishInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ announcement: zRoadmapAnnouncement })),
      announcementDelete: oc
        .input(zRoadmapAnnouncementDeleteInput.extend({ idempotencyKey: zId }))
        .output(z.strictObject({ deleted: z.boolean() })),
      announcementSendNotifications: oc
        .input(zRoadmapAnnouncementSendNotificationsInput.extend({ idempotencyKey: zId }))
        .output(zRoadmapAnnouncementSendNotificationsResult),
      dedupeSuggest: oc.input(zRoadmapDedupeInput).output(zRoadmapDedupeResult),
      changelogDraft: oc.input(zRoadmapChangelogDraftInput).output(zRoadmapChangelogDraftResult),
      signalList: oc.input(zRoadmapSignalListInput).output(zRoadmapSignalListResult),
      signalRollup: oc.input(zRoadmapSignalRollupInput).output(zRoadmapSignalRollupResult),
      signalCreate: oc
        .input(zRoadmapSignalCreateInput.extend({ idempotencyKey: zId }))
        .output(zRoadmapSignalCreateResult),
      signalDelete: oc
        .input(zRoadmapSignalDeleteInput.extend({ idempotencyKey: zId }))
        .output(zRoadmapSignalDeleteResult),
      signalMatchSuggest: oc.input(zRoadmapSignalMatchInput).output(zRoadmapSignalMatchResult),
    },
    startTime: oc
      .input(zProjectTimeStartInput.extend({ idempotencyKey: zId }))
      .output(zProjectTimeStartResult),
    stopTime: oc
      .input(zProjectTimeStopInput.extend({ idempotencyKey: zId }))
      .output(zProjectTimeStopResult),
    logTime: oc
      .input(zProjectTimeLogFields.extend({ idempotencyKey: zId }).refine(validTimeLogRange, PROJECT_TIME_LOG_RANGE_ISSUE))
      .output(zProjectTimeMutateResult),
    updateTimeEntry: oc
      .input(zProjectTimeUpdateFields.extend({ idempotencyKey: zId }).refine(validTimeUpdateRange, PROJECT_TIME_UPDATE_RANGE_ISSUE))
      .output(zProjectTimeMutateResult),
    deleteTimeEntry: oc
      .input(zProjectTimeDeleteInput.extend({ idempotencyKey: zId }))
      .output(zProjectTimeDeleteResult),
    timeSummary: oc.input(zProjectTimeSummaryInput).output(zProjectTimeSummaryResult),
    exportTimeCsv: oc.input(zProjectTimeExportCsvInput).output(zProjectTimeExportCsvResult),
    triage: {
      create: oc
        .input(
          zProjectTriageCreateFields
            .extend({ idempotencyKey: zId })
            .refine(validProjectTriageSourcePair, PROJECT_TRIAGE_SOURCE_PAIR_ISSUE),
        )
        .output(zProjectTriageMutateResult),
      list: oc.input(zProjectTriageListInput).output(zProjectTriageListResult),
      accept: oc
        .input(zProjectTriageAcceptInput.extend({ idempotencyKey: zId }))
        .output(zProjectTriageAcceptResult),
      merge: oc
        .input(zProjectTriageMergeInput.extend({ idempotencyKey: zId }))
        .output(zProjectTriageMutateResult),
      snooze: oc
        .input(zProjectTriageSnoozeInput.extend({ idempotencyKey: zId }))
        .output(zProjectTriageMutateResult),
      decline: oc
        .input(zProjectTriageDeclineInput.extend({ idempotencyKey: zId }))
        .output(zProjectTriageMutateResult),
      reopen: oc
        .input(zProjectTriageReopenInput.extend({ idempotencyKey: zId }))
        .output(zProjectTriageMutateResult),
      assist: oc.input(zProjectTriageAssistInput).output(zProjectTriageAssistResult),
    },
  },
  // Electronic signatures (docs/plan/esign.md, #3325). Off-switchable via LUDY_MODULES and org_app_on.
  sign: {
    envelope: {
      list: oc.input(zSignEnvelopeListInput).output(zSignEnvelopeListResult),
      get: oc.input(z.strictObject({ envelopeId: zId })).output(zSignEnvelopeDetail),
      by_source: oc.input(zSignEnvelopeBySourceInput).output(zSignEnvelopeBySourceResult),
      events: oc.input(z.strictObject({ envelopeId: zId })).output(zSignEnvelopeEventsResult),
      verify: oc.input(z.strictObject({ envelopeId: zId })).output(zSignEnvelopeVerifyResult),
      create: oc.input(zSignEnvelopeCreateInput).output(zSignEnvelopeCreateResult),
      update: oc.input(zSignEnvelopeUpdateInput).output(zSignEnvelopeUpdateResult),
      shared_summary_set: oc.input(zSignEnvelopeSharedSummarySetInput).output(zSignEnvelopeSharedSummarySetResult),
      send: oc.input(zSignEnvelopeSendInput).output(zSignEnvelopeSendResult),
      remind: oc.input(zSignEnvelopeRemindInput).output(zSignEnvelopeRemindResult),
      void: oc.input(zSignEnvelopeVoidInput).output(zSignEnvelopeVoidResult),
      acknowledge_decline: oc.input(zSignEnvelopeAcknowledgeDeclineInput).output(zSignEnvelopeAcknowledgeDeclineResult),
      document: {
        add: oc.input(zSignEnvelopeDocumentAddInput).output(zSignEnvelopeDocumentAddResult),
        remove: oc.input(zSignEnvelopeDocumentRemoveInput).output(zSignEnvelopeDocumentRemoveResult),
        reorder: oc.input(zSignEnvelopeDocumentReorderInput).output(zSignEnvelopeDocumentReorderResult),
      },
    },
    packet: {
      consistency_check: oc.input(zSignPacketConsistencyCheckInput).output(zSignPacketConsistencyCheckResult),
    },
    signer: {
      add: oc.input(zSignSignerAddInput).output(zSignSignerAddResult),
      remove: oc.input(zSignSignerRemoveInput).output(zSignSignerRemoveResult),
      reorder: oc.input(zSignSignerReorderInput).output(zSignSignerReorderResult),
      create_link: oc.input(zSignSignerCreateLinkInput).output(zSignSignerCreateLinkResult),
      correct_recipient: oc.input(zSignSignerCorrectRecipientInput).output(zSignSignerCorrectRecipientResult),
      start_in_person: oc.input(zSignSignerStartInPersonInput).output(zSignSignerStartInPersonResult),
    },
    field: {
      set: oc.input(zSignFieldSetInput).output(zSignFieldSetResult),
    },
    ai: {
      analyze: oc.input(zSignAiAnalyzeInput).output(zSignAiAnalyzeResult),
      get: oc.input(z.strictObject({ envelopeId: zId })).output(zSignAiAnalysisRecord.nullable()),
    },
    acceptance: {
      draft_summary: oc.input(zSignAcceptanceDraftInput).output(zSignAcceptanceDraftResult),
    },
    diff: {
      compare: oc.input(zSignDiffCompareInput).output(zSignDiffCompareResult),
    },
    drafter: {
      proposeClauses: oc.input(zSignDrafterProposeInput).output(zSignDrafterProposeResult),
      renderPdf: oc.input(zSignDrafterRenderPdfInput).output(zSignDrafterRenderPdfResult),
    },
    template: {
      list: oc.input(zSignTemplateListInput).output(zSignTemplateListResult),
      get: oc.input(z.strictObject({ templateId: zId })).output(zSignTemplateDetail),
      create: oc.input(zSignTemplateCreateInput).output(zSignTemplateCreateResult),
      update: oc.input(zSignTemplateUpdateInput).output(zSignTemplateUpdateResult),
      shared_summary_set: oc.input(zSignTemplateSharedSummarySetInput).output(zSignTemplateSharedSummarySetResult),
      roles_set: oc.input(zSignTemplateRolesSetInput).output(zSignTemplateRolesSetResult),
      fields_set: oc.input(zSignTemplateFieldsSetInput).output(zSignTemplateFieldsSetResult),
      archive: oc.input(zSignTemplateArchiveInput).output(zSignTemplateArchiveResult),
      instantiate: oc.input(zSignTemplateInstantiateInput).output(zSignTemplateInstantiateResult),
      direct_link_set: oc.input(zSignTemplateDirectLinkSetInput).output(zSignTemplateDirectLinkResult),
      direct_link_rotate: oc.input(zSignTemplateDirectLinkRotateInput).output(zSignTemplateDirectLinkResult),
    },
    ca: {
      settings: oc.output(zSignCaSettingsResult),
      save_connection: oc.input(zSignCaConnectionSaveInput).output(zSignCaConnectionRecord),
      disable_connection: oc.input(zSignCaConnectionDisableInput).output(zSignCaConnectionRecord),
      test_connection: oc.input(zSignCaConnectionTestInput).output(zSignCaConnectionRecord),
      list_requests: oc.input(z.strictObject({ envelopeId: zId })).output(zSignCaRequestListResult),
      initiate_request: oc.input(zSignCaRequestInitiateInput).output(zSignCaSigningRequestRecord),
    },
    obligation: {
      get: oc.input(z.strictObject({ envelopeId: zId })).output(zSignObligationGetResult),
      renewals_list: oc.input(zSignObligationRenewalsListInput).output(zSignObligationRenewalsListResult),
      extract: oc.input(zSignObligationExtractInput).output(zSignObligationExtractResult),
      upsert: oc.input(zSignObligationUpsertInput).output(zSignEnvelopeObligationRecord),
      dismiss_proposal: oc.input(zSignObligationDismissInput).output(zSignObligationDismissResult),
      complete_item: oc.input(zSignObligationCompleteItemInput).output(zSignEnvelopeObligationRecord),
    },
    member_signature: {
      list: oc.input(zSignMemberSignatureListInput).output(zSignMemberSignatureListResult),
      upsert: oc.input(zSignMemberSignatureUpsertInput).output(zSignMemberSignatureUpsertResult),
      delete: oc.input(zSignMemberSignatureDeleteInput).output(zSignMemberSignatureDeleteResult),
    },
    stamp: {
      list: oc.input(zSignOrgStampListInput).output(zSignOrgStampListResult),
      create: oc.input(zSignOrgStampCreateInput).output(zSignOrgStampCreateResult),
      archive: oc.input(zSignOrgStampArchiveInput).output(zSignOrgStampArchiveResult),
    },
    vault: {
      search: oc.input(zSignVaultSearchInput).output(zSignVaultSearchResult),
      ask: oc.input(zSignVaultAskInput).output(zSignVaultAskResult),
    },
    webhook: {
      list: oc.input(zSignWebhookListInput).output(zSignWebhookListResult),
      deliveries: oc.input(zSignWebhookDeliveriesInput).output(zSignWebhookDeliveriesResult),
      create: oc.input(zSignWebhookCreateInput).output(zSignWebhookWithSecretResult),
      update: oc.input(zSignWebhookUpdateInput).output(zSignWebhookRecord),
      rotate_secret: oc.input(zSignWebhookRotateSecretInput).output(zSignWebhookWithSecretResult),
      delete: oc.input(zSignWebhookDeleteInput).output(zSignWebhookDeleteResult),
      ping: oc.input(zSignWebhookPingInput).output(zSignWebhookPingResult),
    },
    playbook: {
      rules_list: oc.input(zSignPlaybookRulesListInput).output(zSignPlaybookRulesListResult),
      rule_upsert: oc.input(zSignPlaybookRuleUpsertInput).output(zSignPlaybookRuleRecord),
      rule_delete: oc.input(zSignPlaybookRuleDeleteInput).output(zSignPlaybookRuleDeleteResult),
      seed_defaults: oc.input(zSignPlaybookSeedDefaultsInput).output(zSignPlaybookRulesListResult),
      get: oc.input(z.strictObject({ envelopeId: zId })).output(zSignPlaybookGetResult),
      evaluate: oc.input(zSignPlaybookEvaluateInput).output(zSignPlaybookEvaluateResult),
      override_finding: oc.input(zSignPlaybookOverrideFindingInput).output(zSignEnvelopePlaybookCheckRecord),
    },
    kyc: {
      list: oc.input(z.strictObject({ envelopeId: zId })).output(zSignKycListResult),
      run_deterministic: oc.input(zSignKycRunDeterministicInput).output(zSignKycCheckRecord),
      analyze: oc.input(zSignKycAnalyzeInput).output(zSignKycAnalyzeResult),
      confirm: oc.input(zSignKycConfirmInput).output(zSignKycCheckRecord),
    },
    api_keys: {
      list: oc.input(zSignApiKeyListInput).output(zSignApiKeyListResult),
      create: oc.input(zSignApiKeyCreateInput).output(zSignApiKeyCreateResult),
      revoke: oc.input(zSignApiKeyRevokeInput).output(zSignApiKeyRecord),
    },
    depositProfile: {
      get: oc.output(zSignDepositProfileGetResult),
      upsert: oc.input(zSignDepositProfileUpsertInput).output(zSignDepositProfile),
      clear: oc.input(zSignDepositProfileClearInput).output(zSignDepositProfileClearResult),
    },
    deposit: {
      set: oc.input(zSignEnvelopeDepositSetInput).output(zSignEnvelopeDepositRecord),
      clear: oc.input(zSignEnvelopeDepositClearInput).output(zSignEnvelopeDepositClearResult),
    },
  },
};

export type Contract = typeof contract;
