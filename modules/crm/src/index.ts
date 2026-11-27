import { crmAgentQueries } from './agent.ts';
import { bookingFeedCommands, bookingFeedQueries } from './booking-feed.ts';
import { bookingCommands, bookingQueries } from './bookings.ts';
import { companySuggestQueries } from './company-suggest.ts';
export { companyCandidates, companySuggestQueries, domainLabelOf, emailDomainOf, taxCodesIn } from './company-suggest.ts';
import { contactQueries } from './contacts.ts';
import { dealMeetingUpdateCommands } from './deal-meeting-update.ts';
import { dealCommands, dealQueries } from './deals.ts';
import { boardQueries, stageCommands } from './stages.ts';
import { crmEngageProposalCommands } from './engage-proposals.ts';
export { crmEngageProposalCommands, bookingCancelApproved, bookingMoveApproved, quoteSendApproved } from './engage-proposals.ts';
import { eventTypeCommands, eventTypeQueries } from './event-types.ts';
import { importCommands, importQueries } from './import.ts';
import { mcpCrmQueries } from './mcp.ts';
import { mcpCrmWriteCommands } from './mcp-write.ts';
import { nextStepCommands, nextStepQueries } from './next-steps.ts';
import { attentionCommands, attentionQueries } from './attention.ts';
import { followupQueries } from './followup-source.ts';
import { meetingBriefQueries } from './meeting-brief.ts';
import { meetingFactsQueries } from './meeting-facts.ts';
import { quoteCommands, quoteQueries } from './quotes.ts';
import { quotePdfCommands, quotePdfQueries } from './quote-pdf.ts';
import { quoteSuggestSource } from './quote-suggest.ts';
import { quoteReport } from './quote-report.ts';
import { salesOrderCommands, salesOrderQueries } from './sales-orders.ts';
import { crmOpenDealsSignals } from './signals-open-deals.ts';
import { crmWonDealsSignals } from './signals-won-deals.ts';
import { crmToday } from './today.ts';
import { crmWakeQueries } from './wake.ts';

export { dealMeetingUpdateApply, dealMeetingUpdateCommands } from './deal-meeting-update.ts';
export { dealCommands, dealConversations, dealCreate, dealDelete, dealGet, dealList, dealMove, dealQueries, dealUpdate, partyConversations, partyDeals, partySearch, pipelineSetup, pipelineStages } from './deals.ts';
export { boardQueries, dealBoard, stageAdd, stageCommands, stageRemove, stageRename, stageReorder } from './stages.ts';
export * from './event-types.ts';
export * from './bookings.ts';
export * from './agent.ts';
export * from './booking-feed.ts';
export * from './contacts.ts';
export * from './mcp.ts';
export { mcpDealCreate, mcpDealMove, mcpQuoteSave, mcpQuoteRevise, mcpNextStepDone, mcpNextStepSnooze } from './mcp-write.ts';
export { importCancel, importCommands, importCommit, importExpire, importFillTaxSuggestions, importPreview, importQueries, importStage, importTaxLookupCandidates, type ImportTaxLookupCandidate, type ImportTaxLookupCandidatesResult } from './import.ts';

export { dealSettingGet, dealSettingSet, nextStepCommands, nextStepDone, nextStepList, nextStepQueries, nextStepRaise, nextStepSnooze, staleDays } from './next-steps.ts';

export { loadQuoteDocument, quoteDocument, quoteMailDocument, quotePdfCommands, type QuoteDocumentData, type QuoteLogoFile } from './quote-pdf.ts';
export { renderQuotePdf, type QuoteDocument, type QuoteParty } from './pdf/quote-document.ts';
export { readLogoImage, type PdfImage } from './pdf/image.ts';
export { dealHasQuotes, dealQuotes, quoteCommands, quoteDefaults, quoteDeleteDraft, newQuoteToken, quoteGet, quoteLinkCreate, quoteLinkRevoke, quoteList, quoteLogoRemove, quoteLogoSet, quoteQueries, quoteRevise, quoteSave, quoteSend, quoteSettingGet, quoteSettingSet, quoteTokenHash } from './quotes.ts';

export { QUOTE_MAIL_SOURCE, QUOTE_MAIL_TEMPLATE, renderQuoteMail, zQuoteMail } from './quote-mail.ts';

export { quoteSuggestSource, type QuoteSuggestSource } from './quote-suggest.ts';
export { attentionCommands, attentionQueries, partyAttention, partyAttentionSeen } from './attention.ts';
export { followupQueries, followupSource, type FollowupSource } from './followup-source.ts';
export { meetingBriefQueries, meetingBriefSourceQuery, type MeetingBriefSource } from './meeting-brief.ts';
export { quoteReport } from './quote-report.ts';

export { dealSalesOrders, quoteAccept, quoteDecline, salesOrderCancel, salesOrderCommands, salesOrderDeliver, salesOrderGet, salesOrderHandoff, salesOrderList, salesOrderQueries, salesOrderUndeliver } from './sales-orders.ts';

export { crmToday } from './today.ts';

export const crmCommands = [...crmEngageProposalCommands, ...eventTypeCommands, ...bookingCommands, ...bookingFeedCommands, ...dealCommands, ...dealMeetingUpdateCommands, ...stageCommands, ...importCommands, ...nextStepCommands, ...attentionCommands, ...quoteCommands, ...quotePdfCommands, ...salesOrderCommands, ...mcpCrmWriteCommands];
export const crmQueries = [...eventTypeQueries, ...bookingQueries, ...crmAgentQueries, ...bookingFeedQueries, ...dealQueries, ...boardQueries, ...contactQueries, ...companySuggestQueries, ...importQueries, ...nextStepQueries, ...attentionQueries, ...quoteQueries, quoteSuggestSource, ...followupQueries, ...meetingBriefQueries, ...meetingFactsQueries, quoteReport, ...quotePdfQueries, ...salesOrderQueries, crmToday, crmWonDealsSignals, crmOpenDealsSignals, ...mcpCrmQueries, ...crmWakeQueries];
export { crmManifest } from './manifest.ts';
